/**
 * ComfyUI-Multi-Image-Loader  –  Frontend Extension v1.9
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

  async function renderCropPreviews() {
    if (items.length === 0) return;
    // Get reference dims (aspect_ratio-aware)
    let refW, refH;
    try {
      const dims = await computeRefDims();
      refW = dims.refW; refH = dims.refH;
    } catch { return; }

    for (const item of items) {
      const t = cropMap[item.filename];
      if (!t) { item.previewSrc = undefined; continue; }
      const bgRaw = t.bg ?? getEffectiveBgColor();
      const isInpaint = bgRaw === "telea" || bgRaw === "navier-stokes";

      if (isInpaint) {
        // Use Python server to generate thumbnail (exact same pipeline as queue time)
        try {
          const resp = await fetch("/multi_image_loader/preview", {
            method: "POST",
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify({filename: item.filename, transform: t, refW, refH})
          });
          if (resp.ok) {
            const { dataUrl } = await resp.json();
            item.previewSrc = dataUrl;
          } else {
            console.warn("[MIL] inpaint thumbnail failed:", item.filename, resp.status);
          }
        } catch(e) {
          console.warn("[MIL] inpaint thumbnail error:", item.filename, e);
        }
        continue;
      }

      // Solid-fill path — JS canvas rendering
      try {
        const el = await loadImage(item.src);
        const cvs = document.createElement("canvas");
        cvs.width = refW; cvs.height = refH;
        const ctx = cvs.getContext("2d");
        const bgC = /^#[0-9a-fA-F]{6}$/.test(bgRaw) ? bgRaw : getEffectiveBgColor();
        ctx.fillStyle = bgC; ctx.fillRect(0, 0, refW, refH);

        const ox = t.ox ?? 0, oy = t.oy ?? 0, sc = t.scale ?? 1;
        const fH = !!(t.flipH), fV = !!(t.flipV), rot = (t.rotate || 0) * Math.PI / 180;
        const cosA = Math.abs(Math.cos(rot)), sinA = Math.abs(Math.sin(rot));
        // Pre-crop: use source rect from crop region
        const hasCR = t.cx != null && (t.cx > 0 || t.cy > 0 || t.cw < 1 || t.ch < 1);
        const srcX = hasCR ? t.cx * el.naturalWidth  : 0;
        const srcY = hasCR ? t.cy * el.naturalHeight : 0;
        const srcW = hasCR ? t.cw * el.naturalWidth  : el.naturalWidth;
        const srcH = hasCR ? t.ch * el.naturalHeight : el.naturalHeight;
        const rW = srcW * cosA + srcH * sinA;
        const rH = srcW * sinA + srcH * cosA;
        const bf = Math.min(refW / rW, refH / rH);
        const eff = bf * sc;
        const dw = srcW * eff, dh = srcH * eff;

        ctx.save();
        ctx.translate(refW / 2 + ox * refW, refH / 2 + oy * refH);
        ctx.rotate(rot);
        ctx.scale(fH ? -1 : 1, fV ? -1 : 1);
        ctx.drawImage(el, srcX, srcY, srcW, srcH, -dw / 2, -dh / 2, dw, dh);
        // Lasso mask overlay for thumbnail
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

        item.previewSrc = cvs.toDataURL("image/jpeg", 0.92);
      } catch (e) {
        console.warn("[MIL] crop preview error:", item.filename, e);
      }
    }
    previewActive = true;
    render();
  }

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
      cropBtn.title = "Edit crop";
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

      // ── copy button (top-right, next to crop btn) ──────────────────────
      const copyBtn = document.createElement("button");
      copyBtn.textContent = "⎘";
      copyBtn.title = "Copy image";
      copyBtn.style.cssText = `
        position:absolute;top:2px;right:34px;
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
      });
      wrapper.addEventListener("mouseleave", () => {
        removeBtn.style.opacity = "0";
        cropBtn.style.opacity   = "0";
        copyBtn.style.opacity   = "0";
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

      // ── double-click → open crop editor ──────────────────────────────────
      wrapper.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        openCropEditor(idx);
      });

      wrapper.appendChild(img);
      wrapper.appendChild(badge);
      wrapper.appendChild(copyBtn);
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
      // Get reference dimensions (aspect_ratio-aware)
      const { refW: targetW, refH: targetH } = await computeRefDims();

      // When aspect_ratio is set, render ALL images; otherwise start from idx=1
      const startIdx = ar !== "none" ? 0 : 1;

      for (let i = startIdx; i < items.length; i++) {
        try {
          const srcImg = await loadImage(items[i].src);
          const canvas = document.createElement("canvas");
          canvas.width  = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext("2d");

          if (mode === "letterbox") {
            // Check for per-image bg override from cropMap
            const itemBg = cropMap[items[i].filename]?.bg;
            ctx.fillStyle = (itemBg && /^#[0-9a-fA-F]{6}$/.test(itemBg)) ? itemBg : getEffectiveBgColor();
            ctx.fillRect(0, 0, targetW, targetH);
            const scale = Math.min(targetW / srcImg.naturalWidth, targetH / srcImg.naturalHeight);
            const dw = srcImg.naturalWidth  * scale;
            const dh = srcImg.naturalHeight * scale;
            const dx = (targetW - dw) / 2;
            const dy = (targetH - dh) / 2;
            ctx.drawImage(srcImg, dx, dy, dw, dh);
          } else { // crop
            const scale = Math.max(targetW / srcImg.naturalWidth, targetH / srcImg.naturalHeight);
            const sw = targetW / scale;
            const sh = targetH / scale;
            const sx = (srcImg.naturalWidth  - sw) / 2;
            const sy = (srcImg.naturalHeight - sh) / 2;
            ctx.drawImage(srcImg, sx, sy, sw, sh, 0, 0, targetW, targetH);
          }

          items[i].previewSrc = canvas.toDataURL("image/jpeg", 0.92);
        } catch (e) {
          console.warn(`[MIL] Preview failed for ${items[i].filename}:`, e);
        }
      }

      previewActive = true;
      render(); // thumbnails now use previewSrc
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
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const t = cropMap[item.filename];
      if (!t) continue;  // no transform — handled by renderFitPreviews
      try {
        const bgRaw = t.bg ?? getEffectiveBgColor();
        const isInpaint = bgRaw === "telea" || bgRaw === "navier-stokes";
        if (isInpaint) {
          // Inpaint path — Python server renders this
          const resp = await fetch("/multi_image_loader/preview", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({filename: item.filename, transform: t, refW, refH})
          });
          if (resp.ok) {
            const { dataUrl } = await resp.json();
            item.previewSrc = dataUrl;
          }
        } else {
          // Solid-fill path — canvas rendering
          const el = await loadImage(item.src);
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
          ctx.restore();
          item.previewSrc = cvs.toDataURL("image/jpeg", 0.92);
        }
      } catch(e) {
        console.warn(`[MIL] renderCropPreviews failed for ${item.filename}:`, e);
      }
    }
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
  function openCropEditor(startIdx) {
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
    dlg.className = "mil-crop-enter";
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
    const titleEl = document.createElement("span");
    titleEl.style.cssText = `color:#ccc;font-size:${_fs13};font-weight:600;flex:1;`;
    titleEl.textContent = "\u2702  Crop Editor";
    const prevB = mkB("\u2190 Prev"); const cntEl = document.createElement("span");
    cntEl.style.cssText = `color:#555;font-size:${_fs11};min-width:${Math.round(52*uiScale)}px;text-align:center;`;
    const nextB = mkB("Next \u2192"); const closeB = mkB("\u2715 Close");
    hdr.appendChild(titleEl); hdr.appendChild(prevB); hdr.appendChild(cntEl);
    hdr.appendChild(nextB); hdr.appendChild(closeB);

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
    applyB.textContent = "\u2713 Apply";
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
    function drawLassoOverlay(ctx) {
      if (!edLassoMode) return; // hide ants when lasso tool is off
      const fx = frameCX - frameW / 2, fy = frameCY - frameH / 2;
      // Marching ants along composite mask boundary (cached)
      if (edLassoOps.length > 0) {
        const mw = Math.ceil(frameW), mh = Math.ceil(frameH);
        if (mw > 0 && mh > 0) {
          getLassoMaskCanvas(mw, mh); // ensure edge cache is for frame dims
          if (_cachedEdgePixels && _cachedEdgePixels.length > 0) {
            ctx.save();
            ctx.strokeStyle = '#ff9f43'; ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 5]); ctx.lineDashOffset = -edLassoAntsOffset;
            ctx.beginPath();
            for (let i = 0; i < _cachedEdgePixels.length; i += 2) {
              ctx.rect(fx + _cachedEdgePixels[i], fy + _cachedEdgePixels[i+1], 1, 1);
            }
            ctx.stroke();
            ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineDashOffset = -edLassoAntsOffset + 3;
            ctx.stroke();
            ctx.setLineDash([]); ctx.restore();
          }
        }
      }
      // Current in-progress path
      if (edLassoCurrentPts.length >= 1) {
        const pts = edLassoCurrentPts.map(p => ({ px: fx + p.x * frameW, py: fy + p.y * frameH }));
        ctx.save(); ctx.strokeStyle = '#ffcc00'; ctx.lineWidth = 1.5;
        if (edLassoTool === "freehand") {
          if (pts.length >= 2) {
            ctx.beginPath(); ctx.moveTo(pts[0].px, pts[0].py);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].px, pts[i].py);
            ctx.stroke();
          }
        } else {
          ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(pts[0].px, pts[0].py);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].px, pts[i].py);
          if (_lassoCursorNorm) ctx.lineTo(fx + _lassoCursorNorm.x * frameW, fy + _lassoCursorNorm.y * frameH);
          ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = '#ffcc00';
          for (const p of pts) { ctx.beginPath(); ctx.arc(p.px, p.py, 3, 0, Math.PI * 2); ctx.fill(); }
          if (_lassoCursorNorm && pts.length >= 3) {
            const dist = Math.hypot((_lassoCursorNorm.x - edLassoCurrentPts[0].x) * frameW, (_lassoCursorNorm.y - edLassoCurrentPts[0].y) * frameH);
            if (dist < 10) { ctx.strokeStyle = '#44ff44'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(pts[0].px, pts[0].py, 6, 0, Math.PI * 2); ctx.stroke(); }
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
    function cropPxToNorm(px, py) {
      const fx = frameCX - frameW / 2, fy = frameCY - frameH / 2;
      return { nx: (px - fx) / frameW, ny: (py - fy) / frameH };
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

      // Snap to center lines first (highest priority when near center)
      const snapX_center = Math.abs(dOX) < SNAP;
      const snapY_center = Math.abs(dOY) < SNAP;

      // Snap X: center → left edge → right edge
      if (snapX_center) {
        dOX = 0;                  // snap to horizontal center
      } else {
        const dL = imgL - frmL, dR = imgR - frmR;
        if (Math.abs(dL) < SNAP && (Math.abs(dL) <= Math.abs(dR))) {
          dOX = frmL + hW;       // snap left edge flush
        } else if (Math.abs(dR) < SNAP) {
          dOX = frmR - hW;       // snap right edge flush
        }
      }

      // Snap Y: center → top edge → bottom edge
      if (snapY_center) {
        dOY = 0;                  // snap to vertical center
      } else {
        const dT = imgT - frmT, dB = imgB - frmB;
        if (Math.abs(dT) < SNAP && (Math.abs(dT) <= Math.abs(dB))) {
          dOY = frmT + hH;       // snap top edge flush
        } else if (Math.abs(dB) < SNAP) {
          dOY = frmB - hH;       // snap bottom edge flush
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
      if (panSt) { panSt=null; ca.style.cursor = edLassoMode ? _lassoCursors.normal : edCropMode ? "crosshair" : "grab"; requestInpaintPreview(); }
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
            const d = Math.hypot((cNx - edLassoCurrentPts[0].x) * frameW, (cNy - edLassoCurrentPts[0].y) * frameH);
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
      // commit session to cropMap
      for (const fn of valid) {
        const t=ses[fn];
        if (t&&(t.ox!==0||t.oy!==0||t.scale!==1.0||t.flipH||t.flipV||(t.rotate||0)!==0||(t.bg&&t.bg!==_nodeBg)||
            (t.cx!=null&&(t.cx>0||t.cy>0||t.cw<1||t.ch<1))||(t.lassoOps&&t.lassoOps.length>0)||t.lassoInverted)) cropMap[fn]=t;
        else delete cropMap[fn];
      }
      persistCropData(); persist(); doClose();
      renderCropPreviews();  // async: update thumbnails with crop applied
    }
    applyB.addEventListener("click",  doApply);
    cancelB.addEventListener("click", doClose);
    closeB.addEventListener("click",  doApply);
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
