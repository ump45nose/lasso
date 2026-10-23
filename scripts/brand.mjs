// Rasterize brand SVG sources with Electron's Chromium (keeps SVG filters intact).
// Run after editing assets/*.svg: npx electron scripts/brand.mjs
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';

const jobs = [
  ['assets/lasso-icon.svg', 'assets/lasso-icon.png', 1024],
  ['assets/trayTemplate.svg', 'assets/trayTemplate.png', 18],
  ['assets/trayTemplate.svg', 'assets/trayTemplate@2x.png', 36]
];

app.dock?.hide();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  for (const [source, target, size] of jobs) {
    const svg = 'data:image/svg+xml;base64,' + readFileSync(source).toString('base64');
    const html = `<!doctype html><style>html,body{margin:0;overflow:hidden;background:transparent}img{display:block}</style><img src="${svg}" width="${size}" height="${size}">`;
    const win = new BrowserWindow({ show: false, width: size, height: size, useContentSize: true, frame: false, transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
    await win.webContents.executeJavaScript('document.images[0].decode()');
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    writeFileSync(target, image.resize({ width: size, height: size, quality: 'best' }).toPNG());
    win.destroy();
  }
  app.quit();
});
