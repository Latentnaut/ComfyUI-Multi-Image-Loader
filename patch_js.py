import codecs
import re

path = r'c:\AI\ComfyUI_windows_portable\ComfyUI\custom_nodes\ComfyUI-Multi-Image-Loader\web\load_images_in_grid.js'
try:
    text = codecs.open(path, 'r', 'utf-8').read()
    
    # Remove THUMB_COLS
    text = re.sub(r'const THUMB_COLS\s*=\s*\{[^}]+\};\s*', '', text)
    
    # Replace getThumbCols logic
    old_getThumbCols = '''  function getThumbCols() {
    const szKey = node.widgets?.find((ww) => ww.name === "thumb_size")?.value ?? "medium";
    return THUMB_COLS[szKey] ?? 4;
  }'''
    
    new_getThumbCols = '''  function getThumbCols() {
    return node.widgets?.find((ww) => ww.name === "grid_columns")?.value ?? 3;
  }'''
    text = text.replace(old_getThumbCols, new_getThumbCols)
    
    # Replace the widget listener assignment
    text = text.replace('node.widgets?.find((w) => w.name === "thumb_size");', 'node.widgets?.find((w) => w.name === "grid_columns");')
    
    # Also fix comments just to be clean
    text = text.replace('thumb_size preset', 'grid_columns preset')
    text = text.replace('thumb_size now controls', 'grid_columns now controls')
    text = text.replace('driven by thumb_size', 'driven by grid_columns')
    
    codecs.open(path, 'w', 'utf-8').write(text)
    print("Done frontend script patch")
except Exception as e:
    print("Error:", e)
