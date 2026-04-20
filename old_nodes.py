import os
import json
import math
import hashlib
import numpy as np
import torch
from PIL import Image, ImageOps, ImageDraw
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


# ─── Inpaint route (Content-Aware Fill) ───────────────────────────────────────

@PromptServer.instance.routes.post("/multi_image_loader/inpaint")
async def inpaint_handler(request):
    """Accept base64 image + mask, run cv2.inpaint (Telea), return base64 result."""
    import asyncio, base64, io as _io
    try:
        import cv2
    except ImportError:
        return web.json_response({"error": "opencv-python not installed"}, status=500)

    try:
        data = await request.json()
        img_b64 = data.get("image", "")
        mask_b64 = data.get("mask", "")
        if not img_b64 or not mask_b64:
            return web.Response(status=400, text="Missing image or mask")

        # Strip data URL prefix if present
        for prefix in ("data:image/png;base64,", "data:image/webp;base64,",
                        "data:image/jpeg;base64,"):
            if img_b64.startswith(prefix):
                img_b64 = img_b64[len(prefix):]
            if mask_b64.startswith(prefix):
                mask_b64 = mask_b64[len(prefix):]

        loop = asyncio.get_event_loop()

        def _run():
            img_pil = Image.open(_io.BytesIO(base64.b64decode(img_b64))).convert("RGB")
            mask_pil = Image.open(_io.BytesIO(base64.b64decode(mask_b64))).convert("L")
            # Resize mask to match image if needed
            if mask_pil.size != img_pil.size:
                mask_pil = mask_pil.resize(img_pil.size, Image.NEAREST)
            img_cv = np.array(img_pil)[:, :, ::-1]  # RGB→BGR
            # In our mask convention: black=masked, white=unmasked
            # cv2.inpaint wants white=inpaint region, so invert
            mask_cv = 255 - np.array(mask_pil)
            result = cv2.inpaint(img_cv, mask_cv, inpaintRadius=5, flags=cv2.INPAINT_TELEA)
            result_rgb = result[:, :, ::-1]  # BGR→RGB
            result_pil = Image.fromarray(result_rgb)
            buf = _io.BytesIO()
            result_pil.save(buf, format="PNG")
            return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

        result_b64 = await loop.run_in_executor(None, _run)
        return web.json_response({"image": result_b64})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ─── Live-preview route ────────────────────────────────────────────────────────

@PromptServer.instance.routes.post("/multi_image_loader/preview")
async def preview_transform_handler(request):
    """Apply crop transform and return base64 JPEG for live inpaint preview."""
    import asyncio, base64, io as _io

    try:
        data      = await request.json()
        filename  = data.get("filename", "")
        transform = data.get("transform", {})
        ref_w     = max(32, int(data.get("refW", 512)))
        ref_h     = max(32, int(data.get("refH", 512)))

        if not filename:
            return web.Response(status=400, text="Missing filename")

        # Sanitise: no directory traversal
        filename = os.path.basename(filename)
        path = os.path.join(folder_paths.get_input_directory(), filename)
        if not os.path.isfile(path):
            return web.Response(status=404, text=f"File not found: {filename}")

        loop = asyncio.get_event_loop()
        PREVIEW_MAX = 768  # cap preview resolution for speed
        def _run():
            img = Image.open(path).convert("RGB")
            # Downscale source + ref dimensions proportionally for fast inpaint
            w, h = img.size
            if max(ref_w, ref_h) > PREVIEW_MAX:
                s = PREVIEW_MAX / max(ref_w, ref_h)
                p_ref_w, p_ref_h = max(32, int(ref_w * s)), max(32, int(ref_h * s))
            else:
                p_ref_w, p_ref_h = ref_w, ref_h
            return _apply_crop_transform(img, transform, p_ref_w, p_ref_h)

        result = await loop.run_in_executor(None, _run)

        buf = _io.BytesIO()
        result.save(buf, format="JPEG", quality=88)
        b64 = base64.b64encode(buf.getvalue()).decode()
        print(f"[MIL preview] served: rotate={transform.get('rotate', 0):.1f}° bg={transform.get('bg','#808080')}")
        return web.json_response({"dataUrl": f"data:image/jpeg;base64,{b64}"})

    except Exception as e:
        import traceback
        print(f"[MIL preview] error: {e}\n{traceback.format_exc()}")
        return web.Response(status=500, text=str(e))


