const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function sniff(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (buffer.length >= 6 && buffer.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "";
}

function fail(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function cleanImages(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw fail("Images must be a list", 400);
  if (input.length > 4) throw fail("Attach up to 4 images", 400);
  const images = [];
  for (const item of input) {
    const mime = String(item?.mime || item?.mimeType || "");
    if (!ALLOWED.has(mime)) throw fail("Use JPEG, PNG, WebP, or GIF", 400);
    const data = String(item?.data || "").replace(/\s/g, "");
    if (!data || data.length > 400_000 || !/^[A-Za-z0-9+/=]+$/.test(data)) throw fail("Image is too large", 413);
    const buffer = Buffer.from(data, "base64");
    if (!buffer.length || buffer.length > 280_000 || sniff(buffer) !== mime) throw fail("Image could not be read", 400);
    images.push({ mime, data });
  }
  return images;
}

export function promptBlocks(text, images) {
  const blocks = [];
  if (text) blocks.push({ type: "text", text });
  for (const image of images) blocks.push({ type: "image", mimeType: image.mime, data: image.data });
  return blocks;
}
