/**
 * ComfyUI-Multi-Image-Loader  –  Frontend Extension v1.3
 *
 * Changes:
 *  - Thumbnails persist across page refresh (Ctrl+F5) and workflow reload
 *  - item.src can be a data-URL (freshly uploaded) or a /view server URL (restored)
 *  - Aspect ratio is recovered from the first image on restore
 *  - onConfigure hook restores thumbnails when a saved workflow is loaded
 */

import { app } from "../../scripts/app.js";

// ─── constants ───────────────────────────────────────────────────────────────

const NODE_TYPE  = "MultiImageLoader";
const UPLOAD_URL = "/multi_image_loader/upload";

// Layout constants (px)
const NODE_HEADER_H  = 30;
const NODE_SLOT_H    = 22;
const NODE_PADDING_V = 12;
const DROPZONE_H     = 108;
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

// Inject global scrollbar CSS once
function injectScrollbarStyles() {
  if (document.getElementById("mil-scrollbar-style")) return;
  const style = document.createElement("style");
  style.id = "mil-scrollbar-style";
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
  injectScrollbarStyles();

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
  statusBar.appendChild(statusLabel);
  statusBar.appendChild(clearBtn);

  root.appendChild(dropZone);
  root.appendChild(grid);
  root.appendChild(statusBar);

  // ── state ─────────────────────────────────────────────────────────────────
  // Each item: { filename: string, src: string }
  // src = data-URL (fresh upload) or /view URL (restored from saved workflow)
  let items  = [];
  let thumbH = THUMB_W;  // updated from first image's aspect ratio

  // ── helpers ───────────────────────────────────────────────────────────────

  function getImageListWidget() {
    return node.widgets?.find((w) => w.name === "image_list");
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
      const wrapper = document.createElement("div");
      wrapper.style.cssText = `
        position: relative;
        width: ${tw}px;
        height: ${th}px;
        border-radius: 6px;
        overflow: hidden;
        border: 1px solid #3a5080;
        flex-shrink: 0;
        cursor: default;
      `;

      const img = document.createElement("img");
      img.src = item.src;
      img.style.cssText = `width:${tw}px;height:${th}px;object-fit:fill;display:block;`;
      img.title = item.filename;

      const badge = document.createElement("span");
      badge.textContent = idx + 1;
      badge.style.cssText = `
        position:absolute;bottom:2px;left:3px;
        background:rgba(0,0,0,0.65);color:#fff;
        font-size:9px;font-family:sans-serif;
        padding:0 3px;border-radius:3px;
        pointer-events:none;
      `;

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
        if (items.length === 0) thumbH = THUMB_W; // reset ratio on empty
        render();
        persist();
      });

      wrapper.appendChild(img);
      wrapper.appendChild(badge);
      wrapper.appendChild(removeBtn);
      grid.appendChild(wrapper);
    });

    const count = items.length;
    statusLabel.textContent = count > 0 ? `${count} image${count !== 1 ? "s" : ""} queued` : "";
    clearBtn.style.display = count > 0 ? "inline-block" : "none";

    resizeNode();
  }

  // ── restore (called on page load / workflow reload) ───────────────────────

  /**
   * Reads the persisted image_list widget value and rebuilds thumbnails
   * using the /view endpoint (no re-upload needed, files are still on disk).
   * Safe to call multiple times – skips if items are already populated.
   */
  async function restore() {
    // Skip if there are already items (e.g., restore called twice)
    if (items.length > 0) return;

    const w = getImageListWidget();
    let filenames;
    try {
      filenames = JSON.parse(w?.value || "[]");
    } catch {
      filenames = [];
    }
    if (!filenames?.length) return;

    // Rebuild items using server /view URLs (files already exist in input/)
    items = filenames.map((fn) => ({ filename: fn, src: viewURL(fn) }));

    // Recover aspect ratio from the first image
    try {
      const firstSrc = viewURL(filenames[0]);
      const { w: iw, h: ih } = await getImageDimensions(firstSrc);
      thumbH = Math.max(20, Math.round(THUMB_W * ih / iw));
    } catch {
      thumbH = THUMB_W;
    }

    render();
    // Do NOT call persist() – we haven't changed state, just rendered it
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

      // Detect aspect ratio from the FIRST image only (when queue was empty)
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

  clearBtn.addEventListener("click", () => {
    items  = [];
    thumbH = THUMB_W;
    render();
    persist();
  });

  // ── initial render ────────────────────────────────────────────────────────
  render();

  // Expose public API on the element
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

      // ── Inject DOM widget ──────────────────────────────────────────────
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

      // Store on node so onConfigure can access it
      node._milDomWidget = domWidget;

      // ── Hide auxiliary widgets (they still save values, just invisible) ─
      setTimeout(() => {
        const hiddenNames = ["image_list", "resize_mode"];
        node.widgets?.forEach((w) => {
          if (hiddenNames.includes(w.name)) {
            w.type = "hidden";
            w.inputEl?.remove?.();
          }
        });
        node.setDirtyCanvas(true);
        // NOTE: do NOT call _restore() here – widget values aren't
        // populated at onNodeCreated time. Restoration happens in
        // onConfigure (workflow load) or setup → graphConfigured (page load).
      }, 0);

      // ── Intercept drops on the node canvas element ─────────────────────
      node.onDrop = function (e) {
        e.preventDefault?.();
        e.stopPropagation?.();
        if (e.dataTransfer?.files?.length) {
          node._milDomWidget?.element?._addFiles?.(e.dataTransfer.files);
        }
        return false;
      };
    };

    /**
     * onConfigure is called by LiteGraph when a workflow JSON is loaded.
     * Widget values are already set at this point. Double rAF ensures the
     * DOM widget element is mounted before we try to access it.
     */
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