# ─── Rembg route ──────────────────────────────────────────────────────────────

@PromptServer.instance.routes.post("/multi_image_loader/rembg")
async def rembg_handler(request):
    """Apply rembg background removal to an uploaded image.
    Overwrites the source file in the input dir as PNG RGBA.
    Returns a base64 PNG data URL for immediate editor preview.
    """
    import asyncio, base64, io as _io, sys, subprocess

    try:
        data = await request.json()
        filename  = data.get("filename", "")
        model     = data.get("model", "isnet-general-use")
        post_proc = bool(data.get("post_processing", False))
        a_matt    = bool(data.get("alpha_matting", False))
        fg_thr    = int(data.get("fg_threshold", 240))
        bg_thr    = int(data.get("bg_threshold", 10))
        erode     = int(data.get("erode_size", 10))
        only_mask = bool(data.get("only_mask", False))

        if not filename:
            return web.Response(status=400, text="Missing filename")

        filename = os.path.basename(filename)
        path = os.path.join(folder_paths.get_input_directory(), filename)
        if not os.path.isfile(path):
            return web.Response(status=404, text=f"File not found: {filename}")

        # Lazy install rembg if not available
        try:
            import rembg as _rembg_test  # noqa
        except ImportError:
            print("[MIL rembg] rembg not found — installing…")
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "rembg"],
                stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT
            )

        from rembg import remove, new_session

        # Store rembg models alongside other ComfyUI models
        os.environ["U2NET_HOME"] = os.path.join(folder_paths.models_dir, "rembg")
        os.makedirs(os.environ["U2NET_HOME"], exist_ok=True)

        loop = asyncio.get_event_loop()

        def _run():
            # Always work from the untouched original image.
            # On first call, save a backup; on re-runs, read from it.
            stem, ext = os.path.splitext(path)
            backup = f"{stem}_original{ext}"
            if not os.path.isfile(backup):
                # First rembg on this file — save the original
                import shutil
                shutil.copy2(path, backup)
            source = backup  # always rembg from the pristine original

            img = Image.open(source).convert("RGBA")
            result = remove(
                img,
                session=new_session(model),
                post_process_mask=post_proc,
                alpha_matting=a_matt,
                alpha_matting_foreground_threshold=fg_thr,
                alpha_matting_background_threshold=bg_thr,
                alpha_matting_erode_size=erode,
                only_mask=only_mask,
            )
            result = result.convert("RGBA")
            # Overwrite the working file as RGBA PNG
            result.save(path, format="PNG")
            # Encode for immediate preview
            buf = _io.BytesIO()
            result.save(buf, format="PNG")
            return base64.b64encode(buf.getvalue()).decode()

        b64 = await loop.run_in_executor(None, _run)
        print(f"[MIL rembg] done: {filename}  model={model}")
        return web.json_response({"success": True, "dataUrl": f"data:image/png;base64,{b64}"})

    except Exception as e:
        import traceback
        print(f"[MIL rembg] error: {e}\n{traceback.format_exc()}")
        return web.json_response({"success": False, "error": str(e)}, status=500)


# ─── Rembg Reset route ────────────────────────────────────────────────────────

@PromptServer.instance.routes.post("/multi_image_loader/rembg_reset")
async def rembg_reset_handler(request):
    """Restore the original image from the _original backup created by the rembg route.
    Overwrites the working file and returns a base64 data URL for immediate preview."""
    import asyncio, base64, io as _io

    try:
        data     = await request.json()
        filename = data.get("filename", "")

        if not filename:
            return web.Response(status=400, text="Missing filename")

        filename = os.path.basename(filename)
        path = os.path.join(folder_paths.get_input_directory(), filename)
        if not os.path.isfile(path):
            return web.Response(status=404, text=f"File not found: {filename}")

        stem, ext = os.path.splitext(path)
        backup = f"{stem}_original{ext}"

        if not os.path.isfile(backup):
            return web.json_response(
                {"success": False, "error": "No original backup found — rembg has not been applied to this image."},
                status=404
            )

        loop = asyncio.get_event_loop()

        def _run():
            import shutil
            shutil.copy2(backup, path)
            img = Image.open(path)
            buf = _io.BytesIO()
            fmt = "PNG" if path.lower().endswith(".png") else "JPEG"
            img.save(buf, format=fmt)
            mime = "image/png" if fmt == "PNG" else "image/jpeg"
            return f"data:{mime};base64,{base64.b64encode(buf.getvalue()).decode()}"

        data_url = await loop.run_in_executor(None, _run)
        print(f"[MIL rembg_reset] restored: {filename}")
        return web.json_response({"success": True, "dataUrl": data_url})

    except Exception as e:
        import traceback
        print(f"[MIL rembg_reset] error: {e}\n{traceback.format_exc()}")
        return web.json_response({"success": False, "error": str(e)}, status=500)


