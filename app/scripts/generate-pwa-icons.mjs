import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");
const sourceSvg = resolve(appRoot, "public/icons/clipmind-icon.svg");
const outputDir = resolve(appRoot, "public/icons");

const outputs = [
  ["clipmind-192.png", 192],
  ["clipmind-512.png", 512],
  ["clipmind-maskable-512.png", 512]
];

await mkdir(outputDir, { recursive: true });

await Promise.all(
  outputs.map(([fileName, size]) =>
    sharp(sourceSvg)
      .resize(size, size)
      .png()
      .toFile(resolve(outputDir, fileName))
  )
);

console.log("Generated ClipMind PWA icons.");
