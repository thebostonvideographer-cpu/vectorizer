import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const files = ["index.html", "styles.css", "app.js"];
for (const file of files) {
  cpSync(join(root, file), join(dist, file));
}

mkdirSync(join(dist, "vendor", "vtracer"), { recursive: true });
for (const file of ["vtracer.js", "vtracer.wasm"]) {
  cpSync(
    join(root, "vendor", "vtracer", file),
    join(dist, "vendor", "vtracer", file)
  );
}

// Cloudflare Pages: ensure WASM is served with the correct MIME type
writeFileSync(
  join(dist, "_headers"),
  `/*
  X-Content-Type-Options: nosniff

/vendor/vtracer/*
  Access-Control-Allow-Origin: *

/*.wasm
  Content-Type: application/wasm
  Cache-Control: public, max-age=31536000, immutable
`
);

console.log("Built static site → dist/");
