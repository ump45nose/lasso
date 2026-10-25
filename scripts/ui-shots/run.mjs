// Captures every Lasso surface into outputs/ui-shots for visual review: `npm run ui:shots`.
// Runs the built app with all runtime data isolated below outputs and drives it
// through the main-process inspector. Screen capture needs no permission: overlay, editor and pin
// surfaces are rendered from fixture states with the preloads in this folder.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const fixtures = join(root, 'scripts/ui-shots');
const out = join(root, 'outputs/ui-shots');
mkdirSync(out, { recursive: true });
const runtime = mkdtempSync(join(root, 'outputs/ui-shots-runtime-'));
const bootstrap = join(runtime, 'main.cjs');
const runtimePaths = Object.fromEntries(['appData', 'userData', 'sessionData', 'temp', 'crashDumps', 'logs'].map(name => [name, join(runtime, name === 'userData' ? 'lasso-ui-shots' : name)]));
const electron = createRequire(import.meta.url)('electron');
let child, ws, childError, inspectorURL;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function inspector() {
  for (let i = 0; i < 60; i++) {
    if (childError) throw childError;
    if (inspectorURL) return inspectorURL;
    if (child.exitCode !== null || child.signalCode !== null) throw Error('Electron exited before its inspector started');
    await sleep(250);
  }
  throw Error('Electron inspector did not start');
}
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
  for (const directory of Object.values(runtimePaths)) mkdirSync(directory, { recursive: true });
  // Fixture runs must never start global selection hooks or ask for accessibility permission.
  writeFileSync(join(runtimePaths.userData, 'settings.json'), JSON.stringify({ shortcut: '', selectionEnabled: false, clipboardFallback: false }));
  // Electron uses the bootstrap directory as app.getAppPath(); keep icon reads local.
  symlinkSync(join(root, 'assets'), join(runtime, 'assets'), 'dir');
  // This runs before the real entrypoint. LASSO_DATA_ROOT and LASSO_PROFILE derive
  // the same userData path, so the disabled-selection settings are read on boot.
  writeFileSync(bootstrap, `const { app } = require('electron');
const { mkdirSync } = require('node:fs');
const paths = ${JSON.stringify(runtimePaths)};
for (const key of ['appData', 'userData', 'sessionData', 'temp', 'crashDumps']) {
  mkdirSync(paths[key], { recursive: true }); app.setPath(key, paths[key]);
}
app.setAppLogsPath(paths.logs);
require(${JSON.stringify(join(root, 'dist/main.cjs'))});
`);
  // Port 0 avoids attaching to another development session's inspector.
  child = spawn(electron, ['--inspect=127.0.0.1:0', bootstrap], { cwd: root, env: { ...process.env, LASSO_PROFILE: 'lasso-ui-shots', LASSO_DATA_ROOT: runtime, TMPDIR: join(runtime, 'temp') }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.on('error', error => { childError = error; });
  child.stderr.on('data', data => { const match = data.toString().match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/); if (match) inspectorURL = match[1]; });
  ws = new WebSocket(await inspector());
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  await main(async ({ app, BrowserWindow, ipcMain }, out, fixtures, runtime) => {
    const fs = process.mainModule.require('fs'), path = process.mainModule.require('path');
    for (const name of ['appData', 'userData', 'sessionData', 'temp', 'crashDumps', 'logs']) {
      const relative = path.relative(runtime, app.getPath(name));
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Unisolated test path: ' + name);
    }
    if (app.getPath('userData') !== path.join(runtime, 'lasso-ui-shots')) throw Error('Unexpected fixture profile path');
    if (JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')).selectionEnabled !== false) throw Error('Fixture selection hooks were not disabled before boot');
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const find = surface => BrowserWindow.getAllWindows().find(w => surface ? w.webContents.getURL().includes('surface=' + surface) : !w.webContents.getURL().includes('surface='));
    for (let i = 0; i < 40 && !(find() && find('action-bar')); i++) await wait(250);
    const page = (w, script) => w.webContents.executeJavaScript(script);
    const move = async (w, x, y) => { w.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) }); await wait(450); };
    const center = async (w, selector) => page(w, `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null; })()`);
    global.uiShots = { fs, path, wait, find, page, move, center, out, fixtures, ipcMain, BrowserWindow, app,
      save: async (w, name) => { fs.writeFileSync(path.join(out, name + '.png'), (await w.webContents.capturePage()).toPNG()); return name; } };
  }, out, fixtures, runtime);

  // Main window: current view, command palette, settings.
  saved.push(...await main(async () => {
    const { find, page, wait, save } = global.uiShots, m = find(), names = [];
    m.show(); m.focus(); await wait(1500);
    names.push(await save(m, 'main'));
    const launcher = await page(m, `(async () => {
      for (let pass = 0; pass < 40; pass++) {
        const state = await window.desktop.getState();
        for (const task of state.tasks) await window.desktop.closeTask(task.id);
        await new Promise(resolve => setTimeout(resolve, 150));
        if (document.querySelector('.l-launch-foot')) return true;
      }
      return false;
    })()`);
    if (!launcher) throw Error('Launcher did not become ready');
    await wait(500); names.push(await save(m, 'launcher'));
    await page(m, "window.desktop.openPalette('all')"); await wait(600); names.push(await save(m, 'palette'));
    await page(m, 'window.desktop.closePalette()'); await wait(300);
    await page(m, "window.desktop.act('settings')"); await wait(700); names.push(await save(m, 'settings'));
    await page(m, "window.desktop.act('close-settings')"); await wait(300);
    return names;
  }));
  // Dedicated image-generation surface: fixtures exercise layout without sending paid requests.
  saved.push(...await main(async () => {
    const { find, wait, page, save, path, fixtures, ipcMain, BrowserWindow, app, fs } = global.uiShots, names = [];
    const appearance = await page(find(), 'window.desktop.getState().then(s => ({fonts:s.settings.fonts, importedFonts:s.settings.importedFonts}))');
    // Use a bundled test font through the existing isolated lasso-font protocol; no user font is read or copied.
    const assets = path.join(process.cwd(), 'dist/renderer/assets'), fontDirectory = path.join(app.getPath('userData'), 'fonts');
    const bundledFont = fs.readdirSync(assets).find(name => name.startsWith('jetbrains-mono-latin-400-normal-') && name.endsWith('.woff2'));
    fs.mkdirSync(fontDirectory, { recursive: true }); fs.copyFileSync(path.join(assets, bundledFont), path.join(fontDirectory, 'ui-shots-font.woff2'));
    const importedFamily = 'UI Shots Imported Mono';
    const importedAppearance = { fonts: Object.fromEntries(['display', 'text', 'ui', 'mono'].map(role => [role, importedFamily])), importedFonts: [{ family: importedFamily, file: 'ui-shots-font.woff2' }] };
    const image = (await find().webContents.capturePage()).resize({ width: 400, height: 300 }).toDataURL();
    const ref = { id: 'fixture-reference', width: 1200, height: 900, thumbnail: image };
    const config = { baseURL: 'http://127.0.0.1:3000/v1', generationModel: 'configured-generation-model', editModel: 'configured-edit-model', hasCredential: true };
    const original = { id: 'fixture-original', requestId: 'fixture-first', prompt: '一张纸上的暖白建筑草图，细节清晰。', aspect: '3:2', status: 'succeeded', createdAt: '2026-10-25T01:00:00Z', updatedAt: '2026-10-25T01:01:00Z', image: { ...ref, id: 'fixture-original' } };
    const edited = { ...original, id: 'fixture-edited', requestId: 'fixture-second', prompt: '保留构图，将屋顶改成陶土色。', parentId: original.id, referenceId: original.id, reference: original.image, createdAt: '2026-10-25T01:02:00Z', image: { ...ref, id: 'fixture-edited' } };
    const failed = { ...edited, id: 'fixture-failed', image: undefined, status: 'failed', error: '图片请求失败（HTTP 503）；未自动重试', createdAt: '2026-10-25T01:03:00Z' };
    const interrupted = { ...failed, id: 'fixture-interrupted', status: 'interrupted', error: '应用已重启，请求结果未知；不会自动重发。上游可能仍在处理。' };
    let state, requests = [];
    ipcMain.handle('ui-shots:media-state', () => state);
    ipcMain.handle('ui-shots:media-reference', (_event, id) => { state.reference = id ? state.jobs.find(job => job.id === id)?.image || ref : null; return state; });
    ipcMain.handle('ui-shots:media-generate', (_event, request) => {
      requests.push(request);
      if (!state.jobs.some(job => job.requestId === request.requestId)) {
        const id = 'fixture-generated-' + requests.length;
        state.jobs.unshift({ ...request, id, status: 'succeeded', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), image: { ...ref, id }, ...(state.reference ? { reference: state.reference } : {}) });
      }
      return state;
    });
    const states = {
      'quick-image-input': { jobs: [], reference: null, config },
      'quick-image-versions': { jobs: [edited, original], reference: original.image, config },
      'quick-image-failed': { jobs: [failed, edited, original], reference: original.image, config },
      'quick-image-interrupted': { jobs: [interrupted, edited, original], reference: original.image, config },
      'quick-image-running': { jobs: [{ ...failed, id: 'fixture-running', status: 'running', error: undefined }], reference: ref, config },
      'quick-image-settings': { jobs: [], reference: null, config },
      'quick-image-fonts': { jobs: [], reference: null, config, ...importedAppearance },
      'quick-image-narrow': { jobs: [edited, original], reference: original.image, config }
    };
    for (const [name, value] of Object.entries(states)) {
      state = { ...structuredClone(appearance), ...structuredClone(value) }; requests = [];
      const w = new BrowserWindow({ width: name === 'quick-image-narrow' ? 340 : 460, height: 720, frame: false, show: false,
        webPreferences: { preload: path.join(fixtures, 'media-preload.cjs'), contextIsolation: true, sandbox: true } });
      await w.loadFile(path.join(process.cwd(), 'dist/renderer/index.html'), { query: { surface: 'quick-image' } });
      await wait(700);
      if (name === 'quick-image-settings') { await page(w, `document.querySelector('[aria-label="生图连接设置"]').click()`); await wait(400); }
      if (value.jobs.length) { await page(w, `document.querySelector('.qi-results').scrollIntoView({block:'start'})`); await wait(300); }
      const overflow = await page(w, 'document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth');
      if (overflow) throw Error(name + ': horizontal overflow');
      names.push(await save(w, name));
      if (name === 'quick-image-fonts') {
        const loaded = await page(w, `document.fonts.ready.then(() => document.fonts.check('14px "UI Shots Imported Mono"', 'Lasso') && document.documentElement.style.getPropertyValue('--font-ui').includes('UI Shots Imported Mono'))`);
        if (!loaded) throw Error('Imported generation font was not loaded through lasso-font');
        w.hide();
        state.fonts = { ...appearance.fonts, display: 'Newsreader Variable', text: 'Newsreader Variable', ui: 'Newsreader Variable' };
        w.webContents.send('media:changed', state); await wait(350);
        if (!await page(w, `document.documentElement.style.getPropertyValue('--font-ui').includes('Newsreader Variable')`)) throw Error('Reopened generation surface did not update its font');
        names.push(await save(w, 'quick-image-fonts-reopened'));
      }
      if (name === 'quick-image-input') {
        await page(w, `(() => { const el = document.getElementById('qi-prompt'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '组件模拟：一张纸上的建筑草图'); el.dispatchEvent(new Event('input', {bubbles:true})); })()`); await wait(100);
        await page(w, `(() => { const button = document.querySelector('.qi-generate-row .primary'); button.click(); button.click(); })()`); await wait(350);
        await page(w, `document.querySelector('.qi-generate-row .primary').click()`); await wait(100);
        if (requests.length !== 1) throw Error('Repeated component click submitted another generation');
        await page(w, `document.querySelector('.qi-input').scrollIntoView({block:'start'})`); await wait(150);
        names.push(await save(w, 'quick-image-submitted'));
      }
      if (name === 'quick-image-versions') {
        await page(w, `document.querySelector('.qi-body').scrollTop = document.querySelector('.qi-body').scrollHeight`); await wait(200);
        names.push(await save(w, 'quick-image-output-actions'));
        await page(w, `document.querySelectorAll('.qi-version')[1].click()`); await wait(350);
        await page(w, `Array.from(document.querySelectorAll('.qi-result-actions button')).find(b => b.textContent === '基于此版本再改').click()`); await wait(200);
        if (state.reference.id !== original.id || requests.length) throw Error('Selecting a version must only prepare its reference');
        await page(w, `document.querySelector('.qi-body').scrollTop = 0`); await wait(150);
        names.push(await save(w, 'quick-image-selected-reference'));
        await page(w, `(() => { const el = document.getElementById('qi-prompt'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '只修改所选原版'); el.dispatchEvent(new Event('input', {bubbles:true})); })()`); await wait(100);
        await page(w, `document.querySelector('.qi-generate-row .primary').click()`); await wait(200);
        if (requests.length !== 1 || requests[0].parentId !== original.id || requests[0].referenceId !== original.id) throw Error('Version edit did not use the selected image alone');
      }
      w.destroy();
    }
    ipcMain.removeHandler('ui-shots:media-state'); ipcMain.removeHandler('ui-shots:media-reference'); ipcMain.removeHandler('ui-shots:media-generate');
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
    const { find, wait, move, center, page, save, path, fixtures, ipcMain, BrowserWindow } = global.uiShots, names = [];
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
      'editor-window': { ...base, image: backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, selection: { x: 0, y: 0, width: W, height: H }, phase: 'result', origin: 'clipboard' },
      'editor-picker-hex': { ...base, image: backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, selection: { x: 0, y: 0, width: W, height: H }, phase: 'result', origin: 'clipboard' },
      'editor-picker-rgb': { ...base, image: backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, selection: { x: 0, y: 0, width: W, height: H }, phase: 'result', origin: 'clipboard' },
      'editor-selected-annotation': { ...base, image: backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, selection: { x: 0, y: 0, width: W, height: H }, phase: 'result', origin: 'clipboard', annotations: {
        objects: [{ type: 'Rect', left: 300, top: 200, width: 260, height: 120, fill: 'transparent', stroke: '#e24a35', strokeWidth: 4, lassoTool: 'rectangle' }],
        crop: { x: 0, y: 0, width: W, height: H }, nextNumber: 1, privacy: []
      } }
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
      if (name.startsWith('editor-picker-') || name === 'editor-selected-annotation') {
        const picker = name.startsWith('editor-picker-');
        await page(w, `document.querySelector('.ed-tool[data-tip^="${picker ? '取色' : '选择'}"]')?.click()`);
        const point = await page(w, `(() => { const r = document.querySelector('canvas.upper-canvas').getBoundingClientRect(); return [r.x + r.width * 430 / ${W}, r.y + r.height * 260 / ${H}]; })()`);
        await move(w, ...point);
        w.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point[0]), y: Math.round(point[1]), button: 'left', clickCount: 1 });
        w.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(point[0]), y: Math.round(point[1]), button: 'left', clickCount: 1 });
        await wait(350);
        if (name === 'editor-picker-rgb') await page(w, `Array.from(document.querySelectorAll('[aria-label="取色格式"] [role="radio"]')).find(button => button.textContent === 'RGB')?.click()`);
        if (!picker) { const selected = await center(w, '.ed-tool[data-tip^="选择"]'); if (selected) await move(w, ...selected); }
        await wait(450);
        if (picker && !await page(w, `Boolean(document.querySelector('[aria-label="复制颜色"]'))`)) throw Error(name + ': picker controls did not appear');
      }
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
  if (ws?.readyState === WebSocket.OPEN) await Promise.race([
    main(({ app }) => { setTimeout(() => app.quit(), 50); return true; }).catch(() => {}),
    sleep(1000)
  ]);
  ws?.close();
  if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
    const terminate = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(terminate); resolve(); });
    child.kill();
  });
  // Only this invocation's mkdtemp directory is removed; screenshots remain deliverables.
  rmSync(runtime, { recursive: true, force: true });
}