# ─── Node ─────────────────────────────────────────────────────────────────────

def _scale_to_megapixels(img: Image.Image, megapixels: float) -> Image.Image:
    """Scale `img` down if it exceeds `megapixels` * 1 000 000 total pixels.
    Aspect ratio is preserved. Never upscales."""
    if megapixels <= 0:
        return img
    target_px = int(megapixels * 1_000_000)
    w, h = img.size
    if w * h <= target_px:
        return img
    scale = (target_px / (w * h)) ** 0.5
    return img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)


def _compute_canvas_dims(aspect_ratio: str, megapixels: float, first_img_size=None):
    """
    Return (canvas_w, canvas_h) based on the selected aspect ratio.
    When aspect_ratio is 'none', returns first_img_size unchanged.
    When set, computes dimensions whose product ≈ megapixels * 1 000 000.
    """
    if aspect_ratio == "none" or not aspect_ratio:
        return first_img_size  # may be None if not yet known
    aw, ah = map(int, aspect_ratio.split(":"))
    total_px = max(1, megapixels * 1_000_000)
    w = max(1, round(math.sqrt(total_px * aw / ah)))
    h = max(1, round(math.sqrt(total_px * ah / aw)))
    return (w, h)


def _parse_hex_color(hex_str: str) -> tuple:
    """Convert '#RRGGBB' hex string to (R, G, B) tuple. Defaults to gray."""
    hex_str = hex_str.strip()
    if hex_str.startswith("#") and len(hex_str) == 7:
        try:
            return (int(hex_str[1:3], 16), int(hex_str[3:5], 16), int(hex_str[5:7], 16))
        except ValueError:
            pass
    return (128, 128, 128)


def _parse_bg_color_word(word: str) -> tuple:
    """Convert word label ('gray', 'black', 'white') to (R, G, B) tuple."""
    mapping = {"gray": (128, 128, 128), "black": (0, 0, 0), "white": (255, 255, 255)}
    return mapping.get(word.strip().lower(), (128, 128, 128))


def _fit_image(img: Image.Image, target_w: int, target_h: int, mode: str, bg_color: tuple = (128, 128, 128)) -> Image.Image:
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
        canvas = Image.new("RGB", (target_w, target_h), bg_color)
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



def _apply_crop_region(img: Image.Image, transform: dict) -> Image.Image:
    """Apply a crop region sub-selection to the SOURCE image.
    cx/cy/cw/ch are fractions of the source image dimensions.
    Returns the cropped sub-image (NOT resized)."""
    cx = float(transform.get("cx", 0.0))
    cy = float(transform.get("cy", 0.0))
    cw = float(transform.get("cw", 1.0))
    ch = float(transform.get("ch", 1.0))
    if cx <= 0.0 and cy <= 0.0 and cw >= 1.0 and ch >= 1.0:
        return img  # no crop region
    w, h = img.size
    left   = max(0, min(round(cx * w), w - 1))
    top    = max(0, min(round(cy * h), h - 1))
    right  = max(left + 1, min(round((cx + cw) * w), w))
    bottom = max(top + 1, min(round((cy + ch) * h), h))
    return img.crop((left, top, right, bottom))


