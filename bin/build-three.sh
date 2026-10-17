#!/usr/bin/env bash
# Rebuilds public/vendor/three/three-viewer.js: the parts of three.js the 3D artifact viewer uses (renderer,
# OrbitControls, GLTF/STL/OBJ loaders) as one minified ES module, so the page needs no bundler, import map or CDN.
# Pinned versions; the output is checked in. Usage: bin/build-three.sh
set -euo pipefail
THREE=0.186.1
ESBUILD=0.25.11
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/public/vendor/three"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
npm pack --silent "three@$THREE" >/dev/null
mkdir -p node_modules/three
tar xzf "three-$THREE.tgz" -C node_modules/three --strip-components=1
cat > entry.js <<'JS'
export { Scene, PerspectiveCamera, WebGLRenderer, Box3, Vector3, Color, HemisphereLight, DirectionalLight, AmbientLight, Mesh, MeshStandardMaterial, Group, GridHelper, DoubleSide, SRGBColorSpace, REVISION } from "three";
export { OrbitControls } from "three/addons/controls/OrbitControls.js";
export { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
export { STLLoader } from "three/addons/loaders/STLLoader.js";
export { OBJLoader } from "three/addons/loaders/OBJLoader.js";
JS
mkdir -p "$out"
npx -y "esbuild@$ESBUILD" entry.js --bundle --format=esm --minify --legal-comments=eof --log-level=warning \
  --banner:js="/* three.js $THREE (MIT, see LICENSE). Built by bin/build-three.sh with esbuild $ESBUILD. Do not edit. */" \
  --outfile="$out/three-viewer.js"
cp node_modules/three/LICENSE "$out/LICENSE"
echo "wrote $out/three-viewer.js ($(wc -c < "$out/three-viewer.js") bytes)"
