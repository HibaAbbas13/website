// Bundle the public storefront into one minified ESM file.
// Shoppers previously downloaded firebase-app + firebase-firestore as separate
// CDN modules (~790KB raw). One hashed bundle cuts that and lets us cache forever.

import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = join(root, "public", "assets", "b");
const shopHtml = join(root, "public", "shop.html");

// Drop previous hashed storefront bundles so deploys don't accumulate junk.
try {
  for (const name of readdirSync(bundleDir)) {
    if (/^shop\.[a-zA-Z0-9]+\.js(\.map)?$/.test(name)) {
      unlinkSync(join(bundleDir, name));
    }
  }
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: ["public/assets/shop.js"],
  bundle: true,
  format: "esm",
  minify: true,
  target: ["es2020"],
  outdir: "public/assets/b",
  entryNames: "shop.[hash]",
  // Keep model-viewer as a runtime fetch — most shops never need the ~1MB file.
  external: ["https://cdn.jsdelivr.net/*"],
  logLevel: "info",
  metafile: true,
  sourcemap: false,
});

const outputs = Object.keys(result.metafile.outputs).filter((p) =>
  /\/assets\/b\/shop\.[a-zA-Z0-9]+\.js$/.test(p.replace(/\\/g, "/"))
);
if (outputs.length !== 1) {
  throw new Error(`Expected one shop bundle, got: ${outputs.join(", ") || "(none)"}`);
}
const bundlePath = "/assets/b/" + outputs[0].split(/[/\\]/).pop();

let html = readFileSync(shopHtml, "utf8");
const patched = html.replace(
  /(href|src)="\/assets\/(?:b\/shop\.[a-zA-Z0-9]+\.js|shop\.bundle\.js)"/g,
  `$1="${bundlePath}"`
);
if (patched === html && !html.includes(bundlePath)) {
  throw new Error("shop.html did not contain a storefront script src to rewrite");
}
writeFileSync(shopHtml, patched);
console.log(`storefront → ${bundlePath}`);
