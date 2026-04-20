import codecs
import re

path = r'c:\AI\ComfyUI_windows_portable\ComfyUI\custom_nodes\ComfyUI-Multi-Image-Loader\nodes.py'
try:
    text = codecs.open(path, 'r', 'utf-8').read()
    
    new_class = '''class LoadImagesInGrid(MultiImageLoader):
    
    @classmethod
    def INPUT_TYPES(cls):
        inputs = MultiImageLoader.INPUT_TYPES()
        import copy
        inputs = copy.deepcopy(inputs)
        
        if "thumb_size" in inputs["optional"]:
            del inputs["optional"]["thumb_size"]
            
        inputs["optional"]["grid_columns"] = ("INT", {"default": 3, "min": 1, "max": 10, "step": 1, "display": "number"})
        inputs["optional"]["grid_rows"]    = ("INT", {"default": 3, "min": 1, "max": 10, "step": 1, "display": "number"})
        return inputs

    RETURN_TYPES = ("IMAGE", "IMAGE",)
    RETURN_NAMES = ("grid_image", "grid_hires",)
    FUNCTION = "compose_grid"
    CATEGORY = "image/loaders"
    
    @classmethod
    def IS_CHANGED(cls, images=None, image_list="[]", fit_mode="letterbox", bg_color="gray", aspect_ratio="none", megapixels=1.0, grid_columns=3, grid_rows=3, double_click="Edit Image", crop_data="{}", selected_items="[]"):
        master_hash = ""
        if images is not None:
            master_hash = f"{images.shape}"
        import hashlib
        return hashlib.md5((image_list + crop_data + selected_items + aspect_ratio + fit_mode + bg_color + str(megapixels) + str(grid_columns) + str(grid_rows) + master_hash).encode()).hexdigest()

    def compose_grid(self, images=None, image_list="[]", fit_mode="letterbox", bg_color="gray", aspect_ratio="none", megapixels=1.0, grid_columns=3, grid_rows=3, double_click="Edit Image", crop_data="{}", selected_items="[]"):
        batch, mask_batch, orig_batch = self.load_images(
            images=images, 
            image_list=image_list, 
            fit_mode=fit_mode, 
            bg_color=bg_color, 
            aspect_ratio=aspect_ratio, 
            megapixels=megapixels, 
            thumb_size="medium", 
            double_click=double_click, 
            crop_data=crop_data, 
            selected_items=selected_items
        )
        
        grid_image = self._make_grid(batch, grid_rows, grid_columns)
        grid_hires = self._make_grid(orig_batch, grid_rows, grid_columns)
        
        return (grid_image, grid_hires)

    def _make_grid(self, batch, rows, cols):
        import torch
        B, H, W, C = batch.shape
        max_images = rows * cols
        
        batch = batch[:max_images]
        actual_b = batch.shape[0]
        
        if actual_b < max_images:
            padding = torch.zeros((max_images - actual_b, H, W, C), dtype=batch.dtype, device=batch.device)
            batch = torch.cat([batch, padding], dim=0)
            
        # batch represents items in visually row-major order: row 1 (left to right), row 2, etc.
        # we want to reshape it into a single image.
        batch = batch.view(rows, cols, H, W, C)
        # Permute to (rows, H, cols, W, C)
        batch = batch.permute(0, 2, 1, 3, 4)
        # Reshape to (rows*H, cols*W, C)
        grid = batch.reshape(1, rows * H, cols * W, C)
        return grid'''
    
    text = re.sub(r'class LoadImagesInGrid\(MultiImageLoader\):\s+pass', new_class, text)
    codecs.open(path, 'w', 'utf-8').write(text)
    print("Done")
except Exception as e:
    print("Error:", e)
