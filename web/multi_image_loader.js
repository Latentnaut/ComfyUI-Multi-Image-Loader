/**
 * ComfyUI-Multi-Image-Loader  –  Frontend Extension v3.0
 *
 * Changes in v3.0:
 *  - Multi-layer canvas in Mask Editor: 3 stacked canvases (base, mask, tool)
 *    so mousemove only redraws the tool cursor layer → 80%+ fewer draw calls.
 *  - Professional brush engine: Catmull-Rom → Bézier interpolation with
 *    arc-length stamp spacing and pre-rendered soft tip (hardness gradient).
 *  - Keyboard shortcuts: B/E/L/P tools, [/] brush size, Ctrl+Z undo,
 *    Ctrl+Shift+Z redo, 0-9 quick opacity, Ctrl+I invert, Delete clear.
 *
 * Changes in v2.0:
 *  - OffscreenCanvas Worker: all heavy pixel work (crop transforms, fit
 *    previews, lasso mask compositing) now runs in a dedicated Web Worker
 *    (`mil_render_worker.js`). The main UI thread stays free → 0 ms freeze.
 *  - Parallel rendering: renderFitPreviews() and renderCropPreviews() now
 *    dispatch all jobs via Promise.all instead of sequential await loops.
 *
 * Changes in v1.9:
 *  - Double-click on any thumbnail now opens the crop/edit modal panel directly,
 *    as an alternative to hovering and clicking the ✂ button.
 *  - Fixed: aspect_ratio / fit_mode / megapixels now update thumbnails live;
 *    dead previewBtn references that threw a silent TypeError were removed.
 *
 * Changes in v1.8:
 *  - Ctrl+V paste from clipboard: select the node and press Ctrl+V to add a
 *    copied image directly from the system clipboard (works with screenshots,
 *    browser images, etc.)
 *
 * Changes in v1.7:
 *  - Responsive Crop Editor modal: scales properly on 4K / 5K / HiDPI displays
 *  - Dialog grows to clamp(700px,90vw,1920px) × clamp(480px,88vh,1200px)
 *  - uiScale factor derived from physical screen resolution (devicePixelRatio × screen.width)
 *  - All sidebar elements (fonts, buttons, inputs, padding) scale with uiScale
 *
 * Changes in v1.6:
 *  - "Remove Background" section in Crop Editor modal panel
 *  - Powered by rembg via /multi_image_loader/rembg backend endpoint
 *  - Model selector, post-process/alpha-matting options, collapsible advanced params
 *  - Result overwrites source file as RGBA PNG; canvas updates immediately
 */

import { app } from "../../scripts/app.js";

// ─── constants ───────────────────────────────────────────────────────────────

const NODE_TYPE  = "MultiImageLoader";
const UPLOAD_URL = "/multi_image_loader/upload";

// Layout constants (px)
const NODE_HEADER_H  = 30;
const NODE_SLOT_H    = 22;
const NODE_PADDING_V = 12;
const DROPZONE_H     = 110;
const STATUS_H       = 46;
const GAP            = 6;
const THUMB_W            = 72;
const THUMB_GAP          = 5;
const MAX_GRID_ROWS      = 4;   // rows visible before scroll kicks in
const COMPACT_DROPZONE_H = 32;  // collapsed height when images are loaded
const THUMB_SIZES        = { small: 52, medium: 72, large: 100 }; // px widths (grid mode)
const ROW_VIEW_HEIGHTS   = { small: 80, medium: 120, large: 160 }; // px heights (row mode)

// ─── helpers ─────────────────────────────────────────────────────────────────

async function uploadFiles(files) {
  const fd = new FormData();
  for (const f of files) fd.append("images", f, f.name);
  const resp = await fetch(UPLOAD_URL, { method: "POST", body: fd });
  if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
  const json = await resp.json();
  if (!json.success) throw new Error(json.error || "Unknown upload error");
  return json.files;
}

function fileToDataURL(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.readAsDataURL(file);
  });
}

/** Resolve natural pixel dimensions from any image URL or data-URL. */
function getImageDimensions(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 1, h: 1 });
    img.src = src;
  });
}

/** Build the /view URL ComfyUI uses to serve files from the input folder. */
function viewURL(filename) {
  return `/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=`;
}

// Inject global CSS once (scrollbars + drag styles)
function injectStyles() {
  if (document.getElementById("mil-global-style")) return;
  const style = document.createElement("style");
  style.id = "mil-global-style";
  style.textContent = `
    .mil-grid {
      scrollbar-width: thin;
      scrollbar-color: #606060 #252525;
    }
    .mil-grid::-webkit-scrollbar { width: 7px; }
    .mil-grid::-webkit-scrollbar-track {
      background: #252525;
      border-radius: 4px;
    }
    .mil-grid::-webkit-scrollbar-thumb {
      background: #606060;
      border-radius: 4px;
      border: 1px solid #252525;
    }
    .mil-grid::-webkit-scrollbar-thumb:hover { background: #888; }

    /* Drag-to-reorder */
    .mil-thumb { cursor: grab; }
    .mil-thumb:active { cursor: grabbing; }
    .mil-thumb.mil-dragging {
      opacity: 0.35;
      outline: 2px dashed #7ab0ff;
    }
    .mil-thumb.mil-drag-over {
      outline: 2px solid #ffe066;
      background: rgba(255,220,80,0.12);
    }
    .mil-first-badge {
      position: absolute;
      top: 2px;
      left: 3px;
      background: rgba(0,160,100,0.88);
      color: #fff;
      font-size: 8px;
      font-family: sans-serif;
      padding: 1px 4px;
      border-radius: 3px;
      pointer-events: none;
      font-weight: bold;
    }
    .mil-btn { transition: background 0.15s, border-color 0.15s; }
    @keyframes mil-fadein {
      from { opacity:0; transform:scale(0.96); }
      to   { opacity:1; transform:scale(1);    }
    }
    .mil-crop-enter { animation: mil-fadein 0.18s ease-out; }
    @keyframes mil-paste-flash {
      0%   { box-shadow: inset 0 0 0 2px #44ff88, 0 0 10px rgba(68,255,136,0.55); }
      15%  { box-shadow: inset 0 0 0 2px #44ff88, 0 0 10px rgba(68,255,136,0.55); }
      100% { box-shadow: inset 0 0 0 2px rgba(68,255,136,0),  0 0 0   rgba(68,255,136,0); }
    }
    .mil-paste-flash { animation: mil-paste-flash 5s ease-out forwards; }
    .mil-scroll-fade {
      position: absolute; bottom: 0; left: 0; right: 7px;
      height: 24px;
      background: linear-gradient(transparent, rgba(28,28,28,0.95));
      pointer-events: none;
      display: none;
      z-index: 1;
      border-radius: 0 0 4px 4px;
    }
  `;
  document.head.appendChild(style);
}

// ─── height calculation ───────────────────────────────────────────────────────

function computeIdealHeight(count, nodeWidth, thumbH, thumbW, rowView = false) {
  const th       = thumbH || thumbW;
  const innerW   = nodeWidth - 24;
  const cols     = rowView ? 1 : Math.max(1, Math.floor((innerW + THUMB_GAP) / (thumbW + THUMB_GAP)));
  const rows     = count > 0 ? Math.ceil(count / cols) : 0;
  // Row mode: show 1 visible row minimum so the node stays compact/shrinkable.
  // Grid mode: show up to MAX_GRID_ROWS before scrolling kicks in.
  const visRows  = rows > 0 ? (rowView ? 1 : Math.min(rows, MAX_GRID_ROWS)) : 0;
  const gridH    = visRows > 0 ? visRows * (th + THUMB_GAP) - THUMB_GAP + 4 : 0;
  const dropH    = count > 0 ? COMPACT_DROPZONE_H : DROPZONE_H;
  const statH    = count > 0 ? STATUS_H : 0;
  const extraGap = rows > 0 ? GAP * 2 : GAP;

  return (
    NODE_HEADER_H   +
    NODE_SLOT_H * 3 +
    NODE_PADDING_V  +
    dropH           +
    extraGap        +
    gridH           +
    statH           +
    8
  );
}

// ─── widget factory ───────────────────────────────────────────────────────────

