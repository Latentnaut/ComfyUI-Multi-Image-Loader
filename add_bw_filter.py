import os
import codecs

FILES = [
    r'web\_pixel_tools_block.txt',
    r'web\multi_image_loader.js',
    r'web\load_images_in_grid.js',
    r'm_modal.js',
    r'l_modal.js'
]

filter_code = '''    secPixels.appendChild(mkSec("Filtros", () => {
    }, ""));
    const ptFilterRow = document.createElement("div");
    ptFilterRow.style.cssText = `display:flex;gap:${_gap5};flex-wrap:wrap;`;
    const ptBwBtn = document.createElement("button");
    ptBwBtn.textContent = "⚫ B&W";
    ptBwBtn.title = "Apply Black & White filter";
    ptBwBtn.style.cssText = `flex:1 1 calc(50% - 4px);background:#1e1e1e;color:#aaa;border:1px solid #3a3a3a;border-radius:${_r5};padding:${_btnPad};font-size:${_fs11};cursor:pointer;transition:background .12s;`;
    ptBwBtn.addEventListener("mouseenter", () => { ptBwBtn.style.background="#2a2a2a"; ptBwBtn.style.borderColor="#555"; });
    ptBwBtn.addEventListener("mouseleave", () => { ptBwBtn.style.background="#1e1e1e"; ptBwBtn.style.borderColor="#3a3a3a"; });
    ptBwBtn.addEventListener("click", () => _edApplyGrayscale());
    ptFilterRow.appendChild(ptBwBtn);
    secPixels.appendChild(ptFilterRow);
'''

apply_code = '''    // ── Apply Grayscale Filter ──────────────────────────────────
    function _edApplyGrayscale() {
      _edEnsureEditsPx(); _edSaveUndo();
      const pw = _edCvsEditsPx.width, ph = _edCvsEditsPx.height;
      const ctx = _edCvsEditsPx.getContext("2d", { willReadFrequently: true });
      const imgData = ctx.getImageData(0, 0, pw, ph);
      const d = imgData.data;

      let lMskData = null;
      if (typeof edLassoOps !== 'undefined' && edLassoOps.length > 0) {
          const lMsk = buildLassoMaskCanvas(pw, ph);
          lMskData = lMsk.getContext("2d", {willReadFrequently: true}).getImageData(0, 0, pw, ph).data;
      }
      
      for (let i = 0; i < d.length; i += 4) {
          let apply = true;
          if (lMskData) {
               apply = (lMskData[i + 3] > 0);
          }
          if (apply) {
              const avg = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
              d[i] = avg; d[i+1] = avg; d[i+2] = avg;
          }
      }
      ctx.putImageData(imgData, 0, 0);
      redraw();
    }

'''

for f in FILES:
    if not os.path.exists(f): 
        print(f"Skipped {f} (does not exist)")
        continue
    text = codecs.open(f, 'r', 'utf-8').read()
    
    if "Filtros" in text:
        print(f"{f} already patched")
        continue

    # 1. Insert UI
    target_ui = 'ptToolRow.appendChild(ptCABtn);\\n    secPixels.appendChild(ptToolRow);'
    text = text.replace(target_ui, target_ui + '\\n\\n' + filter_code)
    
    # 2. Insert function
    target_fn = '    // ── Reset All button ─────────────────────────────────────────\\n    const resetAllB = document.createElement("button");'
    text = text.replace(target_fn, apply_code + target_fn)
        
    codecs.open(f, 'w', 'utf-8').write(text)
    print(f"Patched {f}")
