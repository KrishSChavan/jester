/**
 * `npm run icons`: Jester's icon, drawn here and written to desktop/icons:
 *
 *   jester.svg    the art, at 1024 on macOS's grid
 *   jester.png    the same, 1024 px
 *   Jester.icns   macOS: the app in the Dock, Finder, permission prompts
 *   Jester.ico    Windows: the window and taskbar
 *
 * to src/web/icons, his website's as an app on a phone's Home Screen (`npm run icons -- --web` writes only those):
 *
 *   apple-touch-icon.png   180 px, the square filled: an iPhone rounds its corners itself
 *   icon-192.png, icon-512.png   Windows' look (the rounded square on clear), for an install prompt and a desktop
 *   maskable-512.png       the square filled, the art inside Android's safe circle, for its launcher's own shape
 *   favicon-32.png, favicon.ico   a browser's tab (the .ico holds 16, 32 and 48 px; a browser asks for it by name)
 *
 * and to the Chrome extension, in Windows' look:
 *
 *   jester-extension/icons/icon16.png … icon128.png   its toolbar button and its chrome://extensions card,
 *                                                     and this app's menu-bar icon (src/main/tray.js)
 *   store/icon-128.png                                the Web Store's
 *
 * The art is code: a jester's head in lilac line with nothing filled in, tipped
 * 15° to the right, its eyes shut in a grin, in front of a faint globe of dots
 * like his orb's, on black with a purple glow (the user's pick, 2026-11-19).
 * On a Mac it sits in the system's rounded square with a 100 px margin around
 * it (Apple's grid, which the Dock expects); on Windows the square fills the
 * canvas. At 48 px and under the dots would be mud and the line too thin to
 * see, so the small sizes draw the head alone, larger, in a heavier line.
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

/**
 * The orb: dots on a tilted globe, the far ones smaller and fainter, drawn back to front.
 * `strength` scales every dot's opacity, so the globe can sit faintly behind the head.
 */
function orbDots({ cx, cy, radius, count = 340, strength = 1 }) {
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
    dots.push({ x: cx + radius * x, y: cy + radius * y1, r: 2.6 + 4.2 * near, o: (0.1 + 0.62 * near ** 1.6) * strength, z });
  }
  dots.sort((a, b) => a.z - b.z);
  return dots.map((d) => `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${d.r.toFixed(2)}" fill-opacity="${d.o.toFixed(3)}"/>`).join('');
}

/** The icon's colours: the ground, the glow in it, the line, the dots. */
export const COLOURS = { ground: '#0a0710', glow: '#5b21b6', line: '#c9b8ff', dots: '#d9c9ff' };

/**
 * The jester's head, upright, back to front: his face, the cap's three horns,
 * its band, a bell at each tip. Plain shapes, on the 824 square at 100 with the
 * head's middle at (512, 450); art() decides the line and what's hidden.
 */
const BAND = 'M312 556C352 420 672 420 712 556C700 574 690 580 676 578C620 500 404 500 348 578C334 580 324 574 312 556Z';
const HEAD = [
  '<circle cx="512" cy="590" r="178"/>',
  '<path d="M330 560Q300 450 190 450C230 320 380 290 500 470Z"/>',
  '<path d="M694 560Q724 450 834 450C794 320 644 290 524 470Z"/>',
  '<path d="M420 485C415 340 470 210 590 180C555 250 600 360 612 485Z"/>',
  `<path d="${BAND}"/>`,
  '<circle cx="176" cy="482" r="38"/>',
  '<circle cx="848" cy="482" r="38"/>',
  '<circle cx="614" cy="172" r="38"/>'
];
/** His eyes, shut in a grin: two arcs. */
const GRIN = [450, 574].map((x) => `<path d="M${x - 38} 658Q${x} 600 ${x + 38} 658"/>`).join('');
/** Room enough, in the head's own space, for any mask over it. */
const AREA = 'x="-400" y="-400" width="1824" height="1824"';

/**
 * The head as lines with nothing filled in. Each part's line is hidden where a
 * part in front of it covers it (the cap's foot behind its band, the top of his
 * face behind the cap), so no line crosses another.
 */
function lines(width) {
  const masks = [];
  const parts = HEAD.map((part, i) => {
    const front = HEAD.slice(i + 1).join('');
    if (!front) return part;
    masks.push(`<mask id="front${i}" maskUnits="userSpaceOnUse" ${AREA}><rect ${AREA} fill="#fff"/><g fill="#000">${front}</g></mask>`);
    return `<g mask="url(#front${i})">${part}</g>`;
  });
  return {
    masks: masks.join('\n  '),
    drawing: `<g fill="none" stroke="${COLOURS.line}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round">${parts.join('')}${GRIN}</g>`
  };
}