def _apply_crop_transform(img: Image.Image, transform: dict, canvas_w: int, canvas_h: int, fit_mode: str = "letterbox", node_bg_color: tuple = (128, 128, 128)) -> Image.Image:
    """
    Apply a user-defined pan/zoom/flip/rotate transform and crop to canvas_w × canvas_h.
    transform keys:
      ox, oy    – offset of image centre from canvas centre (fraction of canvas dims)
      scale     – zoom factor relative to letterbox-fit (1.0 = whole image fits)
      flipH, flipV – mirror flags
      rotate    – clockwise degrees (-180..180)
      bg        – background fill: 'black' | 'white' | '#rrggbb' | '#808080' (default) |
                  'telea' | 'navier-stokes'
    fit_mode      – 'letterbox' | 'crop'  controls base scale when scale==1.0
    node_bg_color – RGB tuple for letterbox padding (from the node's bg_color widget)
    """
    import numpy as np

    # ── PRE-CROP: apply crop region to source image FIRST ──────────────────────
    img = _apply_crop_region(img, transform)

    # ── PIXEL EDITS: composite imageEditsDataUrl over source ──────────────────
    edits_data_url = transform.get("imageEditsDataUrl")
    if edits_data_url and isinstance(edits_data_url, str):
        import base64, io as _io
        try:
            # Strip data URL prefix
            for pfx in ("data:image/png;base64,", "data:image/webp;base64,",
                         "data:image/jpeg;base64,"):
                if edits_data_url.startswith(pfx):
                    edits_data_url = edits_data_url[len(pfx):]
                    break
            edits_pil = Image.open(_io.BytesIO(base64.b64decode(edits_data_url))).convert("RGBA")
            # Resize edits to match current source size
            if edits_pil.size != img.size:
                edits_pil = edits_pil.resize(img.size, Image.LANCZOS)
            img = img.convert("RGBA")
            img = Image.alpha_composite(img, edits_pil).convert("RGB")
        except Exception as e:
            print(f"[MIL] Warning: failed to apply pixel edits: {e}")

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
        bg_color = (128, 128, 128)

    # ══════════════════════════════════════════════════════════════════════════
    # INPAINT PATH — all transforms in RGBA so the final alpha = coverage mask.
    # Inpainting runs once at the end on the full canvas, catching BOTH:
    #   • rotation corner gaps
    #   • pan / zoom letterbox borders
    # ══════════════════════════════════════════════════════════════════════════
    if inpaint_method:
        try:
            import cv2
        except ImportError:
            inpaint_method = None  # fall through to solid-fill path below

    if inpaint_method:
        rgba = img.convert("RGBA")

        # Flip
        if flipH: rgba = ImageOps.mirror(rgba)
        if flipV: rgba = ImageOps.flip(rgba)

        # Rotate (expand=True so corners don't clip; transparent fill)
        if rotate != 0:
            rgba = rgba.rotate(-rotate, expand=True, resample=Image.BICUBIC,
                               fillcolor=(0, 0, 0, 0))

        # Scale to fit/fill canvas, applying user zoom
        src_w, src_h = rgba.size
        if fit_mode == "crop":
            base_scale = max(canvas_w / src_w, canvas_h / src_h)
        else:
            base_scale = min(canvas_w / src_w, canvas_h / src_h)
        eff_scale    = base_scale * scale
        new_w        = max(1, round(src_w * eff_scale))
        new_h        = max(1, round(src_h * eff_scale))
        resized      = rgba.resize((new_w, new_h), Image.LANCZOS)

        # Paste onto a fully-transparent RGBA canvas
        paste_x = round((canvas_w - new_w) / 2 + ox * canvas_w)
        paste_y = round((canvas_h - new_h) / 2 + oy * canvas_h)
        canvas_rgba = Image.new("RGBA", (canvas_w, canvas_h), (128, 128, 128, 0))
        canvas_rgba.paste(resized, (paste_x, paste_y), resized)

        # Alpha channel → inpaint mask  (255 = empty area to fill, 0 = keep)
        alpha_np     = np.array(canvas_rgba.split()[3])
        inpaint_mask = np.where(alpha_np < 128, 255, 0).astype(np.uint8)

        # Incorporate lasso mask — areas outside lasso selection should also be inpainted
        lasso_mask = _generate_lasso_mask(transform, img.size, canvas_w, canvas_h)
        if lasso_mask is not None:
            lasso_np = np.array(lasso_mask)
            # lasso_np: 255 = inside selection (keep), 0 = outside (inpaint)
            inpaint_mask = np.where(lasso_np < 128, 255, inpaint_mask).astype(np.uint8)

        # RGB image with gray seed in empty areas (gives inpaint a neutral start)
        seed = Image.new("RGB", (canvas_w, canvas_h), (128, 128, 128))
        seed.paste(canvas_rgba.convert("RGB"), (0, 0), canvas_rgba.split()[3])
        img_np = np.array(seed)

        if inpaint_mask.any():
            method = cv2.INPAINT_TELEA if inpaint_method == "telea" else cv2.INPAINT_NS
            img_bgr = img_np[:, :, ::-1].copy()
            img_bgr = cv2.inpaint(img_bgr, inpaint_mask, inpaintRadius=3, flags=method)
            img_np  = img_bgr[:, :, ::-1]

        return Image.fromarray(img_np.astype(np.uint8))

    # ══════════════════════════════════════════════════════════════════════════
    # SOLID-FILL PATH — flip → rotate → scale → pan → paste onto bg canvas
    # ══════════════════════════════════════════════════════════════════════════
    if flipH: img = ImageOps.mirror(img)
    if flipV: img = ImageOps.flip(img)

    if rotate != 0:
        img = img.rotate(-rotate, expand=True, resample=Image.LANCZOS,
                         fillcolor=bg_color)

    src_w, src_h = img.size
    if fit_mode == "crop":
        base_scale = max(canvas_w / src_w, canvas_h / src_h)
    else:
        base_scale = min(canvas_w / src_w, canvas_h / src_h)
    eff_scale    = base_scale * scale
    new_w        = max(1, round(src_w * eff_scale))
    new_h        = max(1, round(src_h * eff_scale))
    resized      = img.resize((new_w, new_h), Image.LANCZOS)

    paste_x = round((canvas_w - new_w) / 2 + ox * canvas_w)
    paste_y = round((canvas_h - new_h) / 2 + oy * canvas_h)

    # Letterbox uses the node's bg_color; crop/fill uses the editor's per-image bg
    canvas_bg = node_bg_color if fit_mode == "letterbox" else bg_color
    canvas = Image.new("RGB", (canvas_w, canvas_h), canvas_bg)
    canvas.paste(resized, (paste_x, paste_y))
    return canvas


