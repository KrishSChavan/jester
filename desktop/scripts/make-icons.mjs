/**
 * `npm run icons`: Jester's app icon, drawn here and written to desktop/icons:
 *
 *   jester.svg    the art, at 1024 on macOS's grid
 *   jester.png    the same, 1024 px
 *   Jester.icns   macOS: the app in the Dock, Finder, permission prompts
 *   Jester.ico    Windows: the window and taskbar
 *
 * and, to src/web/icons, his website's as an app on a phone's Home Screen (`npm run icons -- --web` writes only those):
 *
 *   apple-touch-icon.png   180 px, the square filled: an iPhone rounds its corners itself
 *   icon-192.png, icon-512.png   Windows' look (the rounded square on clear), for an install prompt and a desktop
 *   maskable-512.png       the square filled, the art inside Android's safe circle, for its launcher's own shape
 *
 * The art is code: the extension's raised hand, in front of a globe of dots
 * like his orb's, on the extension's purple-to-green. On a Mac it sits in the
 * system's rounded square with a 100 px margin around it (Apple's grid, which
 * the Dock expects); on Windows the square fills the canvas. Below 64 px the
 * dots and shadows would be mud, so the small sizes draw the hand alone, larger.
 *
 * Electron draws the SVG at each size (Chromium, as his pages are drawn);
 * iconutil packs the macOS file, and the .ico is PNGs in Windows' wrapper.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const out = path.resolve(path.dirname(here), '../icons');

/**
 * The rounded square: Apple's "continuous" corners (a curve that eases into
 * the straight sides, not a quarter circle), `size` across from `at`, with
 * corners of radius `radius`. The constants are the well-known fit of
 * UIBezierPath's continuous rounded rect.
 */
function squircle(at, size, radius = size * 0.225) {
  const r = Math.min(radius, size / 2 / 1.52866483);
  const [x0, y0, x1, y1] = [at, at, at + size, at + size];
  const n = (v) => v.toFixed(2);
  const k = [1.52866483, 1.08849323, 0.86840689, 0.63149379, 0.074911, 0.37282392, 0.16905228].map((c) => c * r);
  const [a, b, c, d, e, f, g] = k;
  return [
    `M${n(x0 + a)} ${n(y0)}`,
    `L${n(x1 - a)} ${n(y0)}`,
    `C${n(x1 - b)} ${n(y0)} ${n(x1 - c)} ${n(y0)} ${n(x1 - d)} ${n(y0 + e)}`,
    `C${n(x1 - f)} ${n(y0 + g)} ${n(x1 - g)} ${n(y0 + f)} ${n(x1 - e)} ${n(y0 + d)}`,
    `C${n(x1)} ${n(y0 + c)} ${n(x1)} ${n(y0 + b)} ${n(x1)} ${n(y0 + a)}`,
    `L${n(x1)} ${n(y1 - a)}`,
    `C${n(x1)} ${n(y1 - b)} ${n(x1)} ${n(y1 - c)} ${n(x1 - e)} ${n(y1 - d)}`,
    `C${n(x1 - g)} ${n(y1 - f)} ${n(x1 - f)} ${n(y1 - g)} ${n(x1 - d)} ${n(y1 - e)}`,
    `C${n(x1 - c)} ${n(y1)} ${n(x1 - b)} ${n(y1)} ${n(x1 - a)} ${n(y1)}`,
    `L${n(x0 + a)} ${n(y1)}`,
    `C${n(x0 + b)} ${n(y1)} ${n(x0 + c)} ${n(y1)} ${n(x0 + d)} ${n(y1 - e)}`,
    `C${n(x0 + f)} ${n(y1 - g)} ${n(x0 + g)} ${n(y1 - f)} ${n(x0 + e)} ${n(y1 - d)}`,
    `C${n(x0)} ${n(y1 - c)} ${n(x0)} ${n(y1 - b)} ${n(x0)} ${n(y1 - a)}`,
    `L${n(x0)} ${n(y0 + a)}`,
    `C${n(x0)} ${n(y0 + b)} ${n(x0)} ${n(y0 + c)} ${n(x0 + e)} ${n(y0 + d)}`,
    `C${n(x0 + g)} ${n(y0 + f)} ${n(x0 + f)} ${n(y0 + g)} ${n(x0 + d)} ${n(y0 + e)}`,
    `C${n(x0 + c)} ${n(y0)} ${n(x0 + b)} ${n(y0)} ${n(x0 + a)} ${n(y0)}`,
    'Z'
  ].join('');
}

