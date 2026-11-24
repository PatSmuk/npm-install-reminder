// Renders images/icon.svg to images/icon.png (VS Code requires a PNG icon).
// Usage: node scripts/render-icon.mjs [size] [output]
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const size = Number(process.argv[2] ?? 256);
const out = process.argv[3] ?? `${root}images/icon.png`;

const svg = readFileSync(`${root}images/icon.svg`);
const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
writeFileSync(out, png);
console.log(`wrote ${out} (${size}x${size})`);
