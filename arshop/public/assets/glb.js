// Builds a glTF 2.0 binary (.glb) containing a single textured rectangle, sized
// in real-world metres, from a product photo.
//
// Why this exists: a photo carries no depth, so it can never become a true 3D
// model. What it *can* become is a flat panel standing on the floor at the
// product's actual size — a cardboard standee. For flat goods (rugs, posters,
// wall art, boxes, laid-out clothing) that reads as genuinely correct, and for
// solid objects it still answers the question customers actually have: "how big
// is this in my room?"
//
// Written by hand rather than with a glTF library: the whole file is four
// vertices, two triangles and one texture, and shipping a mesh library to every
// dashboard visitor to emit ~500 bytes of geometry would be absurd.
//
// <model-viewer> generates the iOS USDZ from this GLB on the fly when `ios-src`
// isn't set, so one file covers AR on both Android and iPhone.

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/** glTF requires every bufferView to start on a 4-byte boundary. */
function pad4(n) {
  return (4 - (n % 4)) % 4;
}

/**
 * Decode an image blob and re-encode it at a texture-friendly size.
 *
 * Alpha is preserved only when the source actually has it: a PNG keeps its
 * transparency (so a cut-out product floats correctly in the room), while a
 * JPEG is re-encoded as JPEG, because forcing it to PNG would quadruple the
 * file size to store an alpha channel that is entirely opaque.
 */
export async function prepareTexture(source, maxEdge = 1024) {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const keepAlpha = source.type === "image/png" || source.type === "image/webp";
  const mimeType = keepAlpha ? "image/png" : "image/jpeg";
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, mimeType, 0.86)
  );
  bitmap.close?.();

  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mimeType,
    hasAlpha: keepAlpha,
    aspect: canvas.width / canvas.height,
  };
}

/**
 * Assemble the .glb bytes. Deliberately free of DOM APIs — `prepareTexture`
 * does the canvas work — so this half can be unit-tested under Node against the
 * Khronos glTF validator, which is a far stronger check than eyeballing a render.
 *
 * @param {{bytes:Uint8Array, mimeType:string, hasAlpha:boolean, aspect:number}} tex
 * @param {number} widthMeters real-world width of the product
 * @returns {Uint8Array} the complete GLB
 */
export function buildStandeeGlb(tex, widthMeters) {
  const w = Math.max(0.01, widthMeters);
  const h = w / (tex.aspect || 1);

  // Quad stands upright on the floor: origin at the bottom centre, +Y up,
  // facing +Z. AR placement puts the origin on the detected surface, so this
  // makes the product stand on the floor rather than sink halfway into it.
  const hw = w / 2;
  const positions = new Float32Array([
    -hw, h, 0,   // 0 top-left
     hw, h, 0,   // 1 top-right
    -hw, 0, 0,   // 2 bottom-left
     hw, 0, 0,   // 3 bottom-right
  ]);
  const normals = new Float32Array([
    0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
  ]);
  // glTF UV origin is top-left, V increasing downward.
  const uvs = new Float32Array([
    0, 0,  1, 0,  0, 1,  1, 1,
  ]);
  // Counter-clockwise seen from +Z, so the front face points at the viewer.
  const indices = new Uint16Array([0, 2, 1, 1, 2, 3]);

  const parts = [positions, normals, uvs, indices, tex.bytes];
  const views = [];
  let offset = 0;
  for (const part of parts) {
    const bytes = part.byteLength;
    views.push({ byteOffset: offset, byteLength: bytes });
    offset += bytes + pad4(bytes);
  }
  const binLength = offset;

  const bin = new Uint8Array(binLength);
  parts.forEach((part, i) => {
    const src = new Uint8Array(
      part.buffer ? part.buffer : part,
      part.byteOffset || 0,
      part.byteLength
    );
    bin.set(src, views[i].byteOffset);
  });

  const gltf = {
    asset: { version: "2.0", generator: "arshop photo-standee" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "Product" }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
            indices: 3,
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        // Visible from behind too — a one-sided panel would vanish when the
        // customer walks around it, which looks broken rather than intentional.
        doubleSided: true,
        // MASK not BLEND: blended surfaces need depth sorting that AR viewers
        // handle inconsistently, and a cut-out only needs a hard edge.
        ...(tex.hasAlpha ? { alphaMode: "MASK", alphaCutoff: 0.5 } : {}),
      },
    ],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: [{ bufferView: 4, mimeType: tex.mimeType }],
    accessors: [
      {
        bufferView: 0, componentType: FLOAT, count: 4, type: "VEC3",
        min: [-hw, 0, 0], max: [hw, h, 0], // required on POSITION
      },
      { bufferView: 1, componentType: FLOAT, count: 4, type: "VEC3" },
      { bufferView: 2, componentType: FLOAT, count: 4, type: "VEC2" },
      { bufferView: 3, componentType: UNSIGNED_SHORT, count: 6, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, ...views[0], target: ARRAY_BUFFER },
      { buffer: 0, ...views[1], target: ARRAY_BUFFER },
      { buffer: 0, ...views[2], target: ARRAY_BUFFER },
      { buffer: 0, ...views[3], target: ELEMENT_ARRAY_BUFFER },
      { buffer: 0, ...views[4] }, // image data carries no target
    ],
    buffers: [{ byteLength: binLength }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = pad4(jsonBytes.length);
  const jsonLength = jsonBytes.length + jsonPad;

  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);

  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  bytes.set(jsonBytes, 20);
  // The JSON chunk pads with spaces; the BIN chunk pads with zeroes.
  bytes.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);

  const binHeader = 20 + jsonLength;
  view.setUint32(binHeader, binLength, true);
  view.setUint32(binHeader + 4, CHUNK_BIN, true);
  bytes.set(bin, binHeader + 8);

  return bytes;
}

/**
 * @param {Blob} photo         the product image
 * @param {number} widthMeters real-world width of the product
 * @returns {Promise<Blob>}    a .glb ready to upload
 */
export async function photoToStandeeGlb(photo, widthMeters) {
  const tex = await prepareTexture(photo);
  return new Blob([buildStandeeGlb(tex, widthMeters)], {
    type: "model/gltf-binary",
  });
}
