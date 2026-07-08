// One-off: rasterize public/icon.svg to PNGs at the sizes a PWA manifest needs.
// Run from app/: node scripts/generate-pwa-icons.mjs
import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "..", "public");

const svg = await readFile(join(PUBLIC, "icon.svg"));

const targets = [
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
  { name: "apple-touch-icon.png", size: 180 },
];

for (const t of targets) {
  const out = await sharp(svg, { density: 384 })
    .resize(t.size, t.size)
    .png()
    .toBuffer();
  await writeFile(join(PUBLIC, t.name), out);
  console.log(`wrote public/${t.name} (${t.size}x${t.size}, ${out.length} bytes)`);
}
