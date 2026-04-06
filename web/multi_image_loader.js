/**
 * ComfyUI-Multi-Image-Loader  –  Frontend Extension v1.4
 *
 * Changes in v1.5:
 *  - "🔄 Preview Fit" button: appears when drag-reorder changes image #1
 *  - Clicking renders a canvas-based letterbox/crop preview for every thumbnail
 *  - Preview is purely visual; files are not modified
 *  - Button auto-hides after preview is applied or list changes
 */

import { app } from "../../scripts/app.js";

// ─── constants ───────────────────────────────────────────────────────────────

const NODE_TYPE  = "MultiImageLoader";
const UPLOAD_URL = "/multi_image_loader/upload";

// Layout constants (px)
const NODE_HEADER_H  = 30;
const NODE_SLOT_H    = 22;
const NODE_PADDING_V = 12;
const DROPZONE_H     = 128;
const STATUS_H       = 22;
const GAP            = 6;
const THUMB_W        = 72;
const THUMB_GAP      = 5;

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
      scrollbar-color: #5a7abf #1e2535;
    }
    .mil-grid::-webkit-scrollbar { width: 7px; }
    .mil-grid::-webkit-scrollbar-track {
      background: #1e2535;
      border-radius: 4px;
    }
    .mil-grid::-webkit-scrollbar-thumb {
      background: #5a7abf;
      border-radius: 4px;
      border: 1px solid #1e2535;
    }
    .mil-grid::-webkit-scrollbar-thumb:hover { background: #7aacff; }

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
  `;
  document.head.appendChild(style);
}

// ─── height calculation ───────────────────────────────────────────────────────

function computeIdealHeight(count, nodeWidth, thumbH) {
  const th       = thumbH || THUMB_W;
  const innerW   = nodeWidth - 24;
  const cols     = Math.max(1, Math.floor((innerW + THUMB_GAP) / (THUMB_W + THUMB_GAP)));
  const rows     = count > 0 ? Math.ceil(count / cols) : 0;
  const gridH    = rows > 0 ? rows * (th + THUMB_GAP) - THUMB_GAP + 4 : 0;
  const extraGap = rows > 0 ? GAP * 2 : GAP;

  return (
    NODE_HEADER_H +
    NODE_SLOT_H   +
    NODE_PADDING_V +
    DROPZONE_H    +
    extraGap      +
    gridH         +
    STATUS_H      +
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
    min-width: 240px;
  `;

  // ── drop zone ─────────────────────────────────────────────────────────────
  const dropZone = document.createElement("div");
  dropZone.style.cssText = `
    flex-shrink: 0;
    border: 2px dashed #5a7abf;
    border-radius: 10px;
    padding: 14px 10px;
    text-align: center;
    cursor: pointer;
    color: #8ebaff;
    font-size: 12px;
    font-family: sans-serif;
    background: rgba(60, 90, 150, 0.15);
    transition: background 0.2s, border-color 0.2s;
    user-select: none;
    height: ${DROPZONE_H}px;
    box-sizing: border-box;
  `;
  dropZone.innerHTML = `
    <div style="font-size:28px;margin-bottom:4px;">🖼️</div>
    <div><strong>Drop images here</strong> or <strong>click to browse</strong></div>
    <div style="opacity:0.6;margin-top:4px;font-size:10px;">PNG · JPG · WebP · BMP</div>
    <div style="opacity:0.5;margin-top:6px;font-size:9px;">Drag thumbnails below to reorder · First image sets the canvas</div>
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
  `;

  // ── status bar ────────────────────────────────────────────────────────────
  const statusBar = document.createElement("div");
  statusBar.style.cssText = `
    flex-shrink: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-family: sans-serif;
    font-size: 10px;
    color: #8899bb;
    padding: 0 2px;
    height: ${STATUS_H}px;
    box-sizing: border-box;
  `;
  const statusLabel = document.createElement("span");
  statusLabel.style.whiteSpace = "pre-line";

  // Right-side button group
  const btnGroup = document.createElement("div");
  btnGroup.style.cssText = `display:flex;gap:4px;align-items:center;`;

  const previewBtn = document.createElement("button");
  previewBtn.textContent = "🔄 Preview Fit";
  previewBtn.title = "Render letterbox/crop preview for all thumbnails";
  previewBtn.style.cssText = `
    background: #1a3a28;
    color: #44cc88;
    border: 1px solid #336644;
    border-radius: 4px;
    padding: 1px 8px;
    font-size: 10px;
    cursor: pointer;
    display: none;
  `;

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "✕ Clear all";
  clearBtn.style.cssText = `
    background: #3a2020;
    color: #ff8888;
    border: 1px solid #884444;
    border-radius: 4px;
    padding: 1px 8px;
    font-size: 10px;
    cursor: pointer;
    display: none;
  `;
  btnGroup.appendChild(previewBtn);
  btnGroup.appendChild(clearBtn);
  statusBar.appendChild(statusLabel);
  statusBar.appendChild(btnGroup);

  root.appendChild(dropZone);
  root.appendChild(grid);
  root.appendChild(statusBar);

  // ── state ─────────────────────────────────────────────────────────────────
  // Each item: { filename: string, src: string, previewSrc?: string }
  let items  = [];
  let thumbH = THUMB_W;  // updated from first image's aspect ratio

  // Drag-reorder state
  let dragSrcIdx = null;

  // Preview state
  let previewActive = false;

  // ── helpers ───────────────────────────────────────────────────────────────

  function getImageListWidget() {
    return node.widgets?.find((w) => w.name === "image_list");
  }

  function getFitModeWidget() {
    return node.widgets?.find((w) => w.name === "fit_mode");
  }

  function persist() {
    const w = getImageListWidget();
    if (w) w.value = JSON.stringify(items.map((i) => i.filename));
    node.setDirtyCanvas(true, true);
  }

  function resizeNode() {
    const curW   = node.size[0];
    const idealH = computeIdealHeight(items.length, curW, thumbH);
    node.setSize([curW, idealH]);
  }

  // ── render ────────────────────────────────────────────────────────────────

  function render() {
    grid.innerHTML = "";
    const tw = THUMB_W;
    const th = thumbH;

    items.forEach((item, idx) => {
      // ── wrapper ────────────────────────────────────────────────────────
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
        border: ${idx === 0 ? "2px solid #00c880" : "1px solid #3a5080"};
        flex-shrink: 0;
      `;

      // ── image ──────────────────────────────────────────────────────────
      const img = document.createElement("img");
      // Show canvas-rendered preview if available, otherwise original src
      img.src = item.previewSrc || item.src;
      img.style.cssText = `width:${tw}px;height:${th}px;object-fit:cover;display:block;pointer-events:none;`;
      img.title = item.filename;

      // ── "★ First" badge on image 0 ──────────────────────────────────
      if (idx === 0) {
        const firstBadge = document.createElement("span");
        firstBadge.className = "mil-first-badge";
        firstBadge.textContent = "★ First";
        wrapper.appendChild(firstBadge);
      }

      // ── numeric badge (bottom-left) ────────────────────────────────────
      const badge = document.createElement("span");
      badge.textContent = idx + 1;
      badge.style.cssText = `
        position:absolute;bottom:2px;left:3px;
        background:rgba(0,0,0,0.65);color:#fff;
        font-size:9px;font-family:sans-serif;
        padding:0 3px;border-radius:3px;
        pointer-events:none;
      `;

      // ── remove button ──────────────────────────────────────────────────
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "✕";
      removeBtn.title = "Remove";
      removeBtn.style.cssText = `
        position:absolute;top:2px;right:2px;
        background:rgba(180,30,30,0.88);color:#fff;
        border:none;border-radius:3px;
        width:16px;height:16px;font-size:10px;
        cursor:pointer;padding:0;line-height:16px;text-align:center;
        opacity:0;transition:opacity 0.15s;
      `;
      wrapper.addEventListener("mouseenter", () => (removeBtn.style.opacity = "1"));
      wrapper.addEventListener("mouseleave", () => (removeBtn.style.opacity = "0"));
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        items.splice(idx, 1);
        if (items.length === 0) thumbH = THUMB_W;
        render();
        persist();
      });

      // ── drag-to-reorder events ─────────────────────────────────────────
      wrapper.addEventListener("dragstart", (e) => {
        dragSrcIdx = idx;
        wrapper.classList.add("mil-dragging");
        e.dataTransfer.effectAllowed = "move";
        // Needed for Firefox
        e.dataTransfer.setData("text/plain", String(idx));
      });

      wrapper.addEventListener("dragend", () => {
        dragSrcIdx = null;
        wrapper.classList.remove("mil-dragging");
        // Clean up any leftover highlights
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

        // Track whether position-0 is involved (first image will change)
        const firstWillChange = dragSrcIdx === 0 || idx === 0;

        // Reorder: remove from old position, insert at new position
        const [moved] = items.splice(dragSrcIdx, 1);
        items.splice(idx, 0, moved);

        // Clear all previews — they're stale after reorder
        items.forEach((it) => delete it.previewSrc);
        previewActive = false;

        // Update thumbH from the new first image
        updateThumbHFromFirst();

        render();
        persist(); // ← image_list is updated immediately; next Run uses new order
      });

      wrapper.appendChild(img);
      wrapper.appendChild(badge);
      wrapper.appendChild(removeBtn);
      grid.appendChild(wrapper);
    });

    const count = items.length;
    statusLabel.textContent =
      count > 0
        ? `${count} image${count !== 1 ? "s" : ""} queued\nDrag to reorder`
        : "";
    clearBtn.style.display    = count > 0 ? "inline-block" : "none";
    previewBtn.style.display  = count > 1 ? "inline-block" : "none";

    resizeNode();
  }

  // Update thumbH from whatever image is now first
  async function updateThumbHFromFirst() {
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
   * Renders a canvas-based fit preview for every non-first thumbnail.
   * The first image dimensions become the target canvas size.
   * mode = "letterbox" | "crop"  (reads fit_mode widget).
   */
  async function renderFitPreviews() {
    if (items.length < 2) return;

    const mode = getFitModeWidget()?.value ?? "letterbox";
    previewBtn.textContent = "⏳ Rendering…";
    previewBtn.disabled = true;

    try {
      // Get reference dimensions from image #0
      const refImg = await loadImage(items[0].src);
      const targetW = refImg.naturalWidth;
      const targetH = refImg.naturalHeight;

      // Render a preview canvas for each subsequent image
      for (let i = 1; i < items.length; i++) {
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

      filenames.forEach((fn, i) => {
        items.push({ filename: fn, src: dataURLs[i] });
      });

      statusLabel.style.color = "#8899bb";
      render();
      persist();
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
  dropZone.addEventListener("dragleave", () => {
    dropZone.style.background = "rgba(60, 90, 150, 0.15)";
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
    render();
    persist();
  });

  // ── initial render ────────────────────────────────────────────────────────
  render();

  root._addFiles = addFiles;
  root._restore  = restore;

  return root;
}

// ─── Extension registration ───────────────────────────────────────────────────

app.registerExtension({
  name: "MultiImageLoader",

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
            return [width, Math.max(120, node.size[1] - NODE_HEADER_H - NODE_SLOT_H - NODE_PADDING_V)];
          },
        }
      );

      node._milDomWidget = domWidget;

      setTimeout(() => {
        const hiddenNames = ["image_list", "fit_mode"];
        node.widgets?.forEach((w) => {
          if (hiddenNames.includes(w.name)) {
            w.type = "hidden";
            w.inputEl?.remove?.();
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
