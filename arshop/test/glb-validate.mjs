// Validates generated standee GLBs against the official Khronos glTF validator.
//
//   cd arshop/test && npm install gltf-validator && node glb-validate.mjs
//
// Worth keeping: glb.js writes the binary container by hand, and a malformed
// GLB fails *silently* in most viewers — model-viewer emits neither a load nor
// an error event, it simply shows nothing. This catches that at the source
// instead of during a customer demo.

import validator from "gltf-validator";
import { buildStandeeGlb } from "../public/assets/glb.js";

// 2x2 PNG with alpha, and a 1x1 JPEG — enough for the validator to confirm the
// embedded image decodes and matches its declared mimeType.
const PNG_2x2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYEJxIAB" +
    "AAr3AgFvKQeCAAAAAElFTkSuQmCC",
  "base64"
);
const JPEG_1x1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

const cases = [
  {
    name: "PNG cut-out, 30cm wide, 2:3 portrait",
    tex: { bytes: new Uint8Array(PNG_2x2), mimeType: "image/png", hasAlpha: true, aspect: 2 / 3 },
    width: 0.3,
    expect: { w: 0.3, h: 0.45 },
  },
  {
    name: "JPEG opaque, 120cm wide, 16:9 landscape",
    tex: { bytes: new Uint8Array(JPEG_1x1), mimeType: "image/jpeg", hasAlpha: false, aspect: 16 / 9 },
    width: 1.2,
    expect: { w: 1.2, h: 0.675 },
  },
  {
    // Below the 0.01m floor: must clamp rather than emit a degenerate mesh,
    // which would pass validation but be invisible in AR.
    name: "sub-centimetre width (clamp path)",
    tex: { bytes: new Uint8Array(PNG_2x2), mimeType: "image/png", hasAlpha: true, aspect: 1 },
    width: 0.001,
    expect: { w: 0.01, h: 0.01 },
  },
];

let failed = 0;

for (const c of cases) {
  const glb = buildStandeeGlb(c.tex, c.width);
  const report = await validator.validateBytes(new Uint8Array(glb), {
    externalResourceFunction: () => Promise.reject("no external resources expected"),
  });
  const { numErrors, numWarnings } = report.issues;

  // Re-read the JSON chunk to confirm real-world sizing survived the write.
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  const [maxX, maxY] = json.accessors[0].max;
  const w = maxX * 2;
  const h = maxY;
  const sizeOk =
    Math.abs(w - c.expect.w) < 1e-6 && Math.abs(h - c.expect.h) < 1e-6;

  const ok = numErrors === 0 && sizeOk;
  if (!ok) failed++;

  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  console.log(
    `      ${glb.length} bytes · errors=${numErrors} warnings=${numWarnings} · ` +
      `${w.toFixed(3)}m x ${h.toFixed(3)}m ${sizeOk ? "" : `(expected ${c.expect.w}x${c.expect.h})`}`
  );
  for (const m of report.issues.messages) {
    console.log(`      [${m.severity === 0 ? "ERROR" : "WARN"}] ${m.code}: ${m.message} @ ${m.pointer}`);
  }
}

console.log(failed === 0 ? "\nAll cases are valid glTF 2.0." : `\n${failed} case(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