/** The orb: dots on a tilted globe, the far ones smaller and fainter, drawn back to front. */
function orbDots({ cx, cy, radius, count = 340 }) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const [tilt, turn] = [0.42, 0.5];
  const dots = [];
  for (let i = 0; i < count; i++) {
    const y0 = 1 - (i / (count - 1)) * 2;
    const ring = Math.sqrt(1 - y0 * y0);
    const x0 = Math.cos(golden * i) * ring;
    const z0 = Math.sin(golden * i) * ring;
    // Tipped towards the viewer, then turned, so the poles aren't straight up.
    const y1 = y0 * Math.cos(tilt) - z0 * Math.sin(tilt);
    const z1 = y0 * Math.sin(tilt) + z0 * Math.cos(tilt);
    const x = x0 * Math.cos(turn) + z1 * Math.sin(turn);
    const z = -x0 * Math.sin(turn) + z1 * Math.cos(turn);
    const near = (z + 1) / 2;
    dots.push({ x: cx + radius * x, y: cy + radius * y1, r: 2.6 + 4.2 * near, o: 0.1 + 0.62 * near ** 1.6, z });
  }
  dots.sort((a, b) => a.z - b.z);
  return dots.map((d) => `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${d.r.toFixed(2)}" fill-opacity="${d.o.toFixed(3)}"/>`).join('');
}

/**
 * The raised hand as one outline (separate shapes leave hairline seams where
 * their edges meet), in a 1024 square with its middle at (0, 0). Four fingers
 * 72 wide with 14 between, a palm 330 by 275, and a thumb 78 wide at 45
 * degrees, its web with the first finger curved rather than a notch.
 */
function hand() {
  const r = 36;
  const gap = 7;
  // [left edge, top] of each finger: index, middle, ring, little.
  const fingers = [[-165, -248], [-79, -292], [7, -260], [93, -190]];
  const path = ['M-165 -45.2'];
  fingers.forEach(([left, top], i) => {
    const right = left + 2 * r;
    path.push(`L${left} ${top + r}`, `A${r} ${r} 0 0 1 ${right} ${top + r}`);
    // Down between this finger and the next, round at the bottom.
    if (i < fingers.length - 1) path.push(`L${right} -67`, `A${gap} ${gap} 0 0 0 ${right + 2 * gap} -67`);
  });
  path.push(
    // The palm's side and rounded foot.
    'L165 111', 'A104 104 0 0 1 61 215', 'L-61 215', 'A104 104 0 0 1 -165 111', 'L-165 105.2',
    // The thumb: out along its outer edge, round its tip, back along the inner edge, into the web.
    'L-259.6 10.6', 'A39 39 0 0 1 -204.4 -44.6', 'L-193.3 -33.5', 'Q-165 -5.2 -165 -45.2', 'Z'
  );
  return `<path d="${path.join('')}"/>`;
}

/**
 * The icon as SVG, 1024 square.
 * @param {object} options
 * @param {number} options.inset  the margin around the rounded square
 * @param {boolean} options.small  the hand alone, for 16-32 px
 * @param {boolean} options.lifted  the square's own shadow (macOS's grid has room for it)
 */
