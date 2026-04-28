/**
 * mil_render_worker.js — OffscreenCanvas Web Worker
 *
 * Handles heavy pixel work (crop transforms, fit letterbox/crop, lasso masks)
 * off the main UI thread so ComfyUI / LiteGraph stays responsive.
 *
 * Communication protocol:
 *   Main → Worker:  { jobId, type, imageBlob, params }
 *   Worker → Main:  { jobId, dataUrl }
 *
 * Job types:
 *   "cropTransform"  — full crop/pan/zoom/flip/rotate + lasso composite
 *   "fitPreview"     — simple letterbox or center-crop fit
 */

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Draw lasso ops onto a sub-canvas and composite the bg-fill cutout
 * back onto the main context. All coordinates are normalised [0..1].
 */
function applyLassoMask(ctx, lassoOps, lassoInverted, dw, dh, bgColor) {
  const mw = Math.ceil(dw), mh = Math.ceil(dh);
  if (mw < 1 || mh < 1) return;

  // 1. Build the lasso mask (white = inside lasso)
  const mc = new OffscreenCanvas(mw, mh);
  const mx = mc.getContext("2d");
  for (const op of lassoOps) {
    if (!op.points || op.points.length < 3) continue;
    mx.globalCompositeOperation = op.mode === "add" ? "source-over" : "destination-out";
    mx.fillStyle = "white";
    mx.beginPath();
    mx.moveTo(op.points[0][0] * mw, op.points[0][1] * mh);
    for (let k = 1; k < op.points.length; k++) {
      mx.lineTo(op.points[k][0] * mw, op.points[k][1] * mh);
    }
    mx.closePath();
    mx.fill();
  }
  if (lassoInverted) {
    mx.globalCompositeOperation = "xor";
    mx.fillStyle = "white";
    mx.fillRect(0, 0, mw, mh);
  }
  mx.globalCompositeOperation = "source-over";

  // 2. Build a bg-color rect and punch out the lasso shape
  const oc = new OffscreenCanvas(mw, mh);
  const ox = oc.getContext("2d");
  ox.fillStyle = bgColor;
  ox.fillRect(0, 0, mw, mh);
  ox.globalCompositeOperation = "destination-out";
  ox.drawImage(mc, 0, 0);
  ox.globalCompositeOperation = "source-over";

  // 3. Overlay onto the main canvas
  ctx.drawImage(oc, -dw / 2, -dh / 2);
}

// ── message handler ─────────────────────────────────────────────────────────

self.addEventListener("message", async (event) => {
  const { jobId, type, imageBlob, params } = event.data;

  try {
    const bitmap = await createImageBitmap(imageBlob);
    let dataUrl;

    if (type === "cropTransform") {
      dataUrl = await handleCropTransform(bitmap, params);
    } else if (type === "fitPreview") {
      dataUrl = await handleFitPreview(bitmap, params);
    } else {
      throw new Error(`Unknown job type: ${type}`);
    }

    bitmap.close();
    self.postMessage({ jobId, dataUrl });
  } catch (err) {
    self.postMessage({ jobId, error: err.message });
  }
});


// ── crop transform ──────────────────────────────────────────────────────────

async function handleCropTransform(bitmap, p) {
  const { refW, refH, bgColor, fitMode } = p;
  const t = p.transform;

  const cvs = new OffscreenCanvas(refW, refH);
  const ctx = cvs.getContext("2d");

  // Background fill
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, refW, refH);

  // Source crop region
  const hasCR = t.cx != null && (t.cx > 0 || t.cy > 0 || t.cw < 1 || t.ch < 1);
  const srcX = hasCR ? t.cx * bitmap.width : 0;
  const srcY = hasCR ? t.cy * bitmap.height : 0;
  const srcW = hasCR ? t.cw * bitmap.width : bitmap.width;
  const srcH = hasCR ? t.ch * bitmap.height : bitmap.height;

  // Transform parameters
  const ox = t.ox ?? 0, oy = t.oy ?? 0, sc = t.scale ?? 1;
  const fH = !!(t.flipH), fV = !!(t.flipV);
  const rot = (t.rotate || 0) * Math.PI / 180;
  const cosA = Math.abs(Math.cos(rot)), sinA = Math.abs(Math.sin(rot));

  // Rotated bounding box
  const rW = srcW * cosA + srcH * sinA;
  const rH = srcW * sinA + srcH * cosA;

  // Base fit scale (letterbox vs crop mode)
  const globalScale = p.globalScale ?? 1.0;
  const bf = fitMode === "crop"
    ? Math.max(refW / rW, refH / rH)
    : Math.min(refW / rW, refH / rH);
  const eff = bf * sc;
  const dw = srcW * eff, dh = srcH * eff;

  ctx.save();
  if (globalScale !== 1.0) {
    ctx.translate(refW / 2, refH / 2);
    ctx.scale(globalScale, globalScale);
    ctx.translate(-refW / 2, -refH / 2);
    
    // Explicit clip guarantees any image parts brought 'inside' the frame by scaling are cropped
    ctx.beginPath();
    ctx.rect(0, 0, refW, refH);
    ctx.clip();
  }

  ctx.translate(refW / 2 + ox * refW, refH / 2 + oy * refH);
  ctx.rotate(rot);
  ctx.scale(fH ? -1 : 1, fV ? -1 : 1);
  ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, -dw / 2, -dh / 2, dw, dh);

  // Lasso mask overlay
  const tOps = t.lassoOps;
  if (tOps && tOps.length > 0) {
    applyLassoMask(ctx, tOps, t.lassoInverted, dw, dh, bgColor);
  }

  ctx.restore();

  // Convert to data URL via blob → base64
  const blob = await cvs.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  const arrayBuf = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return "data:image/jpeg;base64," + btoa(binary);
}


// ── fit preview (letterbox / crop) ──────────────────────────────────────────

async function handleFitPreview(bitmap, p) {
  const { targetW, targetH, mode, bgColor } = p;

  const cvs = new OffscreenCanvas(targetW, targetH);
  const ctx = cvs.getContext("2d");

  // Always fill bg first – critical for blank/solid panels in any fit mode
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, targetW, targetH);

  const globalScale = p.globalScale ?? 1.0;
  
  ctx.save();
  if (globalScale !== 1.0) {
    ctx.translate(targetW / 2, targetH / 2);
    ctx.scale(globalScale, globalScale);
    ctx.translate(-targetW / 2, -targetH / 2);
    
    ctx.beginPath();
    ctx.rect(0, 0, targetW, targetH);
    ctx.clip();
  }

  const baseScale = mode === "letterbox" 
    ? Math.min(targetW / bitmap.width, targetH / bitmap.height)
    : Math.max(targetW / bitmap.width, targetH / bitmap.height);
  
  const dw = bitmap.width * baseScale, dh = bitmap.height * baseScale;
  const dx = (targetW - dw) / 2, dy = (targetH - dh) / 2;
  
  ctx.drawImage(bitmap, dx, dy, dw, dh);

  ctx.restore();

  // Convert to data URL via blob
  const blob = await cvs.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  const arrayBuf = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return "data:image/jpeg;base64," + btoa(binary);
}