function createWidget(node) {
  injectStyles();

  // ── root container ────────────────────────────────────────────────────────
  const root = document.createElement("div");
  root.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: ${GAP}px;
    padding: 4px 6px 6px;
    box-sizing: border-box;
    width: 100%;
    min-width: 180px;
    overflow: hidden;
  `;

  // ── drop zone ─────────────────────────────────────────────────────────────
  const dropZone = document.createElement("div");
  dropZone.style.cssText = `
    flex-shrink: 0;
    flex-grow: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    border: 2px dashed #5a7abf;
    border-radius: 10px;
    padding: 14px 10px;
    text-align: center;
    cursor: pointer;
    color: #8ebaff;
    font-size: 12px;
    font-family: sans-serif;
    background: rgba(60, 90, 150, 0.15);
    transition: background 0.2s, border-color 0.2s, min-height 0.15s, padding 0.15s;
    user-select: none;
    min-height: ${DROPZONE_H}px;
    box-sizing: border-box;
  `;
  dropZone.innerHTML = `
    <div style="font-size:18px;margin-bottom:2px;">🖼️</div>
    <div><strong>Drop images here</strong> or <strong>click to browse</strong></div>
    <div style="opacity:0.6;margin-top:4px;font-size:10px;">PNG · JPG · WebP · BMP</div>
    <div style="opacity:0.5;margin-top:6px;font-size:9px;">Fit mode applied using first image as canvas reference</div>
  `;

  dropZone.addEventListener("mouseenter", () => {
    dropZone.style.background = "rgba(90, 122, 191, 0.3)";
    dropZone.style.borderColor = "#7ab0ff";
  });
  dropZone.addEventListener("mouseleave", () => {
    dropZone.style.background = "rgba(60, 90, 150, 0.15)";
    dropZone.style.borderColor = "#5a7abf";
  });

  // ── hidden file input ─────────────────────────────────────────────────────
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.accept = "image/*";
  fileInput.style.display = "none";
  root.appendChild(fileInput);

  // ── thumbnail grid ────────────────────────────────────────────────────────
  const gridWrapper = document.createElement("div");
  gridWrapper.style.cssText = `
    position: relative;
    flex-grow: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  `;
  const scrollFade = document.createElement("div");
  scrollFade.className = "mil-scroll-fade";
  const grid = document.createElement("div");
  grid.className = "mil-grid";
  grid.style.cssText = `
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    gap: ${THUMB_GAP}px;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 2px;
    flex-grow: 1;
    min-height: 0;
    box-sizing: border-box;
  `;
  gridWrapper.appendChild(grid);
  gridWrapper.appendChild(scrollFade);

  // ── status bar ────────────────────────────────────────────────────────────
  const statusBar = document.createElement("div");
  statusBar.style.cssText = `
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: flex-end;
    font-family: sans-serif;
    font-size: 10px;
    color: #8899bb;
    padding: 6px 2px 4px;
    min-height: ${STATUS_H}px;
    box-sizing: border-box;
    gap: 8px;
  `;
  const statusLabel = document.createElement("span");
  statusLabel.style.textAlign = "center";

  // Right-side button group
  const btnGroup = document.createElement("div");
  btnGroup.style.cssText = `display:flex;gap:4px;align-items:center;justify-content:center;flex-shrink:0;white-space:nowrap;width:100%;`;

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "\u2715 Clear all";
  clearBtn.className = "mil-btn";
  clearBtn.style.cssText = `
    background: #3a2020;
    color: #ff8888;
    border: 1px solid #884444;
    border-radius: 4px;
    padding: 3px 10px;
    font-size: 10px;
    cursor: pointer;
    display: none;
  `;
  clearBtn.addEventListener("mouseenter", () => {
    clearBtn.style.background  = "#552828";
    clearBtn.style.borderColor = "#ff8888";
  });
  clearBtn.addEventListener("mouseleave", () => {
    clearBtn.style.background  = "#3a2020";
    clearBtn.style.borderColor = "#884444";
  });
  statusBar.appendChild(statusLabel);
  statusBar.appendChild(btnGroup);

  root.appendChild(dropZone);
  root.appendChild(gridWrapper);
  root.appendChild(statusBar);

  // ── state ─────────────────────────────────────────────────────────────────
  // Each item: { filename: string, src: string, previewSrc?: string }
  let items  = [];
  let thumbH = THUMB_W;  // updated from first image's aspect ratio
  let viewMode = "grid"; // "grid" | "row"

  // Drag-reorder state
  let dragSrcIdx = null;

  // Preview state
  let previewActive = false;
  // Per-image crop transforms: { filename → { ox, oy, scale } }
  let cropMap = {};

  // ── OffscreenCanvas Worker ─────────────────────────────────────────────────
  // Lazily initialised shared worker for heavy pixel work (crop, fit, lasso).
  // All rendering runs off the main thread → 0 ms UI freeze.
  let _renderWorker = null;
  let _workerJobId  = 0;
  const _pendingJobs = new Map();

  function getRenderWorker() {
    if (_renderWorker) return _renderWorker;
    // Resolve the worker path relative to the current script (ComfyUI serves
    // everything under /extensions/<node>/…).  We derive the base from the
    // module's own URL so it works regardless of the server layout.
    const scriptUrl = import.meta.url;                         // …/web/multi_image_loader.js
    const base      = scriptUrl.substring(0, scriptUrl.lastIndexOf("/") + 1);
    _renderWorker   = new Worker(base + "mil_render_worker.js");
    _renderWorker.addEventListener("message", (ev) => {
      const { jobId, dataUrl, error } = ev.data;
      const job = _pendingJobs.get(jobId);
      if (!job) return;
      _pendingJobs.delete(jobId);
      if (error) job.reject(new Error(error));
      else       job.resolve(dataUrl);
    });
    _renderWorker.addEventListener("error", (ev) => {
      console.error("[MIL Worker] error:", ev.message);
    });
    return _renderWorker;
  }

  /**
   * Send a render job to the Worker and return a Promise<string> (data URL).
   * The image is fetched as a Blob so it can be transferred zero-copy.
   */
  async function workerRender(type, imageSrc, params) {
    const resp = await fetch(imageSrc);
    const imageBlob = await resp.blob();
    const jobId = _workerJobId++;
    return new Promise((resolve, reject) => {
      _pendingJobs.set(jobId, { resolve, reject });
      getRenderWorker().postMessage(
        { jobId, type, imageBlob, params }
      );
    });
  }

  // ── view-mode toggle button ────────────────────────────────────────────────
  const viewToggleBtn = document.createElement("button");
  viewToggleBtn.title = "Toggle row / grid view";
  viewToggleBtn.className = "mil-btn";
  viewToggleBtn.style.cssText = `
    background: #252525;
    color: #aaa;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 3px 7px;
    font-size: 11px;
    cursor: pointer;
    display: none;
    line-height: 1;
  `;
  function syncViewToggleBtn() {
    viewToggleBtn.textContent = viewMode === "row" ? "⊞" : "☰";
    viewToggleBtn.title = viewMode === "row" ? "Switch to grid view" : "Switch to row view";
    viewToggleBtn.style.color  = viewMode === "row" ? "#7ab0ff" : "#aaa";
    viewToggleBtn.style.borderColor = viewMode === "row" ? "#5a7abf" : "#444";
  }
  viewToggleBtn.addEventListener("mouseenter", () => {
    viewToggleBtn.style.background = "#333";
  });
  viewToggleBtn.addEventListener("mouseleave", () => {
    viewToggleBtn.style.background = "#252525";
  });
  viewToggleBtn.addEventListener("click", () => {
    viewMode = viewMode === "grid" ? "row" : "grid";
    syncViewToggleBtn();
    render();
  });
  syncViewToggleBtn();
  btnGroup.appendChild(viewToggleBtn);

  // ── mask-view toggle button (◐) ──
  let maskViewMode = false; // when true: draw mask overlay on thumbnails
  const maskViewBtn = document.createElement("button");
  maskViewBtn.title = "Toggle mask view";
  maskViewBtn.className = "mil-btn";
  maskViewBtn.textContent = "\u25D0";
  maskViewBtn.style.cssText = `
    background: #252525;
    color: #aaa;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 3px 7px;
    font-size: 11px;
    cursor: pointer;
    display: none;
    line-height: 1;
  `;
  function syncMaskViewBtn() {
    maskViewBtn.style.color       = maskViewMode ? "#7fff7f" : "#aaa";
    maskViewBtn.style.borderColor = maskViewMode ? "#3a6a3a" : "#444";
    maskViewBtn.style.background  = maskViewMode ? "#1e2e1e" : "#252525";
    maskViewBtn.title              = maskViewMode ? "Hide mask overlay" : "Show mask overlay";
  }
  maskViewBtn.addEventListener("mouseenter", () => {
    if (!maskViewMode) maskViewBtn.style.background = "#333";
  });
  maskViewBtn.addEventListener("mouseleave", () => {
    maskViewBtn.style.background = maskViewMode ? "#1e2e1e" : "#252525";
  });
  maskViewBtn.addEventListener("click", () => {
    maskViewMode = !maskViewMode;
    syncMaskViewBtn();
    render();
  });
  syncMaskViewBtn();
  btnGroup.appendChild(maskViewBtn);
  btnGroup.appendChild(clearBtn);

  // ── helpers ───────────────────────────────────────────────────────────────

  function getImageListWidget() {
    return node.widgets?.find((w) => w.name === "image_list");
  }

  function getAspectRatioWidget() {
    return node.widgets?.find((w) => w.name === "aspect_ratio");
  }

  function getFitModeWidget() {
    return node.widgets?.find((w) => w.name === "fit_mode");
  }

  function getBgColorWidget() {
    return node.widgets?.find((w) => w.name === "bg_color");
  }

  /** Returns the effective hex bg color from the bg_color widget.
   *  Handles both word labels (gray/black/white) and legacy hex (#808080/#000000/#ffffff). */
  function getEffectiveBgColor() {
    const val = getBgColorWidget()?.value ?? "gray";
    // Word labels (new)
    const wordMap = { gray: "#808080", black: "#000000", white: "#ffffff" };
    if (wordMap[val]) return wordMap[val];
    // Hex values (legacy / pre-restart compatibility)
    if (/^#[0-9a-fA-F]{6}$/.test(val)) return val;
    return "#808080";
  }

  function persist() {
    const w = getImageListWidget();
    if (w) w.value = JSON.stringify(items.map((i) => i.filename));
    persistCropData();
    node.setDirtyCanvas(true, true);
  }

  function getCropDataWidget() {
    return node.widgets?.find((ww) => ww.name === "crop_data");
  }
  function hasCrop(filename) {
    const t = cropMap[filename];
    return !!(t && (t.ox!==0 || t.oy!==0 || t.scale!==1.0 || t.flipH || t.flipV ||
              (t.rotate||0)!==0 || (t.bg && t.bg !== getEffectiveBgColor()) ||
              (t.cx != null && (t.cx > 0 || t.cy > 0 || t.cw < 1 || t.ch < 1)) ||
              (t.lassoOps && t.lassoOps.length > 0) || t.lassoInverted));
  }
  function hasMask(filename) {
    const t = cropMap[filename];
    return !!(t && t.maskOps && t.maskOps.length > 0);
  }
  function persistCropData() {
    const w = getCropDataWidget();
    if (w) w.value = JSON.stringify(cropMap);
  }

  // Auto-update thumbnails after crop editor Apply.
  // Draws each image through the same canvas transform as the editor.
  async function computeRefDims() {
    const ar = getAspectRatioWidget()?.value ?? "none";
    const mp = node.widgets?.find(w => w.name === "megapixels")?.value ?? 1.0;
    if (ar !== "none") {
      const [aw, ah] = ar.split(":").map(Number);
      const totalPx = Math.max(1, mp * 1_000_000);
      const refW = Math.max(1, Math.round(Math.sqrt(totalPx * aw / ah)));
      const refH = Math.max(1, Math.round(Math.sqrt(totalPx * ah / aw)));
      return { refW, refH };
    }
    // "none" → use first image natural dims
    const r0 = await getImageDimensions(items[0].src);
    return { refW: r0.w, refH: r0.h };
  }

  // (renderCropPreviews — defined later after renderFitPreviews)

  function getMinThumbW() {
    const w = node.widgets?.find((ww) => ww.name === "thumb_size");
    return THUMB_SIZES[w?.value] ?? THUMB_W;
  }

  /** Compute actual display thumb width, filling available node width. */
  function getEffectiveThumbW() {
    const minW   = getMinThumbW();
    const innerW = Math.max(minW, node.size[0] - 24);
    if (viewMode === "row") return innerW;
    // Grid: fit as many columns of at-least-minW as possible, then spread to fill
    const cols = Math.max(1, Math.floor((innerW + THUMB_GAP) / (minW + THUMB_GAP)));
    // Width that exactly fills the row
    return Math.floor((innerW - (cols - 1) * THUMB_GAP) / cols);
  }

  /** Compute actual display thumb height, mode-aware.
   *  Grid: proportional to tw based on image AR.  Row: fixed comfortable height. */
  function getEffectiveThumbH(tw) {
    if (viewMode === "row") {
      const w = node.widgets?.find((ww) => ww.name === "thumb_size");
      return ROW_VIEW_HEIGHTS[w?.value] ?? 120;
    }
    return Math.max(20, Math.round(tw * thumbH / THUMB_W));
  }

  function resizeNode() {
    const curW   = node.size[0];
    const curH   = node.size[1];
    const tw     = getEffectiveThumbW();
    const th     = getEffectiveThumbH(tw);
    const minW   = getMinThumbW();
    const idealH = computeIdealHeight(items.length, curW, th, viewMode === 'row' ? tw : minW, viewMode === 'row');
    // Only grow — never shrink (user may manually set a larger size)
    if (idealH > curH) node.setSize([curW, idealH]);
  }

  /** Snap node to ideal height — used on mode switch (shrinks AND grows).
   *  Always shows up to MAX_GRID_ROWS visible rows in both grid and row modes. */
  function snapNodeToIdealH() {
    const curW   = node.size[0];
    const tw     = getEffectiveThumbW();
    const th     = getEffectiveThumbH(tw);
    const minW   = getMinThumbW();
    // For snapping: always use MAX_GRID_ROWS cap in both modes
    const count  = items.length;
    const cols   = viewMode === 'row' ? 1
                 : Math.max(1, Math.floor((curW - 24 + THUMB_GAP) / (minW + THUMB_GAP)));
    const rows   = count > 0 ? Math.ceil(count / cols) : 0;
    const vis    = Math.min(rows, MAX_GRID_ROWS);
    const gridH  = vis > 0 ? vis * (th + THUMB_GAP) - THUMB_GAP + 4 : 0;
    const dropH  = count > 0 ? COMPACT_DROPZONE_H : DROPZONE_H;
    const statH  = count > 0 ? STATUS_H : 0;
    const snapH  = NODE_HEADER_H + NODE_SLOT_H * 3 + NODE_PADDING_V
                 + dropH + (rows > 0 ? GAP * 2 : GAP) + gridH + statH + 8;
    node.setSize([curW, snapH]);
  }

  function updateScrollFade() {
    const hasOverflow = grid.scrollHeight > grid.clientHeight + 2;
    const atBottom    = grid.scrollHeight - grid.scrollTop <= grid.clientHeight + 4;
    scrollFade.style.display = (hasOverflow && !atBottom) ? "block" : "none";
  }
  grid.addEventListener("scroll", updateScrollFade);

  function updateDropZone(count) {
    if (count > 0) {
      dropZone.style.minHeight     = `${COMPACT_DROPZONE_H}px`;
      dropZone.style.padding       = "0 12px";
      dropZone.style.flexDirection = "row";
      dropZone.innerHTML = `<span style="font-size:10px;opacity:0.6;">＋ Drop or click to add more images</span>`;
    } else {
      dropZone.style.minHeight     = `${DROPZONE_H}px`;
      dropZone.style.padding       = "14px 10px";
      dropZone.style.flexDirection = "column";
      dropZone.innerHTML = `
        <div style="font-size:18px;margin-bottom:2px;">🖼️</div>
        <div><strong>Drop images here</strong> or <strong>click to browse</strong></div>
        <div style="opacity:0.6;margin-top:4px;font-size:10px;">PNG · JPG · WebP · BMP</div>
        <div style="opacity:0.5;margin-top:6px;font-size:9px;">Fit mode applied using first image as canvas reference</div>
      `;
    }
  }

  // ── render ────────────────────────────────────────────────────────────────

  function render() {
    statusLabel.style.color = "#8899bb";
    grid.innerHTML = "";
    const tw = getEffectiveThumbW();
    const th = getEffectiveThumbH(tw);

    items.forEach((item, idx) => {

      // ── wrapper ──────────────────────────────────────────────────────────
      const wrapper = document.createElement("div");
      wrapper.className = "mil-thumb";
      wrapper.draggable = true;
      wrapper.dataset.idx = idx;
      if (viewMode === "row") {
        wrapper.style.cssText = `
          position: relative;
          width: 100%;
          box-sizing: border-box;
          height: ${th}px;
          border-radius: 6px;
          overflow: hidden;
          border: 1px solid #444;
          flex-shrink: 0;
          background: #353535;
        `;
      } else {
        const arRatio = tw / th;   // e.g. 1.0 for 1:1, 1.778 for 16:9
        wrapper.style.cssText = `
          position: relative;
          min-width: ${tw}px;
          max-width: ${Math.round(tw * 1.5)}px;
          aspect-ratio: ${arRatio.toFixed(4)};
          border-radius: 6px;
          overflow: hidden;
          border: 1px solid #444;
          flex: 1 0 ${tw}px;
          background: #353535;
        `;
      }

      // ── image ─────────────────────────────────────────────────────────────
      const img = document.createElement("img");
      img.src = item.previewSrc || item.src;
      // previewSrc already has letterbox/crop baked in — use cover in grid to fill wrapper seamlessly
      // In row (list) mode always use contain so the full image is visible
      const fit = (viewMode === "row") ? "contain" : (item.previewSrc ? "cover" : "contain");
      const imgH = (viewMode === "row") ? `${th}px` : "100%";
      img.style.cssText = `width:100%;height:${imgH};object-fit:${fit};display:block;pointer-events:none;`;
      img.title = item.filename;

      // ── mask overlay canvas (maskViewMode) ──
      // When active: ALL thumbnails show pure B&W mask regardless of whether ops exist.
      // No maskOps = all black (default: unmasked). With maskOps = white where painted.
      let maskOvEl = null;
      const maskData = cropMap[item.filename]?.maskOps;
      if (maskViewMode) {
        // Hide the source image — replace with B&W mask
        img.style.visibility = "hidden";
        maskOvEl = document.createElement("canvas");
        maskOvEl.style.cssText = `position:absolute;inset:0;width:100%;height:${imgH};pointer-events:none;z-index:2;`;
        const drawOnCanvas = () => {
          const cw = maskOvEl.offsetWidth  || 72;
          const ch = maskOvEl.offsetHeight || 72;
          maskOvEl.width = cw; maskOvEl.height = ch;
          const octx = maskOvEl.getContext("2d");
          const inverted = !!(cropMap[item.filename]?.maskInverted);
          // Default: all black (fully unmasked)
          octx.fillStyle = "#000"; octx.fillRect(0, 0, cw, ch);
          if (maskData && maskData.length > 0) {
            for (const op of maskData) {
              // ── Fill op: draw pre-baked mask from dataUrl ──
              if (op.type === "fill" && (op.dataUrl || op._canvas)) {
                const drawFillOp = (source) => {
                  // source is black=masked, white=unmasked; thumbnail wants white=masked
                  const tmp = document.createElement("canvas"); tmp.width = cw; tmp.height = ch;
                  const tc = tmp.getContext("2d");
                  tc.drawImage(source, 0, 0, cw, ch);
                  const id = tc.getImageData(0, 0, cw, ch);
                  for (let pi = 0; pi < id.data.length; pi += 4) {
                    const v = 255 - id.data[pi]; // invert R
                    id.data[pi] = id.data[pi+1] = id.data[pi+2] = v;
                  }
                  tc.putImageData(id, 0, 0);
                  octx.drawImage(tmp, 0, 0);
                };
                if (op._canvas) {
                  drawFillOp(op._canvas);
                } else if (op.dataUrl) {
                  const fi = new Image();
                  fi.onload = () => { drawFillOp(fi); };
                  fi.src = op.dataUrl;
                }
                continue;
              }
              if (!op.pts || op.pts.length < 1) continue;
              // add = white (masked region), sub = black (unmasked)
              octx.fillStyle = op.mode === "sub" ? "#000" : "#fff";
              if (op.type === "brush") {
                const r = Math.max(1, (op.r || 0.01) * cw);
                for (const p of op.pts) { octx.beginPath(); octx.arc(p.x*cw, p.y*ch, r, 0, Math.PI*2); octx.fill(); }
              } else {
                if (op.pts.length < 3) continue;
                octx.beginPath(); octx.moveTo(op.pts[0].x*cw, op.pts[0].y*ch);
                for (let i=1;i<op.pts.length;i++) octx.lineTo(op.pts[i].x*cw, op.pts[i].y*ch);
                octx.closePath(); octx.fill();
              }
            }
          }
          if (inverted) { const id=octx.getImageData(0,0,cw,ch); for(let i=0;i<id.data.length;i+=4){id.data[i]=255-id.data[i];id.data[i+1]=255-id.data[i+1];id.data[i+2]=255-id.data[i+2];} octx.putImageData(id,0,0); }
        };
        // Draw immediately (no need to wait for img if all-black default)
        requestAnimationFrame(drawOnCanvas);
      }

      // ── numeric badge (bottom-left, clear of ✕ button) ───────────────────
      const badge = document.createElement("span");
      badge.textContent = idx + 1;
      badge.style.cssText = `
        position:absolute;bottom:2px;left:3px;
        background:rgba(0,0,0,0.65);color:#fff;
        font-size:9px;font-family:sans-serif;
        padding:0 3px;border-radius:3px;
        pointer-events:none;z-index:1;
      `;



      // ── remove button (top-right, shown on hover) ─────────────────────────
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "✕";
      removeBtn.title = "Remove";
      removeBtn.style.cssText = `
        position:absolute;top:2px;right:2px;
        background:rgba(180,30,30,0.85);color:#fff;
        border:none;border-radius:3px;
        width:14px;height:14px;font-size:8px;
        cursor:pointer;padding:0;line-height:14px;text-align:center;
        opacity:0;transition:opacity 0.15s;
        z-index:2;
      `;
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        items.splice(idx, 1);
        items.forEach((it) => delete it.previewSrc);
        previewActive = false;
        if (items.length === 0) thumbH = THUMB_W;
        render();
        persist();
      });

      // ── drag-to-reorder events ────────────────────────────────────────────
      wrapper.addEventListener("dragstart", (e) => {
        dragSrcIdx = idx;
        wrapper.classList.add("mil-dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(idx));
      });

      wrapper.addEventListener("dragend", () => {
        dragSrcIdx = null;
        wrapper.classList.remove("mil-dragging");
        grid.querySelectorAll(".mil-drag-over").forEach((el) =>
          el.classList.remove("mil-drag-over")
        );
      });

      wrapper.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dragSrcIdx !== null && dragSrcIdx !== idx) {
          wrapper.classList.add("mil-drag-over");
        }
      });

      wrapper.addEventListener("dragleave", () => {
        wrapper.classList.remove("mil-drag-over");
      });

      wrapper.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        wrapper.classList.remove("mil-drag-over");
        if (dragSrcIdx === null || dragSrcIdx === idx) return;

        const [moved] = items.splice(dragSrcIdx, 1);
        items.splice(idx, 0, moved);

        // Clear only non-crop previews; crop previews are rebuilt async
        items.forEach((it) => { if (!hasCrop(it.filename)) delete it.previewSrc; });
        previewActive = items.some(it => it.previewSrc);

        updateThumbHFromFirst();
        render();
        persist();
        renderCropPreviews();  // async: restore crop thumbnails after reorder
      });

      // ── crop button (top-right, next to remove btn) ──────────────────────
      const cropBtn = document.createElement("button");
      cropBtn.textContent = "✂";
      cropBtn.title = "Edit image";
      const cropActive = hasCrop(item.filename);
      cropBtn.style.cssText = `
        position:absolute;top:2px;right:18px;
        background:${cropActive ? "rgba(110,110,110,0.9)" : "rgba(40,40,40,0.82)"};
        color:#eee;
        border:none;border-radius:3px;
        width:14px;height:14px;font-size:8px;
        cursor:pointer;padding:0;line-height:14px;text-align:center;
        opacity:0;transition:opacity 0.15s;
        z-index:2;
      `;
      cropBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openCropEditor(idx);
      });

      // ── mask button (◧, next to crop btn) ────────────────────────────────────
      const maskBtnEl = document.createElement("button");
      maskBtnEl.textContent = "\u25D0";
      maskBtnEl.title = "Edit mask";
      const maskActive = hasMask(item.filename);
      maskBtnEl.style.cssText = `
        position:absolute;top:2px;right:34px;
        background:${maskActive ? "rgba(30,80,30,0.92)" : "rgba(40,40,40,0.82)"};
        color:${maskActive ? "#7fff7f" : "#eee"};
        border:none;border-radius:3px;
        width:14px;height:14px;font-size:8px;
        cursor:pointer;padding:0;line-height:14px;text-align:center;
        opacity:0;transition:opacity 0.15s;
        z-index:2;
      `;
      maskBtnEl.addEventListener("click", (e) => {
        e.stopPropagation();
        openMaskEditor(idx);
      });

      // ── copy button (top-right, next to mask btn) ──────────────────────
      const copyBtn = document.createElement("button");
      copyBtn.textContent = "⎘";
      copyBtn.title = "Copy image";
      copyBtn.style.cssText = `
        position:absolute;top:2px;right:50px;
        background:rgba(40,40,40,0.82);
        color:#eee;
        border:none;border-radius:3px;
        width:14px;height:14px;font-size:8px;
        cursor:pointer;padding:0;line-height:14px;text-align:center;
        opacity:0;transition:opacity 0.15s, color 0.15s;
        z-index:2;
      `;
      wrapper.addEventListener("mouseenter", () => {
        removeBtn.style.opacity = "1";
        cropBtn.style.opacity   = "1";
        copyBtn.style.opacity   = "1";
        maskBtnEl.style.opacity = "1";
      });
      wrapper.addEventListener("mouseleave", () => {
        removeBtn.style.opacity = "0";
        cropBtn.style.opacity   = "0";
        copyBtn.style.opacity   = "0";
        maskBtnEl.style.opacity = "0";
      });
      wrapper.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        // Apply any pending edits, then open Mask Editor directly
        openMaskEditor(idx);
      });
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        copyBtn.textContent = "⏳";
        (async () => {
          try {
            const dataUrl = await renderItemToDataUrl(item, idx);
            const resp = await fetch(dataUrl);
            const blob = await resp.blob();
            await navigator.clipboard.write([new ClipboardItem({[blob.type]: blob})]);
            copyBtn.style.color = "#5f5";
          } catch(err) {
            copyBtn.style.color = "#f55";
            console.error("[MIL] Copy failed:", err);
          } finally {
            copyBtn.textContent = "⎘";
            setTimeout(() => { copyBtn.style.color = "#eee"; }, 800);
          }
        })();
      });

      // ── crop-active badge (bottom-right, always visible) ──────────────────
      if (cropActive) {
        const cropBadge = document.createElement("span");
        cropBadge.textContent = "✂";
        cropBadge.title = "Custom crop active";
        cropBadge.style.cssText = `
          position:absolute;bottom:2px;right:2px;
          background:rgba(110,110,110,0.85);color:#eee;
          font-size:8px;padding:0 2px;border-radius:2px;
          pointer-events:none;z-index:1;
        `;
        wrapper.appendChild(cropBadge);
      }

      // ── mask-active badge ──
      if (maskActive) {
        const maskBadge = document.createElement("span");
        maskBadge.textContent = "\u25D0";
        maskBadge.title = "Mask active";
        maskBadge.style.cssText = `
          position:absolute;bottom:2px;right:${cropActive ? 14 : 2}px;
          background:rgba(30,90,30,0.85);color:#7fff7f;
          font-size:8px;padding:0 2px;border-radius:2px;
          pointer-events:none;z-index:1;
        `;
        wrapper.appendChild(maskBadge);
      }

      wrapper.appendChild(img);
      if (maskOvEl) wrapper.appendChild(maskOvEl);
      wrapper.appendChild(badge);
      wrapper.appendChild(copyBtn);
      wrapper.appendChild(maskBtnEl);
      wrapper.appendChild(cropBtn);
      wrapper.appendChild(removeBtn);
      grid.appendChild(wrapper);
    });

    // In grid mode, add invisible spacers so the last row doesn't over-stretch
    if (viewMode === "grid" && items.length > 0) {
      const innerW = grid.clientWidth || (node.size[0] - 24);
      const cols = Math.max(1, Math.floor((innerW + THUMB_GAP) / (tw + THUMB_GAP)));
      const remainder = items.length % cols;
      if (remainder > 0) {
        for (let s = 0; s < cols - remainder; s++) {
          const spacer = document.createElement("div");
          spacer.style.cssText = `flex:1 0 ${tw}px;min-width:${tw}px;height:0;visibility:hidden;`;
          grid.appendChild(spacer);
        }
      }
    }

    const count = items.length;
    updateDropZone(count);
    statusBar.style.display  = count > 0 ? "flex" : "none";
    statusLabel.textContent  = count > 0
      ? `${count} image${count !== 1 ? "s" : ""} queued · Drag to reorder`
      : "";

    if (count > 0) {
      (async () => {
        try {
          const { refW, refH } = await computeRefDims();
          const ar = getAspectRatioWidget()?.value ?? "none";
          const arLabel = ar !== "none" ? ` · ${ar}` : "";
          statusLabel.textContent = `${count} image${count !== 1 ? "s" : ""} queued · Drag to reorder · ${refW} x ${refH}${arLabel}`;
        } catch(e) {
          // ignore error, keep default text
        }
      })();
    }
    clearBtn.style.display      = count > 0 ? "inline-block" : "none";
    viewToggleBtn.style.display = count > 0 ? "inline-block" : "none";
    maskViewBtn.style.display   = count > 0 ? "inline-block" : "none";

    resizeNode();
    requestAnimationFrame(updateScrollFade);
  }

  // Update thumbH: respects aspect_ratio if set, otherwise uses first image
  async function updateThumbHFromFirst() {
    if (items.length === 0) { thumbH = THUMB_W; return; }
    const ar = getAspectRatioWidget()?.value ?? "none";
    if (ar !== "none") {
      const [aw, ah] = ar.split(":").map(Number);
      thumbH = Math.max(20, Math.round(THUMB_W * ah / aw));
      return;
    }
    try {
      const { w, h } = await getImageDimensions(items[0].src);
      thumbH = Math.max(20, Math.round(THUMB_W * h / w));
    } catch {
      thumbH = THUMB_W;
    }
  }

  // ── canvas fit preview ─────────────────────────────────────────────────────

  /** Loads any URL/dataURL as an HTMLImageElement. */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error(`Load failed: ${src}`));
      img.src = src;
    });
  }

  /**
   * Renders a single item to a PNG data URL using the same composite pipeline
   * as `renderCropPreviews` and `renderFitPreviews`. Used by the copy button.
   * - Has crop transform + inpaint bg: fetches from Python server
   * - Has crop transform + solid bg:   canvas crop/transform path
   * - No crop transform:               letterbox/crop fit against ref dims
   * When aspect_ratio is set, even idx=0 is fitted to the fixed canvas.
   */
  async function renderItemToDataUrl(item, idx) {
    // Reference image with no aspect_ratio override — return raw
    const ar = getAspectRatioWidget()?.value ?? "none";
    if (idx === 0 && ar === "none") {
      return item.src;
    }

    // Get reference dims (aspect_ratio-aware)
    const { refW, refH } = await computeRefDims();

    const t = cropMap[item.filename];

    if (t) {
      // Crop-transform path
      const bgRaw = t.bg ?? getEffectiveBgColor();
      const isInpaint = bgRaw === "telea" || bgRaw === "navier-stokes";

      if (isInpaint) {
        const resp = await fetch("/multi_image_loader/preview", {
          method: "POST",
          headers: {"Content-Type":"application/json"},
          body: JSON.stringify({filename: item.filename, transform: t, refW, refH})
        });
        if (!resp.ok) throw new Error(`Server error ${resp.status}`);
        const { dataUrl } = await resp.json();
        return dataUrl;
      }

      // Solid-fill crop path — crop region is a PRE-step on the source
      const el = await loadImage(item.src);
      const mode = getFitModeWidget()?.value ?? "letterbox";
      // Effective source dimensions after pre-crop
      const hasCR = t.cx != null && (t.cx > 0 || t.cy > 0 || t.cw < 1 || t.ch < 1);
      const srcX = hasCR ? t.cx * el.naturalWidth  : 0;
      const srcY = hasCR ? t.cy * el.naturalHeight : 0;
      const srcW = hasCR ? t.cw * el.naturalWidth  : el.naturalWidth;
      const srcH = hasCR ? t.ch * el.naturalHeight : el.naturalHeight;
      const cvs = document.createElement("canvas");
      cvs.width = refW; cvs.height = refH;
      const ctx = cvs.getContext("2d");
      const bgC = /^#[0-9a-fA-F]{6}$/.test(bgRaw) ? bgRaw : getEffectiveBgColor();
      ctx.fillStyle = bgC; ctx.fillRect(0, 0, refW, refH);
      const ox = t.ox ?? 0, oy = t.oy ?? 0, sc = t.scale ?? 1;
      const fH = !!(t.flipH), fV = !!(t.flipV), rot = (t.rotate || 0) * Math.PI / 180;
      const cosA = Math.abs(Math.cos(rot)), sinA = Math.abs(Math.sin(rot));
      const rW = srcW * cosA + srcH * sinA;
      const rH = srcW * sinA + srcH * cosA;
      // respect fit_mode for base scale
      const bf = mode === "crop"
        ? Math.max(refW / rW, refH / rH)
        : Math.min(refW / rW, refH / rH);
      const eff = bf * sc;
      const dw = srcW * eff, dh = srcH * eff;
      ctx.save();
      ctx.translate(refW / 2 + ox * refW, refH / 2 + oy * refH);
      ctx.rotate(rot);
      ctx.scale(fH ? -1 : 1, fV ? -1 : 1);
      ctx.drawImage(el, srcX, srcY, srcW, srcH, -dw / 2, -dh / 2, dw, dh);
      // Lasso mask overlay — same logic as renderCropPreviews
      const tOps = t.lassoOps;
      if (tOps && tOps.length > 0) {
        const mw = Math.ceil(dw), mh = Math.ceil(dh);
        const mc = document.createElement('canvas'); mc.width = mw; mc.height = mh;
        const mx = mc.getContext('2d');
        for (const op of tOps) {
          if (op.points.length < 3) continue;
          mx.globalCompositeOperation = op.mode === "add" ? "source-over" : "destination-out";
          mx.fillStyle = "white"; mx.beginPath();
          mx.moveTo(op.points[0][0]*mw, op.points[0][1]*mh);
          for (let k=1;k<op.points.length;k++) mx.lineTo(op.points[k][0]*mw, op.points[k][1]*mh);
          mx.closePath(); mx.fill();
        }
        if (t.lassoInverted) { mx.globalCompositeOperation="xor"; mx.fillStyle="white"; mx.fillRect(0,0,mw,mh); }
        mx.globalCompositeOperation="source-over";
        const oc = document.createElement('canvas'); oc.width=mw; oc.height=mh;
        const ox2 = oc.getContext('2d');
        ox2.fillStyle = bgC; ox2.fillRect(0,0,mw,mh);
        ox2.globalCompositeOperation = 'destination-out';
        ox2.drawImage(mc, 0, 0);
        ox2.globalCompositeOperation = 'source-over';
        ctx.drawImage(oc, -dw/2, -dh/2);
      }
      ctx.restore();
      return cvs.toDataURL("image/png");
    }

    // No crop transform — apply letterbox/crop fit vs reference dims
    const mode = getFitModeWidget()?.value ?? "letterbox";
    const el = await loadImage(item.src);
    const cvs = document.createElement("canvas");
    cvs.width = refW; cvs.height = refH;
    const ctx = cvs.getContext("2d");

    if (mode === "letterbox") {
      ctx.fillStyle = getEffectiveBgColor();  // node bg_color (no per-image override for non-crop items)
      ctx.fillRect(0, 0, refW, refH);
      const scale = Math.min(refW / el.naturalWidth, refH / el.naturalHeight);
      const dw = el.naturalWidth * scale, dh = el.naturalHeight * scale;
      ctx.drawImage(el, (refW - dw) / 2, (refH - dh) / 2, dw, dh);
    } else { // crop
      const scale = Math.max(refW / el.naturalWidth, refH / el.naturalHeight);
      const sw = refW / scale, sh = refH / scale;
      const sx = (el.naturalWidth - sw) / 2, sy = (el.naturalHeight - sh) / 2;
      ctx.drawImage(el, sx, sy, sw, sh, 0, 0, refW, refH);
    }
    return cvs.toDataURL("image/png");
  }

  /**
   * Renders a canvas-based fit preview for thumbnails.
   * When aspect_ratio is set: renders ALL images (including #0) to the fixed canvas.
   * When aspect_ratio is "none": renders images #1+ against image #0 as reference.
   * mode = "letterbox" | "crop"  (reads fit_mode widget).
   */
  async function renderFitPreviews() {
    if (items.length < 1) return;

    const mode = getFitModeWidget()?.value ?? "letterbox";
    const ar = getAspectRatioWidget()?.value ?? "none";

    try {
      const { refW: targetW, refH: targetH } = await computeRefDims();
      const startIdx = ar !== "none" ? 0 : 1;

      // Dispatch ALL fit renders in parallel via the Worker
      const jobs = [];
      for (let i = startIdx; i < items.length; i++) {
        const itemBg = cropMap[items[i].filename]?.bg;
        const bgColor = (mode === "letterbox")
          ? ((itemBg && /^#[0-9a-fA-F]{6}$/.test(itemBg)) ? itemBg : getEffectiveBgColor())
          : "#000000"; // crop mode doesn't use bg
        jobs.push(
          workerRender("fitPreview", items[i].src, {
            targetW, targetH, mode, bgColor
          }).then(dataUrl => { items[i].previewSrc = dataUrl; })
            .catch(e => console.warn(`[MIL] Fit preview failed for ${items[i].filename}:`, e))
        );
      }
      await Promise.all(jobs);

      previewActive = true;
      render();
    } catch (e) {
      statusLabel.textContent = `Preview error: ${e.message}`;
      statusLabel.style.color = "#ff6666";
    }
  }

  /**
   * Regenerates thumbnails for items that have a crop/editor transform stored
   * in cropMap. Respects fit_mode and aspect_ratio, same as renderItemToDataUrl.
   * Must be called after renderFitPreviews so all items get a consistent preview.
   */
  async function renderCropPreviews() {
    if (items.length < 1) return;
    const { refW, refH } = await computeRefDims();
    const mode = getFitModeWidget()?.value ?? "letterbox";

    // Dispatch all crop renders in parallel via the Worker
    const jobs = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const t = cropMap[item.filename];
      if (!t) continue;  // no transform — handled by renderFitPreviews

      const bgRaw = t.bg ?? getEffectiveBgColor();
      const isInpaint = bgRaw === "telea" || bgRaw === "navier-stokes";

      if (isInpaint) {
        // Inpaint path — Python server renders this (can't be off-threaded)
        jobs.push(
          fetch("/multi_image_loader/preview", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({filename: item.filename, transform: t, refW, refH})
          }).then(async resp => {
            if (resp.ok) {
              const { dataUrl } = await resp.json();
              item.previewSrc = dataUrl;
            }
          }).catch(e => console.warn(`[MIL] inpaint preview error: ${item.filename}`, e))
        );
      } else {
        // Solid-fill path — off-thread via Worker
        const bgC = /^#[0-9a-fA-F]{6}$/.test(bgRaw) ? bgRaw : getEffectiveBgColor();
        jobs.push(
          workerRender("cropTransform", item.src, {
            refW, refH, bgColor: bgC, fitMode: mode, transform: t
          }).then(dataUrl => { item.previewSrc = dataUrl; })
            .catch(e => console.warn(`[MIL] crop preview error: ${item.filename}`, e))
        );
      }
    }
    await Promise.all(jobs);

    previewActive = items.some(it => it.previewSrc);
    render();
  }

  // ── restore (called on page load / workflow reload) ───────────────────────

  async function restore() {
    if (items.length > 0) return;

    const w = getImageListWidget();
    let filenames;
    try {
      filenames = JSON.parse(w?.value || "[]");
    } catch {
      filenames = [];
    }
    if (!filenames?.length) return;

    items = filenames.map((fn) => ({ filename: fn, src: viewURL(fn) }));

    // Restore crop transforms
    const cw = getCropDataWidget();
    try { cropMap = JSON.parse(cw?.value || "{}"); } catch { cropMap = {}; }

    try {
      const { w: iw, h: ih } = await getImageDimensions(viewURL(filenames[0]));
      thumbH = Math.max(20, Math.round(THUMB_W * ih / iw));
    } catch {
      thumbH = THUMB_W;
    }

    render();
    // Re-generate previews after restore so fit/crop thumbnails are correct
    await updateThumbHFromFirst();
    await renderFitPreviews();
    await renderCropPreviews();
  }

  // ── addFiles (called by drag-drop / file picker) ──────────────────────────

  async function addFiles(files) {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;

    statusLabel.textContent = "Uploading…";
    statusLabel.style.color = "#ffcc66";

    try {
      const dataURLs  = await Promise.all(imageFiles.map(fileToDataURL));
      const filenames = await uploadFiles(imageFiles);

      const insertedCount = filenames.length;
      filenames.forEach((fn, i) => {
        items.push({ filename: fn, src: dataURLs[i] });
      });

      // Compute thumbH respecting aspect_ratio widget (1:1, 16:9, etc.)
      await updateThumbHFromFirst();

      statusLabel.style.color = "#8899bb";
      render();
      persist();

      // Generate fit/crop previews so thumbnails reflect current aspect_ratio + fit_mode
      await renderFitPreviews();
      await renderCropPreviews();

      // Flash newly added thumbnails with a green border that fades over 5 s
      requestAnimationFrame(() => {
        const allThumbs = grid.querySelectorAll(".mil-thumb");
        const start = allThumbs.length - insertedCount;
        for (let i = Math.max(0, start); i < allThumbs.length; i++) {
          allThumbs[i].classList.remove("mil-paste-flash");
          void allThumbs[i].offsetWidth; // force reflow
          allThumbs[i].classList.add("mil-paste-flash");
        }
      });
    } catch (err) {
      statusLabel.textContent = `Error: ${err.message}`;
      statusLabel.style.color = "#ff6666";
    }
  }

  // ── events ────────────────────────────────────────────────────────────────

  dropZone.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    if (fileInput.files?.length) addFiles(fileInput.files);
    fileInput.value = "";
  });

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.style.background = "rgba(90, 122, 191, 0.45)";
    dropZone.style.borderColor = "#aaccff";
  });
  dropZone.addEventListener("dragleave", (e) => {
    if (dropZone.contains(e.relatedTarget)) return; // cursor still inside
    dropZone.style.background  = "rgba(60, 90, 150, 0.15)";
    dropZone.style.borderColor = "#5a7abf";
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.style.background = "rgba(60, 90, 150, 0.15)";
    dropZone.style.borderColor = "#5a7abf";
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });


  clearBtn.addEventListener("click", () => {
    items  = [];
    thumbH = THUMB_W;
    previewActive = false;
    cropMap = {};
    render();
    persist();
  });

  // ── initial render ────────────────────────────────────────────────────────
  render();

  root._addFiles         = addFiles;
  root._restore          = restore;
  root._render           = render;
  root._renderWithResize = () => {
    // Re-render thumbnails when thumb_size changes — no height change
    render();
  };
  root._onAspectRatioChange = async () => {
    // Called whenever aspect_ratio, fit_mode, or megapixels changes.
    // Re-renders all thumbnails and resizes node to reflect the new canvas shape.
    if (items.length === 0) return;
    await updateThumbHFromFirst();
    // Clear cached previews so they get regenerated
    items.forEach(it => delete it.previewSrc);
    previewActive = false;
    render();
    resizeNode();
    // Regenerate fit previews for all images
    await renderFitPreviews();
    // Regenerate crop previews for items that have a crop transform
    await renderCropPreviews();
  };

  // ── openCropEditor ───────────────────────────────────────────────────
  function openCropEditor(startIdx, skipAnim) {
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
    function mkTab(label, active) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = `background:${active?"#2a2a2a":"transparent"};color:${active?"#ccc":"#555"};border:1px solid ${active?"#444":"transparent"};border-bottom:${active?"2px solid #7ab0ff":"2px solid transparent"};border-radius:${Math.round(4*uiScale)}px ${Math.round(4*uiScale)}px 0 0;padding:${Math.round(4*uiScale)}px ${Math.round(9*uiScale)}px;font-size:${_fs11};cursor:pointer;transition:color .15s,border-color .15s;margin-bottom:-1px;`;
      b.addEventListener("mouseenter", () => { if (!active) b.style.color = "#999"; });
      b.addEventListener("mouseleave", () => { if (!active) b.style.color = "#555"; });
      return b;
    }
    const tabEdit = mkTab("\u270F Edit Image", true);
    const tabMask = mkTab("\u25D0 Mask", false);
    tabMask.addEventListener("click", () => {
      // Auto-apply current edits so Mask Editor sees the processed image
      doApply();
      openMaskEditor(curIdx, true);
    });
    hdr.appendChild(tabEdit);
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
    // ── Image Dimensions ─────────────────────────────────────────
    pnlBody.appendChild(mkSec("Image"));
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
    pnlBody.appendChild(dimOrigLbl);
    pnlBody.appendChild(dimEffLbl);

    // ── Crop Region (first step) ─────────────────────────────────
    pnlBody.appendChild(mkSec("Crop Region", () => {
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
    function syncLassoToggle() {
      // OFF state for both buttons
      const offS = {bg:'#1e1e1e',col:'#aaa',bc:'#333'};
      const onFree = {bg:'#3a2a1a',col:'#ff9f43',bc:'#664422'};
      const onPoly = {bg:'#3a2a1a',col:'#ff9f43',bc:'#664422'};
      if (edLassoMode) {
        const f = edLassoTool==="freehand" ? onFree : offS;
        const p = edLassoTool==="polygonal" ? onPoly : offS;
        lassoFreehandB.style.background=f.bg; lassoFreehandB.style.color=f.col; lassoFreehandB.style.borderColor=f.bc;
        lassoPolyB.style.background=p.bg; lassoPolyB.style.color=p.col; lassoPolyB.style.borderColor=p.bc;
        ca.style.cursor = "crosshair";
        hint.textContent = edLassoTool === "freehand" ? "Drag to draw \u00b7 Shift: add \u00b7 Alt: subtract" : "Click vertices \u00b7 Close near start / dblclick \u00b7 Shift: add \u00b7 Alt: subtract";
      } else {
        lassoFreehandB.style.background=offS.bg; lassoFreehandB.style.color=offS.col; lassoFreehandB.style.borderColor=offS.bc;
        lassoPolyB.style.background=offS.bg; lassoPolyB.style.color=offS.col; lassoPolyB.style.borderColor=offS.bc;
        if (!edCropMode) {
          ca.style.cursor = "grab";
          hint.textContent = "Drag to pan \u00b7 Scroll to zoom";
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
    pnlBody.appendChild(cropToggleB);

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
    pnlBody.appendChild(cropArRow);

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
    pnlBody.appendChild(cropApplyB);

    const cropInfoLbl = document.createElement("div");
    cropInfoLbl.style.cssText = `color:#666;font-size:${_fs10};text-align:center;min-height:${Math.round(11*uiScale)}px;`;
    pnlBody.appendChild(cropInfoLbl);

    // ══════════════════════════════════════════════════════════════════
    // ── Lasso Selection Section ─────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════
    pnlBody.appendChild(mkSec("Lasso Selection", () => {
      edLassoOps = []; edLassoInverted = false;
      edLassoCurrentPts = []; edLassoDrawing = false;
      _lassoMaskDirty = true; _lassoCursorNorm = null;
      stopLassoAnts();
      syncLassoInvertBtn(); updateLassoInfoLbl();
    }, "Reset Lasso Selection"));

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
    pnlBody.appendChild(lassoToolRow);

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
    pnlBody.appendChild(lassoInvertB);

    // Hint + Info
    const lassoHintLbl = document.createElement("div");
    lassoHintLbl.style.cssText = `color:#555;font-size:${_fs10};text-align:center;line-height:1.3;`;
    lassoHintLbl.textContent = "Shift: add \u00b7 Alt: subtract";
    pnlBody.appendChild(lassoHintLbl);
    const lassoInfoLbl = document.createElement("div");
    lassoInfoLbl.style.cssText = `color:#666;font-size:${_fs10};text-align:center;min-height:${Math.round(11*uiScale)}px;`;
    pnlBody.appendChild(lassoInfoLbl);

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
      if (!edLassoMode) return;
      const { dw, dh } = _imgRenderDims();

      // ── Marching ants (committed ops) ──
      if (edLassoOps.length > 0) {
        const mw = Math.ceil(dw), mh = Math.ceil(dh);
        if (mw > 0 && mh > 0) {
          getLassoMaskCanvas(mw, mh);
          if (_cachedEdgePixels && _cachedEdgePixels.length > 0) {
            ctx.save();
            // Match image transform: translate → rotate → flip
            ctx.translate(frameCX + dOX, frameCY + dOY);
            ctx.rotate(edRotate * Math.PI / 180);
            ctx.scale(edFlipH ? -1 : 1, edFlipV ? -1 : 1);
            ctx.strokeStyle = '#ff9f43'; ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 5]); ctx.lineDashOffset = -edLassoAntsOffset;
            ctx.beginPath();
            for (let i = 0; i < _cachedEdgePixels.length; i += 2) {
              // Edge pixels are in mask space (0..mw, 0..mh); image is centred at 0
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

      // ── In-progress path ──
      if (edLassoCurrentPts.length >= 1) {
        ctx.save();
        ctx.translate(frameCX + dOX, frameCY + dOY);
        ctx.rotate(edRotate * Math.PI / 180);
        ctx.scale(edFlipH ? -1 : 1, edFlipV ? -1 : 1);
        // Points stored as normalized 0..1; map to image-local space (-dw/2..dw/2)
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

    pnlBody.appendChild(mkSec("Quick Fit", () => {
      dOX=0; dOY=0; edScale=1; updLbl();
    }, "Reset to Letterbox"));
    pnlBody.appendChild(mkPB("\u2B1B Fill  (cover)",  doFill));
    pnlBody.appendChild(mkPB("\u2B1C Fit   (letterbox)", ()=>{ dOX=0;dOY=0;edScale=1; updLbl(); }));
    pnlBody.appendChild(mkPB("\u2194 Fit Width",  doFitW));
    pnlBody.appendChild(mkPB("\u2195 Fit Height", doFitH));
    pnlBody.appendChild(mkSec("Flip", () => {
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
    pnlBody.appendChild(flipRow);
    pnlBody.appendChild(mkSec("Rotate", () => {
      edRotate=0; syncRotUI();
    }, "Reset Rotation"));
    // slider + click-to-type angle
    const rotRow = document.createElement("div");
    rotRow.style.cssText = `display:flex;align-items:center;gap:${_gap5};width:100%;`;
    const rotSlider = document.createElement("input");
    rotSlider.type="range"; rotSlider.min=-180; rotSlider.max=180; rotSlider.step=1; rotSlider.value=0;
    rotSlider.style.cssText="flex:1;accent-color:#5a7abf;cursor:pointer;";
    const rotValEl = document.createElement("div");
    rotValEl.style.cssText=`color:#888;font-size:${_fs10};min-width:${Math.round(38*uiScale)}px;text-align:right;cursor:text;user-select:none;flex-shrink:0;`;
    rotValEl.textContent="0\u00b0";
    function syncRotUI(){
      rotSlider.value = edRotate;
      rotValEl.textContent = edRotate + "\u00b0";
    }
    rotValEl.addEventListener("click", () => {
      const inp = document.createElement("input");
      inp.type="number"; inp.min=-180; inp.max=180; inp.value=edRotate;
      inp.style.cssText=`width:${Math.round(40*uiScale)}px;background:#1a1a1a;color:#ccc;border:1px solid #444;border-radius:3px;font-size:${_fs10};padding:1px 3px;`;
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
    rotRow.appendChild(rotSlider); rotRow.appendChild(rotValEl);
    pnlBody.appendChild(rotRow);

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
    pnlBody.appendChild(mkSec("Remove Background", () => {
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
    pnlBody.appendChild(rbModelSel);

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
    pnlBody.appendChild(rbBtn);
    pnlBody.appendChild(rbStatus);

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
    pnlBody.appendChild(mkSec("Background Fill", () => {
      edBg = getEffectiveBgColor(); syncBgUI();
      edInpaintPreview=null; edInpaintDirty=true;
    }, "Reset to Node Default"));
    pnlBody.appendChild(bgSelect); pnlBody.appendChild(bgCustomRow); pnlBody.appendChild(bgNote);

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
            // Lasso mask overlay — show bg color outside selection
            if (edLassoOps.length > 0) {
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
      const nodeBg = getEffectiveBgColor();
      if (dOX!==0||dOY!==0||edScale!==1.0||edFlipH||edFlipV||edRotate!==0||edBg!==nodeBg||hasAppliedCrop||hasLasso) {
        const t = {ox:dOX/frameW,oy:dOY/frameH,scale:edScale,flipH:edFlipH,flipV:edFlipV,rotate:edRotate,bg:edBg};
        if (hasAppliedCrop) { t.cx = edAppliedCrop.cx; t.cy = edAppliedCrop.cy; t.cw = edAppliedCrop.cw; t.ch = edAppliedCrop.ch; }
        if (hasLasso) { t.lassoOps = edLassoOps; if (edLassoInverted) t.lassoInverted = true; }
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
          syncRotUI(); syncBgUI(); syncFlipUI(); updLbl(); redraw(); requestInpaintPreview(); res();
        };
        el.onerror=res; el.src=items[idx].src;
      });
    }

    // ── events ───────────────────────────────────────────────
    function onGlobalMove(e) {
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
      for (const fn of valid) {
        const t=ses[fn];
        // Carry forward existing mask data
        const prevMask = cropMap[fn]?.maskOps;
        const prevMaskInv = cropMap[fn]?.maskInverted;
        const prevMaskXf = cropMap[fn]?.maskXform;
        if (t&&(t.ox!==0||t.oy!==0||t.scale!==1.0||t.flipH||t.flipV||(t.rotate||0)!==0||(t.bg&&t.bg!==_nodeBg)||
            (t.cx!=null&&(t.cx>0||t.cy>0||t.cw<1||t.ch<1))||(t.lassoOps&&t.lassoOps.length>0)||t.lassoInverted)) {
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
    ov.addEventListener("click", e=>{ if(e.target===ov) doClose(); });

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

  // ── clipboard paste (Ctrl+V while node is selected) ─────────────────────
  // Expose a paste handler callable by the global extension setup hook.
  // root._addFiles is already set above; this only adds _pasteFromClipboard.
  root._pasteFromClipboard = async function (clipboardItems) {
    const imageItems = clipboardItems.filter(item =>
      item.types.some(t => t.startsWith("image/"))
    );
    if (!imageItems.length) return;
    const files = [];
    for (const item of imageItems) {
      const mimeType = item.types.find(t => t.startsWith("image/")) || "image/png";
      try {
        const blob = await item.getType(mimeType);
        const ext  = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
        const ts   = Date.now();
        files.push(new File([blob], `clipboard_${ts}.${ext}`, { type: mimeType }));
      } catch (e) {
        console.warn("[MIL] clipboard read failed:", e);
      }
    }
    if (files.length) await addFiles(files);
  };


  // ── openMaskEditor ────────────────────────────────────────────────────────
  function openMaskEditor(startIdx, skipAnim) {
    let curIdx = startIdx;
    // ── Unified sizing (mirrors openCropEditor for consistency) ──
    const _vpW2 = window.innerWidth || 1920;
    const uiScale = Math.min(1.3, Math.max(1.0, Math.sqrt(_vpW2 / 1920)));
    function _r(v) { return Math.round(v * uiScale); }
    const _pnlW  = Math.round(168 * uiScale);   // same sidebar width as Edit Image
    const _fs11  = `${(11 * uiScale).toFixed(1)}px`;
    const _fs12  = `${(12 * uiScale).toFixed(1)}px`;
    const _fs13  = `${(13 * uiScale).toFixed(1)}px`;
    const _pad6  = `${_r(6)}px`;
    const _pad8  = `${_r(8)}px`;
    const _pad10 = `${_r(10)}px`;
    const _gap5  = `${_r(5)}px`;
    const _r4    = `${_r(4)}px`;
    const _r5    = `${_r(5)}px`;
    const _r6    = `${_r(6)}px`;
    const _btnPadW = `${_r(7)}px`;

    // Modal overlay
    const ov = document.createElement("div");
    ov.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:9999;display:flex;align-items:center;justify-content:center;`;

    const dlg = document.createElement("div");
    dlg.style.cssText = `
      width:clamp(700px,90vw,1920px);height:clamp(480px,88vh,1200px);
      background:#1a1a1a;border-radius:${_r(10)}px;display:flex;flex-direction:column;
      box-shadow:0 8px 48px rgba(0,0,0,0.7);overflow:hidden;font-family:sans-serif;
      ${skipAnim ? '' : 'animation:mil-fadein 0.18s ease-out;'}
    `;

    // Header
    const hdr = document.createElement("div");
    hdr.style.cssText = `display:flex;align-items:center;gap:${_r(8)}px;padding:${_r(10)}px ${_r(14)}px;background:#111;border-bottom:1px solid #2a2a2a;flex-shrink:0;`;
    // matches Edit panel's mkB exactly
    const _btnPad = `${_r(5)}px ${_r(12)}px`;
    function mkHBtn(t, col) {
      const b = document.createElement("button");
      b.textContent = t;
      b.style.cssText = `background:#222;color:${col||"#bbb"};border:1px solid #3a3a3a;border-radius:${_r5};padding:${_btnPad};font-size:${_fs11};cursor:pointer;`;
      b.addEventListener("mouseenter", () => { b.style.background="#2e2e2e"; b.style.borderColor="#555"; });
      b.addEventListener("mouseleave", () => { b.style.background="#222"; b.style.borderColor="#3a3a3a"; });
      return b;
    }
    // ── Mode switcher tabs (left of title) ──
    function mkTab(label, active, accentColor) {
      const b = document.createElement("button");
      b.textContent = label;
      const ac = accentColor || "#7fff7f";
      b.style.cssText = `background:${active?"#2a2a2a":"transparent"};color:${active?"#ccc":"#555"};border:1px solid ${active?"#444":"transparent"};border-bottom:${active?`2px solid ${ac}`:"2px solid transparent"};border-radius:${_r(4)}px ${_r(4)}px 0 0;padding:${_r(4)}px ${_r(9)}px;font-size:${_fs11};cursor:pointer;transition:color .15s,border-color .15s;margin-bottom:-1px;`;
      b.addEventListener("mouseenter", () => { if (!active) b.style.color = "#999"; });
      b.addEventListener("mouseleave", () => { if (!active) b.style.color = "#555"; });
      return b;
    }
    const tabEdit = mkTab("\u270F Edit Image", false, "#7fff7f");
    const tabMask = mkTab("\u25D0 Mask", true, "#7fff7f");
    tabEdit.addEventListener("click", () => {
      // Save mask data + current transform snapshot before switching to Edit Image
      const fn = items[curIdx]?.filename;
      if (fn) {
        if (!cropMap[fn]) cropMap[fn] = {};
        cropMap[fn].maskOps = mMaskOps.length > 0 ? [...mMaskOps] : undefined;
        cropMap[fn].maskInverted = mMaskInverted || undefined;
        // Snapshot the transform state so we can remap coords if transforms change
        const ct = cropMap[fn];
        cropMap[fn].maskXform = { ox: ct.ox||0, oy: ct.oy||0, scale: ct.scale||1, flipH: !!ct.flipH, flipV: !!ct.flipV, rotate: ct.rotate||0, cx: ct.cx, cy: ct.cy, cw: ct.cw, ch: ct.ch };
        if (!cropMap[fn].maskOps) delete cropMap[fn].maskOps;
        if (!cropMap[fn].maskInverted) delete cropMap[fn].maskInverted;
        if (!cropMap[fn].maskOps) delete cropMap[fn].maskXform; // no ops = no snapshot needed
        persistCropData();
      }
      close();
      openCropEditor(curIdx, true);
    });
    hdr.appendChild(tabEdit);
    hdr.appendChild(tabMask);

    const spacer = document.createElement("span"); spacer.style.flex = "1";
    const prevB = mkHBtn("\u2190 Prev"), cntEl = document.createElement("span"), nextB = mkHBtn("Next \u2192");
    cntEl.style.cssText = `color:#555;font-size:${_fs11};min-width:${Math.round(52*uiScale)}px;text-align:center;`;
    hdr.appendChild(spacer); hdr.appendChild(prevB); hdr.appendChild(cntEl); hdr.appendChild(nextB);

    // Body
    const body = document.createElement("div");
    body.style.cssText = "flex:1;display:flex;min-height:0;";

    // Left panel
    const pnl = document.createElement("div");
    pnl.style.cssText = `width:${_pnlW}px;flex-shrink:0;background:#111;border-right:1px solid #222;display:flex;flex-direction:column;`;
    const pnlBody = document.createElement("div");
    pnlBody.style.cssText = `flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:${_pad10} ${_pad10};display:flex;flex-direction:column;gap:${_gap5};`;
    const pnlFoot = document.createElement("div");
    pnlFoot.style.cssText = `flex-shrink:0;padding:${_pad6} ${_pad10} ${_r(10)}px;border-top:1px solid #222;display:flex;flex-direction:column;gap:${_gap5};`;

    function mkSec(t) {
      const s = document.createElement("div");
      s.style.cssText = `color:#555;font-size:${_r(9)}px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-top:${_r(6)}px;`;
      s.textContent = t; return s;
    }
    function mkBtn2(t, active) {
      const b = document.createElement("button");
      b.textContent = t; b.style.cssText = `background:${active?"#1e3a1e":"#1e1e1e"};color:${active?"#7fff7f":"#aaa"};border:1px solid ${active?"#3a6a3a":"#333"};border-radius:${_r5};padding:${_r(5)}px ${_pad8};font-size:${_fs11};cursor:pointer;text-align:left;transition:background .12s,border-color .12s;`;
      return b;
    }

    // ── Tool section ──
    pnlBody.appendChild(mkSec("MASK TOOLS"));
    const toolRow = document.createElement("div");
    toolRow.style.cssText = `display:flex;gap:${_r(4)}px;flex-wrap:wrap;`;

    let mTool = "brush"; // "brush" | "lasso" | "polygon" | "fill" | "blur" | "smudge"
    const toolBtns = {};
    [["brush","⬤ Brush"],["lasso","⌾ Lasso"],["polygon","⬡ Polygon"],["fill","⬛ Fill"]].forEach(([k,lbl]) => {
      const b = mkBtn2(lbl, k === mTool);
      b.style.flex = "1 0 auto";
      b.addEventListener("click", () => _selectTool(k));
      toolBtns[k] = b; toolRow.appendChild(b);
    });
    pnlBody.appendChild(toolRow);

    // ── Image tools section ──
    pnlBody.appendChild(mkSec("IMAGE TOOLS"));
    const imgToolRow = document.createElement("div");
    imgToolRow.style.cssText = `display:flex;gap:${_r(4)}px;flex-wrap:wrap;`;
    [["blur","💧 Blur"],["smudge","👆 Smudge"]].forEach(([k,lbl]) => {
      const b = mkBtn2(lbl, false);
      b.style.flex = "1 0 auto";
      b.addEventListener("click", () => _selectTool(k));
      toolBtns[k] = b; imgToolRow.appendChild(b);
    });
    const btnCA = mkBtn2("✨ CA Fill", false);
    btnCA.style.flex = "1 0 auto";
    btnCA.addEventListener("click", () => _runCAFill());
    imgToolRow.appendChild(btnCA);
    pnlBody.appendChild(imgToolRow);

    // ── Smudge strength slider (hidden until smudge tool selected) ──
    const smudgeRow = document.createElement("div");
    smudgeRow.style.cssText = `display:none;gap:${_r(6)}px;align-items:center;margin-top:${_r(2)}px;`;
    const smudgeLbl = document.createElement("span");
    smudgeLbl.style.cssText = `color:#888;font-size:${_fs11};flex-shrink:0;`;
    smudgeLbl.textContent = "Strength";
    const smudgeSlider = document.createElement("input");
    smudgeSlider.type = "range"; smudgeSlider.min = "5"; smudgeSlider.max = "100"; smudgeSlider.value = "50";
    smudgeSlider.style.cssText = `flex:1;accent-color:#40a0ff;`;
    const smudgeValEl = document.createElement("span");
    smudgeValEl.style.cssText = `color:#888;font-size:${_fs11};min-width:${_r(28)}px;text-align:right;`;
    smudgeValEl.textContent = "50%";
    let mSmudgeStr = 0.5;
    smudgeSlider.addEventListener("input", () => { mSmudgeStr = parseInt(smudgeSlider.value) / 100; smudgeValEl.textContent = smudgeSlider.value + "%"; });
    smudgeRow.appendChild(smudgeLbl); smudgeRow.appendChild(smudgeSlider); smudgeRow.appendChild(smudgeValEl);
    pnlBody.appendChild(smudgeRow);

    // ── Brush size ──
    pnlBody.appendChild(mkSec("BRUSH SIZE"));
    const brushRow = document.createElement("div");
    brushRow.style.cssText = `display:flex;gap:${_r(6)}px;align-items:center;`;
    const brushSlider = document.createElement("input");
    brushSlider.type = "range"; brushSlider.min = "4"; brushSlider.max = "150"; brushSlider.value = "30";
    brushSlider.style.cssText = `flex:1;accent-color:#40a0ff;`;
    const brushSizeEl = document.createElement("span");
    brushSizeEl.style.cssText = `color:#888;font-size:${_fs11};min-width:${_r(28)}px;text-align:right;`;
    brushSizeEl.textContent = "30px";
    brushSlider.addEventListener("input", () => { brushSizeEl.textContent = brushSlider.value+"px"; mRedraw(); });
    brushRow.appendChild(brushSlider); brushRow.appendChild(brushSizeEl);
    pnlBody.appendChild(brushRow);

    // ── Mode hint ──
    pnlBody.appendChild(mkSec("SELECTION MODE"));
    const modeHint = document.createElement("div");
    modeHint.style.cssText = `color:#555;font-size:${_r(9.5)}px;line-height:1.5;`;
    modeHint.innerHTML = `<span style="color:#7fb0ff">Default</span> — add<br><span style="color:#ff8080">Alt</span> — subtract`;
    pnlBody.appendChild(modeHint);

    // ── Display section ──
    pnlBody.appendChild(mkSec("DISPLAY"));

    // Mask color picker
    const colorRow = document.createElement("div");
    colorRow.style.cssText = `display:flex;gap:${_r(6)}px;align-items:center;`;
    const colorLbl = document.createElement("span");
    colorLbl.style.cssText = `color:#888;font-size:${_fs11};`;
    colorLbl.textContent = "Mask Color";
    const colorPick = document.createElement("input");
    const _savedColor = localStorage.getItem("mil_mask_color") || "#1e5adc";
    colorPick.type = "color"; colorPick.value = _savedColor;
    colorPick.style.cssText = `width:${_r(28)}px;height:${_r(22)}px;border:none;background:none;cursor:pointer;padding:0;`;
    colorRow.appendChild(colorLbl); colorRow.appendChild(colorPick);
    let mMaskColor = _savedColor;
    colorPick.addEventListener("input", () => { mMaskColor = colorPick.value; localStorage.setItem("mil_mask_color", mMaskColor); _dirtyMask = true; mRedraw(); });
    pnlBody.appendChild(colorRow);

    // Mask transparency slider
    const alphaRow = document.createElement("div");
    alphaRow.style.cssText = `display:flex;gap:${_r(6)}px;align-items:center;`;
    const alphaLbl = document.createElement("span");
    alphaLbl.style.cssText = `color:#888;font-size:${_fs11};flex-shrink:0;`;
    alphaLbl.textContent = "Opacity";
    const alphaSlider = document.createElement("input");
    const _savedAlpha = parseInt(localStorage.getItem("mil_mask_alpha") || "55");
    alphaSlider.type = "range"; alphaSlider.min = "10"; alphaSlider.max = "95"; alphaSlider.value = String(_savedAlpha);
    alphaSlider.style.cssText = `flex:1;accent-color:#40a0ff;`;
    const alphaValEl = document.createElement("span");
    alphaValEl.style.cssText = `color:#888;font-size:${_fs11};min-width:${_r(28)}px;text-align:right;`;
    alphaValEl.textContent = _savedAlpha + "%";
    let mMaskAlpha = _savedAlpha / 100;
    alphaSlider.addEventListener("input", () => {
      mMaskAlpha = parseInt(alphaSlider.value) / 100;
      alphaValEl.textContent = alphaSlider.value + "%";
      localStorage.setItem("mil_mask_alpha", alphaSlider.value);
      _dirtyMask = true; mRedraw();
    });
    alphaRow.appendChild(alphaLbl); alphaRow.appendChild(alphaSlider); alphaRow.appendChild(alphaValEl);
    pnlBody.appendChild(alphaRow);

    // ── Mask ops ──
    pnlBody.appendChild(mkSec("MASK"));
    const invertBtn = mkBtn2("\u21C6 Invert Mask", false);
    const clearMaskBtn = mkBtn2("\u2715 Clear Mask", false);
    clearMaskBtn.style.color = "#ff8888"; clearMaskBtn.style.borderColor = "#884444";
    pnlBody.appendChild(invertBtn); pnlBody.appendChild(clearMaskBtn);

    // ── Keyboard shortcuts reference (subtle, always visible) ────────────
    pnlBody.appendChild(mkSec("SHORTCUTS"));
    const kbHint = document.createElement("div");
    kbHint.style.cssText = `display:grid;grid-template-columns:auto 1fr;gap:${_r(2)}px ${_r(7)}px;align-items:center;`;
    const _kRows = [
      ["B / E",    "Brush / Eraser"],
      ["L / P",    "Lasso / Polygon"],
      ["G",        "Fill (bucket)"],
      ["[ / ]",    "Brush size"],
      ["⌥ drag",  "Subtract mode"],
      ["Ctrl+Z",   "Undo"],
      ["Ctrl+⇧Z",  "Redo"],
      ["Ctrl+I",   "Invert mask"],
      ["Del",      "Clear mask"],
      ["0 – 9",    "Opacity"],
      ["Space",    "Pan"],
      ["Esc",      "Cancel"],
    ];
    const _kStyle = `display:inline-block;background:#1a1a1a;color:#4a7aaa;border:1px solid #2a3a4a;border-radius:${_r(3)}px;padding:1px ${_r(4)}px;font-size:${_r(9)}px;font-family:monospace;letter-spacing:0.3px;white-space:nowrap;line-height:1.6;`;
    const _vStyle = `color:#3d3d3d;font-size:${_r(9.5)}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
    _kRows.forEach(([key, desc]) => {
      const kEl = document.createElement("span"); kEl.style.cssText = _kStyle; kEl.textContent = key;
      const vEl = document.createElement("span"); vEl.style.cssText = _vStyle; vEl.textContent = desc;
      kbHint.appendChild(kEl); kbHint.appendChild(vEl);
    });
    pnlBody.appendChild(kbHint);

    const applyBtn = document.createElement("button");
    applyBtn.textContent = "\u2713 Apply Mask";
    applyBtn.style.cssText = `background:#1a3a28;color:#44cc88;border:1px solid #336644;border-radius:${_r6};padding:${_btnPadW};font-size:${_fs12};font-weight:600;cursor:pointer;width:100%;`;
    applyBtn.addEventListener("mouseenter", () => { applyBtn.style.background="#225540"; applyBtn.style.borderColor="#44cc88"; });
    applyBtn.addEventListener("mouseleave", () => { applyBtn.style.background="#1a3a28"; applyBtn.style.borderColor="#336644"; });
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "\u2715 Cancel";
    cancelBtn.style.cssText = `background:#2a2a2a;color:#aaa;border:1px solid #444;border-radius:${_r6};padding:${_btnPadW};font-size:${_fs12};cursor:pointer;width:100%;`;
    cancelBtn.addEventListener("mouseenter", () => { cancelBtn.style.background="#3a2020"; cancelBtn.style.color="#ff8888"; cancelBtn.style.borderColor="#553333"; });
    cancelBtn.addEventListener("mouseleave", () => { cancelBtn.style.background="#2a2a2a"; cancelBtn.style.color="#aaa"; cancelBtn.style.borderColor="#444"; });
    pnlFoot.appendChild(applyBtn); pnlFoot.appendChild(cancelBtn);

    pnl.appendChild(pnlBody); pnl.appendChild(pnlFoot);

    // Right canvas area
    const ca = document.createElement("div");
    ca.style.cssText = "flex:1;position:relative;background:#141414;overflow:hidden;";
    // ── 4-layer canvas stack ──────────────────────────────────────────
    // Layer 0 (cvsBase):  checkerboard + image + dim outside + frame border
    // Layer 1 (cvsEdits): pixel edits overlay (blur/smudge/cafill)
    // Layer 2 (cvsMask):  committed mask overlay at user-set opacity
    // Layer 3 (cvsTool):  active stroke preview + brush cursor + lasso preview
    // Only the tool layer redraws on mousemove → ~80% fewer draw calls.
    const _mkCvs = (pe) => {
      const c = document.createElement("canvas");
      c.style.cssText = `position:absolute;inset:0;width:100%;height:100%;${pe ? '' : 'pointer-events:none;'}`;
      ca.appendChild(c);
      return c;
    };
    const cvsBase = _mkCvs(false);
    const cvsEdits = _mkCvs(false);
    const cvsMask = _mkCvs(false);
    const cvsTool = _mkCvs(true);  // receives pointer events
    body.appendChild(pnl); body.appendChild(ca);
    dlg.appendChild(hdr); dlg.appendChild(body);
    ov.appendChild(dlg);
    document.body.appendChild(ov);

    // ── State ──
    let mImg = null;
    let mMaskOps = []; // {type:"lasso"|"polygon"|"brush", mode:"add"|"sub", pts:[{x,y}], r?:number}
    let mMaskInverted = false;
    let mLassoCurrentPts = [];
    let mLassoDrawing = false;
    let mAntsOff = 0, mAntsTimer = null;
    let mBrushDrawing = false, mBrushPts = [], mBrushMode = "add";
    let mFrameW = 300, mFrameH = 300, mFrameCX = 0, mFrameCY = 0;
    let mNatW = 1, mNatH = 1;
    let mRafId = null;
    let mBrushPos = null; // {cx, cy} canvas px for brush preview
    // Zoom & pan state
    let mZoom = 1, mPanX = 0, mPanY = 0;
    let mIsPanning = false, mPanIsLMB = false, mPanMoved = false;
    let mPanStartX = 0, mPanStartY = 0, mPanOrigX = 0, mPanOrigY = 0;
    let mSpaceDown = false;
    // ── Layer dirty flags ──────────────────────────────────────────────
    let _dirtyBase = true, _dirtyEdits = true, _dirtyMask = true;
    // ── Undo / Redo stacks ─────────────────────────────────────────────
    let mUndoStack = [];  // popped ops for redo
    // ── Default brush mode for shortcuts ────────────────────────────────
    let mDefaultBrushMode = "add"; // "add" for brush (B), "sub" for eraser (E)
    // ── Cached brush tip ───────────────────────────────────────────────
    let _tipCache = null; // { radius, color, canvas }
    // ── Pixel edits state ──────────────────────────────────────────────
    let _cvsEditsPx = null;      // offscreen canvas with pixel edits (max 2048px)
    let _editsUndoStack = [];    // base64 snapshots for undo (max 10)
    let _cafillLoading = false;  // debounce flag

    function close() {
      if (mAntsTimer) clearInterval(mAntsTimer);
      cancelAnimationFrame(mRafId);
      window.removeEventListener("mouseup",  _onMouseUp);
      window.removeEventListener("mousemove", _onPanMove);
      window.removeEventListener("mouseup",   _onPanUp);
      window.removeEventListener("keydown",  _keyHandler);
      window.removeEventListener("keyup",    _keyUpHandler);
      if (ov.parentNode) ov.parentNode.removeChild(ov);
    }
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    cancelBtn.addEventListener("click", close);

    // ── Mask canvas helpers ──
    let mBaseFrameW = 300, mBaseFrameH = 300; // before zoom
    function _syncFrame() {
      const r = ca.getBoundingClientRect();
      const rw = Math.round(r.width), rh = Math.round(r.height);
      // Sync all 4 canvases to container size
      for (const c of [cvsBase, cvsEdits, cvsMask, cvsTool]) {
        if (c.width !== rw || c.height !== rh) { c.width = rw; c.height = rh; _dirtyBase = true; _dirtyEdits = true; _dirtyMask = true; }
      }
      const cw = rw, ch = rh, pad = 40;
      const asp = mNatW / mNatH;
      const maxW = cw - pad * 2, maxH = ch - pad * 2;
      if (asp >= maxW / maxH) { mBaseFrameW = maxW; mBaseFrameH = Math.round(maxW / asp); }
      else                    { mBaseFrameH = maxH; mBaseFrameW = Math.round(maxH * asp); }
      mFrameW = Math.round(mBaseFrameW * mZoom);
      mFrameH = Math.round(mBaseFrameH * mZoom);
      mFrameCX = cw / 2 + mPanX;
      mFrameCY = ch / 2 + mPanY;
    }

    // Convert canvas px → normalized (0..1) image coords
    function _pxToNorm(cx, cy) {
      return { nx: (cx - (mFrameCX - mFrameW / 2)) / mFrameW,
               ny: (cy - (mFrameCY - mFrameH / 2)) / mFrameH };
    }
    // Convert normalized → canvas px
    function _normToPx(nx, ny) {
      return { cx: mFrameCX - mFrameW / 2 + nx * mFrameW,
               cy: mFrameCY - mFrameH / 2 + ny * mFrameH };
    }

    // ── Professional Brush Engine v2 ─────────────────────────────────────────
    // #3: Natural cubic splines via Thomas' Algorithm (tridiagonal matrix solver)
    //     + Arc-length LUT for O(log n) equidistant stamp lookup.
    //     + Pre-rendered soft tip with radial hardness gradient (cached).

    // Thomas' Algorithm: solve tridiagonal system Ax=d in O(n).
    function _thomasSolve(lower, diag, upper, rhs) {
      const n = rhs.length;
      const c = new Float64Array(n), d = new Float64Array(n);
      c[0] = upper[0] / diag[0]; d[0] = rhs[0] / diag[0];
      for (let i = 1; i < n; i++) {
        const m = diag[i] - lower[i] * c[i - 1];
        c[i] = upper[i] / m;
        d[i] = (rhs[i] - lower[i] * d[i - 1]) / m;
      }
      const x = new Float64Array(n);
      x[n - 1] = d[n - 1];
      for (let i = n - 2; i >= 0; i--) x[i] = d[i] - c[i] * x[i + 1];
      return x;
    }

    // Build natural cubic spline for 1-D values via Thomas' Algorithm.
    // Returns {a,b,c,d} cubic coefficients per segment S_i(t), t∈[0,1].
    function _naturalSpline1D(vals) {
      const n = vals.length;
      if (n < 2) return null;
      if (n === 2) {
        return { a: Float64Array.from(vals), b: new Float64Array([vals[1]-vals[0],0]),
                 c: new Float64Array(2), d: new Float64Array(2) };
      }
      const m = n - 1;
      const lo = new Float64Array(m+1), di = new Float64Array(m+1), up = new Float64Array(m+1);
      const rhs = new Float64Array(m+1);
      di[0] = 1; di[m] = 1; // natural BCs: σ₀=σₙ=0
      for (let i = 1; i < m; i++) {
        lo[i] = 1; di[i] = 4; up[i] = 1;
        rhs[i] = 3 * (vals[i+1] - vals[i-1]);
      }
      const sigma = _thomasSolve(lo, di, up, rhs);
      const a = Float64Array.from(vals);
      const b = new Float64Array(m), c = new Float64Array(m), d = new Float64Array(m);
      for (let i = 0; i < m; i++) {
        b[i] = vals[i+1] - vals[i] - (2*sigma[i] + sigma[i+1]) / 6;
        c[i] = sigma[i] / 2;
        d[i] = (sigma[i+1] - sigma[i]) / 6;
      }
      return { a, b, c, d };
    }

    // Build arc-length LUT (cumulative chord-length table, 20 samples/segment).
    const _SPLINE_S = 20; // samples per segment
    function _buildArcLUT(sx, sy, nSeg) {
      const lut = new Float64Array(nSeg * _SPLINE_S + 1);
      let px = sx.a[0], py = sy.a[0], cum = 0;
      for (let i = 0; i < nSeg; i++) {
        for (let s = 1; s <= _SPLINE_S; s++) {
          const t = s / _SPLINE_S, t2 = t*t, t3 = t2*t;
          const x = sx.a[i]+sx.b[i]*t+sx.c[i]*t2+sx.d[i]*t3;
          const y = sy.a[i]+sy.b[i]*t+sy.c[i]*t2+sy.d[i]*t3;
          cum += Math.hypot(x-px, y-py); lut[i*_SPLINE_S+s] = cum;
          px = x; py = y;
        }
      }
      return { lut, totalLen: cum };
    }

    // Binary-search LUT → spline {segIdx, t} for arc length s.
    function _lutInv(lut, s, nSeg) {
      let lo = 0, hi = nSeg * _SPLINE_S;
      while (lo < hi - 1) { const mid = (lo+hi)>>1; if (lut[mid] < s) lo=mid; else hi=mid; }
      const frac = lut[hi]===lut[lo] ? 0 : (s-lut[lo])/(lut[hi]-lut[lo]);
      const seg = Math.min(Math.floor(lo/_SPLINE_S), nSeg-1);
      return { seg, t: (lo%_SPLINE_S + frac)/_SPLINE_S };
    }

    // Equidistant stamps along natural cubic spline (replaces Catmull-Rom).
    function _stampAlongPath(pts, spacingNorm) {
      const n = pts.length;
      if (n < 2) return pts.slice();
      const sx = _naturalSpline1D(pts.map(p=>p.x));
      const sy = _naturalSpline1D(pts.map(p=>p.y));
      if (!sx) return pts.slice();
      const nSeg = n - 1;
      const { lut, totalLen } = _buildArcLUT(sx, sy, nSeg);
      if (totalLen === 0 || spacingNorm <= 0) return pts.slice();
      const stamps = [];
      for (let s = 0; s <= totalLen; s += spacingNorm) {
        const { seg, t } = _lutInv(lut, s, nSeg);
        const t2 = t*t, t3 = t2*t;
        stamps.push({
          x: sx.a[seg]+sx.b[seg]*t+sx.c[seg]*t2+sx.d[seg]*t3,
          y: sy.a[seg]+sy.b[seg]*t+sy.c[seg]*t2+sy.d[seg]*t3,
        });
      }
      return stamps.length ? stamps : pts.slice();
    }

    // Pre-render a soft brush tip with radial hardness gradient
    function _getBrushTip(radius, fillRGBA) {
      const rk = `${Math.round(radius)}|${fillRGBA}`;
      if (_tipCache && _tipCache.key === rk) return _tipCache.canvas;
      const sz = Math.max(2, Math.ceil(radius * 2));
      const tip = document.createElement("canvas"); tip.width = sz; tip.height = sz;
      const tx = tip.getContext("2d");
      const cx = sz / 2, cy = sz / 2;
      const grad = tx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      grad.addColorStop(0, fillRGBA);
      grad.addColorStop(0.7, fillRGBA);  // hardness = 0.7
      grad.addColorStop(1, fillRGBA.replace(/,[\s\d.]+\)$/, ',0)'));
      tx.fillStyle = grad;
      tx.fillRect(0, 0, sz, sz);
      _tipCache = { key: rk, canvas: tip };
      return tip;
    }
    // Stamp brush tip along a Bézier-interpolated path on ctx
    function _stampBrush(ctx, pts, rPx, w, h, fillRGBA) {
      if (pts.length === 0) return;
      const spacingN = Math.max(0.001, (rPx * 0.25) / Math.max(w, h));
      const stamps = pts.length >= 2 ? _stampAlongPath(pts, spacingN) : pts;
      const tip = _getBrushTip(rPx, fillRGBA);
      for (const p of stamps) {
        ctx.drawImage(tip, Math.floor(p.x * w - rPx), Math.floor(p.y * h - rPx));
      }
    }

    // ── #5 Bucket Fill ─────────────────────────────────────────────────────────
    // Scanline flood fill on a BINARIZED mask (hard threshold at R=128).
    // Step 1: Build current mask → Step 2: Binarize → Step 3: Flood fill.
    function _bucketFill(nx, ny, mode) {
      const w = mNatW, h = mNatH;
      if (w < 1 || h < 1) return;
      console.log("[Fill] start", {w, h, nx: nx.toFixed(3), ny: ny.toFixed(3), mode});

      // 1. Build current mask state
      const maskCvs = _buildMaskCanvas(w, h);
      const mx = maskCvs.getContext("2d");
      const imgData = mx.getImageData(0, 0, w, h);
      const d = imgData.data;

      // 2. Hard binarize: every pixel becomes 0 (masked) or 255 (empty)
      const THRESH = 128;
      const bin = new Uint8Array(w * h); // 0=masked, 1=empty
      for (let i = 0; i < w * h; i++) {
        const v = d[i * 4] >= THRESH ? 1 : 0;
        bin[i] = v;
      }

      // Seed pixel
      const sx = Math.max(0, Math.min(w - 1, Math.floor(nx * w)));
      const sy = Math.max(0, Math.min(h - 1, Math.floor(ny * h)));
      const seedVal = bin[sy * w + sx]; // 1=empty, 0=masked

      // For "add" mode: fill empty region (seedVal must be 1)
      // For "sub" mode: fill masked region (seedVal must be 0)
      const wantSeed = mode === "add" ? 1 : 0;
      if (seedVal !== wantSeed) {
        console.log("[Fill] seed mismatch", {seedVal, wantSeed, seedR: d[(sy*w+sx)*4]});
        return;
      }

      // Count barrier pixels for debug
      let barrierCount = 0;
      for (let i = 0; i < w * h; i++) if (bin[i] !== wantSeed) barrierCount++;
      console.log("[Fill] barrier pixels:", barrierCount, "of", w*h);

      // 3. Scanline flood fill on binary array
      const filled = new Uint8Array(w * h);
      let fillCount = 0;
      const stack = [[sx, sy]];
      while (stack.length) {
        let [x, y] = stack.pop();
        // Walk left to find span start
        while (x > 0 && bin[(y * w) + x - 1] === wantSeed && !filled[y * w + x - 1]) x--;
        let spanUp = false, spanDn = false;
        while (x < w && bin[y * w + x] === wantSeed && !filled[y * w + x]) {
          filled[y * w + x] = 1;
          fillCount++;
          // Check row above
          if (y > 0) {
            const above = (y - 1) * w + x;
            if (!spanUp && bin[above] === wantSeed && !filled[above]) {
              stack.push([x, y - 1]); spanUp = true;
            } else if (spanUp && (bin[above] !== wantSeed || filled[above])) {
              spanUp = false;
            }
          }
          // Check row below
          if (y < h - 1) {
            const below = (y + 1) * w + x;
            if (!spanDn && bin[below] === wantSeed && !filled[below]) {
              stack.push([x, y + 1]); spanDn = true;
            } else if (spanDn && (bin[below] !== wantSeed || filled[below])) {
              spanDn = false;
            }
          }
          x++;
        }
      }
      console.log("[Fill] filled pixels:", fillCount, "of", w*h);

      // 4. Apply fill AND binarize the ENTIRE canvas.
      // Binarize all pixels so soft brush edges (R≈128–254) become hard 0/255.
      // Without this, the backend mask shows brush outlines separately from fill.
      for (let i = 0; i < w * h; i++) {
        let v;
        if (filled[i]) {
          v = mode === "add" ? 0 : 255;  // fill target
        } else {
          v = d[i * 4] >= THRESH ? 255 : 0; // binarize existing
        }
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
        d[i * 4 + 3] = 255;
      }
      mx.putImageData(imgData, 0, 0);

      // 5. Store result canvas
      const fillCanvas = document.createElement("canvas");
      fillCanvas.width = w; fillCanvas.height = h;
      fillCanvas.getContext("2d").drawImage(maskCvs, 0, 0);
      mMaskOps.push({ type: "fill", mode, _canvas: fillCanvas });
      mUndoStack = [];
      _dirtyMask = true; mRedraw();
    }

    // Build a flat mask canvas (w×h, black=masked, white=unmasked) from mMaskOps
    function _buildMaskCanvas(w, h) {
      const mc = document.createElement("canvas"); mc.width = w; mc.height = h;
      const mx = mc.getContext("2d");
      // Start white (unmasked)
      mx.fillStyle = "#fff"; mx.fillRect(0, 0, w, h);
      mx.globalCompositeOperation = "source-over";
      for (const op of mMaskOps) {
        // ── fill op: composite pre-rendered canvas ────────────────────────
        if (op.type === "fill" && op._canvas) {
          mx.globalCompositeOperation = "source-over";
          mx.drawImage(op._canvas, 0, 0, w, h);
          continue;
        }
        if (!op.pts || op.pts.length < 1) continue;
        // add = paint black (mask), sub = erase back to white (unmask)
        mx.fillStyle = op.mode === "sub" ? "#fff" : "#000";
        if (op.type === "brush") {
          const r = Math.max(1, (op.r || 0.01) * w);
          const fill = op.mode === "sub" ? "rgba(255,255,255,1)" : "rgba(0,0,0,1)";
          _stampBrush(mx, op.pts, r, w, h, fill);
        } else {
          if (op.pts.length < 3) continue;
          mx.beginPath();
          mx.moveTo(op.pts[0].x*w, op.pts[0].y*h);
          for (let i = 1; i < op.pts.length; i++) mx.lineTo(op.pts[i].x*w, op.pts[i].y*h);
          mx.closePath(); mx.fill();
        }
      }
      if (mMaskInverted) {
        // XOR with white to invert: use a second canvas
        const inv = document.createElement("canvas"); inv.width = w; inv.height = h;
        const ix = inv.getContext("2d");
        ix.fillStyle = "#fff"; ix.fillRect(0, 0, w, h);
        ix.globalCompositeOperation = "difference";
        ix.drawImage(mc, 0, 0);
        return inv;
      }
      return mc;
    }


    // ── Pixel Tool Engines ────────────────────────────────────────────────────
    // All pixel tools operate on _cvsEditsPx, a downscaled offscreen canvas
    // (max 2048px) that gets composited into the display via drawEdits().

    function _ensureEditsPx() {
      if (_cvsEditsPx) return;
      const wpX = Math.min(mNatW, 2048);
      const wpY = Math.round(mNatH * (wpX / mNatW));
      _cvsEditsPx = document.createElement("canvas");
      _cvsEditsPx.width = wpX; _cvsEditsPx.height = wpY;
      if (mImg) {
        const ctx = _cvsEditsPx.getContext("2d");
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        ctx.drawImage(mImg, 0, 0, wpX, wpY);
      }
    }

    function _saveEditsUndo() {
      if (!_cvsEditsPx) return;
      _editsUndoStack.push(_cvsEditsPx.toDataURL("image/webp", 0.92));
      if (_editsUndoStack.length > 10) _editsUndoStack.shift();
    }

    function _undoEdits() {
      if (_editsUndoStack.length === 0) return;
      const src = _editsUndoStack.pop();
      const img = new Image();
      img.onload = () => {
        const ctx = _cvsEditsPx.getContext("2d");
        ctx.clearRect(0, 0, _cvsEditsPx.width, _cvsEditsPx.height);
        ctx.drawImage(img, 0, 0);
        _dirtyEdits = true; mRedraw();
      };
      img.src = src;
    }

    // ── Blur: separable box blur O(N·R) with soft circular falloff ─────────
    function _applyBlur(cx, cy, r) {
      if (!_cvsEditsPx) return;
      const w = _cvsEditsPx.width, h = _cvsEditsPx.height;
      const ctx = _cvsEditsPx.getContext("2d", { willReadFrequently: true });
      const bx = Math.max(0, Math.floor(cx - r)), by = Math.max(0, Math.floor(cy - r));
      const bw = Math.min(w - bx, Math.ceil(r * 2)), bh = Math.min(h - by, Math.ceil(r * 2));
      if (bw <= 0 || bh <= 0) return;
      // Read original region for blending
      const origData = ctx.getImageData(bx, by, bw, bh);
      const origD = new Uint8ClampedArray(origData.data);
      const imgData = ctx.getImageData(bx, by, bw, bh);
      const d = imgData.data;
      const tmp = new Uint8ClampedArray(d.length);
      const rad = Math.max(1, Math.floor(r * 0.25));
      // Horizontal pass
      for (let row = 0; row < bh; row++) {
        let rs = 0, gs = 0, bs = 0, cnt = 0;
        for (let i = -rad; i <= rad; i++) {
          const xi = Math.max(0, Math.min(bw - 1, i));
          const pi = (row * bw + xi) * 4;
          rs += d[pi]; gs += d[pi+1]; bs += d[pi+2]; cnt++;
        }
        for (let col = 0; col < bw; col++) {
          const po = (row * bw + col) * 4;
          tmp[po] = rs / cnt; tmp[po+1] = gs / cnt; tmp[po+2] = bs / cnt; tmp[po+3] = 255;
          const removeIdx = Math.max(0, col - rad);
          const addIdx = Math.min(bw - 1, col + rad + 1);
          const pr = (row * bw + removeIdx) * 4, pa = (row * bw + addIdx) * 4;
          rs += d[pa] - d[pr]; gs += d[pa+1] - d[pr+1]; bs += d[pa+2] - d[pr+2];
        }
      }
      // Vertical pass
      for (let col = 0; col < bw; col++) {
        let rs = 0, gs = 0, bs = 0, cnt = 0;
        for (let i = -rad; i <= rad; i++) {
          const yi = Math.max(0, Math.min(bh - 1, i));
          const pi = (yi * bw + col) * 4;
          rs += tmp[pi]; gs += tmp[pi+1]; bs += tmp[pi+2]; cnt++;
        }
        for (let row = 0; row < bh; row++) {
          const po = (row * bw + col) * 4;
          d[po] = rs / cnt; d[po+1] = gs / cnt; d[po+2] = bs / cnt; d[po+3] = 255;
          const removeIdx = Math.max(0, row - rad);
          const addIdx = Math.min(bh - 1, row + rad + 1);
          const pr = (removeIdx * bw + col) * 4, pa = (addIdx * bw + col) * 4;
          rs += tmp[pa] - tmp[pr]; gs += tmp[pa+1] - tmp[pr+1]; bs += tmp[pa+2] - tmp[pr+2];
        }
      }
      // Soft circular blend with original
      for (let row = 0; row < bh; row++) {
        for (let col = 0; col < bw; col++) {
          const dist = Math.hypot(col - (cx - bx), row - (cy - by));
          const f = dist <= r ? Math.pow(1 - dist / r, 1.2) : 0;
          const i = (row * bw + col) * 4;
          d[i]   = origD[i]   * (1 - f) + d[i]   * f;
          d[i+1] = origD[i+1] * (1 - f) + d[i+1] * f;
          d[i+2] = origD[i+2] * (1 - f) + d[i+2] * f;
        }
      }
      ctx.putImageData(imgData, bx, by);
      _dirtyEdits = true;
    }

    // ── Smudge: ping-pong buffer pixel drag ────────────────────────────────
    let _smudgeBuf = null;
    function _applySmudge(lastPos, currPos, r) {
      if (!_cvsEditsPx || !lastPos) return;
      const ctx = _cvsEditsPx.getContext("2d");
      const w = _cvsEditsPx.width, h = _cvsEditsPx.height;
      // Lazy-init buffer
      if (!_smudgeBuf || _smudgeBuf.width !== w || _smudgeBuf.height !== h) {
        _smudgeBuf = document.createElement("canvas");
        _smudgeBuf.width = w; _smudgeBuf.height = h;
      }
      const bCtx = _smudgeBuf.getContext("2d");
      bCtx.clearRect(0, 0, w, h);
      // Copy source, shifted by delta, clipped to circle at currPos
      bCtx.save();
      bCtx.beginPath(); bCtx.arc(currPos.x, currPos.y, r, 0, Math.PI * 2); bCtx.clip();
      const dx = currPos.x - lastPos.x, dy = currPos.y - lastPos.y;
      bCtx.drawImage(_cvsEditsPx, dx, dy);
      bCtx.restore();
      // Blend into main canvas with radial gradient mask
      const stampSize = Math.ceil(r) * 2;
      const stampCvs = document.createElement("canvas");
      stampCvs.width = stampSize; stampCvs.height = stampSize;
      const sCtx = stampCvs.getContext("2d");
      const sx = currPos.x - r, sy = currPos.y - r;
      sCtx.globalAlpha = mSmudgeStr * 0.92;
      sCtx.drawImage(_smudgeBuf, sx, sy, stampSize, stampSize, 0, 0, stampSize, stampSize);
      sCtx.globalCompositeOperation = "destination-in";
      const grad = sCtx.createRadialGradient(r, r, 0, r, r, r);
      grad.addColorStop(0, "rgba(0,0,0,1)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      sCtx.fillStyle = grad; sCtx.fillRect(0, 0, stampSize, stampSize);
      ctx.drawImage(stampCvs, sx, sy);
      _dirtyEdits = true;
    }

    // ── CA Fill: send image+mask to backend, replace _cvsEditsPx ───────────
    async function _runCAFill() {
      if (_cafillLoading || mMaskOps.length === 0) return;
      _cafillLoading = true; btnCA.textContent = "⏳ Working…";
      try {
        _ensureEditsPx(); _saveEditsUndo();
        const maskCvs = _buildMaskCanvas(_cvsEditsPx.width, _cvsEditsPx.height);
        const payload = {
          image: _cvsEditsPx.toDataURL("image/png"),
          mask: maskCvs.toDataURL("image/png")
        };
        const res = await fetch("/multi_image_loader/inpaint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error("Inpaint request failed: " + res.status);
        const j = await res.json();
        if (j.error) throw new Error(j.error);
        const img = new Image();
        await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = j.image; });
        const ctx = _cvsEditsPx.getContext("2d");
        ctx.clearRect(0, 0, _cvsEditsPx.width, _cvsEditsPx.height);
        ctx.drawImage(img, 0, 0, _cvsEditsPx.width, _cvsEditsPx.height);
        _dirtyEdits = true; mRedraw();
      } catch (e) {
        console.error("[MIL] CA Fill error:", e);
        alert("Content-Aware Fill failed: " + e.message);
      } finally {
        _cafillLoading = false; btnCA.textContent = "✨ CA Fill";
      }
    }


    // ── Split-Layer Rendering ──────────────────────────────────────────────────
    // Layer 0 (cvsBase): checkerboard + image + dim outside + frame border
    function drawBase() {
      const ctx = cvsBase.getContext("2d");
      const cw = cvsBase.width, ch = cvsBase.height;
      const fx = mFrameCX - mFrameW / 2, fy = mFrameCY - mFrameH / 2;
      const T = 14;
      for (let rr = 0; rr < Math.ceil(ch / T); rr++) for (let cc = 0; cc < Math.ceil(cw / T); cc++) {
        ctx.fillStyle = (rr + cc) % 2 === 0 ? "#1a1a1a" : "#141414";
        ctx.fillRect(cc * T, rr * T, T, T);
      }
      if (mImg) ctx.drawImage(mImg, fx, fy, mFrameW, mFrameH);
      ctx.fillStyle = "rgba(0,0,0,0.58)";
      ctx.fillRect(0, 0, cw, fy); ctx.fillRect(0, fy + mFrameH, cw, ch - fy - mFrameH);
      ctx.fillRect(0, fy, fx, mFrameH); ctx.fillRect(fx + mFrameW, fy, cw - fx - mFrameW, mFrameH);
      ctx.strokeStyle = "rgba(255,255,255,0.3)"; ctx.lineWidth = 1.5; ctx.setLineDash([]);
      ctx.strokeRect(fx + 0.75, fy + 0.75, mFrameW - 1.5, mFrameH - 1.5);
    }
    // Layer 1 (cvsEdits): pixel edits overlay
    function drawEdits() {
      const ctx = cvsEdits.getContext("2d");
      ctx.clearRect(0, 0, cvsEdits.width, cvsEdits.height);
      if (!_cvsEditsPx) return;
      const fx = mFrameCX - mFrameW / 2, fy = mFrameCY - mFrameH / 2;
      ctx.save();
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.drawImage(_cvsEditsPx, fx, fy, mFrameW, mFrameH);
      ctx.restore();
    }
    // Layer 2 (cvsMask): committed mask overlay
    function drawMask() {
      const ctx = cvsMask.getContext("2d");
      ctx.clearRect(0, 0, cvsMask.width, cvsMask.height);
      const fx = mFrameCX - mFrameW / 2, fy = mFrameCY - mFrameH / 2;
      if (mMaskOps.length > 0 || mMaskInverted) {
        const mc = document.createElement("canvas"); mc.width = mFrameW; mc.height = mFrameH;
        const mx = mc.getContext("2d");
        const [_cr,_cg,_cb] = [parseInt(mMaskColor.slice(1,3),16), parseInt(mMaskColor.slice(3,5),16), parseInt(mMaskColor.slice(5,7),16)];
        const _mFill = `rgba(${_cr},${_cg},${_cb},1)`;
        for (const op of mMaskOps) {
          // ── fill op: render pre-computed canvas as colored overlay ──────
          if (op.type === "fill" && op._canvas) {
            // _canvas: R=0 (black) = masked, R=255 (white) = unmasked.
            // Convert to RGBA colored overlay: alpha = 255 - R (inverts mask to alpha).
            // This is the ONLY correct way — destination-in needs true alpha, not color.
            const offCvs = document.createElement("canvas");
            offCvs.width = mFrameW; offCvs.height = mFrameH;
            const offCtx = offCvs.getContext("2d");
            offCtx.drawImage(op._canvas, 0, 0, mFrameW, mFrameH);
            const id = offCtx.getImageData(0, 0, mFrameW, mFrameH);
            const dd = id.data;
            for (let pi = 0; pi < dd.length; pi += 4) {
              const a = 255 - dd[pi]; // invert R: black→alpha=255, white→alpha=0
              dd[pi] = _cr; dd[pi+1] = _cg; dd[pi+2] = _cb; dd[pi+3] = a;
            }
            offCtx.putImageData(id, 0, 0);
            mx.globalCompositeOperation = op.mode === "sub" ? "destination-out" : "source-over";
            mx.drawImage(offCvs, 0, 0);
            continue;
          }
          if (!op.pts || op.pts.length < 1) continue;
          mx.globalCompositeOperation = op.mode === "sub" ? "destination-out" : "source-over";
          mx.fillStyle = _mFill;
          if (op.type === "brush") {
            const r = Math.max(1, (op.r || 0.005) * mFrameW);
            _stampBrush(mx, op.pts, r, mFrameW, mFrameH, _mFill);
          } else {
            if (op.pts.length < 3) continue;
            mx.beginPath();
            mx.moveTo(op.pts[0].x * mFrameW, op.pts[0].y * mFrameH);
            for (let i = 1; i < op.pts.length; i++) mx.lineTo(op.pts[i].x * mFrameW, op.pts[i].y * mFrameH);
            mx.closePath(); mx.fill();
          }
        }
        if (mMaskInverted) {
          const ic = document.createElement("canvas"); ic.width = mFrameW; ic.height = mFrameH;
          const ix = ic.getContext("2d");
          ix.fillStyle = _mFill; ix.fillRect(0, 0, mFrameW, mFrameH);
          ix.globalCompositeOperation = "destination-out"; ix.drawImage(mc, 0, 0);
          ctx.save(); ctx.globalAlpha = mMaskAlpha; ctx.drawImage(ic, fx, fy); ctx.restore();
        } else {
          ctx.save(); ctx.globalAlpha = mMaskAlpha; ctx.drawImage(mc, fx, fy); ctx.restore();
        }
      }
    }
    // Layer 3 (cvsTool): active stroke + brush cursor + lasso preview
    function drawTool() {
      const ctx = cvsTool.getContext("2d");
      ctx.clearRect(0, 0, cvsTool.width, cvsTool.height);
      const fx = mFrameCX - mFrameW / 2, fy = mFrameCY - mFrameH / 2;
      // Active brush stroke — use lineTo with round cap for gap-free preview
      if (mTool === "brush" && mBrushDrawing && mBrushPts.length > 0) {
        const [_cr2,_cg2,_cb2] = [parseInt(mMaskColor.slice(1,3),16), parseInt(mMaskColor.slice(3,5),16), parseInt(mMaskColor.slice(5,7),16)];
        const _isE = mBrushMode === "sub";
        const [_pr,_pg,_pb] = _isE ? [255-_cr2, 255-_cg2, 255-_cb2] : [_cr2, _cg2, _cb2];
        const r = Math.max(1, parseFloat(brushSlider.value) * (mFrameW / (mNatW || 1)));
        ctx.save(); ctx.globalAlpha = mMaskAlpha * 0.82;
        ctx.strokeStyle = `rgba(${_pr},${_pg},${_pb},1)`; ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = r * 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(fx + mBrushPts[0].x * mFrameW, fy + mBrushPts[0].y * mFrameH);
        for (let i = 1; i < mBrushPts.length; i++) {
          ctx.lineTo(fx + mBrushPts[i].x * mFrameW, fy + mBrushPts[i].y * mFrameH);
        }
        ctx.stroke();
        // Endpoint dot (for single-click stamps)
        if (mBrushPts.length === 1) {
          ctx.beginPath();
          ctx.arc(fx + mBrushPts[0].x * mFrameW, fy + mBrushPts[0].y * mFrameH, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      // In-progress lasso/polygon preview
      if (mLassoCurrentPts.length > 1) {
        const [_cr3,_cg3,_cb3] = [parseInt(mMaskColor.slice(1,3),16), parseInt(mMaskColor.slice(3,5),16), parseInt(mMaskColor.slice(5,7),16)];
        const p0 = _normToPx(mLassoCurrentPts[0].x, mLassoCurrentPts[0].y);
        ctx.save(); ctx.beginPath(); ctx.moveTo(p0.cx, p0.cy);
        for (let i = 1; i < mLassoCurrentPts.length; i++) {
          const p = _normToPx(mLassoCurrentPts[i].x, mLassoCurrentPts[i].y);
          ctx.lineTo(p.cx, p.cy);
        }
        ctx.closePath();
        ctx.fillStyle = `rgba(${_cr3},${_cg3},${_cb3},0.35)`; ctx.fill();
        ctx.strokeStyle = "rgba(64,200,255,0.9)"; ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]); ctx.lineDashOffset = -mAntsOff; ctx.stroke();
        ctx.restore();
      }
      // Brush cursor circle (shown for brush, blur, smudge tools)
      if ((mTool === "brush" || mTool === "blur" || mTool === "smudge") && mBrushPos) {
        const r = parseFloat(brushSlider.value) * (mFrameW / (mNatW || 1));
        const cursorColor = mTool === "blur" ? "rgba(100,180,255,0.8)"
                          : mTool === "smudge" ? "rgba(255,180,100,0.8)"
                          : (mBrushMode === "sub" ? `rgba(${255-parseInt(mMaskColor.slice(1,3),16)},${255-parseInt(mMaskColor.slice(3,5),16)},${255-parseInt(mMaskColor.slice(5,7),16)},0.9)` : "rgba(64,200,255,0.8)");
        ctx.save(); ctx.strokeStyle = cursorColor; ctx.lineWidth = 1.5; ctx.setLineDash([4, 2]);
        ctx.beginPath(); ctx.arc(mBrushPos.cx, mBrushPos.cy, r, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }
    // Coordinator: uses dirty flags so mousemove only redraws tool layer
    function mRedraw() {
      cancelAnimationFrame(mRafId);
      mRafId = requestAnimationFrame(() => {
        _syncFrame();
        if (_dirtyBase) { drawBase(); _dirtyBase = false; }
        if (_dirtyEdits) { drawEdits(); _dirtyEdits = false; }
        if (_dirtyMask) { drawMask(); _dirtyMask = false; }
        drawTool(); // always redraw — cheapest layer
      });
    }

    // Marching ants
    mAntsTimer = setInterval(() => { mAntsOff = (mAntsOff + 1) % 8; if (mLassoCurrentPts.length > 1) mRedraw(); }, 80);

    function updateCursor() {
      if (mTool === "brush" || mTool === "blur" || mTool === "smudge") ca.style.cursor = "none";
      else if (mTool === "fill") ca.style.cursor = "cell";
      else ca.style.cursor = "crosshair";
    }
    updateCursor();

    function getModeFromEvent(e) { return e.altKey ? "sub" : "add"; }

    function commitShape(pts, mode, type) {
      if (pts.length < (type === "brush" ? 1 : 3)) return;
      mMaskOps.push({ type, mode, pts: pts.map(p => ({ x: p.x, y: p.y })), r: parseFloat(brushSlider.value) / (mNatW || 1) * (mNatW || 1) });
      mUndoStack = []; // new op clears redo
      mLassoCurrentPts = []; mBrushPts = [];
      _dirtyMask = true; mRedraw();
    }
    // ── Undo/Redo helpers ──
    function _undo() {
      if (mMaskOps.length === 0) return;
      mUndoStack.push(mMaskOps.pop());
      _dirtyMask = true; mRedraw();
    }
    function _redo() {
      if (mUndoStack.length === 0) return;
      mMaskOps.push(mUndoStack.pop());
      _dirtyMask = true; mRedraw();
    }
    // Helper: select tool and sync UI
    function _selectTool(t) {
      mTool = t;
      Object.entries(toolBtns).forEach(([kk, bb]) => {
        const on = kk === t;
        bb.style.background = on ? "#1e3a1e" : "#1e1e1e";
        bb.style.color = on ? "#7fff7f" : "#aaa";
        bb.style.borderColor = on ? "#3a6a3a" : "#333";
      });
      // Show/hide smudge strength slider
      smudgeRow.style.display = t === "smudge" ? "flex" : "none";
      // Init pixel canvas for pixel tools
      if (t === "blur" || t === "smudge") _ensureEditsPx();
      mLassoCurrentPts = [];
      updateCursor();
      mRedraw();
    }

    // ── Mouse events ──
    ca.addEventListener("mousemove", (e) => {
      if (mIsPanning) return; // panning handled separately
      const r = ca.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const { nx, ny } = _pxToNorm(cx, cy);
      const cnx = Math.max(0, Math.min(1, nx)), cny = Math.max(0, Math.min(1, ny));
      mBrushPos = { cx, cy };
      // Brush mode follows default (B=add, E=sub) unless overridden by Alt
      if (!mBrushDrawing) mBrushMode = e.altKey ? "sub" : mDefaultBrushMode;

      if (mTool === "brush" && mBrushDrawing) {
        mBrushPts.push({ x: cnx, y: cny });
        mRedraw(); return;
      }
      if ((mTool === "blur" || mTool === "smudge") && mBrushDrawing) {
        const fx = mFrameCX - mFrameW / 2, fy = mFrameCY - mFrameH / 2;
        const pxScale = _cvsEditsPx ? _cvsEditsPx.width / mFrameW : 1;
        const epx = (cx - fx) * pxScale, epy = (cy - fy) * pxScale;
        const rPx = parseFloat(brushSlider.value) * pxScale;
        if (mTool === "blur") {
          _applyBlur(epx, epy, rPx);
        } else {
          const prevPt = mBrushPts.length > 0 ? mBrushPts[mBrushPts.length - 1] : null;
          if (prevPt) _applySmudge(prevPt, { x: epx, y: epy }, rPx);
        }
        mBrushPts.push({ x: epx, y: epy });
        mRedraw(); return;
      }
      if (mTool === "lasso" && mLassoDrawing) {
        mLassoCurrentPts.push({ x: cnx, y: cny });
        mRedraw(); return;
      }
      if (mTool === "polygon") {
        mRedraw();
      }
      if (mTool === "brush" || mTool === "blur" || mTool === "smudge") mRedraw();
    });

    ca.addEventListener("mouseleave", () => { mBrushPos = null; mRedraw(); });

    ca.addEventListener("mousedown", (e) => {
      // Right-click with brush = erase; otherwise right-click pans
      if (e.button === 2 && mTool === "brush") {
        e.preventDefault();
        const r = ca.getBoundingClientRect();
        const cx = e.clientX - r.left, cy = e.clientY - r.top;
        const { nx, ny } = _pxToNorm(cx, cy);
        const cnx = Math.max(0, Math.min(1, nx)), cny = Math.max(0, Math.min(1, ny));
        mBrushDrawing = true; mBrushMode = "sub"; mBrushPts = [{ x: cnx, y: cny }];
        mRedraw(); return;
      }
      // Middle-click / right-click (non-brush) / Ctrl+LMB / Space+LMB → panning
      const isPanIntent = e.button === 1 || (e.button === 2 && mTool !== "brush")
                        || (e.button === 0 && e.ctrlKey)
                        || (e.button === 0 && mSpaceDown);
      // Track movement for middle-click vs middle-drag distinction
      if (isPanIntent) {
        e.preventDefault();
        mIsPanning = true; mPanMoved = false;
        mPanIsLMB = e.button === 0;
        mPanStartX = e.clientX; mPanStartY = e.clientY;
        mPanOrigX = mPanX; mPanOrigY = mPanY;
        ca.style.cursor = "grabbing";
        return;
      }
      if (e.button !== 0) return;
      const r = ca.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const { nx, ny } = _pxToNorm(cx, cy);
      const cnx = Math.max(0, Math.min(1, nx)), cny = Math.max(0, Math.min(1, ny));
      const mode = getModeFromEvent(e);

      if (mTool === "brush") {
        mBrushDrawing = true; mBrushMode = e.altKey ? "sub" : mDefaultBrushMode; mBrushPts = [{ x: cnx, y: cny }];
        mRedraw(); return;
      }
      if (mTool === "blur" || mTool === "smudge") {
        _ensureEditsPx(); _saveEditsUndo();
        mBrushDrawing = true;
        const fx2 = mFrameCX - mFrameW / 2, fy2 = mFrameCY - mFrameH / 2;
        const pxScale = _cvsEditsPx.width / mFrameW;
        mBrushPts = [{ x: (cx - fx2) * pxScale, y: (cy - fy2) * pxScale }];
        return;
      }
      if (mTool === "lasso") {
        mLassoDrawing = true; mLassoCurrentPts = [{ x: cnx, y: cny }];
        ca.style.cursor = "crosshair"; return;
      }
      if (mTool === "polygon") {
        if (mLassoCurrentPts.length >= 3) {
          const p0s = _normToPx(mLassoCurrentPts[0].x, mLassoCurrentPts[0].y);
          if (Math.hypot(cx - p0s.cx, cy - p0s.cy) < 10) {
            commitShape(mLassoCurrentPts, mode, "polygon"); return;
          }
        }
        mLassoCurrentPts.push({ x: cnx, y: cny }); mRedraw();
      }
      if (mTool === "fill") {
        e.preventDefault();
        _bucketFill(cnx, cny, e.altKey ? "sub" : "add");
      }
    });

    // Prevent right-click context menu on canvas
    ca.addEventListener("contextmenu", (e) => e.preventDefault());

    // Double-click: close polygon only
    ca.addEventListener("dblclick", (e) => {
      if (mTool === "polygon" && mLassoCurrentPts.length >= 3) {
        e.preventDefault();
        const mode = getModeFromEvent(e);
        commitShape(mLassoCurrentPts, mode, "polygon");
      }
    });

    // ── Mouse wheel zoom ──
    ca.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = ca.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const oldZ = mZoom;
      const zoomFactor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      mZoom = Math.max(0.25, Math.min(20, mZoom * zoomFactor));
      // Zoom centered on cursor position
      const cw2 = cvsBase.width / 2, ch2 = cvsBase.height / 2;
      const ratio = mZoom / oldZ;
      mPanX = (cx - cw2) - ratio * ((cx - cw2) - mPanX);
      mPanY = (cy - ch2) - ratio * ((cy - ch2) - mPanY);
      _dirtyBase = true; _dirtyMask = true; mRedraw();
    }, { passive: false });

    // ── Pan move/up handlers (window-level so drag continues outside canvas) ──
    function _onPanMove(e) {
      if (!mIsPanning) return;
      if (Math.hypot(e.clientX - mPanStartX, e.clientY - mPanStartY) > 4) mPanMoved = true;
      mPanX = mPanOrigX + (e.clientX - mPanStartX);
      mPanY = mPanOrigY + (e.clientY - mPanStartY);
      _dirtyBase = true; _dirtyMask = true; mRedraw();
    }
    function _onPanUp(e) {
      if (!mIsPanning) return;
      const wasLMB = mPanIsLMB && e.button === 0;
      const wasMid = !mPanIsLMB && e.button === 1;
      const wasRight = !mPanIsLMB && e.button === 2;
      if (wasLMB || wasMid || wasRight) {
        // Middle-click with no drag → reset zoom
        if (wasMid && !mPanMoved) {
          mZoom = 1; mPanX = 0; mPanY = 0;
          _dirtyBase = true; _dirtyEdits = true; _dirtyMask = true; mRedraw();
        }
        mIsPanning = false; mPanIsLMB = false; mPanMoved = false;
        updateCursor();
      }
    }
    window.addEventListener("mousemove", _onPanMove);
    window.addEventListener("mouseup", _onPanUp);

    // ── Mouse events ──
    function _onMouseUp(e) {
      if (e.button !== 0 && !(e.button === 2 && mTool === "brush")) return;
      const mode = e.button === 2 ? "sub" : getModeFromEvent(e);
      if (mTool === "brush" && mBrushDrawing) {
        mBrushDrawing = false;
        if (mBrushPts.length >= 1) {
          mMaskOps.push({ type: "brush", mode: mBrushMode, pts: mBrushPts, r: parseFloat(brushSlider.value) / mNatW });
          mUndoStack = [];
          mBrushPts = []; mBrushMode = mDefaultBrushMode;
        }
        _dirtyMask = true; mRedraw(); return;
      }
      if ((mTool === "blur" || mTool === "smudge") && mBrushDrawing) {
        mBrushDrawing = false; mBrushPts = [];
        _dirtyEdits = true; mRedraw(); return;
      }
      if (e.button !== 0) return; // lasso/polygon only respond to LMB release
      if (mTool === "lasso" && mLassoDrawing) {
        mLassoDrawing = false;
        if (mLassoCurrentPts.length >= 5) commitShape(mLassoCurrentPts, getModeFromEvent(e), "lasso");
        else mLassoCurrentPts = [];
        mRedraw(); updateCursor(); return;
      }
    }
    window.addEventListener("mouseup", _onMouseUp);

    // ── Keyboard Shortcuts (Photoshop-style) ──────────────────────────────────
    function _keyHandler(e) {
      // Don't intercept if user is typing in an input
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const k = e.key.toLowerCase();

      // Space → pan mode
      if (k === " " && !mSpaceDown) {
        e.preventDefault(); e.stopPropagation();
        mSpaceDown = true;
        if (!mIsPanning) ca.style.cursor = "grab";
        return;
      }

      // Escape → cancel current drawing
      if (k === "escape") {
        e.preventDefault(); e.stopPropagation();
        mLassoCurrentPts = []; mBrushPts = []; mLassoDrawing = false; mBrushDrawing = false;
        mRedraw(); return;
      }

      // ── Ctrl/Cmd combos ──
      if (e.ctrlKey || e.metaKey) {
        if (k === "z" && !e.shiftKey) {
          e.preventDefault(); e.stopPropagation();
          if ((mTool === "blur" || mTool === "smudge") && _editsUndoStack.length > 0) { _undoEdits(); }
          else { _undo(); }
          return;
        }
        if (k === "z" && e.shiftKey)  { e.preventDefault(); e.stopPropagation(); _redo(); return; }
        if (k === "y")                { e.preventDefault(); e.stopPropagation(); _redo(); return; }
        if (k === "i") {
          e.preventDefault(); e.stopPropagation();
          mMaskInverted = !mMaskInverted;
          if (invertBtn) { invertBtn.style.borderColor = mMaskInverted ? "#7ab0ff" : "#333"; invertBtn.style.color = mMaskInverted ? "#7ab0ff" : "#aaa"; }
          _dirtyMask = true; mRedraw(); return;
        }
        if (k === "d") { e.preventDefault(); e.stopPropagation(); mLassoCurrentPts = []; mBrushPts = []; mLassoDrawing = false; mBrushDrawing = false; mRedraw(); return; }
        return; // don't process further Ctrl combos
      }

      // ── Tool switches ──
      if (k === "b") { e.preventDefault(); e.stopPropagation(); mDefaultBrushMode = "add"; _selectTool("brush"); return; }
      if (k === "e") { e.preventDefault(); e.stopPropagation(); mDefaultBrushMode = "sub"; _selectTool("brush"); return; }
      if (k === "l") { e.preventDefault(); e.stopPropagation(); _selectTool("lasso"); return; }
      if (k === "p") { e.preventDefault(); e.stopPropagation(); _selectTool("polygon"); return; }
      if (k === "g") { e.preventDefault(); e.stopPropagation(); _selectTool("fill"); return; }

      // ── Brush size: [ and ] ──
      if (k === "[" || k === "]") {
        e.preventDefault(); e.stopPropagation();
        const step = 5;
        let v = parseFloat(brushSlider.value);
        v = k === "]" ? v + step : v - step;
        v = Math.max(parseFloat(brushSlider.min), Math.min(parseFloat(brushSlider.max), v));
        brushSlider.value = v;
        brushSlider.dispatchEvent(new Event("input")); // sync label
        mRedraw(); return;
      }

      // ── Quick opacity: 0-9 ──
      if (/^[0-9]$/.test(k)) {
        e.preventDefault(); e.stopPropagation();
        const opVal = k === "0" ? 1.0 : parseInt(k) / 10;
        mMaskAlpha = opVal;
        if (alphaSlider) { alphaSlider.value = opVal; alphaSlider.dispatchEvent(new Event("input")); }
        _dirtyMask = true; mRedraw(); return;
      }

      // ── Delete/Backspace → clear mask ──
      if (k === "delete" || k === "backspace") {
        e.preventDefault(); e.stopPropagation();
        mMaskOps = []; mMaskInverted = false; mUndoStack = [];
        _dirtyMask = true; mRedraw(); return;
      }
    }
    function _keyUpHandler(e) {
      if (e.key === " ") {
        mSpaceDown = false;
        if (!mIsPanning) updateCursor();
      }
    }
    window.addEventListener("keydown", _keyHandler, { capture: true });
    window.addEventListener("keyup",   _keyUpHandler);

    // ── Buttons ──
    invertBtn.addEventListener("click", () => { mMaskInverted = !mMaskInverted; _dirtyMask = true; mRedraw(); });
    clearMaskBtn.addEventListener("click", () => { mMaskOps = []; mLassoCurrentPts = []; mUndoStack = []; _dirtyMask = true; mRedraw(); });

    applyBtn.addEventListener("click", () => {
      const fn = items[curIdx]?.filename;
      if (!fn) { close(); return; }
      if (!cropMap[fn]) cropMap[fn] = {};
      // Serialize fill ops: convert _canvas DOM to dataUrl for JSON persistence
      const serOps = mMaskOps.map(op => {
        if (op.type === "fill" && op._canvas) {
          const { _canvas, ...rest } = op;
          return { ...rest, dataUrl: _canvas.toDataURL("image/png") };
        }
        return { ...op };
      });
      cropMap[fn].maskOps = serOps.length > 0 ? serOps : undefined;
      cropMap[fn].maskInverted = mMaskInverted || undefined;
      // Snapshot current transform so we can remap if transforms change later
      const ct = cropMap[fn];
      cropMap[fn].maskXform = { ox: ct.ox||0, oy: ct.oy||0, scale: ct.scale||1, flipH: !!ct.flipH, flipV: !!ct.flipV, rotate: ct.rotate||0, cx: ct.cx, cy: ct.cy, cw: ct.cw, ch: ct.ch };
      // Clean up undefined keys
      if (!cropMap[fn].maskOps) { delete cropMap[fn].maskOps; delete cropMap[fn].maskXform; }
      if (!cropMap[fn].maskInverted) delete cropMap[fn].maskInverted;
      // ── Pixel edits persistence ──
      if (_cvsEditsPx && _editsUndoStack.length > 0) {
        // Only save if edits were actually made (undo stack has entries)
        cropMap[fn].imageEditsDataUrl = _cvsEditsPx.toDataURL("image/webp", 0.92);
      } else {
        delete cropMap[fn].imageEditsDataUrl;
      }
      persistCropData();
      render();
      close();
    });

    // ── Navigation ──
    function updateNav() {
      cntEl.textContent = `${curIdx + 1} / ${items.length}`;
      prevB.style.opacity = curIdx > 0 ? "1" : "0.3";
      nextB.style.opacity = curIdx < items.length - 1 ? "1" : "0.3";
    }
    prevB.addEventListener("click", () => { if (curIdx > 0) { curIdx--; loadIdx(curIdx); } });
    nextB.addEventListener("click", () => { if (curIdx < items.length - 1) { curIdx++; loadIdx(curIdx); } });

    // ── Remap mask ops when edit transforms change ──
    // Maps each mask point from old-processed-image space to new-processed-image space
    // so the mask "follows" the image content through zoom, pan, flip, rotate, crop changes.
    function _remapMaskOps(ops, oldXf, newXf) {
      // oldXf / newXf: { ox, oy, scale, flipH, flipV, rotate, cx, cy, cw, ch }
      // Transform: frame_norm(0-1) → image_norm(0-1)
      //   In renderItemToDataUrl, the image center maps to (0.5 + ox, 0.5 + oy),
      //   and a unit of image width maps to eff = bf * scale in canvas units.
      //   For simplicity we model: img_x = (frame_x - 0.5 - ox) / scale + 0.5
      //   (ignoring rotation/flip for the inverse, then applying new forward)
      const oOx = oldXf.ox || 0, oOy = oldXf.oy || 0, oSc = oldXf.scale || 1;
      const oFH = oldXf.flipH, oFV = oldXf.flipV, oR = (oldXf.rotate || 0) * Math.PI / 180;
      const nOx = newXf.ox || 0, nOy = newXf.oy || 0, nSc = newXf.scale || 1;
      const nFH = newXf.flipH, nFV = newXf.flipV, nR = (newXf.rotate || 0) * Math.PI / 180;
      function invXf(fx, fy, ox, oy, sc, fH, fV, rot) {
        // Frame-normalized → image-normalized (undo transform)
        let x = fx - 0.5 - ox, y = fy - 0.5 - oy;
        // Undo rotation
        if (rot) { const c = Math.cos(-rot), s = Math.sin(-rot); const rx = x*c - y*s, ry = x*s + y*c; x = rx; y = ry; }
        // Undo flip
        if (fH) x = -x; if (fV) y = -y;
        // Undo scale
        x /= sc; y /= sc;
        return { x: x + 0.5, y: y + 0.5 };
      }
      function fwdXf(ix, iy, ox, oy, sc, fH, fV, rot) {
        // Image-normalized → frame-normalized (apply transform)
        let x = (ix - 0.5) * sc, y = (iy - 0.5) * sc;
        if (fH) x = -x; if (fV) y = -y;
        if (rot) { const c = Math.cos(rot), s = Math.sin(rot); const rx = x*c - y*s, ry = x*s + y*c; x = rx; y = ry; }
        return { x: x + 0.5 + ox, y: y + 0.5 + oy };
      }
      function remapPt(p) {
        const img = invXf(p.x, p.y, oOx, oOy, oSc, oFH, oFV, oR);
        return fwdXf(img.x, img.y, nOx, nOy, nSc, nFH, nFV, nR);
      }
      return ops.map(op => {
        if (!op.pts || op.pts.length < 1) return op;
        const newPts = op.pts.map(remapPt);
        return { ...op, pts: newPts };
      });
    }

    async function loadIdx(idx) {
      curIdx = idx; updateNav();
      mImg = null; mLassoCurrentPts = []; mBrushPts = [];
      mZoom = 1; mPanX = 0; mPanY = 0; // reset zoom/pan on image change
      _cvsEditsPx = null; _editsUndoStack = []; _smudgeBuf = null; // reset pixel edits
      const fn = items[idx]?.filename;
      const saved = fn ? (cropMap[fn] || {}) : {};
      // Deserialize fill ops: convert dataUrl back to _canvas DOM elements
      const rawOps = saved.maskOps ? [...saved.maskOps] : [];
      mMaskOps = [];
      for (const op of rawOps) {
        if (op.type === "fill" && op.dataUrl && !op._canvas) {
          const img = new Image();
          await new Promise(res => { img.onload = res; img.onerror = res; img.src = op.dataUrl; });
          const cvs = document.createElement("canvas");
          cvs.width = img.naturalWidth; cvs.height = img.naturalHeight;
          cvs.getContext("2d").drawImage(img, 0, 0);
          const { dataUrl: _, ...rest } = op;
          mMaskOps.push({ ...rest, _canvas: cvs });
        } else {
          mMaskOps.push({ ...op });
        }
      }
      mMaskInverted = saved.maskInverted || false;
      // Remap mask coordinates if edit transform changed since mask was last saved
      if (mMaskOps.length > 0 && saved.maskXform) {
        const curXf = { ox: saved.ox||0, oy: saved.oy||0, scale: saved.scale||1, flipH: !!saved.flipH, flipV: !!saved.flipV, rotate: saved.rotate||0, cx: saved.cx, cy: saved.cy, cw: saved.cw, ch: saved.ch };
        const oldXf = saved.maskXform;
        // Check if transform actually changed
        if (oldXf.ox !== curXf.ox || oldXf.oy !== curXf.oy || oldXf.scale !== curXf.scale ||
            oldXf.flipH !== curXf.flipH || oldXf.flipV !== curXf.flipV || oldXf.rotate !== curXf.rotate) {
          mMaskOps = _remapMaskOps(mMaskOps, oldXf, curXf);
          // Update the stored snapshot to current so next load won't remap again
          cropMap[fn].maskOps = [...mMaskOps];
          cropMap[fn].maskXform = { ...curXf };
          persistCropData();
        }
      }
      // Use the edit-processed version so mask aligns with what the user sees
      try {
        const processedUrl = await renderItemToDataUrl(items[idx], idx);
        if (processedUrl) {
          const img = new Image(); img.crossOrigin = "anonymous";
          await new Promise(res => { img.onload = res; img.onerror = res; img.src = processedUrl; });
          mImg = img; mNatW = img.naturalWidth || 1; mNatH = img.naturalHeight || 1;
        }
      } catch (err) {
        console.warn("[MIL] Mask: fallback to raw src", err);
        const src = items[idx]?.src;
        if (src) {
          const img = new Image();
          await new Promise(res => { img.onload = res; img.onerror = res; img.src = src; });
          mImg = img; mNatW = img.naturalWidth || 1; mNatH = img.naturalHeight || 1;
        }
      }
      // ── Deserialize pixel edits ──
      if (saved.imageEditsDataUrl) {
        try {
          const editImg = new Image();
          await new Promise((ok, fail) => { editImg.onload = ok; editImg.onerror = fail; editImg.src = saved.imageEditsDataUrl; });
          _cvsEditsPx = document.createElement("canvas");
          _cvsEditsPx.width = editImg.naturalWidth; _cvsEditsPx.height = editImg.naturalHeight;
          _cvsEditsPx.getContext("2d").drawImage(editImg, 0, 0);
        } catch (e) {
          console.warn("[MIL] Failed to restore pixel edits:", e);
          _cvsEditsPx = null;
        }
      }
      _dirtyBase = true; _dirtyEdits = true; _dirtyMask = true; mRedraw();
    }

    loadIdx(startIdx);
  }

  return root;
}

// ─── Extension registration ───────────────────────────────────────────────────

app.registerExtension({
  name: "MultiImageLoader",

  // ── Global Ctrl+V clipboard paste ──────────────────────────────────────────
  setup() {
    /**
     * Listen for the native `paste` event (triggered by Ctrl+V in most browsers)
     * and also for our own keydown fallback using the async Clipboard API.
     *
     * Routing logic:
     *   1. Find all MIL nodes in the current graph.
     *   2. Among those, pick the ones that are selected (LiteGraph sets
     *      node.is_selected = true for selected nodes; also check via
     *      app.canvas.selected_nodes).
     *   3. If exactly one is selected, forward the clipboard image to it.
     */
    function getMILNodes() {
      return (app.graph._nodes || []).filter(n => n.type === NODE_TYPE);
    }
    function getTargetNode() {
      const milNodes = getMILNodes();
      if (!milNodes.length) return null;
      // Must be explicitly selected
      const selected = milNodes.filter(n =>
        n.is_selected ||
        (app.canvas?.selected_nodes && app.canvas.selected_nodes[n.id] !== undefined)
      );
      if (selected.length === 1) return selected[0];
      return null;
    }

    // Handle native paste events (Ctrl+V → ClipboardEvent with clipboardData)
    // ── Capture-phase paste listener ─────────────────────────────────────────
    // Registering with { capture: true } makes our handler run BEFORE
    // ComfyUI's bubble-phase paste listener (which would create a Load Image
    // node). When we take over the event we call stopImmediatePropagation()
    // so ComfyUI never sees it — no modification to core code needed.
    document.addEventListener("paste", async (e) => {
      // Don't intercept paste when the user is typing in a text input
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;

      const items = e.clipboardData?.items
        ? Array.from(e.clipboardData.items)
        : [];
      const imageItems = items.filter(i => i.kind === "file" && i.type.startsWith("image/"));
      if (!imageItems.length) return;

      const node = getTargetNode();
      if (!node) return;

      // We're handling this — stop ComfyUI from also acting on it
      e.preventDefault();
      e.stopImmediatePropagation();

      const el = node._milDomWidget?.element;
      if (!el) return;

      const files = imageItems.map(i => {
        const blob = i.getAsFile();
        const ext  = i.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
        return new File([blob], `clipboard_${Date.now()}.${ext}`, { type: i.type });
      });
      await el._addFiles(files);
    }, { capture: true });

    // ── Capture-phase keydown listener (async Clipboard API fallback) ─────────
    // For cases where the native `paste` event doesn't fire (e.g. when the
    // LiteGraph canvas element has focus). We stop propagation synchronously
    // as soon as we know a MIL node is selected, then read the clipboard async.
    document.addEventListener("keydown", async (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "v") return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;

      const node = getTargetNode();
      if (!node) return;

      // Stop immediately — prevents any Ctrl+V keydown handler in ComfyUI
      e.stopImmediatePropagation();

      // Use async Clipboard API to read the image
      try {
        const clipItems = await navigator.clipboard.read();
        const el = node._milDomWidget?.element;
        if (el?._pasteFromClipboard) await el._pasteFromClipboard(clipItems);
      } catch (err) {
        // Clipboard API may be denied; the capture-phase paste event above
        // will have already handled it in that case.
        if (!err.message?.includes("denied")) {
          console.warn("[MIL] Clipboard API error:", err);
        }
      }
    }, { capture: true });
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const origOnCreated   = nodeType.prototype.onNodeCreated;
    const origOnConfigure = nodeType.prototype.onConfigure;

    nodeType.prototype.onNodeCreated = function () {
      origOnCreated?.apply(this, arguments);

      const node = this;
      const initH = computeIdealHeight(0, 300, THUMB_W);
      node.setSize([300, initH]);

      const domWidget = node.addDOMWidget(
        "mil_uploader",
        "MultiImageLoaderWidget",
        createWidget(node),
        {
          getValue() { return ""; },
          setValue() {},
          computeSize(width) {
            return [width, Math.max(120, node.size[1] - NODE_HEADER_H - NODE_SLOT_H * 4 - NODE_PADDING_V)];
          },
        }
      );

      node._milDomWidget = domWidget;

      setTimeout(() => {
        const hiddenNames = ["image_list", "crop_data"];
        node.widgets?.forEach((w) => {
          if (hiddenNames.includes(w.name)) {
            w.type = "converted-widget";
            w.computeSize = () => [0, -4];
            w.draw = function() {};  // prevent LiteGraph from drawing it
            if (w.inputEl) {
              w.inputEl.style.display = "none";
              w.inputEl.type = "hidden";
            }
            // Also hide the parent wrapper that ComfyUI may wrap the input in
            if (w.element) w.element.style.display = "none";
          }
        });
        // Re-render+resize when user changes thumbnail size
        const tsW = node.widgets?.find((w) => w.name === "thumb_size");
        if (tsW) {
          const origCb = tsW.callback;
          tsW.callback = function (...args) {
            origCb?.apply(this, args);
            node._milDomWidget?.element?._renderWithResize?.();
          };
        }
        // Auto-preview when aspect_ratio, fit_mode, megapixels, or bg_color change
        const autoPreviewWidgets = ["aspect_ratio", "fit_mode", "megapixels", "bg_color"];
        autoPreviewWidgets.forEach(wName => {
          const w = node.widgets?.find(ww => ww.name === wName);
          if (w) {
            const origCb = w.callback;
            w.callback = function (...args) {
              origCb?.apply(this, args);
              node._milDomWidget?.element?._onAspectRatioChange?.();
            };
          }
        });

        // Hide internal-only widgets from user
        ["image_list", "crop_data", "custom_bg_hex"].forEach(name => {
          const hw = node.widgets?.find(ww => ww.name === name);
          if (hw) {
            hw.type = "converted-widget";
            hw.computeSize = () => [0, -4];
            hw.draw = function() {};
            if (hw.inputEl) { hw.inputEl.style.display = "none"; hw.inputEl.type = "hidden"; }
            if (hw.element) hw.element.style.display = "none";
          }
        });

        node.setDirtyCanvas(true);
      }, 0);

      node.onDrop = function (e) {
        e.preventDefault?.();
        e.stopPropagation?.();
        if (e.dataTransfer?.files?.length) {
          node._milDomWidget?.element?._addFiles?.(e.dataTransfer.files);
        }
        return false;
      };

      node.onResize = function () {
        // Re-render thumbnails at new fluid width whenever the node is resized
        requestAnimationFrame(() => {
          node._milDomWidget?.element?._render?.();
        });
      };
    };

    nodeType.prototype.onConfigure = function (data) {
      origOnConfigure?.call(this, data);
      const node = this;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          node._milDomWidget?.element?._restore?.();
        });
      });
    };
  },
});