export function art({ inset = 100, small = false, lifted = true, bleed = false } = {}) {
  const size = 1024 - 2 * inset;
  // Filled to the edges, for a Home Screen that cuts its own shape: the art keeps its inset, the ground doesn't.
  const shape = bleed ? 'M0 0H1024V1024H0Z' : squircle(inset, size);
  // Everything inside is drawn for a 824 square at 100 and scaled to this one.
  const scale = size / 824;
  const inside = `translate(${inset} ${inset}) scale(${scale.toFixed(5)}) translate(-100 -100)`;
  const handAt = small ? 'translate(544 548) scale(1.14)' : 'translate(546 552)';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
  <linearGradient id="ground" x1="0.08" y1="0" x2="0.92" y2="1">
    <stop offset="0" stop-color="#7047e8"/>
    <stop offset="0.42" stop-color="#4a5cc9"/>
    <stop offset="0.72" stop-color="#2f8f9f"/>
    <stop offset="1" stop-color="#23c26c"/>
  </linearGradient>
  <radialGradient id="sheen" cx="0.3" cy="0.08" r="0.75">
    <stop offset="0" stop-color="#fff" stop-opacity="0.26"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="depth" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0.55" stop-color="#0b0420" stop-opacity="0"/>
    <stop offset="1" stop-color="#0b0420" stop-opacity="0.22"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="#e4d9ff" stop-opacity="0.5"/>
    <stop offset="0.55" stop-color="#c7b3ff" stop-opacity="0.2"/>
    <stop offset="1" stop-color="#c7b3ff" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="skin" gradientUnits="userSpaceOnUse" x1="0" y1="-300" x2="0" y2="220">
    <stop offset="0" stop-color="#ffffff"/>
    <stop offset="1" stop-color="#ece6fb"/>
  </linearGradient>
  <clipPath id="shape"><path d="${shape}"/></clipPath>
  <filter id="lift" x="-10%" y="-10%" width="120%" height="125%">
    <feDropShadow dx="0" dy="10" stdDeviation="11" flood-color="#000" flood-opacity="0.3"/>
  </filter>
  <filter id="handShadow" x="-30%" y="-30%" width="160%" height="160%">
    <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#160a3a" flood-opacity="0.38"/>
  </filter>
</defs>
<path d="${shape}" fill="url(#ground)"${lifted ? ' filter="url(#lift)"' : ''}/>
<g clip-path="url(#shape)">
  <path d="${shape}" fill="url(#sheen)"/>
  <path d="${shape}" fill="url(#depth)"/>
  <g transform="${inside}">
    ${small ? '' : `<circle cx="520" cy="470" r="330" fill="url(#glow)"/><g fill="#f4efff">${orbDots({ cx: 520, cy: 470, radius: 292 })}</g>`}
    <g transform="${handAt}" fill="url(#skin)"${small ? '' : ' filter="url(#handShadow)"'}>${hand()}</g>
  </g>
  <path d="${shape}" fill="none" stroke="#fff" stroke-opacity="0.22" stroke-width="${(5 * scale).toFixed(2)}"/>
</g>
</svg>
`;
}

/** Windows' .ico: a directory, then each size as a PNG (Vista and later read those). */
export function icoFile(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, png }, i) => {
    const at = i * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

const MAC = { inset: 100, lifted: true };
const WINDOWS = { inset: 24, lifted: false };
/** [file in the iconset, px]: every size macOS asks for. */
const MAC_SIZES = [
  ['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64],
  ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512],
  ['icon_512x512', 512], ['icon_512x512@2x', 1024]
];
const WINDOWS_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** His website's, as an app: [file, look, px]. Android's safe zone is the middle 80% of a maskable icon. */
const WEB = path.resolve(path.dirname(here), '../src/web/icons');
const WEB_ICONS = [
  ['apple-touch-icon.png', { inset: 0, lifted: false, bleed: true }, 180],
  ['icon-192.png', WINDOWS, 192],
  ['icon-512.png', WINDOWS, 512],
  ['maskable-512.png', { inset: 112, lifted: false, bleed: true }, 512]
];
const SMALL = 32;

async function draw() {
  const { app, BrowserWindow } = await import('electron');
  app.dock?.hide();
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('data:text/html,<!doctype html><title>icons</title>');
  /** One size of the SVG as a PNG; Chromium draws the vectors at that size. */
  const render = async (svg, size) => {
    const base64 = await win.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = ${size};
      canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size});
      return canvas.toDataURL('image/png').split(',')[1];
    })()`);
    return Buffer.from(base64, 'base64');
  };
  const svg = (look, size) => art({ ...look, small: size <= SMALL });

  fs.mkdirSync(WEB, { recursive: true });
  for (const [file, look, size] of WEB_ICONS) fs.writeFileSync(path.join(WEB, file), await render(svg(look, size), size));
  if (process.argv.includes('--web')) return console.log(`Wrote ${WEB_ICONS.map(([file]) => file).join(', ')} to ${WEB}`);

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'jester.svg'), art(MAC));
  fs.writeFileSync(path.join(out, 'jester.png'), await render(art(MAC), 1024));

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-icons-'));
  const iconset = path.join(scratch, 'Jester.iconset');
  fs.mkdirSync(iconset);
  for (const [name, size] of MAC_SIZES) fs.writeFileSync(path.join(iconset, `${name}.png`), await render(svg(MAC, size), size));
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(out, 'Jester.icns')]);
  fs.rmSync(scratch, { recursive: true, force: true });

  const images = [];
  for (const size of WINDOWS_SIZES) images.push({ size, png: await render(svg(WINDOWS, size), size) });
  fs.writeFileSync(path.join(out, 'Jester.ico'), icoFile(images));
  console.log(`Wrote jester.svg, jester.png, Jester.icns and Jester.ico to ${out}`);
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === here;
if (process.versions.electron) {
  draw().then(
    async () => (await import('electron')).app.exit(0),
    async (err) => {
      console.error(err);
      (await import('electron')).app.exit(1);
    }
  );
} else if (direct) {
  if (process.platform !== 'darwin') {
    console.error('npm run icons needs macOS (iconutil makes the .icns).');
    process.exit(1);
  }
  const { default: electron } = await import('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [here, ...process.argv.slice(2)], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 1));
}
