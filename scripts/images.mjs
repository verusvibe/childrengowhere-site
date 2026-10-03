// Local-only image pipeline. Outputs are committed so CI never needs sharp.
// Usage: npm run images
import sharp from 'sharp';
import { mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'source-images');
const OUT = path.join(root, 'src/assets/img');
const ICONS = path.join(root, 'src/assets/icons');

const WIDTHS = [320, 480, 640, 960];
// The marketing frames carry a headline above the phone; the "phone" variant drops it.
const PHONE_CROP = { left: 0, top: 590, width: 1284, height: 2188 };

const FORMATS = {
  avif: (s) => s.avif({ quality: 48, effort: 5 }),
  webp: (s) => s.webp({ quality: 76, effort: 5 }),
  jpg: (s) => s.jpeg({ quality: 74, mozjpeg: true }),
};

async function cleanDir(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

async function screenshots() {
  const files = (await readdir(SRC)).filter((f) => /^\d\d_iphone65_.*\.png$/.test(f)).sort();
  const manifest = {};
  for (const file of files) {
    const n = file.slice(0, 2);
    for (const variant of ['full', 'phone']) {
      const id = `shot-${n}-${variant}`;
      const base = () => {
        const s = sharp(path.join(SRC, file));
        return variant === 'phone' ? s.extract(PHONE_CROP) : s;
      };
      const meta = variant === 'phone'
        ? { width: PHONE_CROP.width, height: PHONE_CROP.height }
        : { width: 1284, height: 2778 };
      manifest[id] = { ...meta, widths: WIDTHS };
      for (const w of WIDTHS) {
        for (const [ext, encode] of Object.entries(FORMATS)) {
          const out = path.join(OUT, `${id}-${w}.${ext}`);
          await encode(base().resize({ width: w })).toFile(out);
        }
      }
      console.log('  ✓', id);
    }
  }
  return manifest;
}

async function appIcons(manifest) {
  const src = path.join(SRC, 'brand/app-icon-1024.png');
  // Header logo (keeps the icon's own rounded corners).
  for (const size of [48, 96]) {
    await sharp(src).resize(size, size).png({ compressionLevel: 9 }).toFile(path.join(OUT, `app-icon-${size}.png`));
    await sharp(src).resize(size, size).webp({ quality: 85 }).toFile(path.join(OUT, `app-icon-${size}.webp`));
  }
  manifest['app-icon'] = { width: 96, height: 96, widths: [48, 96] };

  // iOS applies its own mask, so the touch icon must be full-bleed (no transparency).
  await sharp(src).resize(180, 180).flatten({ background: '#F2573F' }).png({ compressionLevel: 9 })
    .toFile(path.join(ICONS, 'apple-touch-icon.png'));
  for (const size of [192, 512]) {
    await sharp(src).resize(size, size).png({ compressionLevel: 9 }).toFile(path.join(ICONS, `icon-${size}.png`));
  }
  const png16 = await sharp(src).resize(16, 16).png().toBuffer();
  const png32 = await sharp(src).resize(32, 32).png().toBuffer();
  await writeFile(path.join(ICONS, 'favicon-16.png'), png16);
  await writeFile(path.join(ICONS, 'favicon-32.png'), png32);
  await writeFile(path.join(ICONS, 'favicon.ico'), buildIco([[16, png16], [32, png32]]));
  console.log('  ✓ icons');
}

// The three-colour wordmark as an image: a logotype is exempt from text-contrast rules,
// and an image renders identically on every platform (no dependence on a rounded system font).
async function wordmark(manifest) {
  const font = `'Arial Rounded MT Bold','Helvetica Neue',Arial,sans-serif`;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="3400" height="520">` +
    `<text x="40" y="380" font-family="${font}" font-weight="800" font-size="320" letter-spacing="-6">` +
    `<tspan fill="#2978F5">Children</tspan><tspan fill="#FFC240">Go</tspan><tspan fill="#FF636E">Where</tspan></text></svg>`);
  const trimmed = await sharp(svg).trim().png().toBuffer();
  const { data, info } = await sharp(trimmed).resize({ width: 600 }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  await writeFile(path.join(OUT, 'wordmark-600.png'), data);
  await sharp(data).webp({ quality: 90, alphaQuality: 100 }).toFile(path.join(OUT, 'wordmark-600.webp'));
  manifest.wordmark = { width: info.width, height: info.height, widths: [600] };
  console.log(`  ✓ wordmark ${info.width}x${info.height}`);
}

// Minimal ICO container that embeds PNG frames.
function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = 6 + frames.length * 16;
  const entries = frames.map(([size, data]) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size, 0);
    e.writeUInt8(size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...frames.map(([, d]) => d)]);
}

async function ogImage() {
  const W = 1200, H = 630;
  // The phone runs off the bottom edge of the card; only the top corners are rounded.
  const shotH = H - 70;
  const shot = await sharp(path.join(SRC, '01_iphone65_1284x2778.png'))
    .extract(PHONE_CROP).resize({ width: 400 })
    .extract({ left: 0, top: 0, width: 400, height: shotH }).png().toBuffer();
  const mask = Buffer.from(
    `<svg width="400" height="${shotH}"><rect width="400" height="${shotH + 60}" rx="34" fill="#fff"/></svg>`);
  const rounded = await sharp(shot).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();

  const font = `'Arial Rounded MT Bold','Helvetica Neue',Arial,sans-serif`;
  const svg = Buffer.from(`
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#E0F0FF"/><stop offset="0.55" stop-color="#FFF5D9"/><stop offset="1" stop-color="#FFE0E6"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <circle cx="1130" cy="90" r="140" fill="#8CD99E" opacity="0.28"/>
  <circle cx="60" cy="600" r="150" fill="#2978F5" opacity="0.12"/>
  <text x="72" y="190" font-family="${font}" font-weight="800" font-size="66">
    <tspan fill="#2978F5">Children</tspan><tspan fill="#FFC240">Go</tspan><tspan fill="#FF636E">Where</tspan>
  </text>
  <text x="72" y="300" font-family="${font}" font-weight="700" font-size="46" fill="#17202E">Kid-friendly places &amp;</text>
  <text x="72" y="356" font-family="${font}" font-weight="700" font-size="46" fill="#17202E">events in Singapore</text>
  <text x="72" y="430" font-family="Helvetica Neue,Arial,sans-serif" font-size="30" fill="#4A5568">Filter by age, budget and weather.</text>
  <rect x="72" y="480" width="330" height="64" rx="32" fill="#1F63D6"/>
  <text x="237" y="522" text-anchor="middle" font-family="Helvetica Neue,Arial,sans-serif" font-weight="700" font-size="27" fill="#fff">Free for iPhone</text>
</svg>`);
  await sharp(svg).composite([{ input: rounded, left: 720, top: 70 }]).png({ compressionLevel: 9 })
    .toFile(path.join(OUT, 'og-image.png'));
  console.log('  ✓ og-image');
}

if (process.argv.includes('--og')) {
  await ogImage();
  process.exit(0);
}

await cleanDir(OUT);
await mkdir(ICONS, { recursive: true });
console.log('Screenshots');
const manifest = await screenshots();
await appIcons(manifest);
await wordmark(manifest);
await ogImage();
await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Done.');
