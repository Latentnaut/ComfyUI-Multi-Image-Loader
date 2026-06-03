import torch

class FromBatchToGrid:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE",),
                "columns": ("INT", {"default": 3, "min": 1, "max": 64}),
                "rows": ("INT", {"default": 3, "min": 1, "max": 64}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "make_grid"
    CATEGORY = "Latentnaut/Image"

    def make_grid(self, images, columns, rows):
        B, H, W, C = images.shape
        grid_size = columns * rows
        
        num_grids = (B + grid_size - 1) // grid_size
        
        out_images = []
        for n in range(num_grids):
            # Create a black canvas (all zeros)
            canvas = torch.zeros((H * rows, W * columns, C), dtype=images.dtype, device=images.device)
            for r in range(rows):
                for c in range(columns):
                    i = n * grid_size + r * columns + c
                    if i < B:
                        canvas[r * H:(r + 1) * H, c * W:(c + 1) * W, :] = images[i]
            out_images.append(canvas)
            
        return (torch.stack(out_images),)
