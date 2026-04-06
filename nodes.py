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
                # JSON list of ALL filenames persisted in the workflow JSON.
                "image_list": ("STRING", {"default": "[]"}),
                # JSON list of SELECTED filenames (subset of image_list).
                "selected_list": ("STRING", {"default": "[]"}),
                "fit_mode": (["letterbox", "crop"],),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("all_images", "selected_images")
    FUNCTION = "load_images"
    CATEGORY = "image/loaders"
    OUTPUT_NODE = False

    @classmethod
    def IS_CHANGED(cls, image_list="[]", selected_list="[]", fit_mode="letterbox"):
        return hashlib.md5((image_list + selected_list).encode()).hexdigest()

    def load_images(self, image_list="[]", selected_list="[]", fit_mode="letterbox"):
        try:
            filenames = json.loads(image_list)
        except Exception:
            filenames = []

        try:
            selected_fns = set(json.loads(selected_list) or [])
        except Exception:
            selected_fns = set()

        placeholder = torch.zeros((1, 64, 64, 3), dtype=torch.float32)

        if not filenames:
            return (placeholder, placeholder)

        input_dir = Path(folder_paths.get_input_directory())
        loaded = []          # list of (filename, tensor)
        reference_size = None

        for fname in filenames:
            fpath = input_dir / fname
            if not fpath.exists():
                print(f"[MultiImageLoader] Warning: file not found – {fpath}")
                continue
            try:
                img = Image.open(fpath)
                img = ImageOps.exif_transpose(img)
                img = img.convert("RGB")

                if reference_size is None:
                    reference_size = img.size
                elif img.size != reference_size:
                    target_w, target_h = reference_size
                    img = _fit_image(img, target_w, target_h, fit_mode)

                arr = np.array(img).astype(np.float32) / 255.0
                tensor = torch.from_numpy(arr).unsqueeze(0)  # 1×H×W×C
                loaded.append((fname, tensor))
            except Exception as e:
                print(f"[MultiImageLoader] Error loading {fname}: {e}")
                continue

        if not loaded:
            return (placeholder, placeholder)

        # all_images: every successfully loaded image
        all_batch = torch.cat([t for _, t in loaded], dim=0)

        # selected_images: those whose filename is in selected_fns
        # If selected_fns is empty (nothing persisted yet) fall back to all.
        if not selected_fns:
            selected_batch = all_batch
        else:
            sel = [t for fn, t in loaded if fn in selected_fns]
            selected_batch = torch.cat(sel, dim=0) if sel else placeholder

        return (all_batch, selected_batch)


# ─── Registrations ────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "MultiImageLoader": MultiImageLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MultiImageLoader": "Load Multiple Images 🖼️",
}
