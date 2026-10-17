// A minimal valid binary glTF (GLB) of axis-aligned boxes, for tests: positions and indices in one buffer, one mesh.
// The same shape a stdlib-only Python generator writes with struct and json.
export function boxesGlb(boxes) {
  const pos = [];
  const idx = [];
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const base = pos.length / 3;
    for (const [x, y, z] of [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]) pos.push(x, y, z);
    for (const f of [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3]) idx.push(base + f);
  }
  const posBytes = Buffer.from(new Float32Array(pos).buffer);
  const idxBytes = Buffer.from(new Uint32Array(idx).buffer);
  const min = [0, 1, 2].map((a) => Math.min(...pos.filter((_, i) => i % 3 === a)));
  const max = [0, 1, 2].map((a) => Math.max(...pos.filter((_, i) => i % 3 === a)));
  const json = {
    asset: { version: "2.0", generator: "grok-deck test" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: posBytes.length + idxBytes.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 }, { buffer: 0, byteOffset: posBytes.length, byteLength: idxBytes.length, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min, max }, { bufferView: 1, componentType: 5125, count: idx.length, type: "SCALAR" }],
  };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat([posBytes, idxBytes]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(body.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, body]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, bin)]);
}

// An L-bracket: a base plate and an upright, in metres. height changes the upright, for a second version.
export const bracket = (height = 0.06) => boxesGlb([[0, 0, 0, 0.08, 0.005, 0.03], [0, 0, 0, 0.005, height, 0.03]]);
