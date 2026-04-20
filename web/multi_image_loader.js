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
import { api } from "../../scripts/api.js";

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
// Column count per thumb_size preset — images grow freely to fill the node width
const THUMB_COLS         = { full: 1, large: 2, medium: 3, small: 4 };

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
      outline: 2px solid #7ab0ff;
      background: rgba(122,176,255,0.15);
    }
    /* ── Swap mode: blue frame around target thumbnail ── */
    .mil-thumb.mil-swap-target {
      outline: 3px solid #7ab0ff;
      box-shadow: inset 0 0 0 2px #7ab0ff, 0 0 10px 2px rgba(122,176,255,0.55);
      background: rgba(122,176,255,0.14);
    }
    /* ── Insert mode: glowing blue line between thumbnails ── */
    .mil-insert-before::before,
    .mil-insert-after::before {
      content: '';
      position: absolute;
      background: #7ab0ff;
      border-radius: 3px;
      box-shadow: 0 0 10px 3px rgba(122,176,255,0.75), 0 0 3px 1px rgba(180,220,255,0.9);
      pointer-events: none;
      z-index: 10;
    }
    /* Vertical line for grid mode */
    .mil-grid:not(.mil-row-mode) .mil-insert-before::before,
    .mil-grid:not(.mil-row-mode) .mil-insert-after::before {
      top: 0; bottom: 0;
      width: 5px;
      left: -5px;
    }
    .mil-grid:not(.mil-row-mode) .mil-insert-after::before {
      left: auto; right: -5px;
    }
    /* Horizontal line for row mode */
    .mil-grid.mil-row-mode .mil-insert-before::before,
    .mil-grid.mil-row-mode .mil-insert-after::before {
      left: 0; right: 0;
      height: 5px;
      top: -5px;
    }
    .mil-grid.mil-row-mode .mil-insert-after::before {
      top: auto; bottom: -5px;
    }
    .mil-first-badge {
      position: absolute;
      top: 2px;
      left: 3px;
      background: rgba(60,90,150,0.95);
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
      0%   { box-shadow: inset 0 0 0 2px #7ab0ff, 0 0 10px rgba(122,176,255,0.65); }
      15%  { box-shadow: inset 0 0 0 2px #7ab0ff, 0 0 10px rgba(122,176,255,0.65); }
      100% { box-shadow: inset 0 0 0 2px rgba(122,176,255,0),  0 0 0   rgba(122,176,255,0); }
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
    .mil-selected::after {
      content: "";
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      border: 3px solid #7ab0ff;
      border-radius: 4px;
      pointer-events: none;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.5);
      z-index: 2;
    }
    @keyframes mil-paste-fade {
      0%   { box-shadow: inset 0 0 0 1px rgba(0,0,0,0.5); border: 3px solid rgba(122,176,255,1); }
      100% { box-shadow: inset 0 0 0 1px rgba(0,0,0,0);   border: 3px solid rgba(122,176,255,0); }
    }
    .mil-paste-fade::after {
      content: "";
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      border-radius: 4px;
      pointer-events: none;
      z-index: 2;
      animation: mil-paste-fade 0.8s ease-out forwards;
    }
  `;
  document.head.appendChild(style);
}

// ─── height calculation ───────────────────────────────────────────────────────


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

  // Ensure ComfyUI selects this node whenever any part of our DOM widget is clicked
  // This solves the issue where clicking a thumbnail steals focus without selecting the node,
  // causing the global Ctrl+V interceptor to fail.
  root.addEventListener("mousedown", (e) => {
    if (app.canvas && node) {
       app.canvas.selectNodes([node]);
    }
  }, { capture: true });

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
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    align-content: start;
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
  statusLabel.style.whiteSpace = "pre-wrap";

  let _statusMsgTimer = null;
  let _defaultStatusText = "";
  function setStatusText(text) {
    _defaultStatusText = text;
    if (!_statusMsgTimer) {
      statusLabel.textContent = text;
      statusLabel.style.color = "#8899bb";
    }
  }
  function flashStatusMessage(msg, durationMs = 2500) {
    if (_statusMsgTimer) clearTimeout(_statusMsgTimer);
    statusLabel.style.color = "#aaccff";
    statusLabel.textContent = msg;
    _statusMsgTimer = setTimeout(() => {
      _statusMsgTimer = null;
      setStatusText(_defaultStatusText);
    }, durationMs);
  }

  function updateStatusBarText() {
    const count = items.length;
    const selCount = selectedIndices.size;
    
    if (count === 0) {
      setStatusText("");
      return;
    }
    
    setStatusText(`${count} image${count !== 1 ? "s" : ""} queued · Drag to reorder`);
    
    (async () => {
      try {
        const { refW, refH } = await computeRefDims();
        const masterActive = isMasterConnected() && getMasterImageDims();
        const ar = getAspectRatioWidget()?.value ?? "none";
        const arLabel = masterActive ? " · upstream" : (ar !== "none" ? ` · ${ar}` : "");
        const baseText = `${count} image${count !== 1 ? "s" : ""} queued · Drag to reorder · ${refW} x ${refH}${arLabel}`;
        
        if (selCount > 0) {
          setStatusText(`${baseText}\n${selCount} image${selCount !== 1 ? "s" : ""} selected for the output batch`);
        } else {
          setStatusText(baseText);
        }
      } catch(e) {
        // ignore error, keep default text
      }
    })();
  }

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
  
  const undoBtn = document.createElement("button");
  undoBtn.textContent = "↶ Undo";
  undoBtn.title = "Undo last action";
  undoBtn.className = "mil-btn";
  undoBtn.style.cssText = `
    background: #252525;
    color: #555;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 3px 10px;
    font-size: 10px;
    cursor: default;
    display: none;
  `;
  undoBtn.addEventListener("mouseenter", () => {
    if (undoStack.length > 0) {
      undoBtn.style.background = "#333";
      undoBtn.style.borderColor = "#444";
      undoBtn.style.color = "#aaccff";
    }
  });
  undoBtn.addEventListener("mouseleave", () => {
    if (undoStack.length > 0) {
      undoBtn.style.background = "#252525";
      undoBtn.style.borderColor = "#333";
      undoBtn.style.color = "#8899bb";
    }
  });
  undoBtn.addEventListener("click", () => {
    if (undoStack.length > 0) popUndoState();
  });
  
  function syncUndoBtn() {
    if (undoStack.length > 0) {
      undoBtn.style.display = "inline-block";
      undoBtn.style.color = "#8899bb";
      undoBtn.style.cursor = "pointer";
      undoBtn.style.background = "#252525";
      undoBtn.style.borderColor = "#333";
    } else {
      undoBtn.style.display = "none";
    }
  }

  // Position it right next to clear all
  btnGroup.appendChild(undoBtn);

  statusBar.appendChild(statusLabel);
  statusBar.appendChild(btnGroup);

  root.appendChild(dropZone);
  root.appendChild(gridWrapper);
  root.appendChild(statusBar);

  // ── state ─────────────────────────────────────────────────────────────────
  // Each item: { filename: string, src: string, previewSrc?: string }
  let items  = [];
  let thumbH = THUMB_W;  // updated from first image's aspect ratio
  
  // ── Undo stack ────────────────────────────────────────────────────────────
  const undoStack = [];
  const MAX_UNDO = 30;

  function pushUndoState() {
    undoStack.push({
      items: JSON.parse(JSON.stringify(items)),
      cropMap: JSON.parse(JSON.stringify(cropMap))
    });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    if (typeof syncUndoBtn === "function") syncUndoBtn();
  }

  function popUndoState() {
    if (undoStack.length === 0) return;
    const state = undoStack.pop();
    items = state.items;
    cropMap = state.cropMap;
    selectedIdx = null;
    selectedIndices.clear();
    anchorIdx = null;
    previewActive = items.some(it => it.previewSrc);
    if (typeof syncUndoBtn === "function") syncUndoBtn();
    
    // Rerender and repaint everything
    // NOTE: We do NOT strictly need to regenerate renderFitPreviews or renderCropPreviews
    // because JSON.parse(JSON.stringify) perfectly restored the base64 previewSrc images!
    updateThumbHFromFirst().then(() => {
      render();
      persist();
    });
  }
  // viewMode removed — layout is always grid; column count driven by thumb_size

  // Drag-reorder state
  let dragSrcIdx = null;
  let selectedIdx = null; // Track primary selected thumbnail
  let selectedIndices = new Set(); // Multi-selection tracking
  let anchorIdx = null; // Anchor for shift-click range selection
  let _cachedCopyBlob = null; // Pre-rendered PNG blob for instant Ctrl+C
  let _cachedCopyIdx  = null; // Which idx the cached blob belongs to

  // Pre-render the selected thumbnail to a PNG blob in background.
  // When Ctrl+C fires, we can write this blob instantly (no async delay)
  // so the browser's user-gesture window doesn't expire.
  function precacheSelectedBlob() {
    _cachedCopyBlob = null;
    _cachedCopyIdx  = null;
    if (selectedIdx === null || selectedIdx < 0 || selectedIdx >= items.length) return;
    const idx = selectedIdx;
    const item = items[idx];
    (async () => {
      try {
        const dataUrl = await renderItemToDataUrl(item, idx);
        // Check selection didn't change while we were rendering
        if (selectedIdx !== idx) return;
        const resp = await fetch(dataUrl);
        let blob = await resp.blob();
        if (selectedIdx !== idx) return;
        // Ensure PNG
        if (blob.type !== "image/png") {
          const cvs = document.createElement("canvas");
          const img = await loadImage(dataUrl);
          cvs.width = img.naturalWidth; cvs.height = img.naturalHeight;
          cvs.getContext("2d").drawImage(img, 0, 0);
          blob = await new Promise(r => cvs.toBlob(r, "image/png"));
        }
        if (selectedIdx !== idx) return;
        _cachedCopyBlob = blob;
        _cachedCopyIdx  = idx;
      } catch(err) {
        console.warn("[MIL] precache blob failed:", err);
      }
    })();
  }

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

  // ── refresh button ─────────────────────────────────────────────────────────
  const refreshBtn = document.createElement("button");
  refreshBtn.textContent = "↻ Cache Images";
  refreshBtn.title = "Refresh Images · Pull connected images as first thumbnails";
  refreshBtn.className = "mil-btn";
  refreshBtn.style.cssText = `
    background: #252525;
    color: #aaa;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 3px 10px;
    font-size: 10px;
    cursor: pointer;
    display: inline-block;
    line-height: 1;
  `;
  refreshBtn.addEventListener("mouseenter", () => {
    refreshBtn.style.background = "#333";
    refreshBtn.style.borderColor = "#666";
  });
  refreshBtn.addEventListener("mouseleave", () => {
    refreshBtn.style.background = "#252525";
    refreshBtn.style.borderColor = "#444";
  });
  refreshBtn.addEventListener("click", () => {
    doRefreshImages();
    flashStatusMessage("Images refreshed");
  });
  btnGroup.appendChild(refreshBtn);

  // (viewToggleBtn removed — thumb_size now controls column layout)

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

  // ── doRefreshImages ─────────────────────────────────────────────────────────
  // Reads the first frame from the connected images source node.
  // Injects a temporary PreviewImage node into the subgraph to force execution 
  // and guarantee we capture the output image directly from the websocket.
  async function doRefreshImages() {
    if (!node.inputs) return;
    const masterInput = node.inputs.find(inp => inp.name === "images");
    if (!masterInput || masterInput.link == null) {
      // No input connected — just re-render existing items
      render();
      await renderFitPreviews();
      await renderCropPreviews();
      return;
    }
    const linkInfo = app.graph.links[masterInput.link];
    if (!linkInfo) return;
    const srcNode = app.graph.getNodeById(linkInfo.origin_id);
    if (!srcNode) {
      statusLabel.textContent = "Master source node not found";
      statusLabel.style.color = "#ff9966";
      return;
    }

    statusLabel.textContent = "Executing master subgraph…";
    statusLabel.style.color = "#ffcc66";

    let imgUrls = null;
    try {
      imgUrls = await _execSourceSubgraph(srcNode, linkInfo.origin_slot);
    } catch (e) {
      console.warn("[MIL Refresh] Subgraph execution failed:", e);
    }

    if (!imgUrls || imgUrls.length === 0) {
      statusLabel.textContent = "No images returned — check node outputs";
      statusLabel.style.color = "#ff9966";
      return;
    }

    statusLabel.textContent = `Pulling ${imgUrls.length} image(s)…`;
    statusLabel.style.color = "#ffcc66";

    try {
      pushUndoState();
      
      const newFiles = [];
      const dataUrls = [];
      
      for (let i = 0; i < imgUrls.length; i++) {
        const imgSrc = imgUrls[i];
        const resp = await fetch(imgSrc);
        if (!resp.ok) continue;
        const blob = await resp.blob();

        let ext = "png";
        try {
          const u = new URL(imgSrc, location.origin);
          const fn = u.searchParams.get("filename");
          if (fn && fn.includes(".")) ext = fn.split('.').pop();
        } catch {}
        const masterFilename = `master_image_${Date.now()}_${i}.${ext}`;
        const file = new File([blob], masterFilename, { type: blob.type || `image/${ext}` });
        
        newFiles.push(file);
        dataUrls.push(await fileToDataURL(file));
      }

      if (newFiles.length === 0) throw new Error("Failed to download any valid images");
      
      // Upload bulk to ComfyUI
      const uploadedNames = await uploadFiles(newFiles);
      
      const newItems = [];
      for (let i = 0; i < uploadedNames.length; i++) {
        newItems.push({ filename: uploadedNames[i], src: dataUrls[i] });
      }

      // Remove any previously cached master images from the very start of the array
      while (items.length > 0 && (items[0].filename.startsWith("master_image") || items[0].filename.startsWith("ComfyUI_temp"))) {
        const oldFn = items.shift().filename;
        delete cropMap[oldFn];
      }

      // Prepend the new batch
      items.unshift(...newItems);

      await updateThumbHFromFirst();
      statusLabel.style.color = "#8899bb";
      statusLabel.textContent = "";
      render();
      persist();
      await renderFitPreviews();
      await renderCropPreviews();

      // Brief cyan flash on position 0
      requestAnimationFrame(() => {
        const thumb = grid.querySelectorAll(".mil-thumb")[0];
        if (thumb) {
          thumb.classList.add("mil-paste-flash");
          setTimeout(() => thumb.classList.remove("mil-paste-flash"), 3000);
        }
      });
    } catch (err) {
      console.error("[MIL Refresh] Error:", err);
      statusLabel.textContent = `Refresh error: ${err.message}`;
      statusLabel.style.color = "#ff6666";
    }
  }

  // ── _execSourceSubgraph ─────────────────────────────────────────────────────
  // Injects a temporary PreviewImage node to force the subgraph to execute
  // and safely extracts its output via websocket.
  // Returns a Promise<string[]|null> resolving to an array of image URLs.
  function _execSourceSubgraph(srcNode, srcSlot) {
    return new Promise(async (resolve) => {
      let resolved = false;
      const targetId = String(srcNode.id);
      const previewNodeId = "MIL_TEMP_PREV_" + Date.now();

      function cleanup() {
        api.removeEventListener("executed", onExecuted);
        api.removeEventListener("status", onStatus);
        api.removeEventListener("execution_error", onError);
      }

      let executionStarted = false;

      const onExecuted = (event) => {
        const eventNodeId = String(event.detail?.node ?? "");
        executionStarted = true;
        // We listen for OUR proxy node, which guarantees the image is in the event!
        if (eventNodeId === previewNodeId && !resolved) {
          resolved = true;
          cleanup();
          console.log("[MIL Refresh] ✅ Preview intercepted via proxy node");
          let imgUrls = null;
          const images = event.detail?.output?.images;
          if (images && images.length > 0) {
            imgUrls = images.map(img => `/view?filename=${encodeURIComponent(img.filename)}&type=${img.type || "temp"}&subfolder=${encodeURIComponent(img.subfolder || "")}`);
          }
          resolve(imgUrls);
        }
      };

      const onStatus = (event) => {
        const queueRemaining = event.detail?.exec_info?.queue_remaining
          ?? event.detail?.status?.exec_info?.queue_remaining;
        if (queueRemaining === 0 && executionStarted && !resolved) {
          resolved = true;
          cleanup();
          console.log("[MIL Refresh] Queue drained without hit on proxy");
          resolve(null);
        }
      };

      const onError = (event) => {
        if (executionStarted && !resolved) {
          resolved = true;
          cleanup();
          console.error("[MIL Refresh] ❌ Execution error", event.detail);
          resolve(null);
        }
      };

      // Safety timeout (20s)
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          console.warn("[MIL Refresh] ⏱️ Subgraph execution timed out after 20s");
          resolve(null);
        }
      }, 20000);

      api.addEventListener("executed", onExecuted);
      api.addEventListener("status", onStatus);
      api.addEventListener("execution_error", onError);

      try {
        await new Promise(r => setTimeout(r, 100));
        const prompt = await app.graphToPrompt();

        if (!prompt?.output?.[targetId]) {
          console.warn("[MIL Refresh] Source node not in prompt output");
          resolved = true;
          cleanup();
          resolve(null);
          return;
        }

        // Prune to only the source node and its upstream dependencies
        const prunedOutput = {};
        (function addDeps(nodeId) {
          const id = String(nodeId);
          if (prunedOutput[id]) return;
          const n = prompt.output[id];
          if (!n) return;
          prunedOutput[id] = n;
          for (const val of Object.values(n.inputs || {})) {
            if (Array.isArray(val) && val.length >= 2) addDeps(val[0]);
          }
        })(targetId);

        // Inject the proxy PreviewImage node connected to our target
        prunedOutput[previewNodeId] = {
          class_type: "PreviewImage",
          inputs: {
            images: [targetId, srcSlot]
          }
        };

        prompt.output = prunedOutput;
        console.log(`[MIL Refresh] Queuing subgraph + proxy node (${Object.keys(prunedOutput).length} nodes)`);

        await api.queuePrompt(0, prompt);
      } catch (e) {
        console.error("[MIL Refresh] Failed to queue subgraph:", e);
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(null);
        }
      }
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  function getImageListWidget() {
    return node.widgets?.find((w) => w.name === "image_list");
  }

  function getSelectedItemsWidget() {
    return node.widgets?.find((w) => w.name === "selected_items");
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
    
    const sw = getSelectedItemsWidget();
    if (sw) {
      sw.value = JSON.stringify(Array.from(selectedIndices).map(idx => items[idx]?.filename).filter(Boolean));
    }
    
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

  // ── input connection helper ────────────────────────────────────────
  // Returns { w, h } of the connected images source node's last output,
  // or null if not connected / not yet executed.
  function getMasterImageDims() {
    if (!node.inputs) return null;
    const masterInput = node.inputs.find(inp => inp.name === "images");
    if (!masterInput || masterInput.link == null) return null;
    const linkInfo = app.graph.links[masterInput.link];
    if (!linkInfo) return null;
    const srcNode = app.graph.getNodeById(linkInfo.origin_id);
    if (!srcNode) return null;
    // Try to get dims from the source node's last executed images
    if (srcNode.imgs && srcNode.imgs.length > 0) {
      const img = srcNode.imgs[0];
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        return { w: img.naturalWidth, h: img.naturalHeight };
      }
    }
    // Fallback: try to read from the node's size/properties if available
    return null;
  }

  /** Check if images input is connected. */
  function isMasterConnected() {
    if (!node.inputs) return false;
    const masterInput = node.inputs.find(inp => inp.name === "images");
    return !!(masterInput && masterInput.link != null);
  }

  // Auto-update thumbnails after crop editor Apply.
  // Draws each image through the same canvas transform as the editor.
  async function computeRefDims() {
    const mp = node.widgets?.find(w => w.name === "megapixels")?.value ?? 1.0;

    // Priority 1: master_image connection
    const masterDims = getMasterImageDims();
    if (masterDims) {
      const ratio = masterDims.w / masterDims.h;
      const totalPx = Math.max(1, mp * 1_000_000);
      const refW = Math.max(1, Math.round(Math.sqrt(totalPx * ratio)));
      const refH = Math.max(1, Math.round(Math.sqrt(totalPx / ratio)));
      return { refW, refH };
    }

    // Priority 2: aspect_ratio widget
    const ar = getAspectRatioWidget()?.value ?? "none";
    if (ar !== "none") {
      const [aw, ah] = ar.split(":").map(Number);
      const totalPx = Math.max(1, mp * 1_000_000);
      const refW = Math.max(1, Math.round(Math.sqrt(totalPx * aw / ah)));
      const refH = Math.max(1, Math.round(Math.sqrt(totalPx * ah / aw)));
      return { refW, refH };
    }

    // Priority 3: first image natural dims
    const r0 = await getImageDimensions(items[0].src);
    return { refW: r0.w, refH: r0.h };
  }

  // (renderCropPreviews — defined later after renderFitPreviews)

  /** Number of columns for the current thumb_size preset. */
  function getThumbCols() {
    const szKey = node.widgets?.find((ww) => ww.name === "thumb_size")?.value ?? "medium";
    return THUMB_COLS[szKey] ?? 4;
  }

  function getMinThumbW() {
    // Minimum thumb width derived from column count and current node width
    const cols   = getThumbCols();
    const innerW = Math.max(40, node.size[0] - 24);
    return Math.max(40, Math.floor((innerW - (cols - 1) * THUMB_GAP) / cols));
  }

  /** Compute actual display thumb width — fills available node width using fixed column count. */
  function getEffectiveThumbW() {
    const cols   = getThumbCols();
    const innerW = Math.max(40, node.size[0] - 24);
    return Math.max(40, Math.floor((innerW - (cols - 1) * THUMB_GAP) / cols));
  }

  /** Compute actual display thumb height — proportional to tw based on image AR. */
  function getEffectiveThumbH(tw) {
    return Math.max(20, Math.round(tw * thumbH / THUMB_W));
  }

  function resizeNode() {
    if (items.length === 0) return;
    const cols  = getThumbCols();
    const rows  = Math.ceil(items.length / cols);
    const vis   = Math.min(rows, MAX_GRID_ROWS);
    const thumb = grid.querySelector('.mil-thumb');
    if (!thumb || thumb.offsetHeight === 0) return;
    
    let idealGridH = vis > 0 ? vis * (thumb.offsetHeight + THUMB_GAP) - THUMB_GAP + 4 : 0;
    
    const diff = idealGridH - grid.clientHeight;
    // Only grow
    if (diff > 0) node.setSize([node.size[0], node.size[1] + diff]);
  }

  function snapNodeToIdealH() {
    if (items.length === 0) {
      const snapH = NODE_HEADER_H + NODE_SLOT_H * 3 + NODE_PADDING_V + DROPZONE_H + GAP + 8;
      node.setSize([node.size[0], snapH]);
      return;
    }
    const cols  = getThumbCols();
    const rows  = Math.ceil(items.length / cols);
    const vis   = Math.min(rows, MAX_GRID_ROWS);
    const thumb = grid.querySelector('.mil-thumb');
    if (!thumb || thumb.offsetHeight === 0) return;

    let idealGridH = vis > 0 ? vis * (thumb.offsetHeight + THUMB_GAP) - THUMB_GAP + 4 : 0;
    
    const diff = idealGridH - grid.clientHeight;
    // Shrink AND grow
    if (diff !== 0) node.setSize([node.size[0], node.size[1] + diff]);
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
    if (!_statusMsgTimer) statusLabel.style.color = "#8899bb";
    grid.innerHTML = "";
    const cols = getThumbCols();
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    const tw = getEffectiveThumbW();
    const th = getEffectiveThumbH(tw);

    items.forEach((item, idx) => {

      // ── wrapper ──────────────────────────────────────────────────────────
      const wrapper = document.createElement("div");
      wrapper.className = "mil-thumb";
      if (selectedIndices.has(idx)) wrapper.classList.add("mil-selected");
      wrapper.draggable = true;
      wrapper.dataset.idx = idx;
      const arRatio = tw / th;   // e.g. 1.0 for 1:1, 1.778 for 16:9
      wrapper.style.cssText = `
        position: relative;
        width: 100%;
        padding-top: ${(100 / arRatio).toFixed(4)}%;
        border-radius: 6px;
        overflow: hidden;
        border: 1px solid #444;
        background: #353535;
      `;

      // ── image ─────────────────────────────────────────────────────────────
      const img = document.createElement("img");
      img.src = item.previewSrc || item.src;
      const fit = item.previewSrc ? "cover" : "contain";
      const imgH = "100%";
      img.style.cssText = `position:absolute;top:0;left:0;width:100%;height:${imgH};object-fit:${fit};display:block;pointer-events:none;`;
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
        pushUndoState();
        
        let toRemove = [idx];
        if (selectedIndices.has(idx) && selectedIndices.size > 1) {
          toRemove = Array.from(selectedIndices).sort((a,b) => b - a);
        }
        
        for (const i of toRemove) {
          items.splice(i, 1);
        }
        items.forEach((it) => delete it.previewSrc);
        previewActive = false;
        
        selectedIndices.clear();
        selectedIdx = null;
        anchorIdx = null;
        
        if (items.length === 0) thumbH = THUMB_W;
        flashStatusMessage(`${toRemove.length} image${toRemove.length > 1 ? 's' : ''} deleted`);
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
        clearInsertIndicator();
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
      wrapper.addEventListener("click", (e) => {
        // Only toggle selection if clicking the thumbnail directly (not its buttons)
        if (e.target.closest("button")) return;
        
        if (e.shiftKey && anchorIdx !== null) {
          selectedIndices.clear();
          const start = Math.min(anchorIdx, idx);
          const end = Math.max(anchorIdx, idx);
          for (let i = start; i <= end; i++) selectedIndices.add(i);
          selectedIdx = idx;
        } else {
          if (selectedIndices.has(idx)) {
            selectedIndices.delete(idx);
            if (selectedIdx === idx) {
              selectedIdx = selectedIndices.size > 0 ? Array.from(selectedIndices).pop() : null;
            }
          } else {
            selectedIndices.add(idx);
            selectedIdx = idx;
            anchorIdx = idx;
          }
        }

        _cachedCopyBlob = null;
        _cachedCopyIdx = null;
        
        try { root.querySelectorAll(".mil-selected").forEach(el => el.classList.remove("mil-selected")); } catch(err){}
        const allWrappers = grid.querySelectorAll(".mil-thumb");
        selectedIndices.forEach(i => {
           if (allWrappers[i]) allWrappers[i].classList.add("mil-selected");
        });

        if (selectedIdx !== null) precacheSelectedBlob();
        persist();
        updateStatusBarText();
      });
      wrapper.addEventListener("dblclick", (e) => {
        // Find double_click widget setting
        const dcWidget = node.widgets?.find(w => w.name === "double_click");
        const action = dcWidget ? dcWidget.value : "Edit Image";
        
        if (action === "Edit Pixel") {
          openCropEditor(idx, false, "pixels");
        } else if (action === "Mask") {
          openMaskEditor(idx);
        } else {
          // Default to Edit Image
          openCropEditor(idx, false, "edit");
        }
      });
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        // Set this as primary but don't clear multi-selection if it's already in it
        if (!selectedIndices.has(idx)) {
          selectedIndices.clear();
          selectedIndices.add(idx);
          try { root.querySelectorAll(".mil-selected").forEach(el => el.classList.remove("mil-selected")); } catch(err){}
          wrapper.classList.add("mil-selected");
        }
        selectedIdx = idx;
        anchorIdx = idx;
        persist();
        updateStatusBarText();

        copyBtn.textContent = "⏳";
        (async () => {
          try {
            const dataUrl = await renderItemToDataUrl(item, idx);
            const resp = await fetch(dataUrl);
            let blob = await resp.blob();
            // Ensure PNG
            if (blob.type !== "image/png") {
              const cvs = document.createElement("canvas");
              const img2 = await loadImage(dataUrl);
              cvs.width = img2.naturalWidth; cvs.height = img2.naturalHeight;
              cvs.getContext("2d").drawImage(img2, 0, 0);
              blob = await new Promise(r => cvs.toBlob(r, "image/png"));
            }
            // Try Clipboard API
            let ok = false;
            if (navigator.clipboard?.write) {
              try {
                await navigator.clipboard.write([new ClipboardItem({"image/png": blob})]);
                ok = true;
              } catch(_) {}
            }
            // Fallback: contenteditable + execCommand
            if (!ok) {
              const url = URL.createObjectURL(blob);
              const fi = document.createElement("img");
              fi.src = url;
              await new Promise((res, rej) => { fi.onload = res; fi.onerror = rej; });
              const wrap = document.createElement("div");
              wrap.contentEditable = "true";
              wrap.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;";
              wrap.appendChild(fi);
              document.body.appendChild(wrap);
              const range = document.createRange();
              range.selectNodeContents(wrap);
              const sel = window.getSelection();
              sel.removeAllRanges(); sel.addRange(range);
              ok = document.execCommand("copy");
              document.body.removeChild(wrap);
              URL.revokeObjectURL(url);
            }
            copyBtn.style.color = ok ? "#5f5" : "#f55";
          } catch(err) {
            copyBtn.style.color = "#f55";
            console.error("[MIL] Copy failed:", err);
            flashStatusMessage("Copy failed");
          } finally {
            if (ok) flashStatusMessage("Image copied");
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

    // Spacers not needed — CSS grid handles column distribution

    const count = items.length;
    updateDropZone(count);
    statusBar.style.display  = "flex"; // Always show so refreshBtn is visible
    
    updateStatusBarText();

    clearBtn.style.display      = count > 0 ? "inline-block" : "none";
    // viewToggleBtn removed
    maskViewBtn.style.display   = count > 0 ? "inline-block" : "none";


    resizeNode();
    requestAnimationFrame(updateScrollFade);

    // mil-row-mode removed — always grid layout
    grid.classList.remove("mil-row-mode");
  }

  // ── Dual drag system: INSERT (edge) + SWAP (center) ────────────────────────
  // The approach:
  //  - Cursor in outer 30% of a thumbnail's main axis → INSERT mode (blue line)
  //  - Cursor in inner 70% (center zone)              → SWAP mode  (orange frame)
  // A single dragover listener on the grid container handles both.

  // Zone threshold: what fraction from the edge triggers INSERT vs SWAP
  const EDGE_ZONE = 0.28;

  let _insertTarget = null;  // { el, side:'before'|'after', insertIdx, mode:'insert'|'swap' }

  function clearInsertIndicator() {
    if (_insertTarget) {
      _insertTarget.el.classList.remove(
        "mil-insert-before", "mil-insert-after", "mil-swap-target"
      );
      _insertTarget = null;
    }
  }

  /**
   * Returns { el, mode, side, insertIdx } or null.
   * mode = 'insert' → cursor in edge zone  → show blue line
   * mode = 'swap'   → cursor in center zone → show orange frame
   */
  function findInsertPosition(e) {
    const thumbEls = [...grid.querySelectorAll(".mil-thumb")];
    if (thumbEls.length === 0) return null;

    // Find closest thumbnail to cursor
    let best = null, bestDist = Infinity;
    for (const el of thumbEls) {
      const r = el.getBoundingClientRect();
      // Clamp cursor to rect for distance — gives 0 when cursor is inside
      const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
      const dy = Math.max(r.top  - e.clientY, 0, e.clientY - r.bottom);
      const dist = dx + dy;
      if (dist < bestDist) { bestDist = dist; best = { el, r }; }
    }
    if (!best) return null;

    const { el, r } = best;
    const elIdx = parseInt(el.dataset.idx, 10);

    // Relative cursor position within the thumbnail (0..1)
    const relX = (e.clientX - r.left) / r.width;
    const relY = (e.clientY - r.top)  / r.height;

    // Primary axis depends on view mode
    let mode, side, insertIdx;
    {
      // Grid mode: check left/right edges
      const inEdge = relX < EDGE_ZONE || relX > 1 - EDGE_ZONE;
      if (inEdge) {
        mode = "insert";
        side = relX < 0.5 ? "before" : "after";
        insertIdx = side === "before" ? elIdx : elIdx + 1;
      } else {
        mode = "swap";
        side = null;
        insertIdx = elIdx;  // swap target
      }
    }
    return { el, mode, side, insertIdx, elIdx, dist: bestDist };
  }

  function applyIndicator(pos) {
    if (!pos) return;
    if (pos.mode === "insert") {
      pos.el.classList.add(pos.side === "before" ? "mil-insert-before" : "mil-insert-after");
    } else {
      pos.el.classList.add("mil-swap-target");
    }
  }

  function indicatorChanged(prev, next) {
    if (!prev || !next) return true;
    return prev.el !== next.el || prev.mode !== next.mode || prev.side !== next.side;
  }

  grid.addEventListener("dragover", (e) => {
    const isExternalFile = dragSrcIdx === null && e.dataTransfer?.types?.includes("Files");

    const pos = findInsertPosition(e);
    if (!pos) return;

    if (isExternalFile) {
      if (pos.dist > 0) return; // Not hovering directly over a thumbnail -> let it bubble to gridWrapper
      
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      // Force swap mode for explicit thumbnail replacement
      const swapPos = { el: pos.el, mode: "swap", side: null, insertIdx: pos.elIdx, elIdx: pos.elIdx };
      if (indicatorChanged(_insertTarget, swapPos)) {
        clearInsertIndicator();
        applyIndicator(swapPos);
        _insertTarget = swapPos;
      }
      return;
    }

    // ── Internal reorder drag ──
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    // Skip true no-ops (dragging onto itself)
    const isSelf = pos.elIdx === dragSrcIdx;
    const isAdjacentInsert = pos.mode === "insert" &&
      (pos.insertIdx === dragSrcIdx || pos.insertIdx === dragSrcIdx + 1);
    const noop = isSelf || isAdjacentInsert;

    if (indicatorChanged(_insertTarget, noop ? null : pos)) {
      clearInsertIndicator();
    }
    if (noop) return;

    if (!_insertTarget) {
      applyIndicator(pos);
      _insertTarget = pos;
    }
  });

  grid.addEventListener("dragleave", (e) => {
    if (!grid.contains(e.relatedTarget)) {
      clearInsertIndicator();
    }
  });

  grid.addEventListener("drop", (e) => {
    const isExternalFile = dragSrcIdx === null && e.dataTransfer?.types?.includes("Files");

    if (isExternalFile) {
      if (!_insertTarget || _insertTarget.dist > 0) return; // Not hovering exactly on a thumbnail -> let it bubble to gridWrapper appending

      e.preventDefault();
      e.stopPropagation();
      const targetIdx = _insertTarget.elIdx;
      clearInsertIndicator();
      
      const ol = gridWrapper.querySelector(".mil-drop-overlay");
      if (ol) ol.style.opacity = "0";
      gridWrapper.dataset.dragCount = "0";

      const imageFiles = [...e.dataTransfer.files].filter(f => f.type.startsWith("image/"));
      if (imageFiles.length > 0) replaceFileAt(targetIdx, imageFiles[0]);
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    // ── Internal reorder drop ──
    const pos = _insertTarget;
    clearInsertIndicator();
    if (dragSrcIdx === null || !pos) return;

    if (pos.mode === "insert") {
      // No-op guard
      if (pos.insertIdx === dragSrcIdx || pos.insertIdx === dragSrcIdx + 1) return;
      pushUndoState();
      const [moved] = items.splice(dragSrcIdx, 1);
      const adjustedIdx = pos.insertIdx > dragSrcIdx ? pos.insertIdx - 1 : pos.insertIdx;
      items.splice(adjustedIdx, 0, moved);
    } else {
      // Swap mode: exchange positions
      const targetIdx = pos.elIdx;
      if (targetIdx === dragSrcIdx) return;
      pushUndoState();
      [items[dragSrcIdx], items[targetIdx]] = [items[targetIdx], items[dragSrcIdx]];
    }

    // Rather than deleting previewSrc for un-cropped items out from under the UI,
    // we keep the previews as they are to avoid flickering, and trigger a background refresh
    // because index 0 might have changed, affecting standard dimensions.
    previewActive = items.some(it => it.previewSrc);

    updateThumbHFromFirst();
    render();
    persist();
    renderFitPreviews().then(() => renderCropPreviews());
  });

  // ── replaceFileAt: upload file and replace item at given index ──────────────────
  async function replaceFileAt(idx, file) {
    if (idx < 0 || idx >= items.length) return;
    statusLabel.textContent = "Uploading…";
    statusLabel.style.color = "#ffcc66";
    try {
      const [dataUrl]  = await Promise.all([fileToDataURL(file)]);
      const [filename] = await uploadFiles([file]);

      // Clear any crop/mask data from the old file
      pushUndoState();
      const oldFilename = items[idx].filename;
      if (oldFilename !== filename) {
        delete cropMap[oldFilename];
      }

      items[idx] = { filename, src: dataUrl };

      if (selectedIdx === idx) selectedIdx = null;

      await updateThumbHFromFirst();
      statusLabel.style.color = "#8899bb";
      render();
      persist();
      await renderFitPreviews();
      await renderCropPreviews();

      // Brief orange fade-out on replaced thumbnail
      requestAnimationFrame(() => {
        const thumb = grid.querySelectorAll(".mil-thumb")[idx];
        if (thumb) {
          thumb.classList.add("mil-paste-fade");
          setTimeout(() => thumb.classList.remove("mil-paste-fade"), 850);
        }
      });
    } catch (err) {
      statusLabel.textContent = `Error: ${err.message}`;
      statusLabel.style.color = "#ff6666";
    }
  }

  // Update thumbH: respects master_image > aspect_ratio > first image
  async function updateThumbHFromFirst() {
    if (items.length === 0 && !isMasterConnected()) { thumbH = THUMB_W; return; }

    // Priority 1: master_image connection
    const masterDims = getMasterImageDims();
    if (masterDims) {
      thumbH = Math.max(20, Math.round(THUMB_W * masterDims.h / masterDims.w));
      return;
    }

    // Priority 2: aspect_ratio widget
    const ar = getAspectRatioWidget()?.value ?? "none";
    if (ar !== "none") {
      const [aw, ah] = ar.split(":").map(Number);
      thumbH = Math.max(20, Math.round(THUMB_W * ah / aw));
      return;
    }

    // Priority 3: first image natural dims
    if (items.length === 0) { thumbH = THUMB_W; return; }
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
   * When aspect_ratio is set or master_image is connected, even idx=0 is fitted to the fixed canvas.
   */
  async function renderItemToDataUrl(item, idx) {
    const ar = getAspectRatioWidget()?.value ?? "none";
    const t = cropMap[item.filename];
    if (idx === 0 && ar === "none" && !isMasterConnected()) {
      const hasPixelEdits = t && t.imageEditsDataUrl;
      const hasLassoOps = t && ((t.lassoOps && t.lassoOps.length > 0) || t.lassoInverted);
      if (!hasPixelEdits && !hasLassoOps) {
        return item.src;
      }
    }

    // Get reference dims (aspect_ratio-aware)
    const { refW, refH } = await computeRefDims();

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
      // If pixel edits exist, load the edited image (crop already baked in)
      let drawSrc = el, srcX, srcY, srcW, srcH;
      if (t.imageEditsDataUrl) {
        const pxImg = await loadImage(t.imageEditsDataUrl);
        drawSrc = pxImg;
        srcX = 0; srcY = 0; srcW = pxImg.naturalWidth; srcH = pxImg.naturalHeight;
      } else {
        // Effective source dimensions after pre-crop
        const hasCR = t.cx != null && (t.cx > 0 || t.cy > 0 || t.cw < 1 || t.ch < 1);
        srcX = hasCR ? t.cx * el.naturalWidth  : 0;
        srcY = hasCR ? t.cy * el.naturalHeight : 0;
        srcW = hasCR ? t.cw * el.naturalWidth  : el.naturalWidth;
        srcH = hasCR ? t.ch * el.naturalHeight : el.naturalHeight;
      }
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
      ctx.drawImage(drawSrc, srcX, srcY, srcW, srcH, -dw / 2, -dh / 2, dw, dh);
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

  function hasCrop(filename) {
    const t = cropMap[filename];
    if (!t) return false;
    if (t.bg === "telea" || t.bg === "navier-stokes") return true;
    return !!(
      t.cx != null || t.cy != null || t.cw != null || t.ch != null ||
      t.imageEditsDataUrl || (t.lassoOps && t.lassoOps.length) || (t.maskOps && t.maskOps.length) ||
      t.ox || t.oy || (t.scale !== undefined && t.scale !== 1 && t.scale !== 0) || t.rotate || t.flipH || t.flipV
    );
  }

  // ... [we'll skip modifying everything inside renderItemToDataUrl since it just works] ...
  
  /**
   * Renders a canvas-based fit preview for thumbnails.
   */
  async function renderFitPreviews() {
    if (items.length < 1) return;

    const mode = getFitModeWidget()?.value ?? "letterbox";
    const ar = getAspectRatioWidget()?.value ?? "none";

    try {
      const { refW: targetW, refH: targetH } = await computeRefDims();
      const startIdx = (isMasterConnected() || ar !== "none") ? 0 : 1;

      const jobs = [];
      for (let i = startIdx; i < items.length; i++) {
        // Skip items that have custom crops; they are handled by renderCropPreviews
        if (hasCrop(items[i].filename)) continue;

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
   * Regenerates thumbnails for items that have a crop/editor transform.
   */
  async function renderCropPreviews() {
    if (items.length < 1) return;
    const { refW, refH } = await computeRefDims();
    const mode = getFitModeWidget()?.value ?? "letterbox";

    const jobs = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!hasCrop(item.filename)) continue;  // handled by renderFitPreviews

      const t = cropMap[item.filename];
      const bgRaw = t.bg ?? getEffectiveBgColor();
      const isInpaint = bgRaw === "telea" || bgRaw === "navier-stokes";

      if (isInpaint) {
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
        const bgC = /^#[0-9a-fA-F]{6}$/.test(bgRaw) ? bgRaw : getEffectiveBgColor();
        const imgSrc = t.imageEditsDataUrl || item.src;
        const xform = t.imageEditsDataUrl
          ? { ...t, cx: undefined, cy: undefined, cw: undefined, ch: undefined }
          : t;
        jobs.push(
          workerRender("cropTransform", imgSrc, {
            refW, refH, bgColor: bgC, fitMode: mode, transform: xform
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

    // Restore selected items
    const sw = getSelectedItemsWidget();
    try {
      const selectedFilenames = JSON.parse(sw?.value || "[]");
      selectedIndices.clear();
      selectedFilenames.forEach((fn) => {
        const idx = items.findIndex((it) => it.filename === fn);
        if (idx !== -1) selectedIndices.add(idx);
      });
      // also set selectedIdx to the first one if present so UI has an anchor
      if (selectedIndices.size > 0 && selectedIdx === null) {
        selectedIdx = Array.from(selectedIndices)[0];
      }
    } catch {
      // ignore
    }

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

  async function addFiles(files, insertIdx = -1) {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;

    statusLabel.textContent = "Uploading…";
    statusLabel.style.color = "#ffcc66";

    try {
      const dataURLs  = await Promise.all(imageFiles.map(fileToDataURL));
      const filenames = await uploadFiles(imageFiles);

      pushUndoState();
      
      const newItems = filenames.map((fn, i) => ({ filename: fn, src: dataURLs[i] }));
      const insertedCount = newItems.length;
      let startFlashIdx = 0;
      
      if (insertIdx !== -1 && insertIdx <= items.length) {
        items.splice(insertIdx, 0, ...newItems);
        startFlashIdx = insertIdx;
        selectedIdx = insertIdx + insertedCount - 1; // optionally select the last pasted item
      } else {
        startFlashIdx = items.length;
        items.push(...newItems);
      }

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
        const endFlashIdx = Math.min(startFlashIdx + insertedCount, allThumbs.length);
        for (let i = startFlashIdx; i < endFlashIdx; i++) {
          if (!allThumbs[i]) continue;
          allThumbs[i].classList.remove("mil-paste-flash");
          void allThumbs[i].offsetWidth; // force reflow
          allThumbs[i].classList.add("mil-paste-flash");
        }
        
        // Scroll to the newly inserted items if needed
        if (allThumbs[startFlashIdx]) {
           allThumbs[startFlashIdx].scrollIntoView({ behavior: "smooth", block: "nearest" });
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

  // ── gridWrapper file drag support ─────────────────────────────────────────
  const dropOverlay = document.createElement("div");
  dropOverlay.className = "mil-drop-overlay";
  dropOverlay.style.cssText = `
    position: absolute;
    inset: 0;
    border: 2px dashed #aaccff;
    border-radius: 10px;
    background: rgba(90, 122, 191, 0.15);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s;
    z-index: 100;
    box-sizing: border-box;
  `;
  gridWrapper.appendChild(dropOverlay);

  gridWrapper.dataset.dragCount = "0";

  gridWrapper.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    gridWrapper.dataset.dragCount = Number(gridWrapper.dataset.dragCount || 0) + 1;
    dropOverlay.style.opacity = "1";
  });

  gridWrapper.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    dropOverlay.style.opacity = "1";
  });

  gridWrapper.addEventListener("dragleave", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    const count = Math.max(0, Number(gridWrapper.dataset.dragCount || 0) - 1);
    gridWrapper.dataset.dragCount = count;
    if (count === 0 || !gridWrapper.contains(e.relatedTarget)) {
      gridWrapper.dataset.dragCount = "0";
      dropOverlay.style.opacity = "0";
    }
  });

  gridWrapper.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    gridWrapper.dataset.dragCount = "0";
    dropOverlay.style.opacity = "0";
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
  
  clearBtn.addEventListener("click", () => {
    pushUndoState();
    if (isMasterConnected() && items.length > 0) {
      const masterItem = items[0];
      const masterCrop = cropMap[masterItem.filename];
      items = [masterItem];
      cropMap = {};
      if (masterCrop) cropMap[masterItem.filename] = masterCrop;
      previewActive = Boolean(masterItem.previewSrc);
      flashStatusMessage("Cleared all except master image");
    } else {
      items  = [];
      thumbH = THUMB_W;
      previewActive = false;
      cropMap = {};
      flashStatusMessage("All images cleared");
    }
    selectedIdx = null;
    selectedIndices.clear();
    anchorIdx = null;
    render();
    persist();
  });

  // ── initial render ────────────────────────────────────────────────────────
  render();

  root._addFiles         = addFiles;
  root._restore          = restore;
  root._render           = render;
  root._hasSelection     = () => selectedIdx !== null;
  root._getCachedBlob    = () => (_cachedCopyIdx === selectedIdx && _cachedCopyBlob) ? _cachedCopyBlob : null;
  root._undo             = popUndoState;
  
  root._removeSelectedItems = () => {
    if (selectedIdx === null) return;
    pushUndoState();
    
    let toRemove = [selectedIdx];
    if (selectedIndices.size > 1) {
      toRemove = Array.from(selectedIndices).sort((a,b) => b - a);
    }
    
    for (const i of toRemove) {
      items.splice(i, 1);
    }
    items.forEach((it) => delete it.previewSrc);
    previewActive = false;
    
    selectedIndices.clear();
    selectedIdx = null;
    anchorIdx = null;
    
    if (items.length === 0) thumbH = THUMB_W;
    if (typeof flashStatusMessage === "function") flashStatusMessage(`${toRemove.length} image${toRemove.length > 1 ? 's' : ''} deleted`);
    render();
    persist();
  };

  root._copySelected     = async () => {
    if (selectedIdx === null || selectedIdx < 0 || selectedIdx >= items.length) return;
    const idxSnap = selectedIdx;

    // ── Obtain the PNG blob ──────────────────────────────────────────────────
    // Prefer pre-cached blob (ready instantly, keeps user-gesture alive).
    // Fall back to rendering on demand (used by the ⎘ button click path).
    let blob = (_cachedCopyIdx === idxSnap && _cachedCopyBlob) ? _cachedCopyBlob : null;

    if (!blob) {
      try {
        const item = items[idxSnap];
        const dataUrl = await renderItemToDataUrl(item, idxSnap);
        const resp = await fetch(dataUrl);
        blob = await resp.blob();
        if (blob.type !== "image/png") {
          const cvs = document.createElement("canvas");
          const img = await loadImage(dataUrl);
          cvs.width = img.naturalWidth; cvs.height = img.naturalHeight;
          cvs.getContext("2d").drawImage(img, 0, 0);
          blob = await new Promise(r => cvs.toBlob(r, "image/png"));
        }
      } catch (err) {
        console.error("[MIL] Copy - render failed:", err);
        return;
      }
    }

    // ── Write to clipboard ───────────────────────────────────────────────────
    let copied = false;

    // Strategy 1: Clipboard API (works in Chrome, Edge, modern Brave with gesture)
    if (navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        copied = true;
      } catch (err) {
        console.warn("[MIL] Clipboard API write failed, trying fallback:", err);
      }
    }

    // Strategy 2: contenteditable + execCommand (legacy but widely supported)
    if (!copied) {
      try {
        const url = URL.createObjectURL(blob);
        const fi  = document.createElement("img");
        fi.src = url;
        await new Promise((res, rej) => { fi.onload = res; fi.onerror = rej; });

        const wrap = document.createElement("div");
        wrap.contentEditable = "true";
        wrap.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;";
        wrap.appendChild(fi);
        document.body.appendChild(wrap);

        const range = document.createRange();
        range.selectNodeContents(wrap);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        copied = document.execCommand("copy");
        document.body.removeChild(wrap);
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error("[MIL] Fallback copy also failed:", err);
      }
    }

    if (!copied) {
      alert("MIL: Could not copy image to clipboard.\nPlease check browser clipboard permissions (brave://settings/content/clipboard).");
      return;
    }

    // Visual feedback — green flash
    const thumb = grid.querySelectorAll(".mil-thumb")[idxSnap];
    if (thumb) {
      thumb.style.borderColor = "#5f5";
      setTimeout(() => { thumb.style.borderColor = ""; }, 600);
    }
  };
  root._cutSelected      = async () => {
    if (selectedIdx === null || selectedIdx < 0 || selectedIdx >= items.length) return;
    await root._copySelected();
    
    // Remove the item
    pushUndoState();
    const fn = items[selectedIdx].filename;
    items.splice(selectedIdx, 1);
    delete cropMap[fn];
    
    // Check if it was master image
    if (selectedIdx === 0 && Array.from(document.querySelectorAll(".mil-thumb")).length > 0) {
       // if we deleted master image, keep layout
    }
    
    selectedIdx = null;
    selectedIndices.clear();
    anchorIdx = null;
    if (typeof flashStatusMessage === "function") flashStatusMessage("Image cut");
    previewActive = items.some(it => it.previewSrc);
    await updateThumbHFromFirst();
    render();
    persist();
    await renderCropPreviews();
  };
  root._renderWithResize = () => {
    // Re-render thumbnails when thumb_size changes — snap height to fit 4 rows
    render();
    if (items.length > 0) snapNodeToIdealH();
  };
  root._onAspectRatioChange = async () => {
    // Called whenever aspect_ratio, fit_mode, or megapixels changes.
    // Re-renders all thumbnails and resizes node to reflect the new canvas shape.
    if (items.length === 0) { render(); return; }
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
    let edLassoIsPaint = false;
    let edLassoInverted = false;
    let pxLassoInvertB = null;
    let edLassoCurrentPts = [];
    let edLassoDrawing = false;
    let edLassoAntsOffset = 0;
    let edLassoAntsRaf = null;
    let _lassoOverlayCvs = null;
    let _lassoOverlayBg = null;
    let _lassoMaskDirty = true;
    let _lassoCursorNorm = null;
    let _lassoShiftAnchorIdx = -1; // index into edLassoCurrentPts when Shift was last pressed
    // Reusable temp canvas for brush clipping (avoids GC pressure from createElement per mousemove)
    let _brushClipCvs = null; let _brushClipCtx = null; // kept for potential future use
    // ── Path2D lasso clip cache — version counter ensures rebuild whenever selection changes ──
    let _cachedLassoPath2D = null;
    let _cachedLassoPath2DW = 0, _cachedLassoPath2DH = 0;
    let _lassoPath2DVersion = 0;       // incremented on every selection change
    let _cachedLassoPath2DVersion = -1; // version at last build
    function _lassoChanged() { _lassoMaskDirty = true; _lassoPath2DVersion++; }
    function _getLassoClipPath(pw, ph) {
      // Rebuild only when selection changes (version) or canvas dimensions change
      if (_cachedLassoPath2D && _cachedLassoPath2DVersion === _lassoPath2DVersion
          && _cachedLassoPath2DW === pw && _cachedLassoPath2DH === ph)
        return _cachedLassoPath2D;
      const path = new Path2D();
      for (const op of edLassoOps) {
        if (op.points.length < 3) continue;
        path.moveTo(op.points[0][0] * pw, op.points[0][1] * ph);
        for (let i = 1; i < op.points.length; i++) path.lineTo(op.points[i][0] * pw, op.points[i][1] * ph);
        path.closePath();
      }
      _cachedLassoPath2D = path;
      _cachedLassoPath2DW = pw; _cachedLassoPath2DH = ph;
      _cachedLassoPath2DVersion = _lassoPath2DVersion;
      return path;
    }
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
      if (mode !== "pixels" && edLassoIsPaint) {
        edLassoOps = [];
        edLassoIsPaint = false;
        _lassoChanged();
        stopLassoAnts();
      }
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
      edLassoOps = []; edLassoInverted = false; _lassoChanged(); edLassoIsPaint = false;
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
        hint.textContent = edLassoTool === "freehand" ? "Drag to draw \u00b7 Shift: ortho · add · Alt: subtract" : "Click vertices \u00b7 Close near start / dblclick \u00b7 Shift: ortho · add · Alt: subtract";
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
      edLassoOps = []; edLassoInverted = false; _lassoChanged(); edLassoIsPaint = false;
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
      edLassoOps = []; edLassoInverted = false; edLassoIsPaint = false;
      edLassoCurrentPts = []; edLassoDrawing = false;
      _lassoChanged(); _lassoCursorNorm = null;
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
        if (typeof edPixelTool !== 'undefined' && edPixelTool !== null) { edPixelTool = null; _syncPixelToolUI(); }
      }
      syncLassoToggle(); redraw();
    }
    lassoFreehandB.addEventListener("click", () => toggleLassoTool("freehand"));
    lassoPolyB.addEventListener("click", () => toggleLassoTool("polygonal"));
    lassoToolRow.appendChild(lassoFreehandB); lassoToolRow.appendChild(lassoPolyB);
    secEdit.appendChild(lassoToolRow);

    // Invert & Deselect Selection
    const lassoActionRow = document.createElement("div");
    lassoActionRow.style.cssText = `display:flex;gap:${_gap5};width:100%;margin-top:${_gap5};`;

    const lassoInvertB = document.createElement("button");
    lassoInvertB.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><path d="M3 8h14l-4-4"/><path d="M21 16H7l4 4"/></svg>Invert`;
    lassoInvertB.style.cssText = `flex:1;background:#1e1e1e;color:#aaa;border:1px solid #333;border-radius:${_r5};padding:${_btnPadW};font-size:${_fs10};cursor:pointer;transition:background 0.15s;display:flex;align-items:center;justify-content:center;`;
    lassoInvertB.addEventListener("click", () => {
      edLassoInverted = !edLassoInverted;
      _lassoChanged();
      syncLassoInvertBtn(); requestInpaintPreview(); redraw();
    });

    const lassoDeselectB = document.createElement("button");
    lassoDeselectB.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Deselect`;
    lassoDeselectB.style.cssText = `flex:1;background:#1e1e1e;color:#aaa;border:1px solid #333;border-radius:${_r5};padding:${_btnPadW};font-size:${_fs10};cursor:pointer;transition:background 0.15s;display:flex;align-items:center;justify-content:center;`;
    lassoDeselectB.addEventListener("click", () => {
      edLassoOps = []; edLassoIsPaint = false; edLassoInverted = false; _lassoChanged();
      syncLassoInvertBtn(); requestInpaintPreview(); redraw();
    });

    function syncLassoInvertBtn() {
      if (edLassoInverted) {
        lassoInvertB.style.background = "#2a1a3a"; lassoInvertB.style.color = "#bb88ff"; lassoInvertB.style.borderColor = "#553388";
        if (pxLassoInvertB) { pxLassoInvertB.style.background = "#2a1a3a"; pxLassoInvertB.style.color = "#bb88ff"; pxLassoInvertB.style.borderColor = "#553388"; }
      } else {
        lassoInvertB.style.background = "#1e1e1e"; lassoInvertB.style.color = "#aaa"; lassoInvertB.style.borderColor = "#333";
        if (pxLassoInvertB) { pxLassoInvertB.style.background = "#1e1e1e"; pxLassoInvertB.style.color = "#aaa"; pxLassoInvertB.style.borderColor = "#333"; }
      }
    }
    lassoActionRow.appendChild(lassoInvertB);
    lassoActionRow.appendChild(lassoDeselectB);
    secEdit.appendChild(lassoActionRow);

    // Hint + Info
    const lassoHintLbl = document.createElement("div");
    lassoHintLbl.style.cssText = `color:#555;font-size:${_fs10};text-align:center;line-height:1.3;`;
    lassoHintLbl.textContent = "Shift: ortho · add · Alt: subtract";
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

    // ── Orthogonal/45° snap helper (Shift key while drawing) ──
    // Returns {x, y} snapped to the nearest 45° angle from lastPt
    function _snapOrtho45(lastPt, nx, ny) {
      if (!lastPt) return { x: nx, y: ny };
      const dx = nx - lastPt.x, dy = ny - lastPt.y;
      const angle = Math.atan2(dy, dx); // -π to π
      const snap = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4); // nearest 45°
      const dist = Math.hypot(dx, dy);
      return { x: lastPt.x + dist * Math.cos(snap), y: lastPt.y + dist * Math.sin(snap) };
    }

    // ── Commit a completed polygon/freehand shape ──
    function commitLassoShape(points, e) {
      if (points.length < 3) return;
      const normalized = points.map(p => [p.x, p.y]);
      let mode = "add";
      if (e && e.altKey) mode = "subtract";
      if (!e || (!e.shiftKey && !e.altKey)) {
        edLassoOps = [];
        edLassoIsPaint = (edPanelMode === "pixels");
      }
      edLassoOps.push({ mode, points: normalized });
      edLassoCurrentPts = []; edLassoDrawing = false; _lassoCursorNorm = null;
      _lassoChanged();
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
            ctx.beginPath();
            for (let i = 0; i < _cachedEdgePixels.length; i += 2) {
               const px = _cachedEdgePixels[i], py = _cachedEdgePixels[i+1];
               if (Math.floor((px + py + edLassoAntsOffset) / 4) % 2 === 0) {
                 ctx.rect(px - dw/2, py - dh/2, 1, 1);
               }
            }
            ctx.fillStyle = '#ffffff'; ctx.fill();

            ctx.beginPath();
            for (let i = 0; i < _cachedEdgePixels.length; i += 2) {
               const px = _cachedEdgePixels[i], py = _cachedEdgePixels[i+1];
               if (Math.floor((px + py + edLassoAntsOffset) / 4) % 2 !== 0) {
                 ctx.rect(px - dw/2, py - dh/2, 1, 1);
               }
            }
            ctx.fillStyle = '#000000'; ctx.fill();
            
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
        ctx.lineWidth = 1.5;
        if (edLassoTool === 'freehand') {
          if (pts.length >= 2) {
            ctx.strokeStyle = '#ffffff'; ctx.setLineDash([4, 4]);
            ctx.beginPath(); ctx.moveTo(pts[0].lx, pts[0].ly);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].lx, pts[i].ly);
            ctx.stroke();
            ctx.strokeStyle = '#000000'; ctx.lineDashOffset = 4; ctx.stroke();
            ctx.setLineDash([]); ctx.lineDashOffset = 0;
          }
        } else {
          ctx.strokeStyle = '#ffffff'; ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(pts[0].lx, pts[0].ly);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].lx, pts[i].ly);
          const curL = _lassoCursorNorm ? { lx: (_lassoCursorNorm.x - 0.5) * dw, ly: (_lassoCursorNorm.y - 0.5) * dh } : null;
          if (curL) ctx.lineTo(curL.lx, curL.ly);
          ctx.stroke();
          ctx.strokeStyle = '#000000'; ctx.lineDashOffset = 4; ctx.stroke();
          ctx.setLineDash([]); ctx.lineDashOffset = 0;
          ctx.fillStyle = '#ffffff';
          for (const p of pts) { ctx.beginPath(); ctx.arc(p.lx, p.ly, 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
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
    let edPixelTool = null;  // null | "blur" | "smudge" | "brush" | "eyedropper"
    let edColorFg = "#ffffff";
    let edColorBg = "#000000";
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
      edLassoOps = []; edLassoCurrentPts = []; edLassoDrawing = false; edLassoIsPaint = false;
      edLassoInverted = false; _lassoCursorNorm = null; _lassoChanged();
      stopLassoAnts(); syncLassoToggle(); updateLassoInfoLbl(); redraw();
    }, "Clear lasso selection"));

    const pxLassoToolRow = document.createElement("div");
    pxLassoToolRow.style.cssText = `display:flex;gap:0;width:100%;`;
    pxLassoFreehandB = document.createElement("button");
    pxLassoFreehandB.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-3-.4"/><path d="M12 18a14 14 0 0 1-3.3-.4"/></svg>Lasso`;
    pxLassoFreehandB.style.cssText = `flex:1;background:#1e1e1e;color:#aaa;border:1px solid #333;border-radius:${_r5} 0 0 ${_r5};padding:${_btnPadW};font-size:${_fs10};cursor:pointer;transition:background 0.15s;display:flex;align-items:center;justify-content:center;border-right:none;`;
    pxLassoPolyB = document.createElement("button");
    pxLassoPolyB.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><polygon points="3 6 9 3 21 8 18 21 7 15"/></svg>Polygonal`;
    pxLassoPolyB.style.cssText = `flex:1;background:#1e1e1e;color:#aaa;border:1px solid #333;border-radius:0 ${_r5} ${_r5} 0;padding:${_btnPadW};font-size:${_fs10};cursor:pointer;transition:background 0.15s;display:flex;align-items:center;justify-content:center;`;
    pxLassoFreehandB.addEventListener("click", () => toggleLassoTool("freehand"));
    pxLassoPolyB.addEventListener("click", () => toggleLassoTool("polygonal"));
    pxLassoToolRow.appendChild(pxLassoFreehandB); pxLassoToolRow.appendChild(pxLassoPolyB);
    secPixels.appendChild(pxLassoToolRow);

    const pxLassoActionRow = document.createElement("div");
    pxLassoActionRow.style.cssText = `display:flex;gap:${_gap5};width:100%;margin-top:${_gap5};`;

    pxLassoInvertB = document.createElement("button");
    pxLassoInvertB.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><path d="M3 8h14l-4-4"/><path d="M21 16H7l4 4"/></svg>Invert`;
    pxLassoInvertB.style.cssText = `flex:1;background:#1e1e1e;color:#aaa;border:1px solid #333;border-radius:${_r5};padding:${_btnPadW};font-size:${_fs10};cursor:pointer;transition:background 0.15s;display:flex;align-items:center;justify-content:center;`;
    pxLassoInvertB.addEventListener("click", () => {
      edLassoInverted = !edLassoInverted;
      _lassoChanged();
      syncLassoInvertBtn(); requestInpaintPreview(); redraw();
    });

    const pxLassoDeselectB = document.createElement("button");
    pxLassoDeselectB.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Deselect`;
    pxLassoDeselectB.style.cssText = `flex:1;background:#1e1e1e;color:#aaa;border:1px solid #333;border-radius:${_r5};padding:${_btnPadW};font-size:${_fs10};cursor:pointer;transition:background 0.15s;display:flex;align-items:center;justify-content:center;`;
    pxLassoDeselectB.addEventListener("click", () => {
      edLassoOps = []; edLassoIsPaint = false; edLassoInverted = false; _lassoChanged();
      syncLassoInvertBtn(); requestInpaintPreview(); redraw();
    });

    pxLassoActionRow.appendChild(pxLassoInvertB);
    pxLassoActionRow.appendChild(pxLassoDeselectB);
    secPixels.appendChild(pxLassoActionRow);


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
      edPixelTool = null; _edCvsEditsPx = null; _edEditsUndoStack = []; _edEditsRedoStack = [];
      _edSmudgeBuf = null; _edBrushDrawing = false; _edBrushPts = [];
      _syncPixelToolUI(); redraw();
    }, "Reset all pixel edits"));

    const ptToolRow = document.createElement("div");
    ptToolRow.style.cssText = `display:flex;gap:${_gap5};flex-wrap:wrap;`;
    const ptBtns = {};
    [["brush","🖌️ Brush"], ["eyedropper","💉 Eyedrop"], ["blur","💧 Blur"],["smudge","👆 Smudge"]].forEach(([k,lbl]) => {
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

    // Foreground / Background colors UI
    const ptColorRow = document.createElement("div");
    ptColorRow.style.cssText = `position:relative;width:40px;height:40px;margin:2px 0 0 2px;`;
    
    // Background picker
    const ptBgPicker = document.createElement("input");
    ptBgPicker.type = "color"; ptBgPicker.value = edColorBg;
    ptBgPicker.style.cssText = `position:absolute;width:24px;height:24px;left:14px;top:14px;border:1px solid #111;padding:0;cursor:pointer;`;
    ptBgPicker.addEventListener("input", (e) => { edColorBg = e.target.value; });
    
    // Foreground picker
    const ptFgPicker = document.createElement("input");
    ptFgPicker.type = "color"; ptFgPicker.value = edColorFg;
    ptFgPicker.style.cssText = `position:absolute;width:24px;height:24px;left:0px;top:0px;border:1px solid #111;padding:0;cursor:pointer;z-index:2;`;
    ptFgPicker.addEventListener("input", (e) => { edColorFg = e.target.value; });
    
    const ptSwapBtn = document.createElement("button");
    ptSwapBtn.innerHTML = `↹`;
    ptSwapBtn.title = "Swap colors (X)";
    ptSwapBtn.style.cssText = `position:absolute;left:28px;top:-4px;background:none;border:none;color:#aaa;cursor:pointer;font-size:12px;z-index:3;`;
    ptSwapBtn.addEventListener("click", () => {
      const t = edColorFg; edColorFg = edColorBg; edColorBg = t;
      ptFgPicker.value = edColorFg; ptBgPicker.value = edColorBg;
    });

    const ptResetBtn = document.createElement("button");
    ptResetBtn.innerHTML = `🔳`;
    ptResetBtn.title = "Reset to Default (D)";
    ptResetBtn.style.cssText = `position:absolute;left:-8px;top:28px;background:none;border:none;cursor:pointer;font-size:10px;z-index:3;filter:grayscale(1);`;
    ptResetBtn.addEventListener("click", () => {
      edColorFg = "#ffffff"; edColorBg = "#000000";
      ptFgPicker.value = edColorFg; ptBgPicker.value = edColorBg;
    });
    
    ptColorRow.appendChild(ptBgPicker); ptColorRow.appendChild(ptFgPicker);
    ptColorRow.appendChild(ptSwapBtn); ptColorRow.appendChild(ptResetBtn);
    
    const ptColorWrapper = document.createElement("div");
    ptColorWrapper.style.cssText = `display:none;align-items:center;margin-top:4px;gap:8px;`;
    const ptColorLabel = document.createElement("span");
    ptColorLabel.style.cssText = `color:#888;font-size:${_fs10};`;
    ptColorLabel.textContent = "Colors";
    ptColorWrapper.appendChild(ptColorLabel);
    ptColorWrapper.appendChild(ptColorRow);
    secPixels.appendChild(ptColorWrapper);

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
    ptSmVal.style.cssText = `color:#888;font-size:${_fs10};min-width:36px;padding-right:4px;text-align:right;box-sizing:border-box;`;
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
    ptBrVal.style.cssText = `color:#888;font-size:${_fs10};min-width:36px;padding-right:4px;text-align:right;box-sizing:border-box;`;
    ptBrVal.textContent = "30px";
    ptBrSlider.addEventListener("input", () => { ptBrVal.textContent = ptBrSlider.value+"px"; redraw(); });
    ptBrushRow.appendChild(ptBrLbl); ptBrushRow.appendChild(ptBrSlider); ptBrushRow.appendChild(ptBrVal);
    secPixels.appendChild(ptBrushRow);

    // Undo / Redo row
    let _edEditsRedoStack = [];
    const ptUndoRedoRow = document.createElement("div");
    ptUndoRedoRow.style.cssText = `display:flex;gap:${_gap5};width:100%;`;
    const ptUndoB = document.createElement("button");
    ptUndoB.textContent = "\u21B6 Undo";
    ptUndoB.style.cssText = `flex:1;background:#1e1e1e;color:#aaa;border:1px solid #3a3a3a;border-radius:${_r5};padding:${_btnPad};font-size:${_fs11};cursor:pointer;transition:background .12s;`;
    ptUndoB.addEventListener("mouseenter", () => { ptUndoB.style.background="#2a2a2a"; ptUndoB.style.borderColor="#555"; });
    ptUndoB.addEventListener("mouseleave", () => { ptUndoB.style.background="#1e1e1e"; ptUndoB.style.borderColor="#3a3a3a"; });
    ptUndoB.addEventListener("click", () => _edUndoEdits());
    const ptRedoB = document.createElement("button");
    ptRedoB.textContent = "\u21B7 Redo";
    ptRedoB.style.cssText = `flex:1;background:#1e1e1e;color:#aaa;border:1px solid #3a3a3a;border-radius:${_r5};padding:${_btnPad};font-size:${_fs11};cursor:pointer;transition:background .12s;`;
    ptRedoB.addEventListener("mouseenter", () => { ptRedoB.style.background="#2a2a2a"; ptRedoB.style.borderColor="#555"; });
    ptRedoB.addEventListener("mouseleave", () => { ptRedoB.style.background="#1e1e1e"; ptRedoB.style.borderColor="#3a3a3a"; });
    ptRedoB.addEventListener("click", () => _edRedoEdits());
    ptUndoRedoRow.appendChild(ptUndoB); ptUndoRedoRow.appendChild(ptRedoB);
    secPixels.appendChild(ptUndoRedoRow);

    function _syncPixelToolUI() {
      Object.entries(ptBtns).forEach(([k, b]) => {
        const on = edPixelTool === k;
        b.style.background = on ? "#1a2a3a" : "#1e1e1e";
        b.style.color = on ? "#7ab0ff" : "#aaa";
        b.style.borderColor = on ? "#445599" : "#3a3a3a";
      });
      ptSmudgeRow.style.display = edPixelTool === "smudge" ? "flex" : "none";
      const needsSize = ["blur", "smudge", "brush"].includes(edPixelTool);
      ptBrushRow.style.display = needsSize ? "flex" : "none";
      ptColorWrapper.style.display = ["brush", "eyedropper"].includes(edPixelTool) ? "flex" : "none";
      // Update cursor
      if (edPixelTool) {
        ca.style.cursor = "none";
        const msgMap = { blur:"Drag to blur", smudge:"Drag to smudge", brush:"Drag to paint", eyedropper:"Click to sample color" };
        hint.textContent = msgMap[edPixelTool] + " · Scroll to zoom";
      }
    }

    function _selectPixelTool(t) {
      if (edPixelTool === t) { edPixelTool = null; } // toggle off
      else {
        edPixelTool = t;
        // Mutual exclusion: disable crop only (lasso stays active in pixels mode for CA Fill)
        if (edCropMode) { edCropMode = false; syncCropToggle(); }
        if (typeof edLassoMode !== 'undefined' && edLassoMode) { edLassoMode = false; edLassoDrawing = false; edLassoCurrentPts = []; stopLassoAnts(); syncLassoToggle(); }
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

    }


    function _edSaveUndo() {
      if (!_edCvsEditsPx) return;
      // Use raw ImageData for zero-latency snapshots (no WebP encode stall)
      const ctx = _edCvsEditsPx.getContext("2d", { willReadFrequently: true });
      const snap = ctx.getImageData(0, 0, _edCvsEditsPx.width, _edCvsEditsPx.height);
      _edEditsUndoStack.push(snap);
      if (_edEditsUndoStack.length > 20) _edEditsUndoStack.shift();
      _edEditsRedoStack = []; // clear redo on new action
    }

    function _edUndoEdits() {
      if (_edEditsUndoStack.length === 0) return;
      // Save current state to redo before reverting
      if (_edCvsEditsPx) {
        const ctx = _edCvsEditsPx.getContext("2d", { willReadFrequently: true });
        _edEditsRedoStack.push(ctx.getImageData(0, 0, _edCvsEditsPx.width, _edCvsEditsPx.height));
      }
      const snap = _edEditsUndoStack.pop();
      const ctx = _edCvsEditsPx.getContext("2d");
      ctx.putImageData(snap, 0, 0);
      redraw();
    }

    function _edRedoEdits() {
      if (_edEditsRedoStack.length === 0) return;
      // Save current state to undo before going forward
      if (_edCvsEditsPx) {
        const ctx = _edCvsEditsPx.getContext("2d", { willReadFrequently: true });
        _edEditsUndoStack.push(ctx.getImageData(0, 0, _edCvsEditsPx.width, _edCvsEditsPx.height));
      }
      const snap = _edEditsRedoStack.pop();
      const ctx = _edCvsEditsPx.getContext("2d");
      ctx.putImageData(snap, 0, 0);
      redraw();
    }

    function _edApplyEyedropper(ex, ey) {
      if (!_edCvsEditsPx) return;
      const ctx = _edCvsEditsPx.getContext("2d", { willReadFrequently: true });
      const px = Math.round(ex), py = Math.round(ey);
      if (px < 0 || px >= _edCvsEditsPx.width || py < 0 || py >= _edCvsEditsPx.height) return;
      const imgData = ctx.getImageData(px, py, 1, 1).data;
      if (imgData[3] > 0) { // Not transparent
        const hex = "#" + [imgData[0], imgData[1], imgData[2]].map(x => x.toString(16).padStart(2, '0')).join('');
        edColorFg = hex;
        if (typeof ptFgPicker !== 'undefined') ptFgPicker.value = hex;
      }
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

      let lMskData = null;
      if (edLassoOps.length > 0) {
          const lMsk = buildLassoMaskCanvas(_edCvsEditsPx.width, _edCvsEditsPx.height);
          lMskData = lMsk.getContext("2d", {willReadFrequently: true}).getImageData(bx, by, bw, bh).data;
      }
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
          const lf = lMskData ? (lMskData[(row * bw + col) * 4 + 3] / 255) : 1;
          const f = dist <= r ? Math.pow(1 - dist / r, 1.2) * lf : 0;
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
      if (edLassoOps.length > 0) {
          const lMsk = buildLassoMaskCanvas(_edCvsEditsPx.width, _edCvsEditsPx.height);
          sCtx.globalCompositeOperation = "destination-in";
          sCtx.drawImage(lMsk, curPatchX, curPatchY, d, d, 0, 0, d, d);
      }
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
        edLassoOps = []; edLassoCurrentPts = []; edLassoDrawing = false; edLassoIsPaint = false;
        edLassoMode = false; _lassoCursorNorm = null; _lassoChanged();
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
      _lassoChanged(); _lassoCursorNorm=null; stopLassoAnts();
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
              (edPanelMode !== "pixels");
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
          const drawBrushCursor = edPixelTool !== "eyedropper";
          
          if (drawBrushCursor) {
            ctx.save();
            ctx.strokeStyle = edPixelTool === "blur" ? "rgba(100,180,255,0.7)" : (edPixelTool === "smudge" ? "rgba(255,180,100,0.7)" : "rgba(255,255,255,0.8)");
            ctx.lineWidth = 1.5; ctx.setLineDash([4,3]);
            ctx.beginPath(); ctx.arc(_edBrushPos.cx, _edBrushPos.cy, rPx, 0, Math.PI*2); ctx.stroke();
            ctx.setLineDash([]);
            ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 0.5;
            ctx.beginPath(); ctx.moveTo(_edBrushPos.cx-6,_edBrushPos.cy); ctx.lineTo(_edBrushPos.cx+6,_edBrushPos.cy); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(_edBrushPos.cx,_edBrushPos.cy-6); ctx.lineTo(_edBrushPos.cx,_edBrushPos.cy+6); ctx.stroke();
            ctx.restore();
          } else {
            ctx.save();
            ctx.strokeStyle = "rgba(0,0,0,0.8)"; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(_edBrushPos.cx, _edBrushPos.cy); ctx.lineTo(_edBrushPos.cx-12, _edBrushPos.cy-12); ctx.stroke();
            ctx.fillStyle = edColorFg; ctx.beginPath(); ctx.arc(_edBrushPos.cx-12, _edBrushPos.cy-12, 4, 0, Math.PI*2); ctx.fill(); ctx.stroke();
            ctx.restore();
          }
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
        if (hasLasso && !edLassoIsPaint) { t.lassoOps = edLassoOps; if (edLassoInverted) t.lassoInverted = true; }
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
          edLassoIsPaint = false;
          _lassoChanged();
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
        } else if (edPixelTool === "brush") {
          const prevPt = _edBrushPts.length > 0 ? _edBrushPts[_edBrushPts.length - 1] : null;
          if (prevPt) {
            const ctx = _edCvsEditsPx.getContext("2d");
            ctx.lineCap = "round"; ctx.lineJoin = "round";
            ctx.strokeStyle = edColorFg; ctx.lineWidth = rPx * 2;
            if (edLassoOps.length > 0) {
                // Fast GPU path: compile lasso as Path2D, clip natively — no temp canvas needed
                const pw = _edCvsEditsPx.width, ph = _edCvsEditsPx.height;
                const clipPath = _getLassoClipPath(pw, ph);
                ctx.save();
                if (edLassoInverted) {
                  const inv = new Path2D(); inv.rect(0, 0, pw, ph); inv.addPath(clipPath);
                  ctx.clip(inv, "evenodd");
                } else {
                  ctx.clip(clipPath);
                }
                ctx.lineCap = "round"; ctx.lineJoin = "round";
                ctx.strokeStyle = edColorFg; ctx.lineWidth = rPx * 2;
                ctx.beginPath(); ctx.moveTo(prevPt.x, prevPt.y); ctx.lineTo(epx, epy); ctx.stroke();
                ctx.restore();
            } else {
                ctx.beginPath(); ctx.moveTo(prevPt.x, prevPt.y); ctx.lineTo(epx, epy); ctx.stroke();
            }
          } else {
            const ctx = _edCvsEditsPx.getContext("2d");
            ctx.fillStyle = edColorFg;
            if (edLassoOps.length > 0) {
                // Fast GPU path: Path2D clip for first dot too
                const pw = _edCvsEditsPx.width, ph = _edCvsEditsPx.height;
                const clipPath = _getLassoClipPath(pw, ph);
                ctx.save();
                if (edLassoInverted) {
                  const inv = new Path2D(); inv.rect(0, 0, pw, ph); inv.addPath(clipPath);
                  ctx.clip(inv, "evenodd");
                } else {
                  ctx.clip(clipPath);
                }
                ctx.fillStyle = edColorFg;
                ctx.beginPath(); ctx.arc(epx, epy, rPx, 0, Math.PI * 2); ctx.fill();
                ctx.restore();
            } else {
                ctx.beginPath(); ctx.arc(epx, epy, rPx, 0, Math.PI * 2); ctx.fill();
            }
          }
        } else if (edPixelTool === "smudge") {
          const prevPt = _edBrushPts.length > 0 ? _edBrushPts[_edBrushPts.length - 1] : null;
          if (prevPt) _edApplySmudge(prevPt, { x: epx, y: epy }, rPx);
        } else if (edPixelTool === "eyedropper") {
           _edApplyEyedropper(epx, epy);
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
          if (e.shiftKey) {
            // Shift held: lock to a straight snapped segment from anchor
            if (_lassoShiftAnchorIdx < 0) _lassoShiftAnchorIdx = edLassoCurrentPts.length - 1;
            const anchor = edLassoCurrentPts[Math.max(0, _lassoShiftAnchorIdx)];
            const snapped = _snapOrtho45(anchor, cNx, cNy);
            edLassoCurrentPts = edLassoCurrentPts.slice(0, _lassoShiftAnchorIdx + 1);
            edLassoCurrentPts.push(snapped); // live preview endpoint
          } else if (_lassoShiftAnchorIdx >= 0) {
            // Shift just released: snapped endpoint already committed — just exit shift mode
            _lassoShiftAnchorIdx = -1;
            // No push: the committed snapped point is the pivot; free drawing resumes next move
          } else {
            // Normal free drawing
            edLassoCurrentPts.push({ x: cNx, y: cNy });
          }
          redraw(); return;
        }
        if (edLassoTool === "polygonal" && edLassoCurrentPts.length > 0) {
          const last = edLassoCurrentPts[edLassoCurrentPts.length - 1];
          _lassoCursorNorm = e.shiftKey ? _snapOrtho45(last, cNx, cNy) : { x: cNx, y: cNy };
          redraw(); return;
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
        const startX = (cx - (imgCX - dw/2)) * pxScale;
        const startY = (cy - (imgCY - dh/2)) * pxScale;
        _edBrushPts = [{ x: startX, y: startY }];
        
        if (edPixelTool === "brush") {
          const rPx = parseFloat(ptBrSlider.value) * pxScale;
          const ctx = _edCvsEditsPx.getContext("2d");
          if (edLassoOps.length > 0) {
              // Fast GPU path: Path2D clip for mousedown initial dot
              const pw = _edCvsEditsPx.width, ph = _edCvsEditsPx.height;
              const clipPath = _getLassoClipPath(pw, ph);
              const ctx2 = _edCvsEditsPx.getContext("2d");
              ctx2.save();
              if (edLassoInverted) {
                const inv = new Path2D(); inv.rect(0, 0, pw, ph); inv.addPath(clipPath);
                ctx2.clip(inv, "evenodd");
              } else {
                ctx2.clip(clipPath);
              }
              ctx2.fillStyle = edColorFg;
              ctx2.beginPath(); ctx2.arc(startX, startY, rPx, 0, Math.PI * 2); ctx2.fill();
              ctx2.restore();
          } else {
              ctx.fillStyle = edColorFg; ctx.beginPath();
              ctx.arc(startX, startY, rPx, 0, Math.PI * 2); ctx.fill();
          }
          redraw();
        } else if (edPixelTool === "eyedropper") {
          _edApplyEyedropper(startX, startY);
        }
        return;
      }
      // ── lasso start / polygonal click ──
      if (edLassoMode) {
        const r = cvs.getBoundingClientRect();
        const cx = e.clientX - r.left, cy = e.clientY - r.top;
        const { nx, ny } = cropPxToNorm(cx, cy);
        const cNx = Math.max(0, Math.min(1, nx)), cNy = Math.max(0, Math.min(1, ny));
        if (edLassoTool === "freehand") {
          edLassoCurrentPts = [{ x: cNx, y: cNy }]; edLassoDrawing = true; _lassoShiftAnchorIdx = -1; ca.style.cursor = 'crosshair';
        } else {
          if (edLassoCurrentPts.length >= 3) {
            const { dw: _cdw, dh: _cdh } = _imgRenderDims();
            const p0c = _normToCanvas(edLassoCurrentPts[0].x, edLassoCurrentPts[0].y, _cdw, _cdh);
            const d = Math.hypot(cx - p0c.cx, cy - p0c.cy); // distance in canvas pixels
            if (d < 10) { commitLassoShape(edLassoCurrentPts, e); return; }
          }
          edLassoCurrentPts.push(
            e.shiftKey && edLassoCurrentPts.length > 0
              ? _snapOrtho45(edLassoCurrentPts[edLassoCurrentPts.length - 1], cNx, cNy)
              : { x: cNx, y: cNy }
          ); redraw();
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
      // Ctrl+D: deselect
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault(); e.stopImmediatePropagation();
        edLassoOps = []; edLassoIsPaint = false; edLassoInverted = false; _lassoChanged();
        if (typeof syncLassoInvertBtn !== 'undefined') syncLassoInvertBtn();
        requestInpaintPreview(); redraw(); return;
      }
      // Ctrl+Shift+Z: redo pixel edits
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && e.shiftKey) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (typeof _edRedoEdits !== 'undefined') _edRedoEdits(); return;
      }
      // Ctrl+Z: undo pixel edits
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey && edPixelTool && _edEditsUndoStack.length > 0) {
        e.preventDefault(); e.stopImmediatePropagation();
        _edUndoEdits(); return;
      }
      // Ctrl+I: Invert selection
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") {
        e.preventDefault(); e.stopImmediatePropagation();
        if (edLassoOps.length > 0) {
          edLassoInverted = !edLassoInverted; _lassoChanged();
          if (typeof syncLassoInvertBtn !== 'undefined') syncLassoInvertBtn();
          requestInpaintPreview(); redraw();
        }
        return;
      }
      // Photoshop shortcuts in Edit Pixels mode
      if (edPanelMode === "pixels" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "b") { _selectPixelTool("blur"); e.preventDefault(); }
        if (k === "s") { _selectPixelTool("smudge"); e.preventDefault(); }
        if (k === "a") { _selectPixelTool("eyedropper"); e.preventDefault(); } // CA mapped to eyedropper slot for now
        if (k === "l") { toggleLassoTool("freehand"); e.preventDefault(); }
        if (k === "p") { toggleLassoTool("polygonal"); e.preventDefault(); }
        if (k === "d") { edColorFg = "#ffffff"; edColorBg = "#000000"; if(typeof ptFgPicker !== 'undefined') {ptFgPicker.value=edColorFg; ptBgPicker.value=edColorBg;} }
        if (k === "x") { const t = edColorFg; edColorFg = edColorBg; edColorBg = t; if(typeof ptFgPicker !== 'undefined') {ptFgPicker.value=edColorFg; ptBgPicker.value=edColorBg;} }
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
        _lassoChanged(); stopLassoAnts();
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
    await root._pasteFiles(files);
  };

  root._pasteFiles = async function (files) {
    if (files.length) {
      if (typeof flashStatusMessage === "function") {
        flashStatusMessage(`Pasted ${files.length} image${files.length > 1 ? "s" : ""}`);
      }
      if (selectedIdx !== null && selectedIdx >= 0 && selectedIdx < items.length) {
        // Insert AFTER the selected image
        await addFiles(files, selectedIdx + 1);
      } else {
        await addFiles(files);
      }
    }
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
    const tabEdit = mkTab("\u270F Edit Image", false, "#7ab0ff");
    const tabPixels = mkTab("\uD83C\uDFA8 Edit Pixels", false, "#ffaa44");
    const tabMask = mkTab("\u25D0 Mask", true, "#7fff7f");
    function _saveMaskAndSwitch(targetMode) {
      // Save mask data + current transform snapshot before switching
      const fn = items[curIdx]?.filename;
      if (fn) {
        if (!cropMap[fn]) cropMap[fn] = {};
        cropMap[fn].maskOps = mMaskOps.length > 0 ? [...mMaskOps] : undefined;
        cropMap[fn].maskInverted = mMaskInverted || undefined;
        const ct = cropMap[fn];
        cropMap[fn].maskXform = { ox: ct.ox||0, oy: ct.oy||0, scale: ct.scale||1, flipH: !!ct.flipH, flipV: !!ct.flipV, rotate: ct.rotate||0, cx: ct.cx, cy: ct.cy, cw: ct.cw, ch: ct.ch };
        if (!cropMap[fn].maskOps) delete cropMap[fn].maskOps;
        if (!cropMap[fn].maskInverted) delete cropMap[fn].maskInverted;
        if (!cropMap[fn].maskOps) delete cropMap[fn].maskXform;
        persistCropData();
      }
      close();
      openCropEditor(curIdx, true, targetMode);
    }
    tabEdit.addEventListener("click", () => _saveMaskAndSwitch("edit"));
    tabPixels.addEventListener("click", () => _saveMaskAndSwitch("pixels"));
    hdr.appendChild(tabEdit);
    hdr.appendChild(tabPixels);
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

    // ── Mask refinement tools (blur/smudge affect mask, not image) ──
    pnlBody.appendChild(mkSec("MASK REFINE"));
    const imgToolRow = document.createElement("div");
    imgToolRow.style.cssText = `display:flex;gap:${_r(4)}px;flex-wrap:wrap;`;
    [["blur","💧 Blur"],["smudge","👆 Smudge"]].forEach(([k,lbl]) => {
      const b = mkBtn2(lbl, false);
      b.style.flex = "1 0 auto";
      b.addEventListener("click", () => _selectTool(k));
      toolBtns[k] = b; imgToolRow.appendChild(b);
    });
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
    // ── 3-layer canvas stack ──────────────────────────────────────────
    // Layer 0 (cvsBase):  checkerboard + image + dim outside + frame border
    // Layer 1 (cvsMask):  committed mask overlay at user-set opacity
    // Layer 2 (cvsTool):  active stroke preview + brush cursor + lasso preview
    // Only the tool layer redraws on mousemove → ~80% fewer draw calls.
    const _mkCvs = (pe) => {
      const c = document.createElement("canvas");
      c.style.cssText = `position:absolute;inset:0;width:100%;height:100%;${pe ? '' : 'pointer-events:none;'}`;
      ca.appendChild(c);
      return c;
    };
    const cvsBase = _mkCvs(false);
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
    let _dirtyBase = true, _dirtyMask = true;
    // ── Undo / Redo stacks ─────────────────────────────────────────────
    let mUndoStack = [];  // popped ops for redo
    // ── Default brush mode for shortcuts ────────────────────────────────
    let mDefaultBrushMode = "add"; // "add" for brush (B), "sub" for eraser (E)
    // ── Cached brush tip ───────────────────────────────────────────────
    let _tipCache = null; // { radius, color, canvas }
    // ── Mask raster state (for blur/smudge on mask) ────────────────────
    let _maskRaster = null;       // offscreen canvas with rasterized mask
    let _maskRasterUndo = null;   // single-level undo snapshot (dataUrl)

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
    // (click outside overlay intentionally disabled — use the close button)
    cancelBtn.addEventListener("click", close);

    // ── Mask canvas helpers ──
    let mBaseFrameW = 300, mBaseFrameH = 300; // before zoom
    function _syncFrame() {
      const r = ca.getBoundingClientRect();
      const rw = Math.round(r.width), rh = Math.round(r.height);
      // Sync all 3 canvases to container size
      for (const c of [cvsBase, cvsMask, cvsTool]) {
        if (c.width !== rw || c.height !== rh) { c.width = rw; c.height = rh; _dirtyBase = true; _dirtyMask = true; }
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


    // ── Mask Raster Tool Engines ────────────────────────────────────────────────
    // Blur/Smudge operate on a rasterized copy of the mask bitmap.
    // When the stroke completes, the raster replaces all vector mask ops.

    function _ensureMaskRaster() {
      if (_maskRaster) return;
      const sz = Math.min(Math.max(mNatW, mNatH), 2048);
      const w = Math.round(mNatW * (sz / Math.max(mNatW, mNatH)));
      const h = Math.round(mNatH * (sz / Math.max(mNatW, mNatH)));
      _maskRaster = _buildMaskCanvas(w, h);
    }

    function _saveMaskRasterUndo() {
      if (!_maskRaster) return;
      _maskRasterUndo = _maskRaster.toDataURL("image/png");
    }

    function _undoMaskRaster() {
      if (!_maskRasterUndo || !_maskRaster) return;
      const img = new Image();
      img.onload = () => {
        const ctx = _maskRaster.getContext("2d");
        ctx.clearRect(0, 0, _maskRaster.width, _maskRaster.height);
        ctx.drawImage(img, 0, 0);
        _commitMaskRaster();
        _dirtyMask = true; mRedraw();
      };
      img.src = _maskRasterUndo;
      _maskRasterUndo = null;
    }

    /** Collapse mask raster back into mMaskOps as a single raster op */
    function _commitMaskRaster() {
      if (!_maskRaster) return;
      const dataUrl = _maskRaster.toDataURL("image/png");
      // Replace all ops with a single raster-based fill op
      const cvs = document.createElement("canvas");
      cvs.width = _maskRaster.width; cvs.height = _maskRaster.height;
      cvs.getContext("2d").drawImage(_maskRaster, 0, 0);
      mMaskOps = [{ type: "fill", mode: "add", _canvas: cvs }];
      mMaskInverted = false; // raster already includes inversion
      mUndoStack = [];
    }

    // ── Blur on mask: separable box blur O(N·R) with soft circular falloff ──
    function _applyMaskBlur(cx, cy, r) {
      if (!_maskRaster) return;
      const w = _maskRaster.width, h = _maskRaster.height;
      const ctx = _maskRaster.getContext("2d", { willReadFrequently: true });
      const bx = Math.max(0, Math.floor(cx - r)), by = Math.max(0, Math.floor(cy - r));
      const bw = Math.min(w - bx, Math.ceil(r * 2)), bh = Math.min(h - by, Math.ceil(r * 2));
      if (bw <= 0 || bh <= 0) return;
      const origData = ctx.getImageData(bx, by, bw, bh);
      const origD = new Uint8ClampedArray(origData.data);
      const imgData = ctx.getImageData(bx, by, bw, bh);
      const d = imgData.data;
      const tmp = new Uint8ClampedArray(d.length);
      const rad = Math.max(1, Math.floor(r * 0.25));
      // Horizontal pass (grayscale — only R channel matters in mask)
      for (let row = 0; row < bh; row++) {
        let rs = 0, cnt = 0;
        for (let i = -rad; i <= rad; i++) {
          const xi = Math.max(0, Math.min(bw - 1, i));
          rs += d[(row * bw + xi) * 4]; cnt++;
        }
        for (let col = 0; col < bw; col++) {
          const po = (row * bw + col) * 4;
          const v = rs / cnt;
          tmp[po] = v; tmp[po+1] = v; tmp[po+2] = v; tmp[po+3] = 255;
          const ri2 = Math.max(0, col - rad), ai2 = Math.min(bw - 1, col + rad + 1);
          rs += d[(row * bw + ai2) * 4] - d[(row * bw + ri2) * 4];
        }
      }
      // Vertical pass
      for (let col = 0; col < bw; col++) {
        let rs = 0, cnt = 0;
        for (let i = -rad; i <= rad; i++) {
          const yi = Math.max(0, Math.min(bh - 1, i));
          rs += tmp[(yi * bw + col) * 4]; cnt++;
        }
        for (let row = 0; row < bh; row++) {
          const po = (row * bw + col) * 4;
          const v = rs / cnt;
          d[po] = v; d[po+1] = v; d[po+2] = v; d[po+3] = 255;
          const ri2 = Math.max(0, row - rad), ai2 = Math.min(bh - 1, row + rad + 1);
          rs += tmp[(ai2 * bw + col) * 4] - tmp[(ri2 * bw + col) * 4];
        }
      }
      // Soft circular blend with original
      for (let row = 0; row < bh; row++) {
        for (let col = 0; col < bw; col++) {
          const dist = Math.hypot(col - (cx - bx), row - (cy - by));
          const f = dist <= r ? Math.pow(1 - dist / r, 1.2) : 0;
          const i = (row * bw + col) * 4;
          const v = origD[i] * (1 - f) + d[i] * f;
          d[i] = v; d[i+1] = v; d[i+2] = v;
        }
      }
      ctx.putImageData(imgData, bx, by);
      _dirtyMask = true;
    }

    // ── Smudge on mask: ping-pong buffer pixel drag ─────────────────────────
    let _smudgeBuf = null;
    function _applyMaskSmudge(lastPos, currPos, r) {
      if (!_maskRaster || !lastPos) return;
      const ctx = _maskRaster.getContext("2d");
      const w = _maskRaster.width, h = _maskRaster.height;
      if (!_smudgeBuf || _smudgeBuf.width !== w || _smudgeBuf.height !== h) {
        _smudgeBuf = document.createElement("canvas");
        _smudgeBuf.width = w; _smudgeBuf.height = h;
      }
      const bCtx = _smudgeBuf.getContext("2d");
      bCtx.clearRect(0, 0, w, h);
      bCtx.save();
      bCtx.beginPath(); bCtx.arc(currPos.x, currPos.y, r, 0, Math.PI * 2); bCtx.clip();
      const dx = currPos.x - lastPos.x, dy = currPos.y - lastPos.y;
      bCtx.drawImage(_maskRaster, dx, dy);
      bCtx.restore();
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
      _dirtyMask = true;
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
    // Layer 1 (cvsMask): committed mask overlay
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
    // Layer 2 (cvsTool): active stroke + brush cursor + lasso preview
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
      // Init mask raster for mask refinement tools
      if (t === "blur" || t === "smudge") _ensureMaskRaster();
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
        const pxScale = _maskRaster ? _maskRaster.width / mFrameW : 1;
        const epx = (cx - fx) * pxScale, epy = (cy - fy) * pxScale;
        const rPx = parseFloat(brushSlider.value) * pxScale;
        if (mTool === "blur") {
          _applyMaskBlur(epx, epy, rPx);
        } else {
          const prevPt = mBrushPts.length > 0 ? mBrushPts[mBrushPts.length - 1] : null;
          if (prevPt) _applyMaskSmudge(prevPt, { x: epx, y: epy }, rPx);
        }
        mBrushPts.push({ x: epx, y: epy });
        _commitMaskRaster();
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
        _ensureMaskRaster(); _saveMaskRasterUndo();
        mBrushDrawing = true;
        const fx2 = mFrameCX - mFrameW / 2, fy2 = mFrameCY - mFrameH / 2;
        const pxScale = _maskRaster.width / mFrameW;
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
          _dirtyBase = true; _dirtyMask = true; mRedraw();
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
        _commitMaskRaster();
        _dirtyMask = true; mRedraw(); return;
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
          if ((mTool === "blur" || mTool === "smudge") && _maskRasterUndo) { _undoMaskRaster(); }
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
      // Pixel edits removed from mask editor — now only in Edit Image modal
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
      _maskRaster = null; _maskRasterUndo = null; _smudgeBuf = null; // reset mask raster
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
      _dirtyBase = true; _dirtyMask = true; mRedraw();
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
    let lastPasteTs = 0;
    function tryDebouncePaste() {
      const now = Date.now();
      if (now - lastPasteTs < 300) return false;
      lastPasteTs = now;
      return true;
    }

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
      
      // 1. If any node has an active internal selection (blue border thumbnail), it's the target!
      for (const n of milNodes) {
        if (n._milDomWidget?.element?.querySelector(".mil-selected")) {
          return n;
        }
      }

      // 2. Otherwise fallback to ComfyUI's standard node selection
      const selected = milNodes.filter(n =>
        n.is_selected ||
        (app.canvas?.selected_nodes && app.canvas.selected_nodes[n.id] !== undefined)
      );
      if (selected.length === 1) return selected[0];
      return null;
    }

    // ── Capture-phase keydown listener (Copy/Cut/Undo/Delete) ───
    window.addEventListener("keydown", async (e) => {
      const key = e.key.toLowerCase();
      
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;

      // Only block if OUR crop/mask editor overlay is actually open
      const overlayOpen = !!document.querySelector(".mil-crop-overlay, .mil-mask-overlay, .mil-overlay");
      if (overlayOpen) return;

      const node = getTargetNode();
      if (!node) return;

      const el = node._milDomWidget?.element;
      if (!el) return;

      // Intercept Delete/Backspace on thumbnails
      if ((key === "delete" || key === "backspace") && el._hasSelection && el._hasSelection()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (el._removeSelectedItems) el._removeSelectedItems();
        return;
      }

      if (!(e.ctrlKey || e.metaKey)) return;
      if (key !== "c" && key !== "x" && key !== "z") return;

      if ((key === "c" || key === "x") && !(el._hasSelection && el._hasSelection())) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      if (key === "c") {
        // Fast path: use pre-cached blob (rendered when thumbnail was selected)
        // so we can write to clipboard while the user gesture is still alive.
        const cachedBlob = el._getCachedBlob?.();
        if (cachedBlob) {
          try {
            await navigator.clipboard.write([
              new ClipboardItem({ "image/png": cachedBlob })
            ]);
            if (typeof el.flashStatusMessage === "function") el.flashStatusMessage("Image copied via hotkey");
            const selThumb = el.querySelector?.(".mil-selected");
            if (selThumb) {
              selThumb.style.borderColor = "#5f5";
              setTimeout(() => { selThumb.style.borderColor = ""; }, 600);
            }
          } catch (err) {
            console.warn("[MIL] Cached clipboard write failed, trying full path:", err);
            if (el._copySelected) await el._copySelected();
          }
        } else {
          if (el._copySelected) await el._copySelected();
        }
        return;
      }

      if (key === "x") {
        if (el._cutSelected) await el._cutSelected();
        return;
      }

      if (key === "z") {
        if (el._undo) el._undo();
        return;
      }
    }, { capture: true });

    // ── Capture-phase paste listener ───
    window.addEventListener("paste", async (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;

      const overlayOpen = !!document.querySelector(".mil-crop-overlay, .mil-mask-overlay, .mil-overlay");
      if (overlayOpen) return;

      const node = getTargetNode();
      if (!node) return;
      
      const el = node._milDomWidget?.element;
      if (!el) return;

      // Extract image files natively (bypasses permission prompts)
      const items = Array.from(e.clipboardData?.items || []);
      const imgItems = items.filter(it => it.type.startsWith("image/"));
      if (imgItems.length > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        
        const files = [];
        for (const item of imgItems) {
           const f = item.getAsFile();
           if (f) {
             const renamed = new File([f], `pasted_${Date.now()}_${Math.floor(Math.random()*1000)}.png`, { type: f.type });
             files.push(renamed);
           }
        }
        
        if (files.length > 0) {
          if (!tryDebouncePaste()) return;
          if (el._pasteFiles) await el._pasteFiles(files);
          else if (el._addFiles) await el._addFiles(files);
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
      const initH = NODE_HEADER_H + NODE_SLOT_H * 3 + NODE_PADDING_V + DROPZONE_H + GAP + 8;
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
        const hiddenNames = ["image_list", "crop_data", "selected_items"];
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
        ["image_list", "crop_data", "selected_items", "custom_bg_hex"].forEach(name => {
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

      // Re-render thumbnails when master_image is connected/disconnected
      node.onConnectionsChange = function (type, index, connected, linkInfo) {
        // type 1 = input, type 2 = output
        if (type === 1) {
          const inp = node.inputs?.[index];
          if (inp && inp.name === "master_image") {
            // Trigger the same flow as aspect_ratio change
            node._milDomWidget?.element?._onAspectRatioChange?.();
          }
        }
      };

      // After execution, master_image source node will have updated imgs —
      // re-render thumbnails so they pick up the master's aspect ratio.
      const origOnExecuted = node.onExecuted;
      node.onExecuted = function (output) {
        origOnExecuted?.apply(this, arguments);
        node._milDomWidget?.element?._onAspectRatioChange?.();
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
