import codecs
import re

path = r'c:\AI\ComfyUI_windows_portable\ComfyUI\custom_nodes\ComfyUI-Multi-Image-Loader\web\load_images_in_grid.js'
try:
    text = codecs.open(path, 'r', 'utf-8').read()
    
    # Replace getThumbCols logic which uses szKey and THUMB_COLS
    new_getThumbCols = '''function getThumbCols() {
    return node.widgets?.find((w) => w.name === "grid_columns")?.value ?? 3;
  }'''
    
    text = re.sub(r'function getThumbCols\b[^{]*\{[^}]+\}', new_getThumbCols, text)
    
    codecs.open(path, 'w', 'utf-8').write(text)
    print("Force replaced getThumbCols")
except Exception as e:
    print("Error:", e)
