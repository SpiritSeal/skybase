// Generate the PNG icons referenced by the PWA manifest and iOS home
// screen from the source SVG. The SVG (`public/favicon.svg`) is the only
// thing you should hand-edit; rerun this script to regenerate the PNGs:
//
//   pnpm --filter @skybase/web gen-icons
//
// Output paths must match what's referenced in:
//   - apps/web/index.html (apple-touch-icon)
//   - apps/web/vite.config.ts (PWA manifest icons)
//
// We don't generate a .ico file — modern browsers all accept SVG via
// <link rel="icon" type="image/svg+xml" href="/favicon.svg">, and the
// only place that needs PNG fallback is iOS home screen.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "../public");
const sourceSvg = resolve(publicDir, "favicon.svg");

const targets = [
  // PWA manifest icons
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
  // iOS home screen — Apple wants 180x180 specifically
  { name: "apple-touch-icon.png", size: 180 },
  // 32x32 fallback for browsers that don't speak SVG favicons (rare)
  { name: "favicon-32.png", size: 32 },
];

async function main() {
  const svg = await readFile(sourceSvg);
  await mkdir(publicDir, { recursive: true });

  for (const t of targets) {
    const out = resolve(publicDir, t.name);
    await sharp(svg, { density: 384 })
      .resize(t.size, t.size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(out);
    console.log(`✓ ${t.name} (${t.size}×${t.size})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
