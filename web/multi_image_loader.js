/**
 * ComfyUI-Multi-Image-Loader  –  Frontend Extension v1.8
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
const THUMB_SIZES        = { small: 52, medium: 72, large: 100 }; // px widths

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

function computeIdealHeight(count, nodeWidth, thumbH, thumbW = THUMB_W) {
  const th       = thumbH || thumbW;
  const innerW   = nodeWidth - 24;
  const cols     = Math.max(1, Math.floor((innerW + THUMB_GAP) / (thumbW + THUMB_GAP)));
  const rows     = count > 0 ? Math.ceil(count / cols) : 0;
  const visRows  = Math.min(rows, MAX_GRID_ROWS);
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

  const previewBtn = document.createElement("button");
  previewBtn.textContent = "🔄 Preview Fit";
  previewBtn.title = "Render letterbox/crop preview for all thumbnails";
  previewBtn.className = "mil-btn";
  previewBtn.style.cssText = `
    background: #1a3a28;
    color: #44cc88;
    border: 1px solid #336644;
    border-radius: 4px;
    padding: 3px 10px;
    font-size: 10px;
    cursor: pointer;
    display: none;
  `;
  previewBtn.addEventListener("mouseenter", () => {
    previewBtn.style.background  = "#225540";
    previewBtn.style.borderColor = "#44cc88";
  });
  previewBtn.addEventListener("mouseleave", () => {
    previewBtn.style.background  = "#1a3a28";
    previewBtn.style.borderColor = "#336644";
  });

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "✕ Clear all";
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
  btnGroup.appendChild(previewBtn);
  btnGroup.appendChild(clearBtn);
  statusBar.appendChild(statusLabel);
  statusBar.appendChild(btnGroup);

  root.appendChild(dropZone);
  root.appendChild(gridWrapper);
  root.appendChild(statusBar);

  // ── state ─────────────────────────────────────────────────────────────────
  // Each item: { filename: string, src: string, previewSrc?: string }
  let items  = [];
  let thumbH = THUMB_W;  // updated from first image's aspect ratio

  // Drag-reorder state
  let dragSrcIdx = null;

  // Preview state
  let previewActive = false;
  // Per-image crop transforms: { filename → { ox, oy, scale } }
  let cropMap = {};


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
              (t.rotate||0)!==0 || (t.bg && t.bg !== "#808080") ||
              (t.cx != null && (t.cx > 0 || t.cy > 0 || t.cw < 1 || t.ch < 1))));
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
      const bgRaw = t.bg ?? "#808080";
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
        const bgC = bgRaw === "black" ? "#000000" : bgRaw === "white" ? "#ffffff"
                  : /^#[0-9a-fA-F]{6}$/.test(bgRaw) ? bgRaw : "#808080";
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
        ctx.restore();

        item.previewSrc = cvs.toDataURL("image/jpeg", 0.92);
      } catch (e) {
        console.warn("[MIL] crop preview error:", item.filename, e);
      }
    }
    previewActive = true;
    render();
  }

  function getEffectiveThumbW() {
    const w = node.widgets?.find((ww) => ww.name === "thumb_size");
    return THUMB_SIZES[w?.value] ?? THUMB_W;
  }

  function resizeNode() {
    const curW   = node.size[0];
    const curH   = node.size[1];
    const tw     = getEffectiveThumbW();
    const th     = Math.max(20, Math.round(tw * thumbH / THUMB_W));
    const idealH = computeIdealHeight(items.length, curW, th, tw);
    // Only grow — never shrink below the user's manually-set size
    if (idealH > curH) node.setSize([curW, idealH]);
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
    const th = Math.max(20, Math.round(tw * thumbH / THUMB_W));

    items.forEach((item, idx) => {

      // ── wrapper ──────────────────────────────────────────────────────────
      const wrapper = document.createElement("div");
      wrapper.className = "mil-thumb";
      wrapper.draggable = true;
      wrapper.dataset.idx = idx;
      wrapper.style.cssText = `
        position: relative;
        width: ${tw}px;
        height: ${th}px;
        border-radius: 6px;
        overflow: hidden;
        border: 1px solid #3a5080;
        flex-shrink: 0;
        background: #000;
      `;

      // ── image ─────────────────────────────────────────────────────────────
      const img = document.createElement("img");
      img.src = item.previewSrc || item.src;
      img.style.cssText = `width:${tw}px;height:${th}px;object-fit:contain;display:block;pointer-events:none;`;
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

      wrapper.appendChild(img);
      wrapper.appendChild(badge);
      wrapper.appendChild(copyBtn);
      wrapper.appendChild(cropBtn);
      wrapper.appendChild(removeBtn);
      grid.appendChild(wrapper);
    });

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
    clearBtn.style.display   = count > 0 ? "inline-block" : "none";
    // Show preview when AR is set (even 1 image) or when there are 2+ images
    const arVal = getAspectRatioWidget()?.value ?? "none";
    previewBtn.style.display = (count > 0 && arVal !== "none") || count > 1 ? "inline-block" : "none";

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
      const bgRaw = t.bg ?? "#808080";
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
      // Effective source dimensions after pre-crop
      const hasCR = t.cx != null && (t.cx > 0 || t.cy > 0 || t.cw < 1 || t.ch < 1);
      const srcX = hasCR ? t.cx * el.naturalWidth  : 0;
      const srcY = hasCR ? t.cy * el.naturalHeight : 0;
      const srcW = hasCR ? t.cw * el.naturalWidth  : el.naturalWidth;
      const srcH = hasCR ? t.ch * el.naturalHeight : el.naturalHeight;
      const cvs = document.createElement("canvas");
      cvs.width = refW; cvs.height = refH;
      const ctx = cvs.getContext("2d");
      const bgC = bgRaw === "black" ? "#000000" : bgRaw === "white" ? "#ffffff"
                : /^#[0-9a-fA-F]{6}$/.test(bgRaw) ? bgRaw : "#808080";
      ctx.fillStyle = bgC; ctx.fillRect(0, 0, refW, refH);
      const ox = t.ox ?? 0, oy = t.oy ?? 0, sc = t.scale ?? 1;
      const fH = !!(t.flipH), fV = !!(t.flipV), rot = (t.rotate || 0) * Math.PI / 180;
      const cosA = Math.abs(Math.cos(rot)), sinA = Math.abs(Math.sin(rot));
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
      ctx.fillStyle = "#000000";
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
    previewBtn.textContent = "⏳ Rendering…";
    previewBtn.disabled = true;

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
            ctx.fillStyle = "#000000";
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
    } finally {
      previewBtn.textContent = "🔄 Preview Fit";
      previewBtn.disabled = false;
      // Button stays visible — user may change fit_mode and preview again
    }
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

      const isFirstBatch = items.length === 0;
      if (isFirstBatch && dataURLs.length > 0) {
        const { w, h } = await getImageDimensions(dataURLs[0]);
        thumbH = Math.max(20, Math.round(THUMB_W * h / w));
      }

      const insertedCount = filenames.length;
      filenames.forEach((fn, i) => {
        items.push({ filename: fn, src: dataURLs[i] });
      });

      statusLabel.style.color = "#8899bb";
      render();
      persist();

      // Flash newly added thumbnails with a green border that fades over 5 s
      requestAnimationFrame(() => {
        const allThumbs = grid.querySelectorAll(".mil-thumb");
        const start = allThumbs.length - insertedCount;
        for (let i = Math.max(0, start); i < allThumbs.length; i++) {
          // Re-trigger animation in case the same element is reused
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

  previewBtn.addEventListener("click", () => renderFitPreviews());

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
  root._renderWithResize = () => {
    // Force resize+render when thumb_size changes (bypasses grow-only logic)
    const curW   = node.size[0];
    const tw     = getEffectiveThumbW();
    const th     = Math.max(20, Math.round(tw * thumbH / THUMB_W));
    const idealH = computeIdealHeight(items.length, curW, th, tw);
    node.setSize([curW, idealH]);
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
    let edBg = "#808080";  // background fill
    let edInpaintPreview = null, edInpaintDirty = true, edReqHandle = null;
    const edPreviewCache = new Map();
    let frameW = 300, frameH = 300, frameCX = 0, frameCY = 0, bFit = 1;
    let rafId = null, panSt = null;
    let edCropMode = false, edCropBox = null;
    let edCropDrag = null;
    let edAppliedCrop = null; // committed crop {cx,cy,cw,ch} — applied BEFORE transforms

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
    function mkSec(t) {
      const d = document.createElement("div");
      d.style.cssText = `color:#444;font-size:${_fs10};text-transform:uppercase;letter-spacing:1px;margin-top:${_gap5};`;
      d.textContent = t; return d;
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
    pnlBody.appendChild(mkSec("Crop Region"));
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
        ca.style.cursor = "grab";
        hint.textContent = "Drag to pan \u00b7 Scroll to zoom";
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
    cropArInput.value = _simplifyAR(edRefW, edRefH);
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
      // Reset transforms since we're now working on a new "image"
      dOX = 0; dOY = 0; edScale = 1.0;
      syncCropToggle(); updateDimLabels(); updateCropInfoLbl();
      syncCvs(); updLbl(); redraw(); requestInpaintPreview();
    });
    pnlBody.appendChild(cropApplyB);
    const cropResetB = mkPB("\u27F2 Reset All Crop", () => {
      edCropBox = null; edAppliedCrop = null; edCropMode = false;
      dOX = 0; dOY = 0; edScale = 1.0;
      syncCropToggle(); updateDimLabels(); updateCropInfoLbl();
      syncCvs(); updLbl(); requestInpaintPreview();
    });
    pnlBody.appendChild(cropResetB);
    const cropInfoLbl = document.createElement("div");
    cropInfoLbl.style.cssText = `color:#666;font-size:${_fs10};text-align:center;min-height:${Math.round(11*uiScale)}px;`;
    pnlBody.appendChild(cropInfoLbl);

    pnlBody.appendChild(mkSec("Quick Fit"));
    pnlBody.appendChild(mkPB("\u2B1B Fill  (cover)",  doFill));
    pnlBody.appendChild(mkPB("\u2B1C Fit   (letterbox)", ()=>{ dOX=0;dOY=0;edScale=1; updLbl(); }));
    pnlBody.appendChild(mkPB("\u2194 Fit Width",  doFitW));
    pnlBody.appendChild(mkPB("\u2195 Fit Height", doFitH));
    pnlBody.appendChild(mkSec("Flip"));
    pnlBody.appendChild(mkPB("\u2194 Flip Horizontal", ()=>{ edFlipH=!edFlipH; }));
    pnlBody.appendChild(mkPB("\u2195 Flip Vertical",   ()=>{ edFlipV=!edFlipV; }));
    pnlBody.appendChild(mkSec("Rotate"));
    // slider + click-to-type angle
    const rotRow = document.createElement("div");
    rotRow.style.cssText = `display:flex;align-items:center;gap:${_gap5};width:100%;overflow:hidden;`;
    const rotSlider = document.createElement("input");
    rotSlider.type="range"; rotSlider.min=-180; rotSlider.max=180; rotSlider.step=1; rotSlider.value=0;
    rotSlider.style.cssText="flex:1;accent-color:#5a7abf;cursor:pointer;";
    const rotValEl = document.createElement("div");
    rotValEl.style.cssText=`color:#888;font-size:${_fs10};min-width:${Math.round(34*uiScale)}px;text-align:right;cursor:text;user-select:none;`;
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

    // Background Fill section
    pnlBody.appendChild(mkSec("Background Fill"));
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
      edBg= v==="custom" ? bgColorPick.value : v;
      edInpaintPreview=null; edInpaintDirty=true;
      redraw(); requestInpaintPreview();
    });
    function syncBgUI(){
      const known=["#808080","black","white","telea","navier-stokes"];
      bgSelect.value=known.includes(edBg)?edBg:"custom";
      const isCust=!known.includes(edBg);
      bgCustomRow.style.display=isCust?"flex":"none";
      if(isCust){ bgColorPick.value=edBg; bgHexInp.value=edBg; }
      bgNote.style.display=(edBg==="telea"||edBg==="navier-stokes")?"block":"none";
    }
    pnlBody.appendChild(bgSelect); pnlBody.appendChild(bgCustomRow); pnlBody.appendChild(bgNote);

    pnlBody.appendChild(mkSec("Transform"));
    pnlBody.appendChild(mkPB("\u27F2 Reset All", ()=>{ dOX=0;dOY=0;edScale=1;edFlipH=false;edFlipV=false;edRotate=0;edBg="#808080"; syncRotUI(); syncBgUI(); updLbl(); }));

    // ── Remove Background ───────────────────────────────────────
    pnlBody.appendChild(mkSec("Remove Background"));

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
    rbBtn.style.cssText = [
      `background:#1a1a3a;color:#88aaff;border:1px solid #334488;`,
      `border-radius:${_r6};padding:${_btnPadW};font-size:${_fs11};font-weight:600;`,
      `cursor:pointer;width:100%;margin-top:${Math.round(3*uiScale)}px;`,
      `transition:background 0.15s,border-color 0.15s;`,
    ].join("");
    rbBtn.addEventListener("mouseenter", () => { rbBtn.style.background = "#222255"; rbBtn.style.borderColor = "#5566cc"; });
    rbBtn.addEventListener("mouseleave", () => { rbBtn.style.background = "#1a1a3a"; rbBtn.style.borderColor = "#334488"; });

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
        // Refresh thumbnail grid
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
    pnlBody.appendChild(rbStatus);
    pnlBody.appendChild(rbBtn);

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
    function _bfitOf(rW, rH) { return Math.min(frameW/rW, frameH/rH); }
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
      const eW = effNatW(), eH = effNatH();
      const rf=edRotate*Math.PI/180, c=Math.abs(Math.cos(rf)), s=Math.abs(Math.sin(rf));
      const rW=eW*c+eH*s, rH=eW*s+eH*c;
      bFit=Math.min(frameW/rW,frameH/rH);
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
        // background fill inside frame
        const bgC = edBg==="black" ? "#000000" : edBg==="white" ? "#ffffff"
                  : /^#[0-9a-fA-F]{6}$/.test(edBg) ? edBg : "#808080";
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
      });
    }

    // ── image load ───────────────────────────────────────────
    function saveToSes() {
      const fn = items[curIdx]?.filename; if (!fn) return;
      const hasAppliedCrop = edAppliedCrop && (edAppliedCrop.cx > 0 || edAppliedCrop.cy > 0 || edAppliedCrop.cw < 1 || edAppliedCrop.ch < 1);
      if (dOX!==0||dOY!==0||edScale!==1.0||edFlipH||edFlipV||edRotate!==0||edBg!=="#808080"||hasAppliedCrop) {
        const t = {ox:dOX/frameW,oy:dOY/frameH,scale:edScale,flipH:edFlipH,flipV:edFlipV,rotate:edRotate,bg:edBg};
        if (hasAppliedCrop) { t.cx = edAppliedCrop.cx; t.cy = edAppliedCrop.cy; t.cw = edAppliedCrop.cw; t.ch = edAppliedCrop.ch; }
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
      await new Promise(res=>{
        const el=new Image(); el.crossOrigin="anonymous";
        el.onload=()=>{
          edImg=el; edNatW=el.naturalWidth; edNatH=el.naturalHeight;
          const t=ses[items[idx].filename];
          // Restore applied crop BEFORE syncCvs so bFit uses effective dims
          if (t && t.cx != null) edAppliedCrop = { cx: t.cx, cy: t.cy, cw: t.cw, ch: t.ch };
          else edAppliedCrop = null;
          edCropBox = null; edCropDrag = null;
          syncCvs();
          dOX=(t?.ox??0)*frameW; dOY=(t?.oy??0)*frameH; edScale=t?.scale??1.0;
          edFlipH=!!(t?.flipH); edFlipV=!!(t?.flipV); edRotate=t?.rotate??0; edBg=t?.bg??"#808080";
          updateDimLabels(); updateCropInfoLbl();
          edInpaintPreview=null; edInpaintDirty=true;
          syncRotUI(); syncBgUI(); updLbl(); redraw(); requestInpaintPreview(); res();
        };
        el.onerror=res; el.src=items[idx].src;
      });
    }

    // ── events ───────────────────────────────────────────────
    function onGlobalMove(e) {
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
        // aspect ratio constraint from AR input
        const arVal = parseCropAR();
        if (arVal && m !== 'move' && edCropBox) {
          const eW = effNatW(), eH = effNatH();
          // target: (w*eW)/(h*eH) = arVal → h = (w*eW)/(arVal*eH)
          if (m === 'top' || m === 'bottom') {
            edCropBox.w = (edCropBox.h * eH * arVal) / eW;
          } else {
            edCropBox.h = (edCropBox.w * eW) / (arVal * eH);
          }
        }
        clampCropBox(); updateCropInfoLbl(); redraw();
        return;
      }
      // ── pan drag ──
      if (!panSt) return;
      dOX=panSt.ox+(e.clientX-panSt.x); dOY=panSt.oy+(e.clientY-panSt.y); redraw();
    }
    function onGlobalUp(e) {
      if (edCropMode && edCropDrag) {
        edCropDrag = null;
        const r = cvs.getBoundingClientRect();
        const hit = cropHitTest(e.clientX - r.left, e.clientY - r.top);
        ca.style.cursor = hit ? cropCursorFor(hit) : 'crosshair';
        updateCropInfoLbl(); return;
      }
      if (panSt) { panSt=null; ca.style.cursor="grab"; requestInpaintPreview(); }
    }
    cvs.addEventListener("mousedown", e=>{
      if (e.button!==0) return;
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
      if (edCropMode && !edCropDrag) {
        const r = cvs.getBoundingClientRect();
        const hit = cropHitTest(e.clientX - r.left, e.clientY - r.top);
        ca.style.cursor = hit ? cropCursorFor(hit) : 'crosshair';
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
      if (e.key==="ArrowLeft"  && curIdx>0)               { saveToSes(); loadIdx(curIdx-1); }
      if (e.key==="ArrowRight" && curIdx<items.length-1)  { saveToSes(); loadIdx(curIdx+1); }
      if (e.key==="Escape") doClose();
    }
    window.addEventListener("keydown", onKey);
    prevB.addEventListener("click", ()=>{ if(curIdx>0)             { saveToSes(); loadIdx(curIdx-1); } });
    nextB.addEventListener("click", ()=>{ if(curIdx<items.length-1){ saveToSes(); loadIdx(curIdx+1); } });

    // ── apply / cancel / close ────────────────────────────────
    function doClose() {
      clearTimeout(edReqHandle);
      cancelAnimationFrame(rafId); ro.disconnect();
      window.removeEventListener("keydown",    onKey);
      window.removeEventListener("mousemove",  onGlobalMove);
      window.removeEventListener("mouseup",    onGlobalUp);
      ov.remove();
    }
    function doApply() {
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
      // commit session to cropMap
      for (const fn of valid) {
        const t=ses[fn];
        if (t&&(t.ox!==0||t.oy!==0||t.scale!==1.0||t.flipH||t.flipV||(t.rotate||0)!==0||(t.bg&&t.bg!=="#808080")||
            (t.cx!=null&&(t.cx>0||t.cy>0||t.cw<1||t.ch<1)))) cropMap[fn]=t;
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
      cropArInput.value = _simplifyAR(edRefW, edRefH);
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
            w.type = "hidden";
            w.inputEl?.remove?.();
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
        // Auto-preview when aspect_ratio, fit_mode, or megapixels change
        const autoPreviewWidgets = ["aspect_ratio", "fit_mode", "megapixels"];
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