def _generate_lasso_mask(transform: dict, source_img_size: tuple, canvas_w: int, canvas_h: int) -> Image.Image:
    """Generate a composite lasso mask from operations and apply geometric transforms.
    Returns an 'L' mode image (canvas_w × canvas_h) — 255 inside, 0 outside.
    Returns None if no lasso ops in transform."""
    ops = transform.get("lassoOps", [])
    inverted = bool(transform.get("lassoInverted", False))

    # Legacy single-polygon support
    legacy_poly = transform.get("lassoPoly")
    if legacy_poly and not ops:
        ops = [{"mode": "add", "points": legacy_poly}]

    if not ops:
        return None

    # ── Crop region dimensions (mirror _apply_crop_region) ──
    cx = float(transform.get("cx", 0.0))
    cy = float(transform.get("cy", 0.0))
    cw = float(transform.get("cw", 1.0))
    ch = float(transform.get("ch", 1.0))
    orig_w, orig_h = source_img_size
    if cx <= 0 and cy <= 0 and cw >= 1 and ch >= 1:
        crop_w, crop_h = orig_w, orig_h
    else:
        left   = max(0, min(round(cx * orig_w), orig_w - 1))
        top    = max(0, min(round(cy * orig_h), orig_h - 1))
        right  = max(left + 1, min(round((cx + cw) * orig_w), orig_w))
        bottom = max(top + 1, min(round((cy + ch) * orig_h), orig_h))
        crop_w = right - left
        crop_h = bottom - top

    # ── Replay operations onto mask ──
    mask = Image.new("L", (crop_w, crop_h), 0)
    draw = ImageDraw.Draw(mask)
    for op in ops:
        points = op.get("points", [])
        if len(points) < 3:
            continue
        mode = op.get("mode", "add")
        poly_px = [(p[0] * crop_w, p[1] * crop_h) for p in points]
        fill_val = 255 if mode == "add" else 0
        draw.polygon(poly_px, fill=fill_val)

    # ── Invert if requested ──
    if inverted:
        mask = ImageOps.invert(mask)

    # ── Geometric transforms (same as solid-fill path in _apply_crop_transform) ──
    ox     = float(transform.get("ox",     0.0))
    oy     = float(transform.get("oy",     0.0))
    scale  = float(transform.get("scale",  1.0))
    flipH  = bool(transform.get("flipH",  False))
    flipV  = bool(transform.get("flipV",  False))
    rotate = float(transform.get("rotate", 0.0))
    if scale <= 0:
        scale = 1.0

    if flipH: mask = ImageOps.mirror(mask)
    if flipV: mask = ImageOps.flip(mask)

    if rotate != 0:
        mask = mask.rotate(-rotate, expand=True, resample=Image.LANCZOS, fillcolor=0)

    src_w, src_h = mask.size
    base_scale   = min(canvas_w / src_w, canvas_h / src_h)
    eff_scale    = base_scale * scale
    new_w        = max(1, round(src_w * eff_scale))
    new_h        = max(1, round(src_h * eff_scale))
    mask         = mask.resize((new_w, new_h), Image.LANCZOS)

    paste_x = round((canvas_w - new_w) / 2 + ox * canvas_w)
    paste_y = round((canvas_h - new_h) / 2 + oy * canvas_h)

    canvas = Image.new("L", (canvas_w, canvas_h), 0)
    canvas.paste(mask, (paste_x, paste_y))
    return canvas


