import os
import json
import hashlib
import numpy as np
import torch
from PIL import Image, ImageOps
from pathlib import Path
from server import PromptServer
from aiohttp import web
import folder_paths

# ─── Upload route ─────────────────────────────────────────────────────────────

@PromptServer.instance.routes.post("/multi_image_loader/upload")
async def upload_images_handler(request):
    """
    Accepts multipart/form-data with multiple files named 'images'.
    Saves each file to ComfyUI's input folder and returns the list of filenames.
    """
    try:
        reader = await request.multipart()
        saved = []
        input_dir = Path(folder_paths.get_input_directory())
        input_dir.mkdir(parents=True, exist_ok=True)

        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name != "images":
                continue

            filename = part.filename or "upload.png"
            # Sanitize filename
            filename = os.path.basename(filename)
            data = await part.read()

            # Use a hash prefix to avoid collisions across users/sessions
            hash_prefix = hashlib.md5(data).hexdigest()[:8]
            stem, ext = os.path.splitext(filename)
            safe_name = f"mil_{hash_prefix}_{stem}{ext}"
            dest = input_dir / safe_name
            dest.write_bytes(data)
            saved.append(safe_name)

        return web.json_response({"success": True, "files": saved})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


# ─── Node ─────────────────────────────────────────────────────────────────────

def _fit_image(img: Image.Image, target_w: int, target_h: int, mode: str) -> Image.Image:
    """
    Resize `img` to (target_w, target_h) using the requested fit strategy.

    letterbox – Preserve aspect ratio; pad with black to fill the canvas.
    crop      – Preserve aspect ratio; scale to fill, then center-crop.
    fill      – Stretch/squish to exact dimensions (no padding, no crop).
    """
    if img.size == (target_w, target_h):
        return img

    if mode == "fill":
        return img.resize((target_w, target_h), Image.LANCZOS)

    src_w, src_h = img.size
    scale_w = target_w / src_w
    scale_h = target_h / src_h

    if mode == "letterbox":
        # Scale down to fit inside the canvas (never upscale beyond target)
        scale = min(scale_w, scale_h)
        new_w = round(src_w * scale)
        new_h = round(src_h * scale)
        resized = img.resize((new_w, new_h), Image.LANCZOS)
        canvas = Image.new("RGB", (target_w, target_h), (0, 0, 0))
        offset_x = (target_w - new_w) // 2
        offset_y = (target_h - new_h) // 2
        canvas.paste(resized, (offset_x, offset_y))
        return canvas

    if mode == "crop":
        # Scale up to fill the canvas, then center-crop
        scale = max(scale_w, scale_h)
        new_w = round(src_w * scale)
        new_h = round(src_h * scale)
        resized = img.resize((new_w, new_h), Image.LANCZOS)
        left = (new_w - target_w) // 2
        top  = (new_h - target_h) // 2
        return resized.crop((left, top, left + target_w, top + target_h))

    # Fallback – should not happen
    return img.resize((target_w, target_h), Image.LANCZOS)


