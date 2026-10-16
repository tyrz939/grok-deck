// A small zip reader, enough for Office files: the central directory, stored and deflated entries, nothing else.
import zlib from "node:zlib";

const MAX_ENTRY = 40 * 1024 * 1024; // what one entry may inflate to (a zip bomb stops here)

export function zipEntries(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const out = [];
  for (let n = 0; n < count && at + 46 <= buffer.length && buffer.readUInt32LE(at) === 0x02014b50; n += 1) {
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    out.push({ name: buffer.toString("utf8", at + 46, at + 46 + nameLen), method, size, local });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function zipRead(buffer, entry) {
  const at = entry.local;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) return null;
  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
  const packed = buffer.subarray(start, start + entry.size);
  try {
    if (entry.method === 0) return packed;
    if (entry.method === 8) return zlib.inflateRawSync(packed, { maxOutputLength: MAX_ENTRY });
  } catch {
    return null;
  }
  return null;
}
