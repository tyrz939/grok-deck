// The 3D artifact viewer: a GLB, glTF, STL or OBJ from the artifact store, drawn with the vendored three.js bundle
// (public/vendor/three/three-viewer.js, built by bin/build-three.sh) and turned with OrbitControls: drag to rotate,
// pinch or wheel to zoom, two fingers or right drag to pan. Loaded only when a model is opened.
// The viewer fetches nothing but the version's own bytes. A glTF that points at files outside itself (a .bin or a
// texture beside it) is refused with a note; only self-contained files (GLB, or glTF with data: URIs) are drawn.

let three = null;
const loadThree = () => (three ||= import("./vendor/three/three-viewer.js"));

export class ExternalRefs extends Error {}

// The external URIs a glTF document names. Anything but data: is outside the file.
export function externalUris(json) {
  const out = [];
  for (const list of [json?.buffers, json?.images]) {
    for (const item of Array.isArray(list) ? list : []) if (typeof item?.uri === "string" && !item.uri.startsWith("data:")) out.push(item.uri);
  }
  return out;
}

// The JSON chunk of a GLB, or null when the bytes are not one.
export function glbJson(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) return null;
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > buffer.byteLength) return null;
  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)));
  } catch {
    return null;
  }
}

const neutral = (T) => new T.MeshStandardMaterial({ color: 0x9aa4b2, roughness: 0.55, metalness: 0.1, side: T.DoubleSide });

async function parse(T, buffer, ext) {
  if (ext === "glb" || ext === "gltf") {
    const json = ext === "glb" ? glbJson(buffer) : JSON.parse(new TextDecoder().decode(buffer));
    if (!json) throw new Error("not a GLB");
    if (externalUris(json).length) throw new ExternalRefs("external");
    const loader = new T.GLTFLoader();
    // Defence in depth: nothing but the file's own data: and blob: URLs may load.
    loader.manager.setURLModifier((url) => (/^(data|blob):/.test(url) ? url : "data:,"));
    const gltf = await loader.parseAsync(buffer, "");
    // There is no environment map, so a fully metallic surface would draw black. A primitive with no material gets
    // glTF's default (white, metalness 1): it is drawn with the neutral material instead, and metalness is capped.
    const plain = gltf.parser.json.meshes?.some((m) => m.primitives?.some((p) => p.material == null));
    const fallback = neutral(T);
    gltf.scene.traverse((node) => {
      if (!node.isMesh) return;
      for (const m of [].concat(node.material)) {
        if (plain && m.name === "" && m.metalness === 1 && m.roughness === 1 && !m.map) node.material = fallback;
        else if (m.metalness > 0.4 && !m.metalnessMap) m.metalness = 0.4;
      }
    });
    return gltf.scene;
  }
  const material = neutral(T);
  if (ext === "stl") {
    const geometry = new T.STLLoader().parse(buffer);
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    return new T.Mesh(geometry, material);
  }
  const group = new T.OBJLoader().parse(new TextDecoder().decode(buffer));
  group.traverse((node) => {
    if (node.isMesh) node.material = material;
  });
  return group;
}

function triangles(root) {
  let count = 0;
  root.traverse((node) => {
    const g = node.isMesh && node.geometry;
    if (g) count += Math.round((g.index ? g.index.count : g.attributes.position?.count || 0) / 3);
  });
  return count;
}

const round = (n) => (Math.abs(n) >= 1000 ? Math.round(n) : Number(n.toPrecision(3)));

// Draws the model at url into host. Returns { reset, dispose } and fills info({ size, triangles }) once drawn.
export async function mountModel(host, url, ext, info) {
  const T = await loadThree();
  const res = await fetch(url);
  if (!res.ok) throw new Error("gone");
  const object = await parse(T, await res.arrayBuffer(), ext);

  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.className = "model-canvas";
  canvas.setAttribute("aria-label", "3D model. Drag to rotate, pinch or scroll to zoom.");
  canvas.setAttribute("role", "img");
  host.append(canvas);

  const scene = new T.Scene();
  scene.add(new T.HemisphereLight(0xffffff, 0x445566, 1.6), new T.AmbientLight(0xffffff, 0.5));
  const camera = new T.PerspectiveCamera(40, 1, 0.001, 1000);
  const key = new T.DirectionalLight(0xffffff, 1.8);
  key.position.set(1, 2, 3);
  camera.add(key);
  scene.add(camera);
  scene.add(object);

  // Frame the model: centred, the whole bounding sphere in view, seen from above and to one side.
  const box = new T.Box3().setFromObject(object);
  const size = box.getSize(new T.Vector3());
  const center = box.getCenter(new T.Vector3());
  const radius = Math.max(size.length() / 2, 1e-6);
  // The narrower of the vertical and horizontal field of view decides, so a tall phone panel does not clip the sides.
  const half = (aspect) => Math.min((camera.fov * Math.PI) / 360, Math.atan(Math.tan((camera.fov * Math.PI) / 360) * aspect));
  const distanceFor = (aspect) => radius / Math.sin(half(aspect)) * 1.1;
  const distance = distanceFor(1);
  const view = new T.Vector3(1, 0.8, 1.3).normalize();
  camera.near = distance / 1000;
  camera.far = distance * 100;

  const controls = new T.OrbitControls(camera, canvas);
  controls.target.copy(center);
  controls.minDistance = distance / 50;
  controls.maxDistance = distance * 50;

  const render = () => renderer.render(scene, camera);
  let moved = false;
  const reset = () => {
    moved = false;
    camera.position.copy(view).multiplyScalar(distanceFor(camera.aspect)).add(center);
    controls.target.copy(center);
    camera.updateProjectionMatrix();
    controls.update();
    render();
  };
  controls.addEventListener("change", render);
  // Until the view is turned, a resize reframes it (the caption below can wrap after the first draw).
  controls.addEventListener("start", () => { moved = true; });

  const fit = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (moved) render();
    else reset();
  };
  const watch = new ResizeObserver(fit);
  watch.observe(host);
  fit();

  info?.({ size: [round(size.x), round(size.y), round(size.z)], triangles: triangles(object) });
  host.dataset.model = "ready";
  host.dataset.dims = [size.x, size.y, size.z].map((n) => n.toFixed(4)).join("x");

  return {
    reset,
    dispose() {
      watch.disconnect();
      controls.dispose();
      object.traverse((node) => {
        node.geometry?.dispose?.();
        for (const m of [].concat(node.material || [])) m.dispose?.();
      });
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
      delete host.dataset.model;
    },
  };
}
