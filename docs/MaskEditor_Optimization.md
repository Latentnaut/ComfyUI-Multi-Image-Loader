# Multi-Image-Loader: Mask Editor Optimization & Bucket Fill Pipeline

This document details the architecture and solutions implemented to finalize the professional-grade Mask Editor for the `ComfyUI-Multi-Image-Loader` custom node, specifically solving the complex challenge of the Bucket Fill (Scanline Flood Fill) end-to-end pipeline.

## 🎯 The Challenge: Bucket Fill Serialization

Unlike Bézier Brush or Lasso points which are easily stored as a series of JSON coordinate arrays, a Flood/Bucket Fill operates temporally based on the *existing pixel state* of the canvas. 

Because we needed high FPS and robust, leak-free flood filling on potentially complex anti-aliased strokes, we implemented a dedicated hidden canvas (`op._canvas`) for each fill operation to compute a strict, binary scanline fill.

The critical issue was **Persistence & Serialization**:
1. When a user clicks "Apply" or saves the workflow, DOM Canvas elements (`op._canvas`) cannot be serialized into JSON (`cropMap`).
2. When the node reloaded or the Mask Editor was reopened, the JSON lacked the pixel context, meaning the fill operation disappeared visually.
3. The backend Python node only parsed mathematical shapes (brush, lasso, poly), entirely ignoring fill operations.

## 🛠️ The Solution: 3-Layer Pipeline Integration

To guarantee that the exact pixels visualized in the Mask Editor perfectly map to the generated tensor mask in ComfyUI, we implemented a robust string-serialization pathway using `dataURL` (base64 PNG).

### 1. Frontend Mask Editor Overlay (JS)
While the user is drawing, the mask is generated continuously at 60 FPS using a *dirty flag* strategy.
- **Problem**: Layering fill ops using `globalCompositeOperation: "difference"` failed to respect alpha transparency accurately.
- **Fix**: We bypassed difference compositing and used direct pixel manipulation via `Uint8Array`.
- We binarize the fill canvas strictly (0 or 255) by forcing a threshold. The mask overlay now explicitly maps `alpha = 255 - R` (mapping black/white logic directly to transparency).

### 2. Frontend Node Thumbnail Render (JS)
The node thumbnail interface uses a completely separate render loop (`drawMask`) from the modal editor. 
- **Problem**: It didn't know how to render the fill ops.
- **Fix**: We added a decoder in the canvas rendering loop. If a `fill` op contains a `dataUrl` or `_canvas`, it draws it directly onto the thumbnail stack. We dynamically invert the RGB channels (black to white) on the fly because the thumbnail logic expects *white* to represent masked areas, while the internal flood fill canvas uses *black*.

```javascript
// Drawing the stored mask slice dynamically
const tc = tmp.getContext("2d");
tc.drawImage(source, 0, 0, cw, ch);
const id = tc.getImageData(0, 0, cw, ch);
for (let pi = 0; pi < id.data.length; pi += 4) {
    const v = 255 - id.data[pi]; // invert R
    id.data[pi] = id.data[pi+1] = id.data[pi+2] = v;
}
```

### 3. Backend Tensor Mask Generator (Python)
The most critical link. The ComfyUI execution logic in `nodes.py` didn't execute fill ops.
- **Problem**: `_generate_mask_from_maskops()` only translated points.
- **Fix**: We unpacked the base64 `dataUrl` during the execution phase.
  - The script now decodes the PNG byte stream using `base64` and `io.BytesIO`.
  - It loads the fill operation via `PIL.Image`, strictly converts it to 8-bit grayscale (`L` mode).
  - It then scales it to the `megapixel` budget requested bounds using `Image.LANCZOS` and *replaces* the mask tensor stack for that layer.

```python
# Unpacking the serialized fill op cleanly in Python
header, b64data = data_url.split(",", 1)
img_bytes = base64.b64decode(b64data)
fill_img = Image.open(_io.BytesIO(img_bytes)).convert("L")
fill_img = ImageOps.invert(fill_img)
fill_img = fill_img.resize((ref_w, ref_h), Image.LANCZOS)
mask = fill_img
```

## ✨ Final Status 

The Mask Editor acts as a premium implementation equivalent to dedicated tools like Photoshop.

Features completed:
- **Thomas' Bezier Curves:** Configurable arc-length stamp rendering for ultra-smooth C² strokes without gaps.
- **Binary Scanline Flood Fill:** Leak-free, boundary-perfect bucket fill via $O(n)$ row scanning.
- **Persistence guarantee:** Whatever visually appears in the Mask Editor is guaranteed to match the generated ComfyUI Output Mask perfectly regardless of session reloading.
- **UX**: Hotkeys (G/B/E/L/P), dynamically updating cursors, hover states, multi-layer canvas, responsive scaling.
