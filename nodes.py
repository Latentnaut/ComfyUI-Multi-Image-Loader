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

class MultiImageLoader:
    """
    Loads multiple images uploaded directly in the UI (no folder needed).
    Images are uploaded via a drag-and-drop / file-picker widget injected
    by the companion JavaScript extension.

    Outputs a single IMAGE batch tensor  [B, H, W, C]  where all images are
    resized to match the first image's dimensions when sizes differ.
    """

    UPLOADED_FILES_KEY = "image_list"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                # JSON list of filenames persisted in the workflow JSON.
                # Must be in 'optional' (NOT 'hidden') so LiteGraph creates a
                # real widget and saves it in widgets_values for persistence.
                "image_list": ("STRING", {"default": "[]"}),
                "resize_mode": (["resize_to_first", "none"],),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image_batch",)
    FUNCTION = "load_images"
    CATEGORY = "image/loaders"
    OUTPUT_NODE = False

    @classmethod
    def IS_CHANGED(cls, image_list="[]", resize_mode="resize_to_first"):
        # Re-run whenever the file list changes
        return hashlib.md5(image_list.encode()).hexdigest()

    def load_images(self, image_list="[]", resize_mode="resize_to_first"):
        try:
            filenames = json.loads(image_list)
        except Exception:
            filenames = []

        if not filenames:
            # Return a 1×64×64 black placeholder so the node never hard-crashes
            placeholder = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
            return (placeholder,)

        input_dir = Path(folder_paths.get_input_directory())
        tensors = []
        reference_size = None  # (W, H) of the first loaded image

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
                    reference_size = img.size  # (W, H)
                elif resize_mode == "resize_to_first" and img.size != reference_size:
                    img = img.resize(reference_size, Image.LANCZOS)

                arr = np.array(img).astype(np.float32) / 255.0  # H×W×C  in [0,1]
                tensors.append(torch.from_numpy(arr).unsqueeze(0))  # 1×H×W×C
            except Exception as e:
                print(f"[MultiImageLoader] Error loading {fname}: {e}")
                continue

        if not tensors:
            placeholder = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
            return (placeholder,)

        batch = torch.cat(tensors, dim=0)  # B×H×W×C
        return (batch,)


# ─── Registrations ────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "MultiImageLoader": MultiImageLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MultiImageLoader": "Load Multiple Images 🖼️",
}
