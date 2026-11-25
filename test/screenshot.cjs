// Headless screenshot of the dashboard for visual verification.
// Usage: SHOT_URL=.. SHOT_OUT=.. [SHOT_CLICK=..] electron test/screenshot.cjs
// (env, not argv: electron CLI swallows http:// arguments silently)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

const { SHOT_URL: url, SHOT_OUT: out, SHOT_CLICK: clickSel } = process.env;

// avoid profile-lock clash with the running dashboard Electron instance
app.setPath('userData', require('node:path').join(require('node:os').tmpdir(), 'skylla-shot-' + Date.now()));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1600, height: 900,
    webPreferences: { offscreen: true },
  });
  await win.loadURL(url);
  await new Promise(r => setTimeout(r, 1500)); // let SSE snapshot render
  if (clickSel) {
    await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(clickSel)})?.click(); true`);
    await new Promise(r => setTimeout(r, 800));
  }
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('wrote', out);
  app.quit();
});
