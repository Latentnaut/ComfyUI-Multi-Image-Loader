function openCropEditor(startIdx, skipAnim, initialMode) {
    let edPanelMode = initialMode || "edit";  // "edit" | "pixels"
    // session crops: edits made during this dialog, committed only on Apply
    const ses = {};
    for (const fn in cropMap) ses[fn] = { ...cropMap[fn] };
    let curIdx = startIdx;

    // per-image display state
    let edImg = null, edNatW = 1, edNatH = 1;
    let edRefW = 1, edRefH = 1;  // reference canvas = first-image dims
    let dOX = 0, dOY = 0, edScale = 1.0;
    let edFlipH = false, edFlipV = false, edRotate = 0;  // intrinsic transforms
    let edBg = getEffectiveBgColor();  // initialize from node bg_color widget
    let edInpaintPreview = null, edInpaintDirty = true, edReqHandle = null;
    const edPreviewCache = new Map();
    let frameW = 300, frameH = 300, frameCX = 0, frameCY = 0, bFit = 1;
    let rafId = null, panSt = null;
    // Snap guide state — which guides are active (drawn during pan)
    let _snapGuides = { cx: false, cy: false, L: false, R: false, T: false, B: false };
    let edCropMode = false, edCropBox = null;
    let edCropDrag = null;
    let edAppliedCrop = null; // committed crop {cx,cy,cw,ch} — applied BEFORE transforms

    // Lasso state
    let edLassoMode = false;
    let edLassoTool = "freehand";
    let edLassoOps = [];
    let edLassoInverted = false;
    let edLassoCurrentPts = [];
    let edLassoDrawing = false;
    let edLassoAntsOffset = 0;
    let edLassoAntsRaf = null;
    let _lassoOverlayCvs = null;
    let _lassoOverlayBg = null;
    let _lassoMaskDirty = true;
    let _lassoCursorNorm = null;
    // Cached mask + edge data for performance
    let _cachedMaskCvs = null;
    let _cachedMaskW = 0, _cachedMaskH = 0;
    let _cachedEdgePixels = null; // Int32Array [x0,y0, x1,y1, ...]
    // Custom lasso cursors (crosshair with +/- modifiers)
    const _lassoCursors = (() => {
      const mk = (extra) => {
        const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'><line x1='16' y1='2' x2='16' y2='30' stroke='white' stroke-width='2'/><line x1='2' y1='16' x2='30' y2='16' stroke='white' stroke-width='2'/><line x1='16' y1='2' x2='16' y2='30' stroke='black' stroke-width='1'/><line x1='2' y1='16' x2='30' y2='16' stroke='black' stroke-width='1'/>${extra}</svg>`;
        return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, crosshair`;
      };
      return {
        normal: 'crosshair',
        add:      mk(`<circle cx='24' cy='8' r='6' fill='#44cc88' stroke='white' stroke-width='1'/><line x1='24' y1='4' x2='24' y2='12' stroke='white' stroke-width='1.5'/><line x1='20' y1='8' x2='28' y2='8' stroke='white' stroke-width='1.5'/>`)  ,
        subtract: mk(`<circle cx='24' cy='8' r='6' fill='#ff6666' stroke='white' stroke-width='1'/><line x1='20' y1='8' x2='28' y2='8' stroke='white' stroke-width='1.5'/>`),
      };
    })();

    // ── UI scale: gentle bump for wide viewports ───────────────────────
    // The OS DPI scaling already makes text/buttons readable at native resolution.
    // We only apply a *subtle* scale-up when the CSS viewport is significantly
    // wider than 1080p, so controls don't look disproportionately tiny relative
    // to the larger dialog. Uses sqrt for diminishing returns + cap at 1.3×.
    //   1080p (1920 CSS px) → 1.0    |   1440p (2560) → 1.15
    //   4K@150% (~2560)     → 1.15   |   5K@150% (~3413) → 1.3
    const _vpW = window.innerWidth || 1920;
    const uiScale = Math.min(1.3, Math.max(1.0, Math.sqrt(_vpW / 1920)));

    // Derived sizes (all scale with uiScale)
    const _pnlW    = Math.round(168 * uiScale);   // sidebar width px
    const _fs10    = `${(10 * uiScale).toFixed(1)}px`;  // small text
    const _fs11    = `${(11 * uiScale).toFixed(1)}px`;
    const _fs12    = `${(12 * uiScale).toFixed(1)}px`;
    const _fs13    = `${(13 * uiScale).toFixed(1)}px`;
    const _pad4    = `${Math.round(4  * uiScale)}px`;
    const _pad8    = `${Math.round(8  * uiScale)}px`;
    const _pad10   = `${Math.round(10 * uiScale)}px`;
    const _pad12   = `${Math.round(12 * uiScale)}px`;
    const _gap5    = `${Math.round(5  * uiScale)}px`;
    const _gap8    = `${Math.round(8  * uiScale)}px`;
    const _btnPad  = `${Math.round(5  * uiScale)}px ${Math.round(12 * uiScale)}px`;
    const _btnPadW = `${Math.round(7  * uiScale)}px`;
    const _r5      = `${Math.round(5  * uiScale)}px`;
    const _r6      = `${Math.round(6  * uiScale)}px`;
    const _r12     = `${Math.round(12 * uiScale)}px`;

    // ── overlay ───────────────────────────────────────────────
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;font-family:-apple-system,sans-serif;";
    const dlg = document.createElement("div");
    if (!skipAnim) dlg.className = "mil-crop-enter";
    // Use clamp() so modal grows with the viewport but caps generously.
    // On 5K: 90vw ≈ 4608px wide, 88vh ≈ 2534px tall — plenty of real estate.
    dlg.style.cssText = `position:relative;width:clamp(700px,90vw,1920px);height:clamp(480px,88vh,1200px);background:#181818;border-radius:${_r12};border:1px solid #333;box-shadow:0 24px 80px rgba(0,0,0,0.8);display:flex;flex-direction:column;overflow:hidden;`;

    // ── header ───────────────────────────────────────────────
    const hdr = document.createElement("div");
    hdr.style.cssText = `flex-shrink:0;display:flex;align-items:center;gap:${_gap8};padding:${_pad8} ${_pad12};background:#111;border-bottom:1px solid #2a2a2a;`;
    function mkB(t, col) {
      const b = document.createElement("button");
      b.textContent = t;
      b.style.cssText = `background:#222;color:${col||"#bbb"};border:1px solid #3a3a3a;border-radius:${_r5};padding:${_btnPad};font-size:${_fs11};cursor:pointer;`;
      b.addEventListener("mouseenter", () => { b.style.background="#2e2e2e"; b.style.borderColor="#555"; });
      b.addEventListener("mouseleave", () => { b.style.background="#222"; b.style.borderColor="#3a3a3a"; });
      return b;
    }
    // ── Mode switcher tabs (left of title) ──
    function mkTab(label, active, accent) {
      const ac = accent || "#7ab0ff";
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = `background:${active?"#2a2a2a":"transparent"};color:${active?"#ccc":"#555"};border:1px solid ${active?"#444":"transparent"};border-bottom:${active?`2px solid ${ac}`:"2px solid transparent"};border-radius:${Math.round(4*uiScale)}px ${Math.round(4*uiScale)}px 0 0;padding:${Math.round(4*uiScale)}px ${Math.round(9*uiScale)}px;font-size:${_fs11};cursor:pointer;transition:color .15s,border-color .15s;margin-bottom:-1px;`;
      b.addEventListener("mouseenter", () => { if (!b._tabActive) b.style.color = "#999"; });
      b.addEventListener("mouseleave", () => { if (!b._tabActive) b.style.color = "#555"; });
      b._tabActive = active;
      b._tabAccent = ac;
      return b;
    }
    function setTabActive(tab, active) {
      tab._tabActive = active;
      const ac = tab._tabAccent || "#7ab0ff";
      tab.style.background = active ? "#2a2a2a" : "transparent";
      tab.style.color = active ? "#ccc" : "#555";
      tab.style.border = `1px solid ${active ? "#444" : "transparent"}`;
      tab.style.borderBottom = active ? `2px solid ${ac}` : "2px solid transparent";
    }
    const tabEdit = mkTab("\u270F Edit Image", edPanelMode === "edit", "#7ab0ff");
    const tabPixels = mkTab("\uD83C\uDFA8 Edit Pixels", edPanelMode === "pixels", "#ffaa44");
    const tabMask = mkTab("\u25D0 Mask", false, "#7fff7f");
    tabEdit.addEventListener("click", () => switchPanelMode("edit"));
    tabPixels.addEventListener("click", () => switchPanelMode("pixels"));
    tabMask.addEventListener("click", () => {
      // Auto-apply current edits so Mask Editor sees the processed image
      doApply();
      openMaskEditor(curIdx, true);
    });
    hdr.appendChild(tabEdit);
    hdr.appendChild(tabPixels);
    hdr.appendChild(tabMask);

    const hdrSpacer = document.createElement("span"); hdrSpacer.style.flex = "1";
    const prevB = mkB("\u2190 Prev"); const cntEl = document.createElement("span");
    cntEl.style.cssText = `color:#555;font-size:${_fs11};min-width:${Math.round(52*uiScale)}px;text-align:center;`;
    const nextB = mkB("Next \u2192");
    hdr.appendChild(hdrSpacer); hdr.appendChild(prevB); hdr.appendChild(cntEl);
    hdr.appendChild(nextB);

    // ── body ────────────────────────────────────────────────
    const body = document.createElement("div");
    body.style.cssText = "flex:1;display:flex;min-height:0;";

    // left panel — outer shell
    const pnl = document.createElement("div");
    pnl.style.cssText = `width:${_pnlW}px;flex-shrink:0;background:#111;border-right:1px solid #222;display:flex;flex-direction:column;`;
    // scrollable controls body
    const pnlBody = document.createElement("div");
    pnlBody.style.cssText = `flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:${_pad12} ${_pad10};display:flex;flex-direction:column;gap:${_gap5};`;
    // sticky footer: zoom label + Apply + Cancel
    const pnlFoot = document.createElement("div");
    pnlFoot.style.cssText = `flex-shrink:0;padding:${_pad4} ${_pad10} ${_pad8};border-top:1px solid #222;display:flex;flex-direction:column;gap:${_gap5};`;
    function mkSec(t, resetCb, resetTip) {
      const d = document.createElement("div");
      d.style.cssText = `color:#444;font-size:${_fs10};text-transform:uppercase;letter-spacing:1px;margin-top:${_gap5};display:flex;align-items:center;justify-content:space-between;`;
      const lbl = document.createElement("span"); lbl.textContent = t; d.appendChild(lbl);
      if (resetCb) {
        const rb = document.createElement("button");
        rb.title = resetTip || ("Reset " + t);
        rb.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.36"/></svg>`;
        rb.style.cssText = `background:none;border:none;cursor:pointer;color:#383838;padding:1px 2px;border-radius:3px;display:flex;align-items:center;transition:color 0.15s;flex-shrink:0;`;
        rb.addEventListener("mouseenter", () => { rb.style.color = "#ff9f43"; });
        rb.addEventListener("mouseleave", () => { rb.style.color = "#383838"; });
        rb.addEventListener("click", (e) => { e.stopPropagation(); resetCb(); redraw(); requestInpaintPreview(); });
        d.appendChild(rb);
      }
      return d;
    }
    const zoomLbl = document.createElement("div");
    zoomLbl.style.cssText = `color:#666;font-size:${_fs10};text-align:center;padding:1px 0;`;
    function mkPB(label, cb) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = `background:#1e1e1e;color:#aaa;border:1px solid #333;border-radius:${_r5};padding:${_btnPadW} ${_pad8};font-size:${_fs11};cursor:pointer;text-align:left;width:100%;`;
      b.addEventListener("mouseenter", () => { b.style.background="#2a2a2a"; b.style.borderColor="#484848"; });
      b.addEventListener("mouseleave", () => { b.style.background="#1e1e1e"; b.style.borderColor="#333"; });
      b.addEventListener("click", () => { cb(); redraw(); requestInpaintPreview(); });
      return b;
    }
    const spacer = document.createElement("div"); spacer.style.flex = "1";
    const applyB = document.createElement("button");
    applyB.textContent = "\u2713 Apply Edit";
    applyB.style.cssText = `background:#1a3a28;color:#44cc88;border:1px solid #336644;border-radius:${_r6};padding:${_btnPadW};font-size:${_fs12};font-weight:600;cursor:pointer;width:100%;`;
    applyB.addEventListener("mouseenter", () => { applyB.style.background="#225540"; applyB.style.borderColor="#44cc88"; });
    applyB.addEventListener("mouseleave", () => { applyB.style.background="#1a3a28"; applyB.style.borderColor="#336644"; });
    const cancelB = document.createElement("button");
    cancelB.textContent = "\u2715 Cancel";
    cancelB.style.cssText = `background:#2a2a2a;color:#aaa;border:1px solid #444;border-radius:${_r6};padding:${_btnPadW};font-size:${_fs12};cursor:pointer;width:100%;`;
    cancelB.addEventListener("mouseenter", () => { cancelB.style.background="#3a2020"; cancelB.style.color="#ff8888"; cancelB.style.borderColor="#553333"; });
    cancelB.addEventListener("mouseleave", () => { cancelB.style.background="#2a2a2a"; cancelB.style.color="#aaa"; cancelB.style.borderColor="#444"; });
    // ── Panel containers for mode switching ──────────────────────
    const secEdit = document.createElement("div");
    secEdit.style.cssText = `display:flex;flex-direction:column;gap:${_gap5};`;
    const secPixels = document.createElement("div");
    secPixels.style.cssText = `display:${edPanelMode==="pixels"?"flex":"none"};flex-direction:column;gap:${_gap5};`;
    if (edPanelMode === "pixels") secEdit.style.display = "none";
    pnlBody.appendChild(secEdit);
    pnlBody.appendChild(secPixels);

    function switchPanelMode(mode) {
      if (edPanelMode === mode) return;
      edPanelMode = mode;
      setTabActive(tabEdit, mode === "edit");
      setTabActive(tabPixels, mode === "pixels");
      secEdit.style.display = mode === "edit" ? "flex" : "none";
      secPixels.style.display = mode === "pixels" ? "flex" : "none";
      // Deactivate pixel tools when switching out
      if (mode !== "pixels" && edPixelTool) {
        edPixelTool = null; _syncPixelToolUI();
        ca.style.cursor = "grab"; hint.textContent = "Drag to pan \u00b7 Scroll to zoom";
      }
      // Deactivate crop/lasso when switching to pixels
      if (mode === "pixels") {
        if (edCropMode) { edCropMode = false; syncCropToggle(); }
        if (edLassoMode) { edLassoMode = false; edLassoDrawing = false; edLassoCurrentPts = []; stopLassoAnts(); syncLassoToggle(); }
        _updatePxDimLbl();
      }
      redraw();
    }

    // ── Image Dimensions ─────────────────────────────────────────
    secEdit.appendChild(mkSec("Image"));
    const dimOrigLbl = document.createElement("div");
    dimOrigLbl.style.cssText = `color:#555;font-size:${_fs10};text-align:center;`;
    const dimEffLbl = document.createElement("div");
    dimEffLbl.style.cssText = `color:#888;font-size:${_fs10};text-align:center;font-weight:600;`;
    function updateDimLabels() {
      dimOrigLbl.textContent = `Original: ${edNatW} × ${edNatH}`;
      if (edAppliedCrop) {
        const cw = Math.round(edAppliedCrop.cw * edNatW), ch = Math.round(edAppliedCrop.ch * edNatH);
        dimEffLbl.textContent = `Cropped: ${cw} × ${ch}`;
        dimEffLbl.style.color = '#d5ff6b';
      } else {
        dimEffLbl.textContent = `${edNatW} × ${edNatH}`;
        dimEffLbl.style.color = '#888';
      }
    }
    secEdit.appendChild(dimOrigLbl);
    secEdit.appendChild(dimEffLbl);

    // ── Crop Region (first step) ─────────────────────────────────
    secEdit.appendChild(mkSec("Crop Region", () => {
      edCropBox = null; edAppliedCrop = null; edCropMode = false;
      edLassoOps = []; edLassoInverted = false; _lassoMaskDirty = true;
      dOX = 0; dOY = 0; edScale = 1.0;
      syncCropToggle(); updateDimLabels(); updateCropInfoLbl();
      syncCvs(); updLbl();
    }, "Reset Crop Region"));
    const cropToggleB = document.createElement("button");
    cropToggleB.textContent = "\u2702 Enable Crop";
    cropToggleB.style.cssText = `background:#1e1e1e;color:#aaa;border:1px solid #333;border-radius:${_r5};padding:${_btnPadW} ${_pad8};font-size:${_fs11};cursor:pointer;text-align:left;width:100%;transition:background 0.15s,border-color 0.15s,color 0.15s;`;
    function syncCropToggle() {
      if (edCropMode) {
        cropToggleB.textContent = "\u2702 Crop ON";
        cropToggleB.style.background = "#1a3a28"; cropToggleB.style.color = "#44cc88"; cropToggleB.style.borderColor = "#336644";
        cropApplyB.style.background = "#1a3a28"; cropApplyB.style.color = "#44cc88"; cropApplyB.style.borderColor = "#336644";
        ca.style.cursor = "crosshair";
        hint.textContent = "Draw to crop \u00b7 Drag edges to resize \u00b7 Scroll to zoom";
      } else {
        cropToggleB.textContent = "\u2702 Enable Crop";
        cropToggleB.style.background = "#1e1e1e"; cropToggleB.style.color = "#aaa"; cropToggleB.style.borderColor = "#333";
        cropApplyB.style.background = "#2a2a2a"; cropApplyB.style.color = "#555"; cropApplyB.style.borderColor = "#333";
        if (!edLassoMode) {
          ca.style.cursor = "grab";
          hint.textContent = "Drag to pan \u00b7 Scroll to zoom";
        }
      }
    }
    // Pixel-panel lasso buttons (declared late, referenced here via closure)
    let pxLassoFreehandB = null, pxLassoPolyB = null;

    function syncLassoToggle() {
      // OFF state for both buttons
      const offS = {bg:'#1e1e1e',col:'#aaa',bc:'#333'};
      const onFree = {bg:'#3a2a1a',col:'#ff9f43',bc:'#664422'};
      const onPoly = {bg:'#3a2a1a',col:'#ff9f43',bc:'#664422'};
      const applyStyle = (btn, s) => { if (!btn) return; btn.style.background=s.bg; btn.style.color=s.col; btn.style.borderColor=s.bc; };
      if (edLassoMode) {
        const f = edLassoTool==="freehand" ? onFree : offS;
        const p = edLassoTool==="polygonal" ? onPoly : offS;
        applyStyle(lassoFreehandB, f); applyStyle(lassoPolyB, p);
        applyStyle(pxLassoFreehandB, f); applyStyle(pxLassoPolyB, p);
        ca.style.cursor = "crosshair";
        hint.textContent = edLassoTool === "freehand" ? "Drag to draw \u00b7 Shift: add \u00b7 Alt: subtract" : "Click vertices \u00b7 Close near start / dblclick \u00b7 Shift: add \u00b7 Alt: subtract";
      } else {
        applyStyle(lassoFreehandB, offS); applyStyle(lassoPolyB, offS);
        applyStyle(pxLassoFreehandB, offS); applyStyle(pxLassoPolyB, offS);
        if (!edCropMode) {
          ca.style.cursor = edPixelTool ? "none" : "grab";
          if (!edPixelTool) hint.textContent = "Drag to pan \u00b7 Scroll to zoom";
        }
      }
    }

    // ── helpers ──
    function _gcd(a, b) { a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b)); while (b) { [a, b] = [b, a % b]; } return a || 1; }
    function _simplifyAR(w, h) { const g = _gcd(w, h); return `${w / g}:${h / g}`; }
    let edCropArLock = true; // AR constraint starts ON

    function parseCropAR() {
      if (!edCropArLock) return null;
      const v = cropArInput.value.trim().toLowerCase();
      if (!v || v === 'free' || v === 'none') return null;
      const m = v.match(/^(\d+(?:\.\d+)?)\s*[:x\/]\s*(\d+(?:\.\d+)?)$/);
      if (m) { const w = parseFloat(m[1]), h = parseFloat(m[2]); if (w > 0 && h > 0) return w / h; }
      const n = parseFloat(v);
      if (n > 0 && isFinite(n)) return n;
      return null;
    }

    /** Refit the current crop box to match a new AR, keeping center and area */
    function refitCropBoxToAR() {
      if (!edCropBox) return;
      const ar = parseCropAR();
      if (!ar) return;
      const eW = effNatW(), eH = effNatH();
      const cxCenter = edCropBox.x + edCropBox.w / 2;
      const cyCenter = edCropBox.y + edCropBox.h / 2;
      // Preserve area in pixel space
      const areaPx = (edCropBox.w * eW) * (edCropBox.h * eH);
      // new pixel dims: nW * nH = areaPx, nW/nH = ar → nW = sqrt(areaPx*ar), nH = sqrt(areaPx/ar)
      let nW = Math.sqrt(areaPx * ar), nH = Math.sqrt(areaPx / ar);
      let bw = nW / eW, bh = nH / eH;
      // clamp to image bounds
      if (bw > 1) { bw = 1; bh = (bw * eW) / (ar * eH); }
      if (bh > 1) { bh = 1; bw = (bh * eH * ar) / eW; }
      bw = Math.min(bw, 1); bh = Math.min(bh, 1);
      let nx = cxCenter - bw / 2, ny = cyCenter - bh / 2;
      nx = Math.max(0, Math.min(1 - bw, nx));
      ny = Math.max(0, Math.min(1 - bh, ny));
      edCropBox = { x: nx, y: ny, w: bw, h: bh };
      clampCropBox(); updateCropInfoLbl(); redraw();
    }

    cropToggleB.addEventListener("click", () => {
      edCropMode = !edCropMode;
      // Mutual exclusion: disable lasso if crop is enabled
      if (edCropMode && edLassoMode) {
        edLassoMode = false; edLassoCurrentPts = []; edLassoDrawing = false; _lassoCursorNorm = null;
        stopLassoAnts(); syncLassoToggle(); updateLassoInfoLbl();
      }
      // Auto-initialize crop box on first enable (centered, 50% scale, tensor AR)
      if (edCropMode && !edCropBox) {
        const eW = effNatW(), eH = effNatH();
        const targetAR = parseCropAR() ?? (edRefW / edRefH);
        const imgAR = eW / eH;
        let bw, bh;
        if (targetAR >= imgAR) {
          bw = 0.5; bh = (bw * eW) / (targetAR * eH);
        } else {
          bh = 0.5; bw = (bh * eH * targetAR) / eW;
        }
        bw = Math.min(bw, 1); bh = Math.min(bh, 1);
        edCropBox = { x: (1 - bw) / 2, y: (1 - bh) / 2, w: bw, h: bh };
        updateCropInfoLbl();
      }
      syncCropToggle(); redraw();
    });
    secEdit.appendChild(cropToggleB);

    // AR lock + input row
    const cropArRow = document.createElement("div");
    cropArRow.style.cssText = `display:flex;align-items:center;gap:${_gap5};width:100%;`;
    const cropArLockB = document.createElement("button");
    cropArLockB.style.cssText = `background:none;border:none;cursor:pointer;font-size:${_fs12};padding:0 2px;flex-shrink:0;transition:opacity 0.15s;`;
    function syncArLockUI() {
      cropArLockB.textContent = edCropArLock ? "\uD83D\uDD12" : "\uD83D\uDD13";
      cropArLockB.style.opacity = edCropArLock ? "1" : "0.4";
      cropArInput.style.color = edCropArLock ? "#ccc" : "#555";
    }
    cropArLockB.addEventListener("click", () => { edCropArLock = !edCropArLock; syncArLockUI(); });
    const cropArInput = document.createElement("input");
    cropArInput.type = "text";
    const _nodeArWidget = getAspectRatioWidget();
    const _nodeArVal = _nodeArWidget?.value;
    cropArInput.value = (_nodeArVal && _nodeArVal !== 'none') ? _nodeArVal : _simplifyAR(edRefW, edRefH);
    cropArInput.placeholder = "16:9";
    cropArInput.style.cssText = `flex:1;background:#1a1a1a;color:#ccc;border:1px solid #333;border-radius:${_r5};padding:${_pad4};font-size:${_fs11};text-align:center;min-width:0;`;
    cropArInput.addEventListener("focus", () => { cropArInput.style.borderColor = '#5a7abf'; });
    cropArInput.addEventListener("blur", () => { cropArInput.style.borderColor = '#333'; });
    cropArInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); cropArInput.blur(); edCropArLock = true; syncArLockUI(); refitCropBoxToAR(); }
    });
    syncArLockUI();
    cropArRow.appendChild(cropArLockB);
    cropArRow.appendChild(cropArInput);
    secEdit.appendChild(cropArRow);

    const cropApplyB = document.createElement("button");
    cropApplyB.textContent = "\u2713 Apply Crop";
    cropApplyB.style.cssText = `background:#2a2a2a;color:#555;border:1px solid #333;border-radius:${_r5};padding:${_btnPadW} ${_pad8};font-size:${_fs11};cursor:pointer;text-align:left;width:100%;font-weight:600;transition:background 0.15s,border-color 0.15s,color 0.15s;`;
    cropApplyB.addEventListener("mouseenter", () => { if(edCropMode || edCropBox) { cropApplyB.style.background="#2a5a3a"; cropApplyB.style.color="#55ee99"; cropApplyB.style.borderColor="#55ee99"; } });
    cropApplyB.addEventListener("mouseleave", () => { syncCropToggle(); });
    cropApplyB.addEventListener("click", () => {
      if (!edCropBox) return;
      // Compose with any existing applied crop
      if (edAppliedCrop) {
        edAppliedCrop = {
          cx: edAppliedCrop.cx + edCropBox.x * edAppliedCrop.cw,
          cy: edAppliedCrop.cy + edCropBox.y * edAppliedCrop.ch,
          cw: edCropBox.w * edAppliedCrop.cw,
          ch: edCropBox.h * edAppliedCrop.ch,
        };
      } else {
        edAppliedCrop = { cx: edCropBox.x, cy: edCropBox.y, cw: edCropBox.w, ch: edCropBox.h };
      }
      edCropBox = null; edCropMode = false;
      edLassoOps = []; edLassoInverted = false; _lassoMaskDirty = true;
      // Reset transforms since we're now working on a new "image"
      dOX = 0; dOY = 0; edScale = 1.0;
      syncCropToggle(); updateDimLabels(); updateCropInfoLbl();
      syncCvs(); updLbl(); redraw(); requestInpaintPreview();
    });
    secEdit.appendChild(cropApplyB);

    const cropInfoLbl = document.createElement("div");
    cropInfoLbl.style.cssText = `color:#666;font-size:${_fs10};text-align:center;min-height:${Math.round(11*uiScale)}px;`;
    secEdit.appendChild(cropInfoLbl);

    // ══════════════════════════════════════════════════════════════════
    // ── Crop Lasso Section ──────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════
    secEdit.appendChild(mkSec("Crop Lasso", () => {
      edLassoOps = []; edLassoInverted = false;
      edLassoCurrentPts = []; edLassoDrawing = false;
      _lassoMaskDirty = true; _lassoCursorNorm = null;
      stopLassoAnts();
      syncLassoInvertBtn(); updateLassoInfoLbl();
    }, "Reset Crop Lasso"));

    // Tool buttons: Lasso / Polygonal — act as mode toggles
    const lassoToolRow = document.createElement("div");
    lassoToolRow.style.cssText = `display:flex;gap:0;width:100%;`;
    const lassoFreehandB = document.createElement("button");
    lassoFreehandB.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-3-.4"/><path d="M12 18a14 14 0 0 1-3.3-.4"/></svg>Lasso`;
    lassoFreehandB.style.cssText = `flex:1;background:#1e1e1e;color:#aaa;border:1px solid #333;border-radius:${_r5} 0 0 ${_r5};padding:${_btnPadW};font-size:${_fs10};cursor:pointer;transition:background 0.15s;display:flex;align-items:center;justify-content:center;`;
    const lassoPolyB = document.createElement("button");
    lassoPolyB.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><polygon points="3 6 9 3 21 8 18 21 7 15"/></svg>Polygonal`;
    lassoPolyB.style.cssText = `flex:1;background:#1e1e1e;color:#aaa;border:1px solid #333;border-radius:0 ${_r5} ${_r5} 0;padding:${_btnPadW};font-size:${_fs10};cursor:pointer;transition:background 0.15s;display:flex;align-items:center;justify-content:center;`;
    function toggleLassoTool(tool) {
      if (edLassoMode && edLassoTool === tool) {
        edLassoMode = false; edLassoDrawing = false;
        edLassoCurrentPts = []; _lassoCursorNorm = null; stopLassoAnts();
      } else {
        edLassoMode = true; edLassoTool = tool;
        edLassoCurrentPts = []; edLassoDrawing = false; _lassoCursorNorm = null;
        if (edCropMode) { edCropMode = false; syncCropToggle(); }
        if (edLassoOps.length > 0) startLassoAnts();
      }
      syncLassoToggle(); redraw();
    }
    lassoFreehandB.addEventListener("click", () => toggleLassoTool("freehand"));
    lassoPolyB.addEventListener("click", () => toggleLassoTool("polygonal"));
    lassoToolRow.appendChild(lassoFreehandB); lassoToolRow.appendChild(lassoPolyB);
    secEdit.appendChild(lassoToolRow);

    // Invert Selection
    const lassoInvertB = mkPB("\u2298 Invert Selection", () => {
      edLassoInverted = !edLassoInverted;
      _lassoMaskDirty = true;
      syncLassoInvertBtn(); requestInpaintPreview(); redraw();
    });
    function syncLassoInvertBtn() {
      if (edLassoInverted) {
        lassoInvertB.style.background = "#2a1a3a"; lassoInvertB.style.color = "#bb88ff"; lassoInvertB.style.borderColor = "#553388";
      } else {
        lassoInvertB.style.background = ""; lassoInvertB.style.color = ""; lassoInvertB.style.borderColor = "";
      }
    }
    secEdit.appendChild(lassoInvertB);

    // Hint + Info
    const lassoHintLbl = document.createElement("div");
    lassoHintLbl.style.cssText = `color:#555;font-size:${_fs10};text-align:center;line-height:1.3;`;
    lassoHintLbl.textContent = "Shift: add \u00b7 Alt: subtract";
    secEdit.appendChild(lassoHintLbl);
    const lassoInfoLbl = document.createElement("div");
    lassoInfoLbl.style.cssText = `color:#666;font-size:${_fs10};text-align:center;min-height:${Math.round(11*uiScale)}px;`;
    secEdit.appendChild(lassoInfoLbl);

    function updateLassoInfoLbl() {
      if (edLassoOps.length === 0 && !edLassoInverted) { lassoInfoLbl.textContent = ''; return; }
      const addN = edLassoOps.filter(o => o.mode === "add").length;
      const subN = edLassoOps.filter(o => o.mode === "subtract").length;
      let txt = `${edLassoOps.length} op${edLassoOps.length !== 1 ? 's' : ''}`;
      if (addN && subN) txt += ` (${addN} add, ${subN} sub)`;
      if (edLassoInverted) txt += " \u00b7 inverted";
      lassoInfoLbl.textContent = txt;
    }

    // ── Commit a completed polygon/freehand shape ──
    function commitLassoShape(points, e) {
      if (points.length < 3) return;
      const normalized = points.map(p => [p.x, p.y]);
      let mode = "add";
      if (e && e.altKey) mode = "subtract";
      if (!e || (!e.shiftKey && !e.altKey)) edLassoOps = [];
      edLassoOps.push({ mode, points: normalized });
      edLassoCurrentPts = []; edLassoDrawing = false; _lassoCursorNorm = null;
      _lassoMaskDirty = true;
      startLassoAnts(); updateLassoInfoLbl(); requestInpaintPreview(); redraw();
    }

    // ── Marching ants animation ──
    let _lastAntTick = 0;
    function startLassoAnts() {
      if (edLassoAntsRaf) return;
      function tick(now) {
        if (now - _lastAntTick > 50) { edLassoAntsOffset = (edLassoAntsOffset + 0.5) % 24; _lastAntTick = now; redraw(); }
        edLassoAntsRaf = requestAnimationFrame(tick);
      }
      edLassoAntsRaf = requestAnimationFrame(tick);
    }
    function stopLassoAnts() { if (edLassoAntsRaf) { cancelAnimationFrame(edLassoAntsRaf); edLassoAntsRaf = null; } }

    // ── Lasso mask canvas builder (cached) ──
    function getLassoMaskCanvas(w, h) {
      if (!_lassoMaskDirty && _cachedMaskCvs && _cachedMaskW === w && _cachedMaskH === h) return _cachedMaskCvs;
      if (!_cachedMaskCvs) _cachedMaskCvs = document.createElement('canvas');
      _cachedMaskCvs.width = w; _cachedMaskCvs.height = h;
      _cachedMaskW = w; _cachedMaskH = h;
      const x = _cachedMaskCvs.getContext('2d');
      x.clearRect(0, 0, w, h);
      for (const op of edLassoOps) {
        if (op.points.length < 3) continue;
        x.globalCompositeOperation = op.mode === "add" ? "source-over" : "destination-out";
        x.fillStyle = "white"; x.beginPath();
        x.moveTo(op.points[0][0] * w, op.points[0][1] * h);
        for (let i = 1; i < op.points.length; i++) x.lineTo(op.points[i][0] * w, op.points[i][1] * h);
        x.closePath(); x.fill();
      }
      if (edLassoInverted) { x.globalCompositeOperation = "xor"; x.fillStyle = "white"; x.fillRect(0, 0, w, h); }
      x.globalCompositeOperation = "source-over";
      // Pre-compute edge pixels
      const imgd = x.getImageData(0, 0, w, h).data;
      const edges = [];
      for (let y = 0; y < h; y++) {
        for (let px = 0; px < w; px++) {
          const i = (y * w + px) * 4;
          if (imgd[i] < 128) continue;
          const left  = px > 0   ? imgd[(y * w + px - 1) * 4] : 0;
          const right = px < w-1 ? imgd[(y * w + px + 1) * 4] : 0;
          const up    = y > 0    ? imgd[((y-1) * w + px) * 4] : 0;
          const down  = y < h-1  ? imgd[((y+1) * w + px) * 4] : 0;
          if (left < 128 || right < 128 || up < 128 || down < 128) edges.push(px, y);
        }
      }
      _cachedEdgePixels = new Int32Array(edges);
      _lassoMaskDirty = false;
      return _cachedMaskCvs;
    }
    // Legacy alias
    function buildLassoMaskCanvas(w, h) { return getLassoMaskCanvas(w, h); }

    // ── Lasso overlay rendering ──
    // Drawn inside the SAME ctx transform as the image (translate → rotate → flip)
    // so marching ants and the in-progress path automatically follow flip/rotation.
    function drawLassoOverlay(ctx) {
      // ── Marching ants (committed ops) — shown whenever there's a selection ──
      if (edLassoOps.length > 0) {
        const { dw, dh } = _imgRenderDims();
        const mw = Math.ceil(dw), mh = Math.ceil(dh);
        if (mw > 0 && mh > 0) {
          getLassoMaskCanvas(mw, mh);
          if (_cachedEdgePixels && _cachedEdgePixels.length > 0) {
            ctx.save();
            ctx.translate(frameCX + dOX, frameCY + dOY);
            ctx.rotate(edRotate * Math.PI / 180);
            ctx.scale(edFlipH ? -1 : 1, edFlipV ? -1 : 1);
            ctx.strokeStyle = '#ff9f43'; ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 5]); ctx.lineDashOffset = -edLassoAntsOffset;
            ctx.beginPath();
            for (let i = 0; i < _cachedEdgePixels.length; i += 2) {
              ctx.rect(_cachedEdgePixels[i] - dw / 2, _cachedEdgePixels[i + 1] - dh / 2, 1, 1);
            }
            ctx.stroke();
            ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineDashOffset = -edLassoAntsOffset + 3;
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
          }
        }
      }

      // ── In-progress path (only while actively drawing) ──
      if (edLassoMode && edLassoCurrentPts.length >= 1) {
        const { dw, dh } = _imgRenderDims();
        ctx.save();
        ctx.translate(frameCX + dOX, frameCY + dOY);
        ctx.rotate(edRotate * Math.PI / 180);
        ctx.scale(edFlipH ? -1 : 1, edFlipV ? -1 : 1);
        const pts = edLassoCurrentPts.map(p => ({ lx: (p.x - 0.5) * dw, ly: (p.y - 0.5) * dh }));
        ctx.strokeStyle = '#ffcc00'; ctx.lineWidth = 1.5;
        if (edLassoTool === 'freehand') {
          if (pts.length >= 2) {
            ctx.beginPath(); ctx.moveTo(pts[0].lx, pts[0].ly);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].lx, pts[i].ly);
            ctx.stroke();
          }
        } else {
          ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(pts[0].lx, pts[0].ly);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].lx, pts[i].ly);
          const curL = _lassoCursorNorm ? { lx: (_lassoCursorNorm.x - 0.5) * dw, ly: (_lassoCursorNorm.y - 0.5) * dh } : null;
          if (curL) ctx.lineTo(curL.lx, curL.ly);
          ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = '#ffcc00';
          for (const p of pts) { ctx.beginPath(); ctx.arc(p.lx, p.ly, 3, 0, Math.PI * 2); ctx.fill(); }
          if (curL && pts.length >= 3) {
            const dist = Math.hypot(curL.lx - pts[0].lx, curL.ly - pts[0].ly);
            if (dist < 10) { ctx.strokeStyle = '#44ff44'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(pts[0].lx, pts[0].ly, 6, 0, Math.PI * 2); ctx.stroke(); }
          }
        }
        ctx.restore();
      }
    }

    secEdit.appendChild(mkSec("Quick Fit", () => {
      dOX=0; dOY=0; edScale=1; updLbl();
    }, "Reset to Letterbox"));
    secEdit.appendChild(mkPB("\u2B1B Fill  (cover)",  doFill));
    secEdit.appendChild(mkPB("\u2B1C Fit   (letterbox)", ()=>{ dOX=0;dOY=0;edScale=1; updLbl(); }));
    secEdit.appendChild(mkPB("\u2194 Fit Width",  doFitW));
    secEdit.appendChild(mkPB("\u2195 Fit Height", doFitH));
    secEdit.appendChild(mkSec("Flip", () => {
      edFlipH=false; edFlipV=false; syncFlipUI();
    }, "Reset Flip"));
    const flipRow = document.createElement("div");
    flipRow.style.cssText = `display:flex;gap:0;width:100%;`;
    function mkFlipBtn(icon, tip, half) {
      const b = document.createElement("button");
      b.title = tip;
      b.textContent = icon;
      const br = half === "L" ? (_r5 + " 0 0 " + _r5) : ("0 " + _r5 + " " + _r5 + " 0");
      b.style.cssText = [
        "flex:1;background:#1e1e1e;color:#aaa;border:1px solid #333;",
        "border-radius:" + br + ";",
        "padding:" + _btnPadW + ";font-size:" + _fs13 + ";cursor:pointer;",
        "transition:background 0.15s,border-color 0.15s,color 0.15s;",
      ].join("");
      return b;
    }
    const flipHBtn = mkFlipBtn("\u2194", "Flip Horizontal", "L");
    const flipVBtn = mkFlipBtn("\u2195", "Flip Vertical",   "R");
    function syncFlipUI() {
      flipHBtn.style.background   = edFlipH ? "#1a2a3a" : "#1e1e1e";
      flipHBtn.style.color        = edFlipH ? "#7ab0ff" : "#aaa";
      flipHBtn.style.borderColor  = edFlipH ? "#5a7abf" : "#333";
      flipVBtn.style.background   = edFlipV ? "#1a2a3a" : "#1e1e1e";
      flipVBtn.style.color        = edFlipV ? "#7ab0ff" : "#aaa";
      flipVBtn.style.borderColor  = edFlipV ? "#5a7abf" : "#333";
    }
    flipHBtn.addEventListener("click", () => { edFlipH=!edFlipH; syncFlipUI(); redraw(); requestInpaintPreview(); });
    flipVBtn.addEventListener("click", () => { edFlipV=!edFlipV; syncFlipUI(); redraw(); requestInpaintPreview(); });
    flipRow.appendChild(flipHBtn);
    flipRow.appendChild(flipVBtn);
    secEdit.appendChild(flipRow);
    secEdit.appendChild(mkSec("Rotate", () => {
      edRotate=0; syncRotUI();
    }, "Reset Rotation"));
    // slider + click-to-type angle
    const rotRow = document.createElement("div");
    rotRow.style.cssText = `display:flex;align-items:center;gap:${_gap5};width:100%;`;
    
    const rotValEl = document.createElement("div");
    rotValEl.style.cssText=`background:#1e1e1e;color:#ccc;border:1px solid #333;border-radius:3px;font-size:${_fs10};width:${Math.round(44*uiScale)}px;text-align:center;cursor:text;user-select:none;flex-shrink:0;padding:2px 0;box-sizing:border-box;`;
    rotValEl.textContent="0\u00b0";

    const rotSlider = document.createElement("input");
    rotSlider.type="range"; rotSlider.min=-180; rotSlider.max=180; rotSlider.step=1; rotSlider.value=0;
    rotSlider.style.cssText="flex:1;accent-color:#5a7abf;cursor:pointer;";
    
    function syncRotUI(){
      rotSlider.value = edRotate;
      rotValEl.textContent = edRotate + "\u00b0";
    }
    rotValEl.addEventListener("click", () => {
      const inp = document.createElement("input");
      inp.type="number"; inp.min=-180; inp.max=180; inp.value=edRotate;
      inp.style.cssText=`width:100%;height:100%;box-sizing:border-box;background:transparent;color:#ccc;border:none;outline:none;font-size:${_fs10};text-align:center;`;
      rotValEl.innerHTML=""; rotValEl.appendChild(inp);
      inp.focus(); inp.select();
      function commit(){
        const v = Math.max(-180,Math.min(180,parseInt(inp.value)||0));
        edRotate=v; rotSlider.value=v; rotValEl.textContent=v+"\u00b0";
        updLbl(); redraw(); requestInpaintPreview();
      }
      inp.addEventListener("blur", commit);
      inp.addEventListener("keydown", e=>{ if(e.key==="Enter") commit(); if(e.key==="Escape") rotValEl.textContent=edRotate+"\u00b0"; });
    });
    rotSlider.addEventListener("input", () => {
      edRotate=parseInt(rotSlider.value); rotValEl.textContent=edRotate+"\u00b0"; updLbl(); redraw();
      requestInpaintPreview();
    });
    rotRow.appendChild(rotValEl); rotRow.appendChild(rotSlider);
    secEdit.appendChild(rotRow);

    // Background fill elements (created here, appended later — after Remove BG)
    const bgSelect = document.createElement("select");
    bgSelect.style.cssText=`width:100%;background:#1e1e1e;color:#aaa;border:1px solid #333;border-radius:${_r5};padding:${Math.round(4*uiScale)}px ${Math.round(5*uiScale)}px;font-size:${_fs10};cursor:pointer;`;
    [["#808080","Gray (default)"],["black","Black"],["white","White"],["custom","Custom color\u2026"],["telea","Telea inpaint \u2699"],["navier-stokes","Navier-Stokes \u2699"]]
      .forEach(([v,l])=>{ const o=document.createElement("option"); o.value=v; o.textContent=l; bgSelect.appendChild(o); });
    const bgCustomRow = document.createElement("div");
    bgCustomRow.style.cssText="display:none;align-items:center;gap:4px;";
    const bgColorPick = document.createElement("input");
    bgColorPick.type="color"; bgColorPick.value="#808080";
    bgColorPick.style.cssText=`width:${Math.round(26*uiScale)}px;height:${Math.round(22*uiScale)}px;border:none;background:none;cursor:pointer;padding:0;flex-shrink:0;`;
    const bgHexInp = document.createElement("input");
    bgHexInp.type="text"; bgHexInp.value="#808080"; bgHexInp.maxLength=7;
    bgHexInp.style.cssText=`flex:1;background:#1a1a1a;color:#ccc;border:1px solid #444;border-radius:3px;font-size:${_fs10};padding:2px 4px;min-width:0;`;
    bgCustomRow.appendChild(bgColorPick); bgCustomRow.appendChild(bgHexInp);
    const bgNote = document.createElement("div");
    bgNote.style.cssText=`color:#444;font-size:${_fs10};line-height:1.3;display:none;`;
    bgNote.textContent="\u2699 Applied by Python at queue";
    bgColorPick.addEventListener("input", ()=>{ bgHexInp.value=bgColorPick.value; edBg=bgColorPick.value; redraw(); });
    bgHexInp.addEventListener("change", ()=>{
      const h=bgHexInp.value.trim();
      if(/^#[0-9a-fA-F]{6}$/.test(h)){ bgColorPick.value=h; edBg=h; redraw(); }
    });
    bgSelect.addEventListener("change", ()=>{
      const v=bgSelect.value;
      bgCustomRow.style.display=v==="custom"?"flex":"none";
      bgNote.style.display=(v==="telea"||v==="navier-stokes")?"block":"none";
      const _w2h = {"black":"#000000","white":"#ffffff"};
      edBg= v==="custom" ? bgColorPick.value : (_w2h[v] || v);
      edInpaintPreview=null; edInpaintDirty=true;
      redraw(); requestInpaintPreview();
    });
    function syncBgUI(){
      // Map hex values to dropdown option values
      const hexToOpt = {"#000000":"black","#ffffff":"white"};
      const optVal = hexToOpt[edBg?.toLowerCase()] || edBg;
      const known=["#808080","black","white","telea","navier-stokes"];
      bgSelect.value=known.includes(optVal)?optVal:"custom";
      const isCust=!known.includes(optVal);
      bgCustomRow.style.display=isCust?"flex":"none";
      if(isCust){ bgColorPick.value=edBg; bgHexInp.value=edBg; }
      bgNote.style.display=(edBg==="telea"||edBg==="navier-stokes")?"block":"none";
    }

    // ── Remove Background ───────────────────────────────────────
    secEdit.appendChild(mkSec("Remove Background", () => {
      doRembgReset();
    }, "Restore Original Image"));

    // Model select
    const rbModelSel = document.createElement("select");
    rbModelSel.title = "rembg model";
    rbModelSel.style.cssText = `width:100%;background:#1e1e1e;color:#aaa;border:1px solid #333;border-radius:${_r5};padding:${Math.round(4*uiScale)}px ${Math.round(5*uiScale)}px;font-size:${_fs10};cursor:pointer;`;
    [
      ["isnet-general-use", "isnet-general-use ★"],
      ["u2net",             "u2net"],
      ["u2net_human_seg",   "u2net human"],
      ["isnet-anime",       "isnet-anime"],
      ["silueta",           "silueta"],
      ["u2netp",            "u2netp (fast)"],
    ].forEach(([v, l]) => {
      const o = document.createElement("option"); o.value = v; o.textContent = l; rbModelSel.appendChild(o);
    });
    secEdit.appendChild(rbModelSel);

    // Status label
    const rbStatus = document.createElement("div");
    rbStatus.style.cssText = `font-size:${_fs10};text-align:center;min-height:${Math.round(11*uiScale)}px;color:#666;transition:color 0.2s;`;

    // Main button
    const rbBtn = document.createElement("button");
    rbBtn.textContent = "\uD83E\uDE84 Remove BG";
    rbBtn.style.cssText = `background:#1e1e1e;color:#aaa;border:1px solid #333;border-radius:${_r5};padding:${_btnPadW} ${_pad8};font-size:${_fs11};cursor:pointer;text-align:left;width:100%;`;
    rbBtn.addEventListener("mouseenter", () => { rbBtn.style.background="#2a2a2a"; rbBtn.style.borderColor="#484848"; });
    rbBtn.addEventListener("mouseleave", () => { rbBtn.style.background="#1e1e1e"; rbBtn.style.borderColor="#333"; });

    async function doRembg() {
      const fn = items[curIdx]?.filename;
      if (!fn) return;
      rbBtn.textContent = "\u23F3 Processing\u2026";
      rbBtn.disabled = true;
      rbStatus.textContent = "";
      rbStatus.style.color = "#888";
      try {
        const resp = await fetch("/multi_image_loader/rembg", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: fn,
            model:    rbModelSel.value,
          }),
        });
        const json = await resp.json();
        if (!json.success) throw new Error(json.error || "Unknown error");

        // Update the item's src to the new transparent PNG
        items[curIdx].src = json.dataUrl;
        delete items[curIdx].previewSrc;

        rbStatus.textContent = "\u2713 Done — BG removed";
        rbStatus.style.color = "#44cc88";

        // Reload ONLY the image element — preserve all editor state (bg, pan, zoom, etc.)
        await new Promise(res => {
          const el = new Image();
          el.crossOrigin = "anonymous";
          el.onload = () => {
            edImg = el; edNatW = el.naturalWidth; edNatH = el.naturalHeight;
            syncCvs(); redraw(); res();
          };
          el.onerror = res;
          el.src = json.dataUrl;
        });
        // Refresh thumbnail grid and save current state (including bg fill)
        saveToSes();
        render();
      } catch (e) {
        console.error("[MIL rembg]", e);
        rbStatus.textContent = "\u2717 " + e.message;
        rbStatus.style.color = "#ff6666";
      } finally {
        rbBtn.textContent = "\uD83E\uDE84 Remove BG";
        rbBtn.disabled = false;
      }
    }

    rbBtn.addEventListener("click", doRembg);
    secEdit.appendChild(rbBtn);
    secEdit.appendChild(rbStatus);

    async function doRembgReset() {
      const fn = items[curIdx]?.filename;
      if (!fn) return;
      rbStatus.textContent = "\u23F3 Restoring\u2026";
      rbStatus.style.color = "#888";
      try {
        const resp = await fetch("/multi_image_loader/rembg_reset", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: fn }),
        });
        const json = await resp.json();
        if (!json.success) throw new Error(json.error || "Unknown error");

        items[curIdx].src = json.dataUrl;
        delete items[curIdx].previewSrc;

        rbStatus.textContent = "\u2713 Original restored";
        rbStatus.style.color = "#88cc88";

        await new Promise(res => {
          const el = new Image();
          el.crossOrigin = "anonymous";
          el.onload = () => { edImg = el; edNatW = el.naturalWidth; edNatH = el.naturalHeight; syncCvs(); redraw(); res(); };
          el.onerror = res;
          el.src = json.dataUrl;
        });
        render();
      } catch (e) {
        console.error("[MIL rembg_reset]", e);
        rbStatus.textContent = "\u2717 " + e.message;
        rbStatus.style.color = "#ff6666";
      }
    }

    // ── Background Fill (last visual section) ────────────────────
    secEdit.appendChild(mkSec("Background Fill", () => {
      edBg = getEffectiveBgColor(); syncBgUI();
      edInpaintPreview=null; edInpaintDirty=true;
    }, "Reset to Node Default"));
    secEdit.appendChild(bgSelect); secEdit.appendChild(bgCustomRow); secEdit.appendChild(bgNote);

    // ══════════════════════════════════════════════════════════════════
    // ── IMAGE TOOLS section (Blur / Smudge / CA Fill on image pixels) ──
    // ══════════════════════════════════════════════════════════════════
    let edPixelTool = null;  // null | "blur" | "smudge"
    let _edCvsEditsPx = null;
    let _edEditsUndoStack = [];
    let _edSmudgeBuf = null;
    let _edSmudgeStr = 0.5;
    let _edBrushDrawing = false;
    let _edBrushPts = [];
    let _edBrushPos = null;
    let _edCafillLoading = false;

    // Image dims in pixels panel (mirrors secEdit dims)
    const pxDimLbl = document.createElement("div");
    pxDimLbl.style.cssText = `color:#666;font-size:${_fs10};text-align:center;`;
    function _updatePxDimLbl() {
      if (!edImg) { pxDimLbl.textContent = ""; return; }
      const ew = effNatW(), eh = effNatH();
      pxDimLbl.textContent = `${ew} × ${eh}${edAppliedCrop ? " (cropped)" : ""}`;
    }
    secPixels.appendChild(pxDimLbl);

    // ── Lasso Selection sub-section (needed for CA Fill) ────────
    secPixels.appendChild(mkSec("Lasso Selection", () => {
      edLassoOps = []; edLassoCurrentPts = []; edLassoDrawing = false;
      edLassoInverted = false; _lassoCursorNorm = null; _lassoMaskDirty = true;
      stopLassoAnts(); syncLassoToggle(); updateLassoInfoLbl(); redraw();
    }, "Clear lasso selection"));

    const pxLassoToolRow = document.createElement("div");
    pxLassoToolRow.style.cssText = `display:flex;gap:0;width:100%;`;
    pxLassoFreehandB = document.createElement("button");
    pxLassoFreehandB.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-3-.4"/><path d="M12 18a14 14 0 0 1-3.3-.4"/></svg>Lasso`;
    pxLassoFreehandB.style.cssText = `flex:1;background:#1e1e1e;color:#aaa;border:1px solid #333;border-radius:${_r5} 0 0 ${_r5};padding:${_btnPadW};font-size:${_fs10};cursor:pointer;transition:background 0.15s;display:flex;align-items:center;justify-content:center;`;
    pxLassoPolyB = document.createElement("button");
    pxLassoPolyB.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><polygon points="3 6 9 3 21 8 18 21 7 15"/></svg>Polygonal`;
    pxLassoPolyB.style.cssText = `flex:1;background:#1e1e1e;color:#aaa;border:1px solid #333;border-radius:0 ${_r5} ${_r5} 0;padding:${_btnPadW};font-size:${_fs10};cursor:pointer;transition:background 0.15s;display:flex;align-items:center;justify-content:center;`;
    pxLassoFreehandB.addEventListener("click", () => toggleLassoTool("freehand"));
    pxLassoPolyB.addEventListener("click", () => toggleLassoTool("polygonal"));
    pxLassoToolRow.appendChild(pxLassoFreehandB); pxLassoToolRow.appendChild(pxLassoPolyB);
    secPixels.appendChild(pxLassoToolRow);

    const pxLassoInfoLbl = document.createElement("div");
    pxLassoInfoLbl.style.cssText = `color:#666;font-size:${_fs10};text-align:center;min-height:${Math.round(11*uiScale)}px;margin-bottom:${_gap5};`;
    secPixels.appendChild(pxLassoInfoLbl);
    // Keep pxLassoInfoLbl in sync with the main lassoInfoLbl by patching updateLassoInfoLbl
    const _origUpdateLassoInfoLbl = updateLassoInfoLbl;
    updateLassoInfoLbl = function() {
      _origUpdateLassoInfoLbl();
      // Mirror text to pixel panel label
      pxLassoInfoLbl.textContent = lassoInfoLbl.textContent;
    };

    secPixels.appendChild(mkSec("Image Tools", () => {
      edPixelTool = null; _edCvsEditsPx = null; _edEditsUndoStack = [];
      _edSmudgeBuf = null; _edBrushDrawing = false; _edBrushPts = [];
      _syncPixelToolUI(); redraw();
    }, "Reset all pixel edits"));

    const ptToolRow = document.createElement("div");
    ptToolRow.style.cssText = `display:flex;gap:${_gap5};flex-wrap:wrap;`;
    const ptBtns = {};
    [["blur","💧 Blur"],["smudge","👆 Smudge"]].forEach(([k,lbl]) => {
      const b = document.createElement("button");
      b.textContent = lbl;
      b.style.cssText = `flex:1 0 auto;background:#1e1e1e;color:#aaa;border:1px solid #3a3a3a;border-radius:${_r5};padding:${_btnPad};font-size:${_fs11};cursor:pointer;transition:background .12s;`;
      b.addEventListener("mouseenter", () => { if (edPixelTool !== k) { b.style.background="#2a2a2a"; b.style.borderColor="#555"; } });
      b.addEventListener("mouseleave", () => { if (edPixelTool !== k) { b.style.background="#1e1e1e"; b.style.borderColor="#3a3a3a"; } });
      b.addEventListener("click", () => _selectPixelTool(k));
      ptBtns[k] = b; ptToolRow.appendChild(b);
    });
    const ptCABtn = document.createElement("button");
    ptCABtn.textContent = "✨ CA Fill";
    ptCABtn.style.cssText = `flex:1 0 auto;background:#1e1e1e;color:#aaa;border:1px solid #3a3a3a;border-radius:${_r5};padding:${_btnPad};font-size:${_fs11};cursor:pointer;transition:background .12s;`;
    ptCABtn.addEventListener("mouseenter", () => { ptCABtn.style.background="#2a2a2a"; ptCABtn.style.borderColor="#555"; });
    ptCABtn.addEventListener("mouseleave", () => { ptCABtn.style.background="#1e1e1e"; ptCABtn.style.borderColor="#3a3a3a"; });
    ptCABtn.addEventListener("click", () => _edRunCAFill());
    ptToolRow.appendChild(ptCABtn);
    secPixels.appendChild(ptToolRow);

    // Smudge strength slider
    const ptSmudgeRow = document.createElement("div");
    ptSmudgeRow.style.cssText = `display:none;gap:${_gap5};align-items:center;margin-top:2px;`;
    const ptSmLbl = document.createElement("span");
    ptSmLbl.style.cssText = `color:#888;font-size:${_fs10};flex-shrink:0;`;
    ptSmLbl.textContent = "Strength";
    const ptSmSlider = document.createElement("input");
    ptSmSlider.type = "range"; ptSmSlider.min = "5"; ptSmSlider.max = "100"; ptSmSlider.value = "50";
    ptSmSlider.style.cssText = `flex:1;accent-color:#40a0ff;`;
    const ptSmVal = document.createElement("span");
    ptSmVal.style.cssText = `color:#888;font-size:${_fs10};min-width:28px;text-align:right;`;
    ptSmVal.textContent = "50%";
    ptSmSlider.addEventListener("input", () => { _edSmudgeStr = parseInt(ptSmSlider.value)/100; ptSmVal.textContent = ptSmSlider.value+"%"; });
    ptSmudgeRow.appendChild(ptSmLbl); ptSmudgeRow.appendChild(ptSmSlider); ptSmudgeRow.appendChild(ptSmVal);
    secPixels.appendChild(ptSmudgeRow);

    // Dedicated brush size slider for image tools
    const ptBrushRow = document.createElement("div");
    ptBrushRow.style.cssText = `display:none;gap:${_gap5};align-items:center;`;
    const ptBrLbl = document.createElement("span");
    ptBrLbl.style.cssText = `color:#888;font-size:${_fs10};flex-shrink:0;`;
    ptBrLbl.textContent = "Size";
    const ptBrSlider = document.createElement("input");
    ptBrSlider.type = "range"; ptBrSlider.min = "4"; ptBrSlider.max = "150"; ptBrSlider.value = "30";
    ptBrSlider.style.cssText = `flex:1;accent-color:#40a0ff;`;
    const ptBrVal = document.createElement("span");
    ptBrVal.style.cssText = `color:#888;font-size:${_fs10};min-width:28px;text-align:right;`;
    ptBrVal.textContent = "30px";
    ptBrSlider.addEventListener("input", () => { ptBrVal.textContent = ptBrSlider.value+"px"; redraw(); });
    ptBrushRow.appendChild(ptBrLbl); ptBrushRow.appendChild(ptBrSlider); ptBrushRow.appendChild(ptBrVal);
    secPixels.appendChild(ptBrushRow);

    // Undo button for pixel edits
    const ptUndoB = document.createElement("button");
    ptUndoB.textContent = "\u21B6 Undo";
    ptUndoB.style.cssText = `background:#1e1e1e;color:#aaa;border:1px solid #3a3a3a;border-radius:${_r5};padding:${_btnPad};font-size:${_fs11};cursor:pointer;width:100%;transition:background .12s;`;
    ptUndoB.addEventListener("mouseenter", () => { ptUndoB.style.background="#2a2a2a"; ptUndoB.style.borderColor="#555"; });
    ptUndoB.addEventListener("mouseleave", () => { ptUndoB.style.background="#1e1e1e"; ptUndoB.style.borderColor="#3a3a3a"; });
    ptUndoB.addEventListener("click", () => _edUndoEdits());
    secPixels.appendChild(ptUndoB);

    function _syncPixelToolUI() {
      Object.entries(ptBtns).forEach(([k, b]) => {
        const on = edPixelTool === k;
        b.style.background = on ? "#1a2a3a" : "#1e1e1e";
        b.style.color = on ? "#7ab0ff" : "#aaa";
        b.style.borderColor = on ? "#445599" : "#3a3a3a";
      });
      ptSmudgeRow.style.display = edPixelTool === "smudge" ? "flex" : "none";
      ptBrushRow.style.display = edPixelTool ? "flex" : "none";
      // Update cursor
      if (edPixelTool) {
        ca.style.cursor = "none";
        hint.textContent = edPixelTool === "blur" ? "Drag to blur · Scroll to zoom" : "Drag to smudge · Scroll to zoom";
      }
    }

    function _selectPixelTool(t) {
      if (edPixelTool === t) { edPixelTool = null; } // toggle off
      else {
        edPixelTool = t;
        // Mutual exclusion: disable crop only (lasso stays active in pixels mode for CA Fill)
        if (edCropMode) { edCropMode = false; syncCropToggle(); }
        _edEnsureEditsPx();
      }
      _syncPixelToolUI();
      if (!edPixelTool && !edCropMode && !edLassoMode) {
        ca.style.cursor = "grab"; hint.textContent = "Drag to pan · Scroll to zoom";
      }
      redraw();
    }

    function _edEnsureEditsPx() {
      if (_edCvsEditsPx) return;
      if (!edImg) return;
      const eW = effNatW(), eH = effNatH();
      const wpX = Math.min(eW, 2048);
      const wpY = Math.round(eH * (wpX / eW));
      _edCvsEditsPx = document.createElement("canvas");
      _edCvsEditsPx.width = wpX; _edCvsEditsPx.height = wpY;
      const ctx = _edCvsEditsPx.getContext("2d");
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";

      // 1) Draw base image (with crop if applied)
      if (edAppliedCrop) {
        const sx = edAppliedCrop.cx * edNatW, sy = edAppliedCrop.cy * edNatH;
        const sw = edAppliedCrop.cw * edNatW, sh = edAppliedCrop.ch * edNatH;
        ctx.drawImage(edImg, sx, sy, sw, sh, 0, 0, wpX, wpY);
      } else {
        ctx.drawImage(edImg, 0, 0, wpX, wpY);
      }

      // 2) Bake lasso mask: paint bg color outside selection
      //    so Edit Pixels sees the same result as Edit Image view.
      if (edLassoOps.length > 0 || edLassoInverted) {
        const bgC = /^#[0-9a-fA-F]{6}$/.test(edBg) ? edBg : "#808080";

        // Build white-fill mask (white = inside selection)
        const maskCvs = document.createElement("canvas");
        maskCvs.width = wpX; maskCvs.height = wpY;
        const mx = maskCvs.getContext("2d");
        mx.clearRect(0, 0, wpX, wpY);
        for (const op of edLassoOps) {
          if (op.points.length < 3) continue;
          mx.globalCompositeOperation = op.mode === "add" ? "source-over" : "destination-out";
          mx.fillStyle = "white"; mx.beginPath();
          mx.moveTo(op.points[0][0] * wpX, op.points[0][1] * wpY);
          for (let k = 1; k < op.points.length; k++)
            mx.lineTo(op.points[k][0] * wpX, op.points[k][1] * wpY);
          mx.closePath(); mx.fill();
        }
        if (edLassoInverted) {
          mx.globalCompositeOperation = "xor";
          mx.fillStyle = "white"; mx.fillRect(0, 0, wpX, wpY);
        }
        mx.globalCompositeOperation = "source-over";

        // Build bg overlay: bg color everywhere, punched out by mask
        const bgCvs = document.createElement("canvas");
        bgCvs.width = wpX; bgCvs.height = wpY;
        const bx = bgCvs.getContext("2d");
        bx.fillStyle = bgC; bx.fillRect(0, 0, wpX, wpY);
        bx.globalCompositeOperation = "destination-out";
        bx.drawImage(maskCvs, 0, 0);
        bx.globalCompositeOperation = "source-over";

        // Paint bg overlay on top of image
        ctx.drawImage(bgCvs, 0, 0);
      }
    }


    function _edSaveUndo() {
      if (!_edCvsEditsPx) return;
      _edEditsUndoStack.push(_edCvsEditsPx.toDataURL("image/webp", 0.92));
      if (_edEditsUndoStack.length > 10) _edEditsUndoStack.shift();
    }

    function _edUndoEdits() {
      if (_edEditsUndoStack.length === 0) return;
      const src = _edEditsUndoStack.pop();
      const img = new Image();
      img.onload = () => {
        const ctx = _edCvsEditsPx.getContext("2d");
        ctx.clearRect(0, 0, _edCvsEditsPx.width, _edCvsEditsPx.height);
        ctx.drawImage(img, 0, 0);
        redraw();
      };
      img.src = src;
    }

    // ── Blur on image: separable box blur O(N·R) ──────────────────
    function _edApplyBlur(cx, cy, r) {
      if (!_edCvsEditsPx) return;
      const w = _edCvsEditsPx.width, h = _edCvsEditsPx.height;
      const ctx = _edCvsEditsPx.getContext("2d", { willReadFrequently: true });
      const bx = Math.max(0, Math.floor(cx - r)), by = Math.max(0, Math.floor(cy - r));
      const bw = Math.min(w - bx, Math.ceil(r * 2)), bh = Math.min(h - by, Math.ceil(r * 2));
      if (bw <= 0 || bh <= 0) return;
      const origData = ctx.getImageData(bx, by, bw, bh);
      const origD = new Uint8ClampedArray(origData.data);
      const imgData = ctx.getImageData(bx, by, bw, bh);
      const d = imgData.data;
      const tmp = new Uint8ClampedArray(d.length);
      const rad = Math.max(1, Math.floor(r * 0.25));
      for (let row = 0; row < bh; row++) {
        let rs=0,gs=0,bs=0,cnt=0;
        for (let i=-rad;i<=rad;i++) { const xi=Math.max(0,Math.min(bw-1,i)); const pi=(row*bw+xi)*4; rs+=d[pi];gs+=d[pi+1];bs+=d[pi+2];cnt++; }
        for (let col=0;col<bw;col++) { const po=(row*bw+col)*4; tmp[po]=rs/cnt;tmp[po+1]=gs/cnt;tmp[po+2]=bs/cnt;tmp[po+3]=255; const ri2=Math.max(0,col-rad),ai2=Math.min(bw-1,col+rad+1); const pr=(row*bw+ri2)*4,pa=(row*bw+ai2)*4; rs+=d[pa]-d[pr];gs+=d[pa+1]-d[pr+1];bs+=d[pa+2]-d[pr+2]; }
      }
      for (let col=0;col<bw;col++) {
        let rs=0,gs=0,bs=0,cnt=0;
        for (let i=-rad;i<=rad;i++) { const yi=Math.max(0,Math.min(bh-1,i)); const pi=(yi*bw+col)*4; rs+=tmp[pi];gs+=tmp[pi+1];bs+=tmp[pi+2];cnt++; }
        for (let row=0;row<bh;row++) { const po=(row*bw+col)*4; d[po]=rs/cnt;d[po+1]=gs/cnt;d[po+2]=bs/cnt;d[po+3]=255; const ri2=Math.max(0,row-rad),ai2=Math.min(bh-1,row+rad+1); const pr=(ri2*bw+col)*4,pa=(ai2*bw+col)*4; rs+=tmp[pa]-tmp[pr];gs+=tmp[pa+1]-tmp[pr+1];bs+=tmp[pa+2]-tmp[pr+2]; }
      }
      for (let row = 0; row < bh; row++) {
        for (let col = 0; col < bw; col++) {
          const dist = Math.hypot(col - (cx - bx), row - (cy - by));
          const f = dist <= r ? Math.pow(1 - dist / r, 1.2) : 0;
          const i = (row * bw + col) * 4;
          d[i]=origD[i]*(1-f)+d[i]*f; d[i+1]=origD[i+1]*(1-f)+d[i+1]*f; d[i+2]=origD[i+2]*(1-f)+d[i+2]*f;
        }
      }
      ctx.putImageData(imgData, bx, by);
    }

    // ── Smudge on image: true pixel-drag (sample → stamp) ────────
    // _edSmudgeBuf holds the "paint" being dragged between steps.
    function _edApplySmudge(lastPos, currPos, r) {
      if (!_edCvsEditsPx || !lastPos) return;
      const ctx = _edCvsEditsPx.getContext("2d", { willReadFrequently: true });
      const w = _edCvsEditsPx.width, h = _edCvsEditsPx.height;
      const d = Math.ceil(r) * 2;  // stamp diameter

      // ── 1. Initialize or reuse the smudge color buffer ──
      if (!_edSmudgeBuf || _edSmudgeBuf.width !== d || _edSmudgeBuf.height !== d) {
        // First step: sample patch under current brush from the canvas
        _edSmudgeBuf = document.createElement("canvas");
        _edSmudgeBuf.width = d; _edSmudgeBuf.height = d;
        const bCtx = _edSmudgeBuf.getContext("2d");
        bCtx.drawImage(_edCvsEditsPx,
          Math.round(currPos.x - r), Math.round(currPos.y - r), d, d,
          0, 0, d, d);
      }

      // ── 2. At the CURRENT position, sample what's already there ──
      const curPatchX = Math.round(currPos.x - r);
      const curPatchY = Math.round(currPos.y - r);
      const curPatch = document.createElement("canvas");
      curPatch.width = d; curPatch.height = d;
      const cpCtx = curPatch.getContext("2d");
      cpCtx.drawImage(_edCvsEditsPx, curPatchX, curPatchY, d, d, 0, 0, d, d);

      // ── 3. Blend smudge color buffer toward the current patch ──
      //    strength=1 → pure drag (max displacement, no blur)
      //    strength=0 → immediate fade into background (lots of blur)
      const alpha = _edSmudgeStr;  // higher = crisper drag
      const bCtx = _edSmudgeBuf.getContext("2d");
      // Mix: smudgeBuf = smudgeBuf * alpha + curPatch * (1-alpha)
      bCtx.globalCompositeOperation = "source-over";
      bCtx.globalAlpha = 1 - alpha;
      bCtx.drawImage(curPatch, 0, 0);
      bCtx.globalAlpha = 1;
      bCtx.globalCompositeOperation = "source-over";

      // ── 4. Stamp the smudge buffer onto the canvas with radial falloff ──
      const stampCvs = document.createElement("canvas");
      stampCvs.width = d; stampCvs.height = d;
      const sCtx = stampCvs.getContext("2d");
      // Draw the smudge color
      sCtx.drawImage(_edSmudgeBuf, 0, 0);
      // Apply radial fade mask (full opacity at center, zero at edge)
      sCtx.globalCompositeOperation = "destination-in";
      const grad = sCtx.createRadialGradient(r, r, 0, r, r, r);
      grad.addColorStop(0,   "rgba(0,0,0,1)");
      grad.addColorStop(0.7, "rgba(0,0,0,0.85)");
      grad.addColorStop(1,   "rgba(0,0,0,0)");
      sCtx.fillStyle = grad;
      sCtx.fillRect(0, 0, d, d);
      // Paint stamp back onto pixel canvas
      ctx.drawImage(stampCvs, curPatchX, curPatchY);
    }

    // ── CA Fill on image: lasso → inpaint backend ─────────────────
    async function _edRunCAFill() {
      if (_edCafillLoading || edLassoOps.length === 0) {
        if (edLassoOps.length === 0) alert("Draw a lasso selection first, then run CA Fill.");
        return;
      }
      _edCafillLoading = true; ptCABtn.textContent = "⏳ Working…";
      try {
        _edEnsureEditsPx(); _edSaveUndo();
        const pw = _edCvsEditsPx.width, ph = _edCvsEditsPx.height;
        // Build lasso mask at pixel canvas resolution
        const maskCvs = document.createElement("canvas"); maskCvs.width = pw; maskCvs.height = ph;
        const mx = maskCvs.getContext("2d");
        mx.fillStyle = "#fff"; mx.fillRect(0, 0, pw, ph); // white = no inpaint
        for (const op of edLassoOps) {
          if (op.points.length < 3) continue;
          mx.globalCompositeOperation = op.mode === "add" ? "source-over" : "destination-out";
          mx.fillStyle = "#000"; mx.beginPath(); // black = inpaint area
          mx.moveTo(op.points[0][0]*pw, op.points[0][1]*ph);
          for (let i=1;i<op.points.length;i++) mx.lineTo(op.points[i][0]*pw, op.points[i][1]*ph);
          mx.closePath(); mx.fill();
        }
        if (edLassoInverted) { mx.globalCompositeOperation="xor"; mx.fillStyle="#fff"; mx.fillRect(0,0,pw,ph); }
        mx.globalCompositeOperation = "source-over";
        const payload = {
          image: _edCvsEditsPx.toDataURL("image/png"),
          mask: maskCvs.toDataURL("image/png")
        };
        const res = await fetch("/multi_image_loader/inpaint", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error("Inpaint request failed: " + res.status);
        const j = await res.json();
        if (j.error) throw new Error(j.error);
        const rImg = new Image();
        await new Promise((ok, fail) => { rImg.onload = ok; rImg.onerror = fail; rImg.src = j.image; });
        const rCtx = _edCvsEditsPx.getContext("2d");
        rCtx.clearRect(0, 0, pw, ph);
        rCtx.drawImage(rImg, 0, 0, pw, ph);
        redraw();
      } catch (e) {
        console.error("[MIL] CA Fill error:", e);
        alert("Content-Aware Fill failed: " + e.message);
      } finally {
        _edCafillLoading = false; ptCABtn.textContent = "✨ CA Fill";
        // Clear the lasso selection — it's been consumed by CA Fill
        edLassoOps = []; edLassoCurrentPts = []; edLassoDrawing = false;
        edLassoMode = false; _lassoCursorNorm = null; _lassoMaskDirty = true;
        stopLassoAnts(); syncLassoToggle(); updateLassoInfoLbl();
      }
    }

    // ── Reset All button ─────────────────────────────────────────
    const resetAllB = document.createElement("button");
    resetAllB.textContent = "\u27F2 Reset All";
    resetAllB.title = "Restore image to its original state";
    resetAllB.style.cssText = [
      `background:#2a1a1a;color:#ff8888;border:1px solid #553333;`,
      `border-radius:${_r6};padding:${_btnPadW};font-size:${_fs11};font-weight:600;`,
      `cursor:pointer;width:100%;margin-top:${_pad8};`,
      `transition:background 0.15s,border-color 0.15s,color 0.15s;`,
    ].join("");
    resetAllB.addEventListener("mouseenter", () => { resetAllB.style.background = "#3a2020"; resetAllB.style.borderColor = "#884444"; resetAllB.style.color = "#ffaaaa"; });
    resetAllB.addEventListener("mouseleave", () => { resetAllB.style.background = "#2a1a1a"; resetAllB.style.borderColor = "#553333"; resetAllB.style.color = "#ff8888"; });
    resetAllB.addEventListener("click", async () => {
      // Reset all transforms
      dOX=0; dOY=0; edScale=1; edFlipH=false; edFlipV=false; edRotate=0;
      // Reset crop
      edCropBox=null; edAppliedCrop=null; edCropMode=false;
      // Reset lasso
      edLassoOps=[]; edLassoInverted=false; edLassoCurrentPts=[]; edLassoDrawing=false;
      _lassoMaskDirty=true; _lassoCursorNorm=null; stopLassoAnts();
      // Reset pixel edits
      edPixelTool = null; _edCvsEditsPx = null; _edEditsUndoStack = [];
      _edSmudgeBuf = null; _edBrushDrawing = false; _edBrushPts = []; _edBrushPos = null;
      _syncPixelToolUI();
      // Reset bg
      edBg=getEffectiveBgColor();
      // Restore original image (undo rembg)
      await doRembgReset();
      // Sync all UI
      syncCropToggle(); syncLassoToggle(); syncLassoInvertBtn(); syncRotUI(); syncBgUI(); syncFlipUI();
      updateDimLabels(); updateCropInfoLbl(); updateLassoInfoLbl(); updLbl();
      syncCvs(); redraw(); requestInpaintPreview();
    });
    pnlBody.appendChild(resetAllB);

    // ── Crop Region helpers ──────────────────────────────────────
    /** Current drawn image half-dims in canvas px (scale=1 at bFit, user zoom applied). */
    function _imgRenderDims() {
      const eW = effNatW(), eH = effNatH();
      const eff = bFit * edScale;
      return { dw: eW * eff, dh: eH * eff };
    }
    /**
     * Convert canvas-pixel → image-normalized (0..1).
     * Applies the INVERSE of the image's ctx transform: undo translate → undo rotate → undo flip.
     * Points are stored in pre-flip, pre-rotation image space so the backend can replay
     * the same transforms correctly.
     */
    function cropPxToNorm(px, py) {
      const { dw, dh } = _imgRenderDims();
      const icx = frameCX + dOX, icy = frameCY + dOY;
      // 1. Offset from image centre in canvas space
      let lx = px - icx, ly = py - icy;
      // 2. Inverse rotation (undo ctx.rotate)
      if (edRotate !== 0) {
        const a = -edRotate * Math.PI / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        const rx = lx * cos - ly * sin, ry = lx * sin + ly * cos;
        lx = rx; ly = ry;
      }
      // 3. Inverse flip (undo ctx.scale(flipH?-1:1, flipV?-1:1))
      if (edFlipH) lx = -lx;
      if (edFlipV) ly = -ly;
      // 4. Normalize: image drawn at -dw/2..dw/2 in local space
      return { nx: lx / dw + 0.5, ny: ly / dh + 0.5 };
    }
    /**
     * Convert image-normalized (0..1) → canvas-pixel.
     * Mirrors the ctx transform order: flip → rotate → translate to image centre.
     */
    function _normToCanvas(nx, ny, dw, dh) {
      let lx = (nx - 0.5) * dw, ly = (ny - 0.5) * dh;
      // 1. Apply flip (same as ctx.scale)
      if (edFlipH) lx = -lx;
      if (edFlipV) ly = -ly;
      // 2. Apply rotation (same as ctx.rotate)
      if (edRotate !== 0) {
        const a = edRotate * Math.PI / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        const rx = lx * cos - ly * sin, ry = lx * sin + ly * cos;
        lx = rx; ly = ry;
      }
      // 3. Translate to canvas coords
      return { cx: frameCX + dOX + lx, cy: frameCY + dOY + ly };
    }
    function cropHitTest(cx, cy) {
      if (!edCropBox) return null;
      const fx = frameCX - frameW / 2, fy = frameCY - frameH / 2;
      const bx = fx + edCropBox.x * frameW, by = fy + edCropBox.y * frameH;
      const bw = edCropBox.w * frameW, bh = edCropBox.h * frameH;
      const E = 8;
      const nL = Math.abs(cx - bx) <= E, nR = Math.abs(cx - (bx + bw)) <= E;
      const nT = Math.abs(cy - by) <= E, nB = Math.abs(cy - (by + bh)) <= E;
      const iH = cx >= bx - E && cx <= bx + bw + E;
      const iV = cy >= by - E && cy <= by + bh + E;
      if (nL && nT) return 'top-left'; if (nR && nT) return 'top-right';
      if (nL && nB) return 'bottom-left'; if (nR && nB) return 'bottom-right';
      if (nL && iV) return 'left'; if (nR && iV) return 'right';
      if (nT && iH) return 'top'; if (nB && iH) return 'bottom';
      if (cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh) return 'move';
      return null;
    }
    function cropCursorFor(hit) {
      return {'top-left':'nwse-resize','bottom-right':'nwse-resize','top-right':'nesw-resize','bottom-left':'nesw-resize','top':'ns-resize','bottom':'ns-resize','left':'ew-resize','right':'ew-resize','move':'grab'}[hit] || 'crosshair';
    }
    function clampCropBox() {
      if (!edCropBox) return;
      edCropBox.x = Math.max(0, Math.min(edCropBox.x, 1 - 0.02));
      edCropBox.y = Math.max(0, Math.min(edCropBox.y, 1 - 0.02));
      edCropBox.w = Math.max(0.02, Math.min(edCropBox.w, 1 - edCropBox.x));
      edCropBox.h = Math.max(0.02, Math.min(edCropBox.h, 1 - edCropBox.y));
    }
    function updateCropInfoLbl() {
      if (!edCropBox || !edCropMode) { cropInfoLbl.textContent = ''; return; }
      const baseW = effNatW(), baseH = effNatH();
      const w = Math.round(edCropBox.w * baseW), h = Math.round(edCropBox.h * baseH);
      cropInfoLbl.textContent = `${w} \u00d7 ${h} px`;
    }
    function drawCropOverlay(ctx) {
      if (!edCropBox || !edCropMode) return;
      const fx = frameCX - frameW / 2, fy = frameCY - frameH / 2;
      const bx = fx + edCropBox.x * frameW, by = fy + edCropBox.y * frameH;
      const bw = edCropBox.w * frameW, bh = edCropBox.h * frameH;
      ctx.save();
      // dim outside crop
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath(); ctx.rect(fx, fy, frameW, frameH); ctx.rect(bx, by, bw, bh); ctx.fill('evenodd');
      // border
      ctx.strokeStyle = '#d5ff6b'; ctx.lineWidth = 1.5;
      ctx.strokeRect(bx + 0.75, by + 0.75, bw - 1.5, bh - 1.5);
      // handles
      const hs = 4;
      ctx.fillStyle = 'rgba(140,140,50,0.7)'; ctx.strokeStyle = '#d5ff6b'; ctx.lineWidth = 1;
      [[bx,by],[bx+bw,by],[bx,by+bh],[bx+bw,by+bh],
       [bx+bw/2,by],[bx+bw/2,by+bh],[bx,by+bh/2],[bx+bw,by+bh/2]].forEach(([hx,hy]) => {
        ctx.fillRect(hx-hs, hy-hs, hs*2, hs*2); ctx.strokeRect(hx-hs, hy-hs, hs*2, hs*2);
      });
      // rule-of-thirds inside crop
      ctx.strokeStyle = 'rgba(213,255,107,0.12)'; ctx.lineWidth = 0.5;
      for (let i = 1; i < 3; i++) {
        ctx.beginPath(); ctx.moveTo(bx + bw/3*i, by); ctx.lineTo(bx + bw/3*i, by+bh); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bx, by + bh/3*i); ctx.lineTo(bx+bw, by + bh/3*i); ctx.stroke();
      }
      // dimensions text
      if (bw > 60 && bh > 30) {
        const baseW = effNatW(), baseH = effNatH();
        const cpW = Math.round(edCropBox.w * baseW), cpH = Math.round(edCropBox.h * baseH);
        ctx.fillStyle = '#d5ff6b'; ctx.font = '11px system-ui';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`${cpW} \u00d7 ${cpH}`, bx + bw/2, by + bh/2);
        ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
      }
      ctx.restore();
    }

    pnlFoot.appendChild(zoomLbl);
    pnlFoot.appendChild(applyB);
    pnlFoot.appendChild(cancelB);
    pnl.appendChild(pnlBody);
    pnl.appendChild(pnlFoot);

    // canvas area
    const ca = document.createElement("div");
    ca.style.cssText = "flex:1;position:relative;overflow:hidden;background:#0d0d0d;cursor:grab;";
    const cvs = document.createElement("canvas");
    cvs.style.cssText = "display:block;width:100%;height:100%;";
    const hint = document.createElement("div");
    hint.style.cssText = `position:absolute;bottom:${_pad8};left:0;right:0;text-align:center;color:#333;font-size:${_fs10};pointer-events:none;`;
    hint.textContent = "Drag to pan \u00b7 Scroll to zoom";
    ca.appendChild(cvs); ca.appendChild(hint);
    body.appendChild(pnl); body.appendChild(ca);
    dlg.appendChild(hdr); dlg.appendChild(body);
    ov.appendChild(dlg); document.body.appendChild(ov);

    // ── helpers ───────────────────────────────────────────────
    function updLbl() {
      const parts = [`Zoom: ${Math.round(edScale*100)}%`];
      if (edRotate)            parts.push(`${edRotate}\u00b0`);
      if (edFlipH)             parts.push("\u2194 H");
      if (edFlipV)             parts.push("\u2195 V");
      zoomLbl.textContent = parts.join(" \u00b7 ");
    }
    function effNatW() { return edAppliedCrop ? Math.round(edNatW * edAppliedCrop.cw) : edNatW; }
    function effNatH() { return edAppliedCrop ? Math.round(edNatH * edAppliedCrop.ch) : edNatH; }
    function _rotDims() {
      const w = effNatW(), h = effNatH();
      const rf = edRotate * Math.PI / 180;
      const c = Math.abs(Math.cos(rf)), s = Math.abs(Math.sin(rf));
      return { rW: w*c+h*s, rH: w*s+h*c };
    }
    function _bfitOf(rW, rH) {
      const fm = getFitModeWidget()?.value ?? "letterbox";
      return fm === "crop" ? Math.max(frameW/rW, frameH/rH) : Math.min(frameW/rW, frameH/rH);
    }
    function doFill() {
      const {rW,rH}=_rotDims(); const bf=_bfitOf(rW,rH);
      dOX=0;dOY=0; edScale=Math.max(frameW/(rW*bf),frameH/(rH*bf)); updLbl();
    }
    function doFitW() {
      const {rW,rH}=_rotDims(); const bf=_bfitOf(rW,rH);
      dOX=0;dOY=0; edScale=frameW/(rW*bf); updLbl();
    }
    function doFitH() {
      const {rW,rH}=_rotDims(); const bf=_bfitOf(rW,rH);
      dOX=0;dOY=0; edScale=frameH/(rH*bf); updLbl();
    }

    // ── inpaint preview (Telea / Navier-Stokes) ────────────────────────────
    function requestInpaintPreview() {
      // Clear stale preview immediately so the old (unrotated) result is never shown
      edInpaintPreview = null;
      if (edBg !== "telea" && edBg !== "navier-stokes") {
        edInpaintDirty = false;
        return;
      }
      clearTimeout(edReqHandle);
      edInpaintDirty = true;
      redraw();
      const transform = {
        ox:dOX/frameW, oy:dOY/frameH, scale:edScale,
        flipH:edFlipH, flipV:edFlipV, rotate:edRotate, bg:edBg
      };
      if (edAppliedCrop) { transform.cx = edAppliedCrop.cx; transform.cy = edAppliedCrop.cy; transform.cw = edAppliedCrop.cw; transform.ch = edAppliedCrop.ch; }
      if (edLassoOps.length > 0) { transform.lassoOps = edLassoOps; }
      if (edLassoInverted) { transform.lassoInverted = true; }
      const fn = items[curIdx]?.filename ?? "";
      const cacheKey = JSON.stringify(transform) + "|" + fn;
      edReqHandle = setTimeout(async () => {
        if (!edImg || !fn) return;
        const cached = edPreviewCache.get(cacheKey);
        if (cached) { edInpaintPreview=cached; edInpaintDirty=false; redraw(); return; }
        try {
          const resp = await fetch("/multi_image_loader/preview", {
            method: "POST",
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify({filename: fn, transform, refW:edRefW, refH:edRefH})
          });
          if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
          const { dataUrl } = await resp.json();
          const img = new Image();
          img.onload = () => {
            if (edPreviewCache.size > 30) edPreviewCache.delete(edPreviewCache.keys().next().value);
            edPreviewCache.set(cacheKey, img);
            edInpaintPreview = img; edInpaintDirty = false; redraw();
          };
          img.src = dataUrl;
        } catch(e) {
          console.error("[MIL] inpaint preview error (rotate="+transform.rotate+" bg="+transform.bg+"):", e.message);
          edInpaintDirty = false; redraw();
        }
      }, 350);
    }

    function syncCvs() {
      const r = ca.getBoundingClientRect();
      if (cvs.width!==Math.round(r.width)||cvs.height!==Math.round(r.height)) {
        cvs.width=Math.round(r.width); cvs.height=Math.round(r.height);
      }
      const asp = edRefW/edRefH, cw=cvs.width, ch=cvs.height, pad=40;
      const maxW=cw-pad*2, maxH=ch-pad*2;
      if (asp>=maxW/maxH) { frameW=maxW; frameH=Math.round(maxW/asp); }
      else               { frameH=maxH; frameW=Math.round(maxH*asp); }
      frameCX=cw/2; frameCY=ch/2;
      // bFit accounts for rotated bounding box of effective (possibly cropped) image
      // Respects fit_mode: crop=max (fill), letterbox=min (fit)
      const eW = effNatW(), eH = effNatH();
      const rf=edRotate*Math.PI/180, c=Math.abs(Math.cos(rf)), s=Math.abs(Math.sin(rf));
      const rW=eW*c+eH*s, rH=eW*s+eH*c;
      const edFitMode = getFitModeWidget()?.value ?? "letterbox";
      bFit = edFitMode === "crop"
        ? Math.max(frameW/rW, frameH/rH)
        : Math.min(frameW/rW, frameH/rH);
    }

    function redraw() {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        syncCvs();
        const ctx = cvs.getContext("2d");
        const cw=cvs.width, ch=cvs.height;
        const fx=frameCX-frameW/2, fy=frameCY-frameH/2;
        // full-canvas checkerboard
        const T=14;
        for(let r=0;r<Math.ceil(ch/T);r++) for(let c=0;c<Math.ceil(cw/T);c++) {
          ctx.fillStyle=(r+c)%2===0?"#1a1a1a":"#141414";
          ctx.fillRect(c*T,r*T,T,T);
        }
        // background fill inside frame — uses per-image edBg (initialized from node bg_color, overridable per-image)
        const bgC = /^#[0-9a-fA-F]{6}$/.test(edBg) ? edBg : "#808080";
        ctx.fillStyle=bgC; ctx.fillRect(fx,fy,frameW,frameH);
        if (edBg==="telea"||edBg==="navier-stokes") {
          ctx.save(); ctx.strokeStyle="rgba(90,122,191,0.18)"; ctx.lineWidth=1;
          for(let i=-frameH;i<frameW+frameH;i+=14){
            ctx.beginPath(); ctx.moveTo(fx+i,fy); ctx.lineTo(fx+i+frameH,fy+frameH); ctx.stroke();
          }
          ctx.restore();
        }
        // image rendering
        const isInpaint = edBg==="telea"||edBg==="navier-stokes";
        if (isInpaint && edInpaintPreview && !edInpaintDirty) {
          // Server-rendered result — draw it filling the reference frame (already fully transformed)
          ctx.drawImage(edInpaintPreview, fx, fy, frameW, frameH);
        } else {
          if (edImg) {
            const eW = effNatW(), eH = effNatH();
            const eff=bFit*edScale;
            const dw=eW*eff, dh=eH*eff;
            ctx.save();
            ctx.translate(frameCX+dOX, frameCY+dOY);
            ctx.rotate(edRotate*Math.PI/180);
            ctx.scale(edFlipH?-1:1, edFlipV?-1:1);
            if (edAppliedCrop) {
              const sx = edAppliedCrop.cx * edNatW, sy = edAppliedCrop.cy * edNatH;
              const sw = edAppliedCrop.cw * edNatW, sh = edAppliedCrop.ch * edNatH;
              ctx.drawImage(edImg, sx, sy, sw, sh, -dw/2, -dh/2, dw, dh);
            } else {
              ctx.drawImage(edImg,-dw/2,-dh/2,dw,dh);
            }
            // ── Pixel edits overlay (blur/smudge/CA Fill) ──
            if (_edCvsEditsPx) {
              ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
              ctx.drawImage(_edCvsEditsPx, -dw/2, -dh/2, dw, dh);
            }
            // Lasso mask overlay — show bg color outside selection.
            // In pixels mode: only shown before pixel edits start (_edCvsEditsPx==null),
            // because once initialized, the lasso is already baked into _edCvsEditsPx.
            const showLassoOverlay = (edLassoOps.length > 0 || edLassoInverted) &&
              (edPanelMode !== "pixels" || !_edCvsEditsPx);
            if (showLassoOverlay) {
              const mw = Math.ceil(dw), mh = Math.ceil(dh);
              // Build mask canvas (white = inside selection)
              if (!_lassoOverlayCvs) _lassoOverlayCvs = document.createElement('canvas');
              _lassoOverlayCvs.width = mw; _lassoOverlayCvs.height = mh;
              const mx = _lassoOverlayCvs.getContext('2d');
              mx.clearRect(0, 0, mw, mh);
              for (const op of edLassoOps) {
                if (op.points.length < 3) continue;
                mx.globalCompositeOperation = op.mode === "add" ? "source-over" : "destination-out";
                mx.fillStyle = "white"; mx.beginPath();
                mx.moveTo(op.points[0][0]*mw, op.points[0][1]*mh);
                for (let k=1;k<op.points.length;k++) mx.lineTo(op.points[k][0]*mw, op.points[k][1]*mh);
                mx.closePath(); mx.fill();
              }
              if (edLassoInverted) { mx.globalCompositeOperation="xor"; mx.fillStyle="white"; mx.fillRect(0,0,mw,mh); }
              mx.globalCompositeOperation = "source-over";
              // Overlay: bg color everywhere, punched out by mask
              if (!_lassoOverlayBg) _lassoOverlayBg = document.createElement('canvas');
              _lassoOverlayBg.width=mw; _lassoOverlayBg.height=mh;
              const ox = _lassoOverlayBg.getContext('2d');
              ox.fillStyle = bgC; ox.fillRect(0,0,mw,mh);
              ox.globalCompositeOperation = 'destination-out';
              ox.drawImage(_lassoOverlayCvs, 0, 0);
              ox.globalCompositeOperation = 'source-over';
              ctx.drawImage(_lassoOverlayBg, -dw/2, -dh/2);
            }
            ctx.restore();
          }
          if (isInpaint) {
            // spinner overlay while computing
            ctx.fillStyle="rgba(0,0,0,0.5)"; ctx.fillRect(fx,fy,frameW,frameH);
            ctx.fillStyle="#888"; ctx.font="12px system-ui";
            ctx.textAlign="center"; ctx.textBaseline="middle";
            ctx.fillText("\u2699 Computing inpaint\u2026", frameCX, frameCY);
            ctx.textAlign="start"; ctx.textBaseline="alphabetic";
          }
        }
        // dim outside frame
        ctx.fillStyle="rgba(0,0,0,0.58)";
        ctx.fillRect(0,0,cw,fy); ctx.fillRect(0,fy+frameH,cw,ch-fy-frameH);
        ctx.fillRect(0,fy,fx,frameH); ctx.fillRect(fx+frameW,fy,cw-fx-frameW,frameH);
        // frame border
        ctx.strokeStyle="rgba(255,255,255,0.35)"; ctx.lineWidth=1.5;
        ctx.strokeRect(fx+0.75,fy+0.75,frameW-1.5,frameH-1.5);
        // ── Pixel tool brush cursor ──
        if (edPixelTool && _edBrushPos) {
          const rPx = parseFloat(ptBrSlider.value);
          ctx.save();
          ctx.strokeStyle = edPixelTool === "blur" ? "rgba(100,180,255,0.7)" : "rgba(255,180,100,0.7)";
          ctx.lineWidth = 1.5; ctx.setLineDash([4,3]);
          ctx.beginPath(); ctx.arc(_edBrushPos.cx, _edBrushPos.cy, rPx, 0, Math.PI*2); ctx.stroke();
          ctx.setLineDash([]);
          ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 0.5;
          ctx.beginPath(); ctx.moveTo(_edBrushPos.cx-6,_edBrushPos.cy); ctx.lineTo(_edBrushPos.cx+6,_edBrushPos.cy); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(_edBrushPos.cx,_edBrushPos.cy-6); ctx.lineTo(_edBrushPos.cx,_edBrushPos.cy+6); ctx.stroke();
          ctx.restore();
        }
        // ── Snap guide lines ──
        const _anySnap = _snapGuides.cx || _snapGuides.cy || _snapGuides.L || _snapGuides.R || _snapGuides.T || _snapGuides.B;
        if (_anySnap) {
          ctx.save();
          ctx.strokeStyle = 'rgba(64,160,255,0.70)';
          ctx.lineWidth = 1;
          ctx.setLineDash([5, 3]);
          // Vertical center line (image centre X aligned to frame centre X)
          if (_snapGuides.cx) {
            ctx.beginPath(); ctx.moveTo(frameCX, fy); ctx.lineTo(frameCX, fy + frameH); ctx.stroke();
          }
          // Horizontal center line
          if (_snapGuides.cy) {
            ctx.beginPath(); ctx.moveTo(fx, frameCY); ctx.lineTo(fx + frameW, frameCY); ctx.stroke();
          }
          ctx.setLineDash([]);
          ctx.lineWidth = 1.5;
          // Left-edge guide
          if (_snapGuides.L) {
            ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx, fy + frameH); ctx.stroke();
          }
          // Right-edge guide
          if (_snapGuides.R) {
            ctx.beginPath(); ctx.moveTo(fx + frameW, fy); ctx.lineTo(fx + frameW, fy + frameH); ctx.stroke();
          }
          // Top-edge guide
          if (_snapGuides.T) {
            ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx + frameW, fy); ctx.stroke();
          }
          // Bottom-edge guide
          if (_snapGuides.B) {
            ctx.beginPath(); ctx.moveTo(fx, fy + frameH); ctx.lineTo(fx + frameW, fy + frameH); ctx.stroke();
          }
          ctx.restore();
        }
        // rule-of-thirds (hide when crop overlay active — it draws its own)
        if (!edCropMode || !edCropBox) {
          ctx.strokeStyle="rgba(255,255,255,0.1)"; ctx.lineWidth=0.5;
          for(let i=1;i<3;i++) {
            ctx.beginPath(); ctx.moveTo(fx+frameW/3*i,fy); ctx.lineTo(fx+frameW/3*i,fy+frameH); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(fx,fy+frameH/3*i); ctx.lineTo(fx+frameW,fy+frameH/3*i); ctx.stroke();
          }
        }
        // crop region overlay
        drawCropOverlay(ctx);
        // lasso overlay
        drawLassoOverlay(ctx);
      });
    }

    // ── image load ───────────────────────────────────────────
    function saveToSes() {
      const fn = items[curIdx]?.filename; if (!fn) return;
      const hasAppliedCrop = edAppliedCrop && (edAppliedCrop.cx > 0 || edAppliedCrop.cy > 0 || edAppliedCrop.cw < 1 || edAppliedCrop.ch < 1);
      const hasLasso = edLassoOps.length > 0 || edLassoInverted;
      const hasPixelEdits = !!_edCvsEditsPx;
      const nodeBg = getEffectiveBgColor();
      if (dOX!==0||dOY!==0||edScale!==1.0||edFlipH||edFlipV||edRotate!==0||edBg!==nodeBg||hasAppliedCrop||hasLasso||hasPixelEdits) {
        const t = {ox:dOX/frameW,oy:dOY/frameH,scale:edScale,flipH:edFlipH,flipV:edFlipV,rotate:edRotate,bg:edBg};
        if (hasAppliedCrop) { t.cx = edAppliedCrop.cx; t.cy = edAppliedCrop.cy; t.cw = edAppliedCrop.cw; t.ch = edAppliedCrop.ch; }
        if (hasLasso) { t.lassoOps = edLassoOps; if (edLassoInverted) t.lassoInverted = true; }
        if (hasPixelEdits) { t.imageEditsDataUrl = _edCvsEditsPx.toDataURL("image/webp", 0.92); }
        ses[fn] = t;
      } else delete ses[fn];
    }
    async function loadIdx(idx) {
      curIdx=idx;
      cntEl.textContent=`${idx+1} / ${items.length}`;
      prevB.disabled=idx===0; nextB.disabled=idx===items.length-1;
      prevB.style.opacity=idx===0?"0.35":"1";
      nextB.style.opacity=idx===items.length-1?"0.35":"1";
      edImg=null; redraw();
      // Reset lasso state when switching images
      edLassoCurrentPts = []; edLassoDrawing = false; edLassoMode = false;
      _lassoCursorNorm = null;
      stopLassoAnts(); syncLassoToggle(); updateLassoInfoLbl();
      await new Promise(res=>{
        const el=new Image(); el.crossOrigin="anonymous";
        el.onload=()=>{
          edImg=el; edNatW=el.naturalWidth; edNatH=el.naturalHeight;
          // Reset pixel tool state on image switch
          edPixelTool = null; _edCvsEditsPx = null; _edEditsUndoStack = [];
          _edSmudgeBuf = null; _edBrushDrawing = false; _edBrushPts = []; _edBrushPos = null;
          _syncPixelToolUI();
          const t=ses[items[idx].filename];
          // Restore applied crop BEFORE syncCvs so bFit uses effective dims
          if (t && t.cx != null) edAppliedCrop = { cx: t.cx, cy: t.cy, cw: t.cw, ch: t.ch };
          else edAppliedCrop = null;
          edLassoOps = (t && t.lassoOps) ? t.lassoOps : [];
          edLassoInverted = !!(t && t.lassoInverted);
          _lassoMaskDirty = true;
          syncLassoInvertBtn();
          edCropBox = null; edCropDrag = null;
          syncCvs();
          dOX=(t?.ox??0)*frameW; dOY=(t?.oy??0)*frameH; edScale=t?.scale??1.0;
          edFlipH=!!(t?.flipH); edFlipV=!!(t?.flipV); edRotate=t?.rotate??0; edBg=t?.bg??getEffectiveBgColor();
          updateDimLabels(); updateCropInfoLbl();
          edInpaintPreview=null; edInpaintDirty=true;
          // Restore pixel edits from session
          if (t && t.imageEditsDataUrl) {
            try {
              const pxImg = new Image();
              pxImg.onload = () => {
                _edCvsEditsPx = document.createElement("canvas");
                _edCvsEditsPx.width = pxImg.naturalWidth; _edCvsEditsPx.height = pxImg.naturalHeight;
                _edCvsEditsPx.getContext("2d").drawImage(pxImg, 0, 0);
                redraw();
              };
              pxImg.src = t.imageEditsDataUrl;
            } catch(e) { console.warn("[MIL] Failed to restore pixel edits:", e); }
          }
          syncRotUI(); syncBgUI(); syncFlipUI(); updLbl(); _updatePxDimLbl(); redraw(); requestInpaintPreview(); res();
        };
        el.onerror=res; el.src=items[idx].src;
      });
    }

    // ── events ───────────────────────────────────────────────
    function onGlobalMove(e) {
      // ── pixel tool drag ──
      if (edPixelTool && _edBrushDrawing) {
        const r = cvs.getBoundingClientRect();
        const cx = e.clientX - r.left, cy = e.clientY - r.top;
        _edBrushPos = { cx, cy };
        const pxScale = _edCvsEditsPx ? _edCvsEditsPx.width / (effNatW() * bFit * edScale) : 1;
        const imgCX = frameCX + dOX, imgCY = frameCY + dOY;
        const { dw, dh } = _imgRenderDims();
        const epx = (cx - (imgCX - dw/2)) * pxScale;
        const epy = (cy - (imgCY - dh/2)) * pxScale;
        const rPx = parseFloat(ptBrSlider.value) * pxScale;
        if (edPixelTool === "blur") {
          _edApplyBlur(epx, epy, rPx);
        } else {
          const prevPt = _edBrushPts.length > 0 ? _edBrushPts[_edBrushPts.length - 1] : null;
          if (prevPt) _edApplySmudge(prevPt, { x: epx, y: epy }, rPx);
        }
        _edBrushPts.push({ x: epx, y: epy });
        redraw(); return;
      }
      // ── pixel tool cursor tracking (not drawing) ──
      if (edPixelTool && !_edBrushDrawing) {
        const r = cvs.getBoundingClientRect();
        _edBrushPos = { cx: e.clientX - r.left, cy: e.clientY - r.top };
        redraw();
      }
      // ── lasso draw / track ──
      if (edLassoMode) {
        const r = cvs.getBoundingClientRect();
        const cx = e.clientX - r.left, cy = e.clientY - r.top;
        const { nx, ny } = cropPxToNorm(cx, cy);
        const cNx = Math.max(0, Math.min(1, nx)), cNy = Math.max(0, Math.min(1, ny));
        if (edLassoTool === "freehand" && edLassoDrawing) {
          edLassoCurrentPts.push({ x: cNx, y: cNy }); redraw(); return;
        }
        if (edLassoTool === "polygonal" && edLassoCurrentPts.length > 0) {
          _lassoCursorNorm = { x: cNx, y: cNy }; redraw(); return;
        }
        return; // lasso mode active — don't pan
      }
      // ── crop drag ──
      if (edCropMode && edCropDrag) {
        const r = cvs.getBoundingClientRect();
        const cx = e.clientX - r.left, cy = e.clientY - r.top;
        const { nx, ny } = cropPxToNorm(cx, cy);
        const cNx = Math.max(0, Math.min(1, nx)), cNy = Math.max(0, Math.min(1, ny));
        const ob = edCropDrag.origBox;
        const m = edCropDrag.mode;
        if (edCropDrag.isNew) {
          const ax = edCropDrag.anchorX, ay = edCropDrag.anchorY;
          edCropBox = { x: Math.min(ax, cNx), y: Math.min(ay, cNy), w: Math.abs(cNx - ax), h: Math.abs(cNy - ay) };
        } else if (m === 'move') {
          const dx = (cx - edCropDrag.startX) / frameW, dy = (cy - edCropDrag.startY) / frameH;
          let nx2 = Math.max(0, Math.min(1 - ob.w, ob.x + dx));
          let ny2 = Math.max(0, Math.min(1 - ob.h, ob.y + dy));
          edCropBox = { x: nx2, y: ny2, w: ob.w, h: ob.h };
        } else {
          let { x, y, w, h } = { ...ob };
          const right = x + w, bottom = y + h;
          if (m.includes('left'))   { const nX = Math.min(cNx, right - 0.02); w = right - nX; x = nX; }
          if (m.includes('right'))  { w = Math.max(0.02, cNx - x); }
          if (m.includes('top'))    { const nY = Math.min(cNy, bottom - 0.02); h = bottom - nY; y = nY; }
          if (m.includes('bottom')) { h = Math.max(0.02, cNy - y); }
          edCropBox = { x, y, w, h };
        }
        // ── AR constraint ─────────────────────────────────────────
        const arVal = parseCropAR();
        if (arVal && m !== 'move' && edCropBox) {
          const eW = effNatW(), eH = effNatH();
          const b = edCropBox;
          if (m === 'top' || m === 'bottom') {
            // h is driven by drag → derive w to match AR
            b.w = (b.h * eH * arVal) / eW;
          } else {
            // w is driven by drag → derive h to match AR
            b.h = (b.w * eW) / (arVal * eH);
          }
          // Now enforce that both dimensions fit inside [0,1] without breaking AR.
          // Anchor: the edge opposite to the drag handle stays fixed.
          // We scale the box down if it overflows, keeping the ratio locked.
          let scale = 1;
          // Max size limited by image edges
          if (m.includes('right') || m === 'bottom') {
            // anchor is left/top edge (x,y are fixed)
            if (b.x + b.w > 1) scale = Math.min(scale, (1 - b.x) / b.w);
            if (b.y + b.h > 1) scale = Math.min(scale, (1 - b.y) / b.h);
          } else if (m.includes('left') || m === 'top') {
            // anchor is right/bottom edge (x+w, y+h are fixed)
            const right  = b.x + b.w;
            const bottom = b.y + b.h;
            if (b.w > right)  scale = Math.min(scale, right  / b.w);
            if (b.h > bottom) scale = Math.min(scale, bottom / b.h);
          } else {
            // corner: anchor is the opposite corner
            if (b.x + b.w > 1) scale = Math.min(scale, (1 - b.x) / b.w);
            if (b.y + b.h > 1) scale = Math.min(scale, (1 - b.y) / b.h);
            if (b.x < 0)       scale = Math.min(scale, (b.x + b.w) / b.w);
            if (b.y < 0)       scale = Math.min(scale, (b.y + b.h) / b.h);
          }
          if (scale < 1) {
            // Scale both dims, keeping the far anchor fixed
            const newW = b.w * scale, newH = b.h * scale;
            if (m.includes('left'))   { b.x = (b.x + b.w) - newW; }
            if (m.includes('top'))    { b.y = (b.y + b.h) - newH; }
            b.w = newW; b.h = newH;
          }
          // Clamp position only (size is already valid from scale above)
          b.x = Math.max(0, Math.min(b.x, 1 - b.w));
          b.y = Math.max(0, Math.min(b.y, 1 - b.h));
          b.w = Math.max(0.02, b.w);
          b.h = Math.max(0.02, b.h);
        } else {
          clampCropBox();
        }
        updateCropInfoLbl(); redraw();
        return;
      }
      // ── pan drag with snap-to-edges ──
      if (!panSt) return;
      dOX = panSt.ox + (e.clientX - panSt.x);
      dOY = panSt.oy + (e.clientY - panSt.y);

      // Uses bFit (already accounts for fit_mode in syncCvs)
      const eW = effNatW(), eH = effNatH();
      const rot = edRotate * Math.PI / 180;
      const cA = Math.abs(Math.cos(rot)), sA = Math.abs(Math.sin(rot));
      const rW = eW * cA + eH * sA, rH = eW * sA + eH * cA;
      const hW = rW * bFit * edScale / 2;   // half-width  of image on canvas px
      const hH = rH * bFit * edScale / 2;   // half-height of image on canvas px

      // Frame half-extents (frame is centred on frameCX, frameCY)
      const hFW = frameW / 2, hFH = frameH / 2;

      // Snap threshold in canvas pixels
      const SNAP = 8;

      // Left edge of image  vs  left edge of frame
      const imgL = dOX - hW,  frmL = -hFW;
      const imgR = dOX + hW,  frmR =  hFW;
      const imgT = dOY - hH,  frmT = -hFH;
      const imgB = dOY + hH,  frmB =  hFH;

      // Reset guides before recalculating
      _snapGuides = { cx: false, cy: false, L: false, R: false, T: false, B: false };

      // Snap to center lines first (highest priority when near center)
      const snapX_center = Math.abs(dOX) < SNAP;
      const snapY_center = Math.abs(dOY) < SNAP;

      // Snap X: center → left edge → right edge
      if (snapX_center) {
        dOX = 0;                  // snap to horizontal center
        _snapGuides.cx = true;
      } else {
        const dL = imgL - frmL, dR = imgR - frmR;
        if (Math.abs(dL) < SNAP && (Math.abs(dL) <= Math.abs(dR))) {
          dOX = frmL + hW;       // snap left edge flush
          _snapGuides.L = true;
        } else if (Math.abs(dR) < SNAP) {
          dOX = frmR - hW;       // snap right edge flush
          _snapGuides.R = true;
        }
      }

      // Snap Y: center → top edge → bottom edge
      if (snapY_center) {
        dOY = 0;                  // snap to vertical center
        _snapGuides.cy = true;
      } else {
        const dT = imgT - frmT, dB = imgB - frmB;
        if (Math.abs(dT) < SNAP && (Math.abs(dT) <= Math.abs(dB))) {
          dOY = frmT + hH;       // snap top edge flush
          _snapGuides.T = true;
        } else if (Math.abs(dB) < SNAP) {
          dOY = frmB - hH;       // snap bottom edge flush
          _snapGuides.B = true;
        }
      }

      redraw();
    }
    function onGlobalUp(e) {
      // ── pixel tool stroke end ──
      if (edPixelTool && _edBrushDrawing) {
        _edBrushDrawing = false; _edBrushPts = [];
        redraw(); return;
      }
      // ── lasso freehand end ──
      if (edLassoMode && edLassoDrawing && edLassoTool === "freehand") {
        edLassoDrawing = false;
        if (edLassoCurrentPts.length < 5) { edLassoCurrentPts = []; }
        else { commitLassoShape(edLassoCurrentPts, e); }
        redraw(); ca.style.cursor = e.shiftKey ? _lassoCursors.add : e.altKey ? _lassoCursors.subtract : _lassoCursors.normal; return;
      }
      if (edCropMode && edCropDrag) {
        edCropDrag = null;
        const r = cvs.getBoundingClientRect();
        const hit = cropHitTest(e.clientX - r.left, e.clientY - r.top);
        ca.style.cursor = hit ? cropCursorFor(hit) : 'crosshair';
        updateCropInfoLbl(); return;
      }
      if (panSt) {
        panSt = null;
        // Clear snap guides when releasing pan
        _snapGuides = { cx: false, cy: false, L: false, R: false, T: false, B: false };
        ca.style.cursor = edLassoMode ? _lassoCursors.normal : edCropMode ? "crosshair" : "grab";
        requestInpaintPreview();
      }
    }
    cvs.addEventListener("mousedown", e=>{
      if (e.button!==0) return;
      // ── pixel tool start ──
      if (edPixelTool) {
        _edEnsureEditsPx(); _edSaveUndo();
        _edBrushDrawing = true;
        _edSmudgeBuf = null; // reset smudge buffer so each stroke samples fresh pixels
        const r = cvs.getBoundingClientRect();
        const cx = e.clientX - r.left, cy = e.clientY - r.top;
        _edBrushPos = { cx, cy };
        const pxScale = _edCvsEditsPx ? _edCvsEditsPx.width / (effNatW() * bFit * edScale) : 1;
        const imgCX = frameCX + dOX, imgCY = frameCY + dOY;
        const { dw, dh } = _imgRenderDims();
        _edBrushPts = [{ x: (cx - (imgCX - dw/2)) * pxScale, y: (cy - (imgCY - dh/2)) * pxScale }];
        return;
      }
      // ── lasso start / polygonal click ──
      if (edLassoMode) {
        const r = cvs.getBoundingClientRect();
        const cx = e.clientX - r.left, cy = e.clientY - r.top;
        const { nx, ny } = cropPxToNorm(cx, cy);
        const cNx = Math.max(0, Math.min(1, nx)), cNy = Math.max(0, Math.min(1, ny));
        if (edLassoTool === "freehand") {
          edLassoCurrentPts = [{ x: cNx, y: cNy }]; edLassoDrawing = true; ca.style.cursor = 'crosshair';
        } else {
          if (edLassoCurrentPts.length >= 3) {
            const { dw: _cdw, dh: _cdh } = _imgRenderDims();
            const p0c = _normToCanvas(edLassoCurrentPts[0].x, edLassoCurrentPts[0].y, _cdw, _cdh);
            const d = Math.hypot(cx - p0c.cx, cy - p0c.cy); // distance in canvas pixels
            if (d < 10) { commitLassoShape(edLassoCurrentPts, e); return; }
          }
          edLassoCurrentPts.push({ x: cNx, y: cNy }); redraw();
        }
        return;
      }
      if (edCropMode) {
        const r = cvs.getBoundingClientRect();
        const cx = e.clientX - r.left, cy = e.clientY - r.top;
        const hit = cropHitTest(cx, cy);
        if (hit) {
          edCropDrag = { mode: hit, startX: cx, startY: cy, origBox: { ...edCropBox } };
          ca.style.cursor = hit === 'move' ? 'grabbing' : cropCursorFor(hit);
        } else {
          const fx = frameCX - frameW/2, fy = frameCY - frameH/2;
          if (cx >= fx && cy >= fy && cx <= fx+frameW && cy <= fy+frameH) {
            const { nx, ny } = cropPxToNorm(cx, cy);
            edCropBox = { x: nx, y: ny, w: 0.001, h: 0.001 };
            edCropDrag = { mode:'bottom-right', startX:cx, startY:cy, origBox:{x:nx,y:ny,w:0.001,h:0.001}, isNew:true, anchorX:nx, anchorY:ny };
            ca.style.cursor = 'crosshair';
          }
        }
        return;
      }
      panSt={x:e.clientX,y:e.clientY,ox:dOX,oy:dOY}; ca.style.cursor="grabbing";
    });
    cvs.addEventListener("mousemove", e=>{
      // Pixel tool cursor tracking on canvas
      if (edPixelTool) {
        const r = cvs.getBoundingClientRect();
        _edBrushPos = { cx: e.clientX - r.left, cy: e.clientY - r.top };
        ca.style.cursor = "none";
        redraw(); return;
      }
      if (edLassoMode) {
        ca.style.cursor = e.shiftKey ? _lassoCursors.add : e.altKey ? _lassoCursors.subtract : _lassoCursors.normal;
        return;
      }
      if (edCropMode && !edCropDrag) {
        const r = cvs.getBoundingClientRect();
        const hit = cropHitTest(e.clientX - r.left, e.clientY - r.top);
        ca.style.cursor = hit ? cropCursorFor(hit) : 'crosshair';
      }
    });
    cvs.addEventListener("dblclick", e => {
      if (edLassoMode && edLassoTool === "polygonal" && edLassoCurrentPts.length >= 3) {
        e.preventDefault(); commitLassoShape(edLassoCurrentPts, e);
      }
    });
    document.addEventListener("keydown", e => {
      if (edLassoMode && e.key === "Escape" && edLassoCurrentPts.length > 0) {
        edLassoCurrentPts = []; edLassoDrawing = false; _lassoCursorNorm = null; redraw();
      }
    });
    window.addEventListener("mousemove", onGlobalMove);
    window.addEventListener("mouseup",   onGlobalUp);
    cvs.addEventListener("wheel", e=>{
      e.preventDefault();
      const f=e.deltaY<0?1.12:0.89;
      const r=cvs.getBoundingClientRect();
      const mx=e.clientX-r.left-frameCX, my=e.clientY-r.top-frameCY;
      dOX=(dOX-mx)*f+mx; dOY=(dOY-my)*f+my;
      edScale=Math.max(0.05,Math.min(20,edScale*f)); updLbl(); redraw();
      requestInpaintPreview();
    },{passive:false});
    const ro=new ResizeObserver(()=>redraw()); ro.observe(ca);
    function onKey(e) {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
      if (e.key === "ArrowLeft"  && curIdx > 0)              { saveToSes(); loadIdx(curIdx-1); }
      if (e.key === "ArrowRight" && curIdx < items.length-1) { saveToSes(); loadIdx(curIdx+1); }
      if (e.key === "Escape") doClose();
      // Ctrl+Z: undo pixel edits
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey && edPixelTool && _edEditsUndoStack.length > 0) {
        e.preventDefault(); e.stopImmediatePropagation();
        _edUndoEdits(); return;
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    prevB.addEventListener("click", ()=>{ if(curIdx>0)             { saveToSes(); loadIdx(curIdx-1); } });
    nextB.addEventListener("click", ()=>{ if(curIdx<items.length-1){ saveToSes(); loadIdx(curIdx+1); } });

    // ── apply / cancel / close ────────────────────────────────
    function doClose() {
      clearTimeout(edReqHandle);
      cancelAnimationFrame(rafId); ro.disconnect();
      stopLassoAnts();
      window.removeEventListener("keydown",    onKey, { capture: true });
      window.removeEventListener("mousemove",  onGlobalMove);
      window.removeEventListener("mouseup",    onGlobalUp);
      ov.remove();
    }
    function doApply() {
      // Auto-commit any pending lasso contour the user forgot to apply
      // Auto-commit any pending lasso drawing
      if (edLassoCurrentPts.length >= 3) {
        const normalized = edLassoCurrentPts.map(p => [p.x, p.y]);
        edLassoOps.push({ mode: "add", points: normalized });
        edLassoCurrentPts = []; edLassoDrawing = false;
        _lassoMaskDirty = true; stopLassoAnts();
      }
      // Auto-commit any pending crop box the user forgot to apply
      if (edCropBox) {
        if (edAppliedCrop) {
          edAppliedCrop = {
            cx: edAppliedCrop.cx + edCropBox.x * edAppliedCrop.cw,
            cy: edAppliedCrop.cy + edCropBox.y * edAppliedCrop.ch,
            cw: edCropBox.w * edAppliedCrop.cw,
            ch: edCropBox.h * edAppliedCrop.ch,
          };
        } else {
          edAppliedCrop = { cx: edCropBox.x, cy: edCropBox.y, cw: edCropBox.w, ch: edCropBox.h };
        }
        edCropBox = null; edCropMode = false;
      }
      saveToSes();
      const valid=new Set(items.map(i=>i.filename));
      const _nodeBg = getEffectiveBgColor();
      // commit session to cropMap — preserve mask data that lives alongside edit transforms
      pushUndoState();
      for (const fn of valid) {
        const t=ses[fn];
        // Carry forward existing mask data
        const prevMask = cropMap[fn]?.maskOps;
        const prevMaskInv = cropMap[fn]?.maskInverted;
        const prevMaskXf = cropMap[fn]?.maskXform;
        if (t&&(t.ox!==0||t.oy!==0||t.scale!==1.0||t.flipH||t.flipV||(t.rotate||0)!==0||(t.bg&&t.bg!==_nodeBg)||
            (t.cx!=null&&(t.cx>0||t.cy>0||t.cw<1||t.ch<1))||(t.lassoOps&&t.lassoOps.length>0)||t.lassoInverted||t.imageEditsDataUrl)) {
          cropMap[fn]=t;
        } else {
          // No edit transforms — keep entry only if mask data exists
          if (prevMask) { cropMap[fn] = {}; } else { delete cropMap[fn]; }
        }
        // Restore mask data on whatever entry remains
        if (cropMap[fn]) {
          if (prevMask) cropMap[fn].maskOps = prevMask;
          if (prevMaskInv) cropMap[fn].maskInverted = prevMaskInv;
          if (prevMaskXf) cropMap[fn].maskXform = prevMaskXf;
        }
      }
      persistCropData(); persist(); doClose();
      renderCropPreviews();  // async: update thumbnails with crop applied
    }
    applyB.addEventListener("click",  doApply);
    cancelB.addEventListener("click", doClose);
    // (click outside overlay intentionally disabled — use Cancel or Apply)

    // ── init ───────────────────────────────────────────────
    async function init() {
      // Prime edRefW/H from aspect_ratio + megapixels (or first image if "none")
      if (items.length > 0) {
        try {
          const { refW, refH } = await computeRefDims();
          edRefW = refW; edRefH = refH;
        } catch {
          // fallback: load first image naturally
          await new Promise(r => {
            const el0 = new Image(); el0.crossOrigin = "anonymous";
            el0.onload = () => { edRefW = el0.naturalWidth; edRefH = el0.naturalHeight; r(); };
            el0.onerror = r; el0.src = items[0].src;
          });
        }
      }
      cropArInput.value = (_nodeArVal && _nodeArVal !== 'none') ? _nodeArVal : _simplifyAR(edRefW, edRefH);
      syncCvs();
      await loadIdx(startIdx);
    }
    init();
  }