def _apply_crop_transform(img: Image.Image, transform: dict, canvas_w: int, canvas_h: int) -> Image.Image:
    """
    Apply a user-defined pan/zoom/flip/rotate transform and crop to canvas_w × canvas_h.
    transform keys:
      ox, oy    – offset of image centre from canvas centre (fraction of canvas dims)
      scale     – zoom factor relative to letterbox-fit (1.0 = whole image fits)
      flipH, flipV – mirror flags
      rotate    – clockwise degrees (-180..180)
      bg        – background fill: 'black' | 'white' | '#rrggbb' | '#808080' (default) |
                  'telea' | 'navier-stokes'
    """
    import numpy as np

    ox     = float(transform.get("ox",     0.0))
    oy     = float(transform.get("oy",     0.0))
    scale  = float(transform.get("scale",  1.0))
    flipH  = bool(transform.get("flipH",  False))
    flipV  = bool(transform.get("flipV",  False))
    rotate = float(transform.get("rotate", 0.0))
    bg_raw = transform.get("bg", "#808080")
    if scale <= 0:
        scale = 1.0

    # ── resolve background colour ──────────────────────────────────────────────
    def _parse_hex(h, default=(128, 128, 128)):
        try:
            h = h.lstrip("#")
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
        except Exception:
            return default

    inpaint_method = None
    if bg_raw == "black":
        bg_color = (0, 0, 0)
    elif bg_raw == "white":
        bg_color = (255, 255, 255)
    elif bg_raw == "telea":
        bg_color = (128, 128, 128)
        inpaint_method = "telea"
    elif bg_raw == "navier-stokes":
        bg_color = (128, 128, 128)
        inpaint_method = "navier-stokes"
    elif isinstance(bg_raw, str) and bg_raw.startswith("#"):
        bg_color = _parse_hex(bg_raw)
    else:
        bg_color = (128, 128, 128)   # default grey

    # ── intrinsic transforms: flip → rotate ────────────────────────────────────
    if flipH: img = ImageOps.mirror(img)
    if flipV: img = ImageOps.flip(img)

    rotation_alpha = None   # PIL Image "L" mask (255=opaque, 0=transparent)
    if rotate != 0:
        if inpaint_method:
            # Rotate in RGBA so we can track newly-transparent pixels
            rgba = img.convert("RGBA")
            rgba = rgba.rotate(-rotate, expand=True, resample=Image.LANCZOS,
                               fillcolor=(0, 0, 0, 0))
            rotation_alpha = rgba.split()[3]           # L mode, 0=gap
            img = rgba.convert("RGB")
        else:
            img = img.rotate(-rotate, expand=True, resample=Image.LANCZOS,
                             fillcolor=bg_color)

    # ── cv2 inpainting to fill rotation gaps ──────────────────────────────────
    if inpaint_method and rotation_alpha is not None:
        try:
            import cv2
            alpha_np = np.array(rotation_alpha)
            inpaint_mask = np.where(alpha_np < 128, 255, 0).astype(np.uint8)
            if inpaint_mask.any():
                img_np = np.array(img.convert("RGB"))
                method = cv2.INPAINT_TELEA if inpaint_method == "telea" else cv2.INPAINT_NS
                img_np = cv2.inpaint(img_np, inpaint_mask, inpaintRadius=3, flags=method)
                img = Image.fromarray(img_np.astype(np.uint8))
        except Exception as e:
            print(f"[MultiImageLoader] cv2 inpaint error (falling back to solid fill): {e}")

    # ── pan / zoom ─────────────────────────────────────────────────────────────
    src_w, src_h = img.size
    base_scale   = min(canvas_w / src_w, canvas_h / src_h)
    eff_scale    = base_scale * scale
    new_w        = max(1, round(src_w * eff_scale))
    new_h        = max(1, round(src_h * eff_scale))
    resized      = img.resize((new_w, new_h), Image.LANCZOS)

    paste_x = round((canvas_w - new_w) / 2 + ox * canvas_w)
    paste_y = round((canvas_h - new_h) / 2 + oy * canvas_h)

    canvas = Image.new("RGB", (canvas_w, canvas_h), bg_color)
    canvas.paste(resized, (paste_x, paste_y))
    return canvas



class MultiImageLoader:
    """
    Loads multiple images uploaded directly in the UI (no folder needed).
    Images are uploaded via a drag-and-drop / file-picker widget injected
    by the companion JavaScript extension.

    Outputs a single IMAGE batch tensor  [B, H, W, C].
    All images are conformed to the first image's dimensions using
    the chosen fit_mode: letterbox, crop, or fill.
    """

    UPLOADED_FILES_KEY = "image_list"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                # JSON list of filenames persisted in the workflow JSON.
                "image_list": ("STRING", {"default": "[]"}),
                "fit_mode": (["letterbox", "crop"],),
                "thumb_size": (["small", "medium", "large"],),  # UI-only
                "crop_data":  ("STRING", {"default": "{}"}),  # UI-only: per-image pan/zoom JSON
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image_batch",)
    FUNCTION = "load_images"
    CATEGORY = "image/loaders"
    OUTPUT_NODE = False

    @classmethod
    def IS_CHANGED(cls, image_list="[]", fit_mode="letterbox", thumb_size="medium", crop_data="{}"):
        return hashlib.md5((image_list + crop_data).encode()).hexdigest()

    def load_images(self, image_list="[]", fit_mode="letterbox", thumb_size="medium", crop_data="{}"):
        try:
            filenames = json.loads(image_list)
        except Exception:
            filenames = []

        try:
            transforms = json.loads(crop_data) if crop_data else {}
        except Exception:
            transforms = {}

        placeholder = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
        if not filenames:
            return (placeholder,)

        input_dir = Path(folder_paths.get_input_directory())
        tensors   = []
        ref_w = ref_h = None

        for fname in filenames:
            fpath = input_dir / fname
            if not fpath.exists():
                print(f"[MultiImageLoader] Warning: file not found \u2013 {fpath}")
                continue
            try:
                img = Image.open(fpath)
                img = ImageOps.exif_transpose(img)
                img = img.convert("RGB")

                if ref_w is None:
                    ref_w, ref_h = img.size

                t = transforms.get(fname)
                if t:
                    img = _apply_crop_transform(img, t, ref_w, ref_h)
                elif img.size != (ref_w, ref_h):
                    img = _fit_image(img, ref_w, ref_h, fit_mode)

                arr = np.array(img).astype(np.float32) / 255.0
                tensors.append(torch.from_numpy(arr).unsqueeze(0))
            except Exception as e:
                print(f"[MultiImageLoader] Error loading {fname}: {e}")
                continue

        if not tensors:
            return (placeholder,)

        batch = torch.cat(tensors, dim=0)
        return (batch,)


# ─── Registrations ────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "MultiImageLoader": MultiImageLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MultiImageLoader": "Load Multiple Images 🖼️",
}
