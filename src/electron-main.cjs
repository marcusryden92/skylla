// Electron shell: one dark window pointed at skylla's local dashboard server.
// Launched by src/index.js as: electron electron-main.cjs <url>
const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('node:path');

const url = process.argv[process.argv.length - 1];

app.whenReady().then(() => {
  // size to the work area so the taskbar never crops the bottom
  const wa = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    backgroundColor: '#0d1117',
    title: 'skylla',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    titleBarStyle: 'hidden', // our own header; native min/max/close overlaid
    titleBarOverlay: { color: '#161b22', symbolColor: '#c9d1d9', height: 34 },
    webPreferences: { preload: path.join(__dirname, 'electron-preload.cjs') },
  });
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  win.loadURL(url);
});

app.on('window-all-closed', () => app.quit());
