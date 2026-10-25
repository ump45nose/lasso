// Captures every Lasso surface into outputs/ui-shots for visual review: `npm run ui:shots`.
// Runs the built app under a disposable profile inside the worktree and drives it
// through the main-process inspector. Screen capture needs no permission: overlay, editor and pin
// surfaces are rendered from fixture states with the preloads in this folder.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const fixtures = join(root, 'scripts/ui-shots');
const out = join(root, 'outputs/ui-shots');
const PORT = Number(process.env.LASSO_UI_SHOTS_PORT || 9347);
mkdirSync(out, { recursive: true });
// Set every Electron storage path before loading the app, whose profile is relative to appData.
// The bootstrap and its disposable profile live entirely under this worktree.
const runtime = join(out, '.runtime');
mkdirSync(runtime, { recursive: true });
const boot = join(runtime, 'boot.cjs');
writeFileSync(boot, `const {app}=require('electron');const {mkdirSync}=require('fs');const {join}=require('path');
const root=${JSON.stringify(runtime)};
for(const name of ['appData','userData','sessionData','temp','crashDumps']){const path=join(root,name);mkdirSync(path,{recursive:true});app.setPath(name,path);}
app.setAppLogsPath(join(root,'logs'));
require(${JSON.stringify(join(root, 'dist/main.cjs'))});\n`);
const electron = createRequire(import.meta.url)('electron');
const child = spawn(electron, [`--inspect=${PORT}`, boot], { cwd: root, env: { ...process.env, LASSO_PROFILE: 'lasso-ui-shots', TMPDIR:join(runtime,'temp') }, stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function inspector() {
  for (let i = 0; i < 60; i++) {
    try { const [target] = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (target) return target.webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw Error('Electron inspector did not start');
}
let ws;
let seq = 0;
/** Runs `fn(electron, ...args)` in the main process; fn must be self-contained. */
function main(fn, ...args) {
  const id = ++seq;
  const expression = `(async () => { const electron = process.mainModule.require('electron'); return JSON.stringify(await (${fn})(electron, ...${JSON.stringify(args)})); })()`;
  return new Promise((resolve, reject) => {
    ws.addEventListener('message', function on(event) {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      ws.removeEventListener('message', on);
      const result = message.result;
      if (result?.exceptionDetails) reject(Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text));
      else resolve(JSON.parse(result?.result?.value ?? 'null'));
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true } }));
  });
}

const saved = [];
try {
  ws = new WebSocket(await inspector());
  await new Promise(resolve => ws.addEventListener('open', resolve));
  await main(async ({ BrowserWindow, ipcMain }, out, fixtures) => {
    const fs = process.mainModule.require('fs'), path = process.mainModule.require('path');
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const find = surface => BrowserWindow.getAllWindows().find(w => surface ? w.webContents.getURL().includes('surface=' + surface) : !w.webContents.getURL().includes('surface='));
    for (let i = 0; i < 40 && !(find() && find('action-bar')); i++) await wait(250);
    const page = (w, script) => w.webContents.executeJavaScript(script);
    const move = async (w, x, y) => { w.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) }); await wait(450); };
    const center = async (w, selector) => page(w, `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null; })()`);
    global.uiShots = { fs, path, wait, find, page, move, center, out, fixtures, ipcMain, BrowserWindow,
      save: async (w, name) => { fs.writeFileSync(path.join(out, name + '.png'), (await w.webContents.capturePage()).toPNG()); return name; } };
  }, out, fixtures);

  // Main window: current view, command palette, settings.
  saved.push(...await main(async () => {
    const { find, page, wait, save } = global.uiShots, m = find(), names = [];
    m.show(); m.focus(); await wait(1500);
    names.push(await save(m, 'main'));
    await page(m, "window.desktop.openPalette('all')"); await wait(600); names.push(await save(m, 'palette'));
    await page(m, 'window.desktop.closePalette()'); await wait(300);
    await page(m, "window.desktop.act('settings')"); await wait(700); names.push(await save(m, 'settings'));
    await page(m, "window.desktop.act('close-settings')"); await wait(300);
    return names;
  }));

  // Selection action bar: hover on the first preset, then the ··· menu with its first row hovered.
  saved.push(...await main(async () => {
    const { find, page, wait, move, center, save } = global.uiShots, w = find('action-bar'), names = [];
    w.setOpacity(1); w.showInactive(); w.webContents.send('bar:enter', { tip: 'above', menu: 'above' }); await wait(500);
    const first = await center(w, '.ab-buttons button'); if (first) await move(w, ...first);
    names.push(await save(w, 'action-bar'));
    await page(w, "document.querySelector('[aria-haspopup=menu]').click()"); await wait(450);
    const row = await center(w, '.ab-menu button'); if (row) await move(w, ...row);
    names.push(await save(w, 'action-bar-menu'));
    await page(w, "document.querySelector('[aria-haspopup=menu]').click()"); w.hide();
    return names;
  }));

  // Capture surfaces from fixture states over a frame of the main window.
  saved.push(...await main(async ({ nativeImage }) => {
    const { find, wait, move, page, save, path, fixtures, ipcMain, BrowserWindow } = global.uiShots, names = [];
    const W = 1280, H = 800, frame = (await find().webContents.capturePage()).resize({ width: W, height: H }), backdrop = frame.toDataURL();
    const sel = { x: 380, y: 170, width: 520, height: 320 }, crop = frame.crop(sel);
    const windows = [{ id: 1, x: 300, y: 120, width: 640, height: 430 }, { id: 2, x: 120, y: 60, width: 900, height: 620 }];
    const base = { id: 'ui-shots', editId: 'ui-shots-edit', candidates: [], status: '', selection: null };
    const longPixels=Buffer.concat([frame.toBitmap(),frame.toBitmap(),frame.toBitmap()]);
    const long=nativeImage.createFromBitmap(longPixels,{width:W,height:H*3});
    const scrolling={status:'running',width:W,height:H*3,segments:3,seams:[H,H*2],message:'在选区内缓慢向下滚动，每次保留至少三分之一重叠'};
    const states = {
      'overlay-area': { ...base, image: '', backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, candidates: [{ ...sel, source: 'element' }, { ...windows[0], source: 'window' }], windows, mode: 'area', phase: 'selecting', origin: 'screen' },
      'overlay-window': { ...base, image: '', backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, windows, mode: 'window', phase: 'selecting', origin: 'screen' },
      'overlay-scroll': { ...base, image: '', backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, candidates:[{...sel,source:'element'}],windows,mode:'scroll',phase:'selecting',origin:'screen' },
      'scroll-running': {...base,image:'',width:W,height:H,pixelWidth:W,pixelHeight:H,phase:'scrolling',scroll:scrolling,origin:'screen'},
      'scroll-paused': {...base,image:'',width:W,height:H,pixelWidth:W,pixelHeight:H,phase:'scrolling',scroll:{...scrolling,status:'paused',message:'匹配不可靠，已暂停并保留结果。请向上回到上次采集位置，再继续慢滚。'},origin:'screen'},
      'scroll-review': {...base,image:long.toDataURL(),width:W,height:H*3,pixelWidth:W,pixelHeight:H*3,phase:'review',scroll:{...scrolling,status:'review',message:'已结束采集。检查接缝后进入编辑；可撤回末段。'},origin:'screen'},
      'editor-inline': { ...base, image: crop.toDataURL(), backdrop, placement: sel, width: sel.width, height: sel.height, pixelWidth: sel.width, pixelHeight: sel.height, selection: { x: 0, y: 0, width: sel.width, height: sel.height }, phase: 'result', origin: 'screen' },
      'editor-window': { ...base, image: backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, selection: { x: 0, y: 0, width: W, height: H }, phase: 'result', origin: 'clipboard' }
    };
    let state = null;
    ipcMain.removeHandler('ui-shots:state'); ipcMain.handle('ui-shots:state', () => state);
    for (const [name, value] of Object.entries(states)) {
      state = value;
      const w = new BrowserWindow({ x: 40, y: 40, width: name.startsWith('scroll-')&&name!=='scroll-review'?700:W, height:name.startsWith('scroll-')&&name!=='scroll-review'?118:H, frame: false, show: true, backgroundColor: value.origin === 'clipboard' ? '#E9E6DD' : '#222222', webPreferences: { preload: path.join(fixtures, 'screenshot-preload.cjs'), contextIsolation: true, sandbox: true } });
      await w.loadFile(path.join(process.cwd(), 'dist/renderer/index.html'), { query: { surface: 'screenshot' } });
      await wait(900);
      if (name === 'overlay-area') await move(w, sel.x + 40, sel.y + 40);
      if (name === 'overlay-scroll') await move(w, sel.x + 40, sel.y + 40);
      if (name === 'scroll-review') {await page(w,`document.querySelector('.scroll-seams button')?.click()`);await wait(300);}
      // The editor enables its tools once the image has loaded; then pick the arrow so the style panel shows.
      if (name === 'editor-inline') { await wait(800); await page(w, `document.querySelector('[aria-label="箭头"]')?.click()`); await wait(500); }
      names.push(await save(w, name)); w.destroy();
    }
    // Pin at rest is just the image; hover shows the toolbar, ··· the options row.
    const pin = { id: 'ui-shots-pin', revision: 0, image: frame.resize({ width: 360, height: 225 }).toDataURL(), width: 360, height: 225, lines: [], status: '拖选文字 · 空格拖动贴图', topmost: true, opacity: 1, passthrough: false };
    ipcMain.removeHandler('ui-shots:pin'); ipcMain.handle('ui-shots:pin', () => pin);
    const p = new BrowserWindow({ x: 120, y: 120, width: 360, height: 225, frame: false, show: true, webPreferences: { preload: path.join(fixtures, 'pin-preload.cjs'), contextIsolation: true, sandbox: true } });
    await p.loadFile(path.join(process.cwd(), 'dist/renderer/index.html'), { query: { surface: 'pin' } }); p.focus(); await wait(600);
    names.push(await save(p, 'pin'));
    for (const x of [150, 170, 190]) await move(p, x, 140);
    names.push(await save(p, 'pin-hover'));
    await page(p, `document.querySelector('button[aria-label="贴图选项"]')?.click()`); await wait(400);
    names.push(await save(p, 'pin-options')); p.destroy();
    return names;
  }));
  console.log(`Saved ${saved.length} shots to outputs/ui-shots:\n` + saved.map(name => `  ${name}.png`).join('\n'));
} finally {
  if(ws?.readyState===WebSocket.OPEN)await main(({ app }) => { setTimeout(() => app.quit(), 50); return true; }).catch(() => {});
  ws?.close();
  if(child.exitCode===null)await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(3000)]);
  if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
  rmSync(runtime,{recursive:true,force:true});
}
