// Renders assets/icon.svg -> icon.png + icon.ico (PNG-embedded ICO, Vista+).
// Run with: node_modules/.bin/electron test/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const assets = path.join(__dirname, '..', 'assets');

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(assets, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({
    show: false, width: 256, height: 256, frame: false,
    transparent: true, // keep corners outside the circle transparent, not white
    webPreferences: { offscreen: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' +
    encodeURIComponent('<body style="margin:0;overflow:hidden;background:transparent">' + svg + '</body>'));
  await new Promise(r => setTimeout(r, 300)); // let it paint
  let img = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  if (img.getSize().width !== 256) img = img.resize({ width: 256, height: 256 });
  const png = img.toPNG();
  fs.writeFileSync(path.join(assets, 'icon.png'), png);

  // ICO container with a single 256x256 PNG entry
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; entry[1] = 0;            // width/height 0 = 256
  entry.writeUInt16LE(1, 4);             // color planes
  entry.writeUInt16LE(32, 6);            // bpp
  entry.writeUInt32LE(png.length, 8);    // data size
  entry.writeUInt32LE(22, 12);           // data offset
  fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([header, entry, png]));
  console.log('wrote icon.png + icon.ico');
  app.quit();
});
