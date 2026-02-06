import fs from "fs";
import path from "path";
import axios from "axios";
import sharp from "sharp";
import "dotenv/config";

const MODEL = "drawing-gpc4l/7";
const UPLOAD_DIR = "upload";
const OUTPUT_DIR = "outputs";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

function getDefaultImagePath() {
  const drawingPath = path.join(UPLOAD_DIR, "drawing.png");
  if (fs.existsSync(drawingPath)) return drawingPath;
  if (!fs.existsSync(UPLOAD_DIR)) return drawingPath;
  const files = fs.readdirSync(UPLOAD_DIR);
  const firstImage = files.find((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()));
  return firstImage ? path.join(UPLOAD_DIR, firstImage) : drawingPath;
}

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`Created ${OUTPUT_DIR}/`);
  }
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function detectAndCrop(imagePath) {
  const apiKey = process.env.ROBOFLOW_API_KEY;
  if (!apiKey) {
    console.error("Error: ROBOFLOW_API_KEY is not set.");
    console.error("Add it to a .env file (see .env.example) or export it.");
    process.exit(1);
  }

  const resolvedPath = path.resolve(imagePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: Image not found at ${resolvedPath}`);
    process.exit(1);
  }

  // Roboflow hosted API expects base64 body with application/x-www-form-urlencoded
  const imageBuffer = fs.readFileSync(resolvedPath);
  const imageBase64 = imageBuffer.toString("base64");

  const url = `https://detect.roboflow.com/${MODEL}`;
  const params = {
    api_key: apiKey,
    confidence: 33, // 45% threshold - include lower-confidence detections
    crop: true,
  };

  console.log("--- Input ---");
  console.log("Image path:", resolvedPath);
  console.log("Image size (bytes):", imageBuffer.length);
  console.log("Image base64 length:", imageBase64.length);
  console.log("Model:", MODEL);
  console.log("Request URL:", url);
  console.log("Params:", { ...params, api_key: params.api_key ? "[REDACTED]" : undefined });
  console.log("");

  const res = await axios.post(url, imageBase64, {
    params,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  console.log("--- API Response (full) ---");
  console.log(JSON.stringify(res.data, null, 2));
  console.log("");

  const predictions = res.data.predictions ?? [];
  console.log("--- Predictions ---");
  console.log("Total predictions:", predictions.length);

  predictions.forEach((p, i) => {
    console.log(`  [${i}] class: ${p.class}, confidence: ${p.confidence}, x: ${p.x}, y: ${p.y}, width: ${p.width}, height: ${p.height}`);
    console.log(`      has crop: ${!!p.crop}, crop type: ${typeof p.crop}, crop length: ${p.crop ? String(p.crop).length : 0}`);
  });
  console.log("");

  if (predictions.length === 0) {
    console.log("No objects detected. Nothing to crop.");
    return;
  }

  // Roboflow bbox format: x, y = center; width, height = size. Convert to left, top for Sharp.
  const imgMeta = res.data.image ?? {};
  const imgWidth = imgMeta.width ?? 0;
  const imgHeight = imgMeta.height ?? 0;

  ensureOutputDir();
  const baseName = path.basename(resolvedPath, path.extname(resolvedPath));
  let savedCount = 0;

  const image = sharp(resolvedPath);
  const metadata = await image.metadata();
  const actualWidth = metadata.width ?? imgWidth;
  const actualHeight = metadata.height ?? imgHeight;

  console.log("--- Cropping with Sharp ---");
  console.log("Image dimensions:", actualWidth, "x", actualHeight);
  console.log("");

  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i];
    // Center-based bbox from Roboflow -> top-left based for Sharp extract()
    let left = Math.round(p.x - p.width / 2);
    let top = Math.round(p.y - p.height / 2);
    let w = Math.round(p.width);
    let h = Math.round(p.height);

    // Clamp to image bounds
    left = Math.max(0, Math.min(left, actualWidth - 1));
    top = Math.max(0, Math.min(top, actualHeight - 1));
    w = Math.min(w, actualWidth - left);
    h = Math.min(h, actualHeight - top);
    if (w <= 0 || h <= 0) {
      console.log(`  [${i}] Skipping ${p.class} - invalid region after clamp`);
      continue;
    }

    const safeClass = sanitizeFilename(p.class || "object");
    const filename = `${OUTPUT_DIR}/${baseName}_${safeClass}_${i}.png`;

    await image
      .clone()
      .extract({ left, top, width: w, height: h })
      .png()
      .toFile(filename);

    console.log(`  [${i}] Saved: ${filename} (class: ${p.class}, confidence: ${p.confidence.toFixed(2)}, region: ${left},${top} ${w}x${h})`);
    savedCount += 1;
  }

  console.log("");
  console.log(`Done. ${savedCount} crop(s) saved to ${OUTPUT_DIR}/`);

  // Create annotated image: draw all detection boxes on the original with different colors
  const BOX_COLORS = [
    "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4",
    "#46f0f0", "#f032e6", "#bcf60c", "#fabebe", "#008080", "#e6beff",
    "#9a6324", "#fffac8", "#800000", "#aaffc3", "#808000", "#ffd8b1",
    "#000075", "#808080", "#ffffff", "#000000",
  ];
  const STROKE_WIDTH = Math.max(2, Math.min(8, Math.round(Math.min(actualWidth, actualHeight) / 500)));

  const rects = predictions.map((p, i) => {
    const left = Math.round(p.x - p.width / 2);
    const top = Math.round(p.y - p.height / 2);
    const w = Math.round(p.width);
    const h = Math.round(p.height);
    const color = BOX_COLORS[i % BOX_COLORS.length];
    return { left, top, w, h, color, class: p.class, index: i };
  });

  const fontSize = Math.max(12, Math.min(24, Math.round(Math.min(actualWidth, actualHeight) / 150)));
  const svgElements = rects
    .map((r) => {
      const label = `${r.index}: ${r.class}`;
      const textX = r.left;
      const textY = Math.max(r.top - 4, fontSize + 2);
      return `<rect x="${r.left}" y="${r.top}" width="${r.w}" height="${r.h}" fill="none" stroke="${r.color}" stroke-width="${STROKE_WIDTH}" />
  <text x="${textX}" y="${textY}" font-family="sans-serif" font-size="${fontSize}" fill="${r.color}" stroke="black" stroke-width="1">${escapeXml(label)}</text>`;
    })
    .join("\n  ");
  const svg = `<svg width="${actualWidth}" height="${actualHeight}" xmlns="http://www.w3.org/2000/svg">
  ${svgElements}
</svg>`;

  const overlayBuffer = await sharp(Buffer.from(svg))
    .resize(actualWidth, actualHeight)
    .png()
    .toBuffer();

  const annotatedPath = `${OUTPUT_DIR}/${baseName}_annotated.png`;
  await image
    .clone()
    .composite([{ input: overlayBuffer, top: 0, left: 0 }])
    .png()
    .toFile(annotatedPath);

  console.log("Annotated image (all boxes drawn):", annotatedPath);
}

const imagePath = process.argv[2] ?? getDefaultImagePath();
detectAndCrop(imagePath).catch((err) => {
  if (err.response) {
    console.error("Roboflow API error:", err.response.status, err.response.data);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});