def _generate_mask_from_maskops(transform: dict, ref_w: int, ref_h: int) -> Image.Image:
    """Generate a mask from Mask Editor maskOps.
    Returns an 'L' mode image (ref_w × ref_h) — 0=masked(black), 255=unmasked(white).
    maskOps format: [{type: 'lasso'|'polygon'|'brush'|'fill', mode: 'add'|'sub',
                      pts: [{x,y}], r?: float, dataUrl?: str}]
    Returns None if no maskOps."""
    import base64, io as _io
    ops = transform.get("maskOps", [])
    inverted = bool(transform.get("maskInverted", False))
    if not ops:
        return None

    # Start black (nothing selected). Ops paint white (add) or black (sub).
    mask = Image.new("L", (ref_w, ref_h), 0)
    draw = ImageDraw.Draw(mask)

    for op in ops:
        mode   = op.get("mode", "add")
        otype  = op.get("type", "polygon")

        # ── Fill op: decode pre-baked mask from dataUrl ──
        if otype == "fill" and op.get("dataUrl"):
            try:
                data_url = op["dataUrl"]
                # Strip "data:image/png;base64," prefix
                header, b64data = data_url.split(",", 1)
                img_bytes = base64.b64decode(b64data)
                fill_img = Image.open(_io.BytesIO(img_bytes)).convert("L")
                # The fill canvas stores: black=masked, white=unmasked
                # But our mask convention is: white=selected/masked, black=unselected
                # So we need to INVERT: fill canvas black(0) → mask white(255)
                fill_img = ImageOps.invert(fill_img)
                fill_img = fill_img.resize((ref_w, ref_h), Image.LANCZOS)
                # Fill op is a complete mask snapshot — replace current mask
                mask = fill_img
                draw = ImageDraw.Draw(mask)
            except Exception as e:
                print(f"[MIL] Warning: failed to decode fill op dataUrl: {e}")
            continue

        pts = op.get("pts", [])
        if not pts:
            continue
        fill   = 255 if mode == "add" else 0   # add = paint white (selected), sub = erase to black

        if otype == "brush":
            r_norm = float(op.get("r", 0.01))  # normalised radius relative to image width
            r_px   = max(1, round(r_norm * ref_w))
            for p in pts:
                px, py = round(p["x"] * ref_w), round(p["y"] * ref_h)
                bbox = [px - r_px, py - r_px, px + r_px, py + r_px]
                draw.ellipse(bbox, fill=fill)
        else:
            # lasso / polygon — need at least 3 points
            if len(pts) < 3:
                continue
            poly_px = [(round(p["x"] * ref_w), round(p["y"] * ref_h)) for p in pts]
            draw.polygon(poly_px, fill=fill)

    if inverted:
        mask = ImageOps.invert(mask)

    return mask



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
                # Optional upstream images whose proportions define the output tensor canvas.
                "images": ("IMAGE",),
                # JSON list of filenames persisted in the workflow JSON.
                "image_list":   ("STRING", {"default": "[]"}),
                "fit_mode":     (["letterbox", "crop"],),
                "bg_color":     (["gray", "black", "white"],
                                 {"default": "gray"}),
                "aspect_ratio": (["none", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
                                 {"default": "none"}),
                "megapixels":   ("FLOAT", {"default": 1.0, "min": 0.1, "max": 32.0, "step": 0.1, "display": "number"}),
                "thumb_size":   (["full", "large", "medium", "small"],),  # UI-only: column count
                "double_click": (["Edit Image", "Edit Pixel", "Mask"], {"default": "Edit Image"}),
                "crop_data":    ("STRING", {"default": "{}"}),  # UI-only: per-image pan/zoom JSON
                "selected_items": ("STRING", {"default": "[]"}),  # UI-only: JSON list of selected filenames
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE",)
    RETURN_NAMES = ("image_batch", "mask_batch", "image_original",)
    FUNCTION = "load_images"
    CATEGORY = "image/loaders"
    OUTPUT_NODE = False

    @classmethod
    def IS_CHANGED(cls, images=None, image_list="[]", fit_mode="letterbox", bg_color="gray", aspect_ratio="none", megapixels=1.0, thumb_size="medium", double_click="Edit Image", crop_data="{}", selected_items="[]"):
        # Include images shape in the hash so re-execution triggers when it changes
        master_hash = ""
        if images is not None:
            master_hash = f"{images.shape}"
        return hashlib.md5((image_list + crop_data + selected_items + aspect_ratio + fit_mode + bg_color + str(megapixels) + master_hash).encode()).hexdigest()

    def load_images(self, images=None, image_list="[]", fit_mode="letterbox", bg_color="gray", aspect_ratio="none", megapixels=1.0, thumb_size="medium", double_click="Edit Image", crop_data="{}", selected_items="[]"):
        try:
            filenames = json.loads(image_list)
        except Exception:
            filenames = []

        try:
            transforms = json.loads(crop_data) if crop_data else {}
        except Exception:
            transforms = {}

        try:
            selected_filenames = json.loads(selected_items) if selected_items else []
            if not isinstance(selected_filenames, list):
                selected_filenames = []
        except Exception:
            selected_filenames = []

        filtered_filenames = []
        if selected_filenames:
            for fname in filenames:
                if fname in selected_filenames:
                    filtered_filenames.append(fname)
        else:
            # Option A: fallback to all images if selection is empty
            filtered_filenames = filenames

        placeholder_img  = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
        placeholder_mask = torch.ones((1, 64, 64), dtype=torch.float32)
        if not filtered_filenames and images is None:
            return (placeholder_img, placeholder_mask, placeholder_img)

        input_dir = Path(folder_paths.get_input_directory())
        tensors      = []
        mask_tensors = []
        orig_tensors = []   # native-resolution batch (no megapixel budget)
        orig_ref_w = orig_ref_h = None  # reference for native-res batch

        import torch.nn.functional as F
        
        # ── Upstream images override aspect_ratio when connected ───────────────
        # Extract all images from the batch tensor [B, H, W, C]
        master_canvas = None
        if images is not None:
            # images is a torch tensor [B, H, W, C]
            m_b = images.shape[0]
            m_h = images.shape[1]
            m_w = images.shape[2]
            
            orig_ref_w = m_w
            orig_ref_h = m_h
            
            # Compute the aspect ratio from the first image of the input batch
            # Scale to fit the megapixel budget while preserving proportions
            total_px = max(1, megapixels * 1_000_000)
            ratio = m_w / m_h
            c_w = max(1, round(math.sqrt(total_px * ratio)))
            c_h = max(1, round(math.sqrt(total_px / ratio)))
            master_canvas = (c_w, c_h)
            ref_w, ref_h = master_canvas
            fixed_canvas = True
            
            print(f"[MultiImageLoader] images input override: {m_w}x{m_h} → canvas {c_w}x{c_h} ({c_w*c_h/1e6:.2f} MP) setting dimensions only")
            
        # Canvas priority: images input > aspect_ratio dropdown > first loaded image
        elif aspect_ratio != "none" and bool(aspect_ratio):
            fixed_canvas = True
            ref_w, ref_h = _compute_canvas_dims(aspect_ratio, megapixels)
            print(f"[MultiImageLoader] fixed canvas {aspect_ratio}: {ref_w}x{ref_h} ({ref_w*ref_h/1e6:.2f} MP)")
        else:
            fixed_canvas = False
            ref_w = ref_h = None

        # Pre-compute target canvas dimensions based on the FIRST uploaded image in the entire batch, 
        # not the first selected image. This guarantees backend dimensions mirror frontend canvas shapes.
        first_valid_img = None
        for fname in filenames:
            fpath = input_dir / fname
            if fpath.exists():
                try:
                    img_tmp = Image.open(fpath)
                    img_tmp = ImageOps.exif_transpose(img_tmp)
                    first_valid_img = img_tmp.copy()
                    break
                except Exception:
                    pass

        if first_valid_img is not None:
            first_native_w, first_native_h = first_valid_img.size
            if orig_ref_w is None:
                if master_canvas:
                    native_mp = (first_native_w * first_native_h) / 1_000_000
                    ratio = master_canvas[0] / master_canvas[1]
                    orig_ref_w = max(1, round(math.sqrt(native_mp * 1_000_000 * ratio)))
                    orig_ref_h = max(1, round(math.sqrt(native_mp * 1_000_000 / ratio)))
                elif fixed_canvas:
                    native_mp = (first_native_w * first_native_h) / 1_000_000
                    orig_ref_w, orig_ref_h = _compute_canvas_dims(aspect_ratio, native_mp)
                else:
                    orig_ref_w = first_native_w
                    orig_ref_h = first_native_h

            if ref_w is None:
                tmp_scaled = _scale_to_megapixels(first_valid_img, megapixels)
                ref_w, ref_h = tmp_scaled.size

        for fname in filtered_filenames:
            fpath = input_dir / fname
            if not fpath.exists():
                print(f"[MultiImageLoader] Warning: file not found \u2013 {fpath}")
                continue
            try:
                img = Image.open(fpath)
                img = ImageOps.exif_transpose(img)
                img = img.convert("RGB")

                # ── Original-resolution branch (no megapixel budget) ──
                img_orig = img.copy()
                t_orig = transforms.get(fname)
                if t_orig:
                    img_orig = _apply_crop_transform(img_orig, t_orig, orig_ref_w, orig_ref_h, fit_mode=fit_mode, node_bg_color=_parse_bg_color_word(bg_color))
                elif img_orig.size != (orig_ref_w, orig_ref_h):
                    img_orig = _fit_image(img_orig, orig_ref_w, orig_ref_h, fit_mode, bg_color=_parse_bg_color_word(bg_color))
                orig_arr = np.array(img_orig).astype(np.float32) / 255.0
                orig_tensors.append(torch.from_numpy(orig_arr).unsqueeze(0))

                # ── Scaled branch (megapixel budget) ──
                img = _scale_to_megapixels(img, megapixels)
                source_size = img.size

                t = transforms.get(fname)
                # Resolve node-level bg_color word to RGB tuple
                _bg_rgb = _parse_bg_color_word(bg_color)

                if t:
                    img = _apply_crop_transform(img, t, ref_w, ref_h, fit_mode=fit_mode, node_bg_color=_bg_rgb)
                elif img.size != (ref_w, ref_h):
                    img = _fit_image(img, ref_w, ref_h, fit_mode, bg_color=_bg_rgb)

                arr = np.array(img).astype(np.float32) / 255.0
                tensors.append(torch.from_numpy(arr).unsqueeze(0))

                # ── Mask batch priority ──
                # 1st priority: dedicated Mask Editor (maskOps) → mask_batch output
                # 2nd priority: blank white mask (no mask)
                # (lassoOps remain for the alpha-cutout effect in Edit Image only)
                if t and t.get("maskOps"):
                    mask_img = _generate_mask_from_maskops(t, ref_w, ref_h)
                    if mask_img is not None:
                        mask_arr = np.array(mask_img).astype(np.float32) / 255.0
                        mask_tensors.append(torch.from_numpy(mask_arr).unsqueeze(0))
                    else:
                        mask_tensors.append(torch.ones((1, ref_h, ref_w), dtype=torch.float32))
                else:
                    mask_tensors.append(torch.ones((1, ref_h, ref_w), dtype=torch.float32))
            except Exception as e:
                print(f"[MultiImageLoader] Error loading {fname}: {e}")
                continue

        if not tensors:
            return (placeholder_img, placeholder_mask, placeholder_img)

        batch      = torch.cat(tensors, dim=0)
        mask_batch = torch.cat(mask_tensors, dim=0)
        orig_batch = torch.cat(orig_tensors, dim=0) if orig_tensors else placeholder_img
        return (batch, mask_batch, orig_batch)


# ─── Registrations ────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "MultiImageLoader": MultiImageLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MultiImageLoader": "Load Multiple Images 🖼️",
}