/**
 * The icon as SVG, 1024 square.
 * @param {object} options
 * @param {number} options.inset  the margin around the rounded square
 * @param {boolean} options.small  the head alone, larger and in a heavier line, for 48 px and under
 * @param {boolean} options.lifted  the square's own shadow (macOS's grid has room for it)
 */
export function art({ inset = 100, small = false, lifted = true, bleed = false } = {}) {
  const size = 1024 - 2 * inset;
  // Filled to the edges, for a Home Screen that cuts its own shape: the art keeps its inset, the ground doesn't.
  const shape = bleed ? 'M0 0H1024V1024H0Z' : squircle(inset, size);
  // Everything inside is drawn for a 824 square at 100 and scaled to this one.
  const scale = size / 824;
  const inside = `translate(${inset} ${inset}) scale(${scale.toFixed(5)}) translate(-100 -100)`;
  // Tipped 15° to the right and centred, clear of the square's edges.
  const head = small ? { at: '520 496', scale: 0.98, width: 40 } : { at: '520 497', scale: 0.9, width: 22 };
  const tipped = `translate(${head.at}) rotate(15) scale(${head.scale}) translate(-512 -450)`;
  const { masks, drawing } = lines(head.width);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
  <radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="512" cy="512" r="635">
    <stop offset="0" stop-color="${COLOURS.glow}" stop-opacity="0.5"/>
    <stop offset="1" stop-color="${COLOURS.glow}" stop-opacity="0"/>
  </radialGradient>
  <clipPath id="shape"><path d="${shape}"/></clipPath>
  <filter id="lift" x="-10%" y="-10%" width="120%" height="125%">
    <feDropShadow dx="0" dy="10" stdDeviation="11" flood-color="#000" flood-opacity="0.3"/>
  </filter>${small ? '' : `
  <mask id="head" maskUnits="userSpaceOnUse" ${AREA}><rect ${AREA} fill="#fff"/><g transform="${tipped}" fill="#000" stroke="#000" stroke-width="${head.width + 34}" stroke-linejoin="round">${HEAD.join('')}</g></mask>`}
  ${masks}
</defs>
<path d="${shape}" fill="${COLOURS.ground}"${lifted ? ' filter="url(#lift)"' : ''}/>
<g clip-path="url(#shape)">
  <g transform="${inside}">
    <rect ${AREA} fill="url(#glow)"/>
    ${small ? '' : `<g fill="${COLOURS.dots}" mask="url(#head)">${orbDots({ cx: 512, cy: 512, radius: 330, strength: 0.675 })}</g>`}
    <g transform="${tipped}">${drawing}</g>
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
  ['maskable-512.png', { inset: 112, lifted: false, bleed: true }, 512],
  // A browser's tab: the head alone, as every small size is.
  ['favicon-32.png', WINDOWS, 32]
];
/** And favicon.ico, which a browser asks for by that name whatever the page says: the tab's sizes in one file. */
const FAVICON_SIZES = [16, 32, 48];
/** The Chrome extension's (its manifest's sizes), and the Web Store's copy of the largest. */
const EXTENSION = path.resolve(path.dirname(here), '../../jester-extension/icons');
const EXTENSION_SIZES = [16, 32, 48, 128];
const STORE_ICON = path.resolve(path.dirname(here), '../../store/icon-128.png');
const SMALL = 48;

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
  const tab = [];
  for (const size of FAVICON_SIZES) tab.push({ size, png: await render(svg(WINDOWS, size), size) });
  fs.writeFileSync(path.join(WEB, 'favicon.ico'), icoFile(tab));
  if (process.argv.includes('--web')) return console.log(`Wrote ${WEB_ICONS.map(([file]) => file).join(', ')} and favicon.ico to ${WEB}`);

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

  for (const size of EXTENSION_SIZES) fs.writeFileSync(path.join(EXTENSION, `icon${size}.png`), await render(svg(WINDOWS, size), size));
  fs.copyFileSync(path.join(EXTENSION, 'icon128.png'), STORE_ICON);
  console.log(`Wrote ${EXTENSION_SIZES.map((size) => `icon${size}.png`).join(', ')} to ${EXTENSION}, and ${STORE_ICON}`);
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
