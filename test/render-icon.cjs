// Renders assets/logo.svg -> icon.svg (256px copy), icon.png (256) and a
// multi-size icon.ico (PNG-embedded entries, Vista+). Each size is rendered
// natively rather than downscaled, so small taskbar/titlebar icons stay crisp.
// Run with: node_modules/.bin/electron test/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const assets = path.join(__dirname, '..', 'assets');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const sized = (svg, px) => svg.replace(/<svg\b[^>]*>/, tag =>
  tag.replace(/\swidth="[^"]*"/, ` width="${px}"`).replace(/\sheight="[^"]*"/, ` height="${px}"`));

async function render(win, svg, px) {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="margin:0;overflow:hidden;background:transparent">' + sized(svg, px) + '</body>'));
  await new Promise(r => setTimeout(r, 200)); // let it paint
  let img = await win.webContents.capturePage({ x: 0, y: 0, width: px, height: px });
  if (img.getSize().width !== px) img = img.resize({ width: px, height: px, quality: 'best' });
  return img.toPNG();
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(assets, 'logo.svg'), 'utf8');
  const win = new BrowserWindow({
    show: false, width: 256, height: 256, frame: false,
    transparent: true, // keep corners outside the circle transparent, not white
    webPreferences: { offscreen: true },
  });

  const pngs = [];
  for (const px of SIZES) pngs.push(await render(win, svg, px));
  fs.writeFileSync(path.join(assets, 'icon.svg'), sized(svg, 256));
  fs.writeFileSync(path.join(assets, 'icon.png'), pngs.at(-1));

  // ICO container: header, one 16-byte entry per size, then the PNG blobs
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(SIZES.length, 4);
  let offset = 6 + 16 * SIZES.length;
  const entries = SIZES.map((px, i) => {
    const e = Buffer.alloc(16);
    e[0] = px >= 256 ? 0 : px; e[1] = px >= 256 ? 0 : px; // 0 = 256
    e.writeUInt16LE(1, 4);                // color planes
    e.writeUInt16LE(32, 6);               // bpp
    e.writeUInt32LE(pngs[i].length, 8);   // data size
    e.writeUInt32LE(offset, 12);          // data offset
    offset += pngs[i].length;
    return e;
  });
  fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]));
  console.log(`wrote icon.svg, icon.png, icon.ico (${SIZES.join('/')})`);
  app.quit();
});
