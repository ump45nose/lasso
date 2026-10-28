// Captures every Lasso surface into outputs/ui-shots for visual review: `npm run ui:shots`.
// Runs the built app with all runtime data isolated below outputs and drives it
// through the main-process inspector. Screen capture needs no permission: overlay, editor and pin
// surfaces are rendered from fixture states with the preloads in this folder.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const fixtures = join(root, 'scripts/ui-shots');
const out = join(root, 'outputs/ui-shots');
const surfacesOnly = process.env.LASSO_UI_SCOPE === 'capture';
const captureOnly = surfacesOnly || process.env.LASSO_UI_SCOPE === 'screenshot';
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
  const expression = `(async () => { for (let i = 0; !process.mainModule && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 50)); const electron = process.mainModule.require('electron'); return JSON.stringify(await (${fn})(electron, ...${JSON.stringify(args)})); })()`;
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
  writeFileSync(bootstrap, `const { app, dialog } = require('electron');
dialog.showErrorBox = (title, message) => console.error(title, message);
const { mkdirSync } = require('node:fs');
const paths = ${JSON.stringify(runtimePaths)};
for (const key of ['appData', 'userData', 'sessionData', 'temp', 'crashDumps']) {
  mkdirSync(paths[key], { recursive: true }); app.setPath(key, paths[key]);
}
app.setAppLogsPath(paths.logs);
app.on('web-contents-created', (_event, contents) => contents.setBackgroundThrottling(false));
require(${JSON.stringify(join(root, 'dist/main.cjs'))});
console.error('ui fixture lock', app.hasSingleInstanceLock(), 'ready', app.isReady());
`);
  // Port 0 avoids attaching to another development session's inspector.
  child = spawn(electron, ['--inspect=127.0.0.1:0', bootstrap], { cwd: root, env: { ...process.env, LASSO_PROFILE: 'lasso-ui-shots', LASSO_DATA_ROOT: runtime, TMPDIR: join(runtime, 'temp') }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.on('error', error => { childError = error; });
  child.stderr.on('data', data => { appendFileSync(join(out,'runtime.log'),data); const match = data.toString().match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/); if (match) inspectorURL = match[1]; });
  ws = new WebSocket(await inspector());
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  // Let AppKit finish launching between inspector calls; an awaited evaluation before ready can starve its launch event.
  for(let pass=0;pass<100;pass++){if(await main(({app})=>app.isReady()))break;await sleep(100);}
  await main(async ({ app, BrowserWindow, ipcMain }, out, fixtures, runtime, captureOnly, surfacesOnly) => {
    const fs = process.mainModule.require('fs'), path = process.mainModule.require('path');
    for (let i = 0; i < 200 && (!app.isReady() || !BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('renderer/index.html'))); i++) await new Promise(resolve => setTimeout(resolve, 50));
    for (const name of ['appData', 'userData', 'sessionData', 'temp', 'crashDumps', 'logs']) {
      const relative = path.relative(runtime, app.getPath(name));
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Unisolated test path: ' + name);
    }
    if (app.getPath('userData') !== path.join(runtime, 'lasso-ui-shots')) throw Error('Unexpected fixture profile path');
    if (JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')).selectionEnabled !== false) throw Error('Fixture selection hooks were not disabled before boot');
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const find = surface => BrowserWindow.getAllWindows().find(w => surface ? w.webContents.getURL().includes('surface=' + surface) : !w.webContents.getURL().includes('surface='));
    for (let i = 0; i < 40 && !(find() && find('action-bar')); i++) await wait(250);
    const page = async (w, script) => { try { return await w.webContents.executeJavaScript(script); } catch (error) { throw Error(error.message + '\nScript: ' + script); } };
    const move = async (w, x, y) => { w.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) }); await wait(450); };
    const center = async (w, selector) => page(w, `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null; })()`);
    if(!find()||!find('action-bar'))throw Error('UI startup failed: '+JSON.stringify(BrowserWindow.getAllWindows().map(w=>({id:w.id,url:w.webContents.getURL()}))));
    global.uiShots = { captureOnly, surfacesOnly, fs, path, wait, find, page, move, center, out, fixtures, ipcMain, BrowserWindow, app,
      save: async (w, name) => { fs.writeFileSync(path.join(out, name + '.png'), (await w.webContents.capturePage()).toPNG()); return name; } };
  }, out, fixtures, runtime, captureOnly, surfacesOnly);

  // Main window: current view, command palette, settings.
  saved.push(...await main(async () => {
    const { find, page, wait, save } = global.uiShots, m = find(), names = [];
    // Keep this isolated fixture visible while the user's foreground app changes.
    await page(m, 'window.desktop.getState().then(s => s.pinned ? undefined : window.desktop.act("pin"))');
    m.show(); m.focus(); await wait(1500);
    if(global.uiShots.surfacesOnly)return names;
    let shell;
    if(!global.uiShots.captureOnly){
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
    // Render capture controls from a shell fixture; none of these entries is run.
    shell = await page(m, 'window.desktop.getState()');
    m.webContents.send('shell:changed', { ...shell, captureEfficiency: { phase: 'idle', mode: null, remaining: 0, hasLastArea: true, error: null } });
    await page(m, "window.desktop.openPalette('all')"); await wait(350);
    await page(m, `(() => { const input = document.querySelector('.l-pal-search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '截图'); input.dispatchEvent(new Event('input', {bubbles:true})); })()`); await wait(350);
    const captureLabels = await page(m, `Array.from(document.querySelectorAll('.l-pal-row .l-pal-label')).map(row => row.textContent).join('\\n')`);
    if (!captureLabels.includes('重截') || ![3, 5, 10].every(seconds => new RegExp(seconds + '\\s*秒').test(captureLabels))) throw Error('Capture palette did not include repeat and 3/5/10-second entries: ' + captureLabels);
    await page(m, `document.querySelector('.l-pal-list').scrollTop = document.querySelector('.l-pal-list').scrollHeight`); await wait(200);
    names.push(await save(m, 'palette-capture'));
    await page(m, 'window.desktop.closePalette()'); await wait(200);
    m.webContents.send('shell:changed', { ...shell, notice: '3 秒后区域截图，可取消', captureEfficiency: { phase: 'countdown', mode: 'area', remaining: 3, hasLastArea: true, error: null } }); await wait(400);
    if (!await page(m, `Boolean(document.querySelector('[aria-label="取消延时截图"]'))`)) throw Error('Capture countdown cancel button did not appear');
    names.push(await save(m, 'capture-countdown'));
    m.webContents.send('shell:changed', shell); await wait(200);
    }
    shell = await page(m, 'window.desktop.getState()');
    await page(m, "window.desktop.act('settings')"); await wait(700); names.push(await save(m, 'settings'));
    await page(m, `Array.from(document.querySelectorAll('.l-set-nav button')).find(button => button.textContent === '截图').click()`); await wait(450);
    names.push(await save(m, 'settings-screenshot-actions'));
    await page(m, `document.querySelector('[aria-label="全屏截图后复制"]').click(); document.querySelector('[aria-label="全屏截图后保存"]').click(); document.querySelector('[aria-label="截图保存格式"] button:last-child').click()`); await wait(250);
    await page(m, `document.getElementById('screenshot-directory').scrollIntoView({block:'center'})`); await wait(200); names.push(await save(m, 'settings-screenshot-save'));
    await page(m, `document.querySelector('[aria-label="窗口截图背景"] button:last-child').click(); document.querySelector('[aria-label="保留窗口阴影"]').click()`); await wait(200); await page(m, `document.getElementById('screenshot-color').scrollIntoView({block:'center'})`); await wait(350); names.push(await save(m, 'settings-screenshot-background'));
    await page(m, `document.getElementById('screenshot-height').scrollIntoView({block:'start'}); Array.from(document.querySelectorAll('button')).find(button => button.textContent === '添加语言').click()`); await wait(250); names.push(await save(m, 'settings-screenshot-ocr'));
    if(global.uiShots.captureOnly)return names;
    await page(m, `Array.from(document.querySelectorAll('.l-set-nav button')).find(button => button.textContent === '通用').click()`); await wait(350);
    m.webContents.send('shell:changed', { ...shell, settingsOpen: true, settings: { ...shell.settings, shortcut: 'F1', captureShortcuts: { ...shell.settings.captureShortcuts, area: 'F2' } } }); await wait(250);
    await page(m, `document.getElementById('shortcut-open').scrollIntoView({block:'center'})`); await wait(150);
    if (!await page(m, `document.getElementById('shortcut-open').textContent.includes('F1') && document.getElementById('shortcut-area').textContent.includes('F2')`)) throw Error('Single function keys did not render in shortcut settings');
    names.push(await save(m, 'settings-shortcuts'));
    await page(m, `document.getElementById('shortcut-rect').scrollIntoView({block:'center'})`); await wait(150); names.push(await save(m, 'settings-rect-shortcut'));
    m.webContents.send('shell:changed', { ...shell, settingsOpen: true });
    m.webContents.send('shell:changed', { ...shell, settingsOpen: true, settings: { ...shell.settings, appPrompts: [
      { name: 'Safari', bundleId: 'com.apple.Safari', prompt: '这段内容来自浏览器。', enabled: true },
      { name: '未安装的应用', bundleId: 'local.lasso.not-installed', prompt: '', enabled: true }
    ] } });
    await page(m, `Array.from(document.querySelectorAll('.l-set-nav button')).find(button => button.textContent === '应用背景').click()`); await wait(450);
    if (!await page(m, `Boolean(document.querySelector('.l-app-icon img')?.src.startsWith('data:image/png;base64,'))`)) throw Error('Installed application icon did not load');
    names.push(await save(m, 'settings-app-icons'));
    m.webContents.send('shell:changed', { ...shell, settingsOpen: true });
    await page(m, `Array.from(document.querySelectorAll('.l-set-nav button')).find(button => button.textContent === '预设').click()`); await wait(350);
    names.push(await save(m, 'preset-list'));
    await page(m, `document.querySelector('.l-preset').focus()`); await wait(150); names.push(await save(m, 'preset-list-selected'));
    await page(m, `document.querySelector('.l-preset').click()`); await wait(450);
    await page(m, `document.getElementById('preset-template').scrollIntoView({block:'center'})`); await wait(150);
    if (!await page(m, `document.querySelector('.l-prompt-source')?.textContent.includes('Google')`)) throw Error('Built-in prompt source was not displayed');
    names.push(await save(m, 'preset-prompt-source'));

    await page(m, `Array.from(document.querySelectorAll('[aria-label="网页会话"] button')).find(button => button.textContent === '临时提问').click(); document.querySelector('[aria-label="网页会话"]').scrollIntoView({block:'center'})`); await wait(250);
    names.push(await save(m, 'preset-temporary-chatgpt'));
    m.show(); m.focus();
    await page(m, `Array.from(document.querySelectorAll('[aria-label="目标"] button')).find(button => button.textContent === 'Gemini').click()`); await wait(450);
    if (!await page(m, `document.querySelector('[aria-label="目标"] [aria-checked="true"]').textContent === 'Gemini' && document.querySelector('.l-editor').textContent.includes('个人 Google 账号')`)) throw Error('Gemini temporary conversation settings did not appear');
    if (!await page(m, `Array.from(document.querySelectorAll('.l-editor .l-seg-thumb')).every(thumb => { const rect=thumb.getBoundingClientRect(); return getComputedStyle(thumb).position==='absolute' && rect.width>30 && rect.height>20; })`)) throw Error('Preset selection highlight has no visible surface');
    names.push(await save(m, 'preset-temporary-gemini'));
    await page(m, `Array.from(document.querySelectorAll('[aria-label="目标"] button')).find(button => button.textContent === 'Codex').click()`); await wait(150);
    if (await page(m, `Boolean(document.querySelector('[aria-label="网页会话"]'))`)) throw Error('Web conversation controls leaked into a local CLI preset');
    await page(m, `Array.from(document.querySelectorAll('[aria-label="预设功能"] button')).find(button => button.textContent === '图片生成').click()`); await wait(200);
    await page(m, `Array.from(document.querySelectorAll('[aria-label="目标"] button')).find(button => button.textContent === 'New API').click()`); await wait(300);
    if (await page(m, `Boolean(document.querySelector('[aria-label="网页会话"]') || document.getElementById('preset-model'))`)) throw Error('Web-only settings leaked into API preset');
    await page(m, `document.querySelector('.l-image-options').scrollIntoView({block:'start'})`); await wait(200);
    if (!await page(m, `document.querySelectorAll('[aria-label="图片比例"] button').length === 12`)) throw Error('Full image aspect choices did not appear');
    names.push(await save(m, 'preset-image-size-auto'));
    for (const [label, choice] of [['图片比例', '16:9'], ['图片分辨率', '2K'], ['图片数量', '3']]) {
      await page(m, `Array.from(document.querySelectorAll('[aria-label="${label}"] button')).find(b => b.textContent === '${choice}').click()`); await wait(100);
    }
    await wait(150);
    names.push(await save(m, 'preset-image-size-selected'));
    await page(m, `Array.from(document.querySelectorAll('[aria-label="尺寸模式"] button')).find(b => b.textContent === '自定义尺寸').click()`); await wait(250);
    if (!await page(m, `document.getElementById('image-width').value === '2752' && document.getElementById('image-height').value === '1536' && !document.querySelector('[aria-label="图片比例"]')`)) throw Error('Custom image dimensions did not take precedence');
    names.push(await save(m, 'preset-image-size-custom'));
    await page(m, `Array.from(document.querySelectorAll('[aria-label="尺寸模式"] button')).find(b => b.textContent === '预设尺寸').click(); document.querySelector('.l-editor').scrollTop = document.querySelector('.l-editor').scrollHeight`); await wait(200);
    if (!await page(m, `(() => { const r = document.querySelector('.l-editor-head button').getBoundingClientRect(); return r.top >= 0 && r.bottom < innerHeight && document.querySelector('.l-editor').scrollTop > 0; })()`)) throw Error('Preset return control scrolled out of view');
    names.push(await save(m, 'preset-return-fixed'));
    await page(m, `document.getElementById('image-api-base').scrollIntoView({block:'center'})`); await wait(150); names.push(await save(m, 'preset-image-api-connection'));
    await page(m, `document.getElementById('image-generation-model').scrollIntoView({block:'start'})`); await wait(150); names.push(await save(m, 'preset-image-api-options'));
    await page(m, `document.querySelector('[aria-label="目标"]').scrollIntoView({block:'center'}); Array.from(document.querySelectorAll('[aria-label="目标"] button')).find(button => button.textContent === 'ChatGPT').click()`); await wait(250);
    await page(m, `Array.from(document.querySelectorAll('[aria-label="网页会话"] button')).find(button => button.textContent === '临时提问').click()`); await wait(150); names.push(await save(m, 'preset-image-web'));
    await page(m, `document.querySelector('.l-editor-head button').click()`); await wait(150);
    if (!await page(m, `document.querySelector('.l-editor-head button').textContent.includes('再点一次放弃更改')`)) throw Error('Unsaved preset return did not require confirmation');
    names.push(await save(m, 'preset-return-confirm'));
    await page(m, `document.querySelector('.l-editor-head button').click()`); await wait(250);
    await page(m, "window.desktop.act('close-settings')"); await wait(300);
    await page(m, "window.desktop.openImagePresets()"); await wait(350); names.push(await save(m, 'palette-images'));
    await page(m, 'window.desktop.closePalette()');
    const imageState = await page(m, 'window.desktop.getState()');
    const thumbnail = (await m.webContents.capturePage()).resize({width:300}).toDataURL();
    m.webContents.send('shell:changed', { ...imageState, inputOpen:true, inputImage:{id:'fixture-input',width:1200,height:900,thumbnail},inputImagePrompt:'保留主体，将背景改成白色。' }); await wait(350);
    if (!await page(m, `document.getElementById('image-prompt')?.value.includes('保留主体')`)) throw Error('Image entry lost the supplied description');
    names.push(await save(m, 'image-preset-input')); m.webContents.send('shell:changed', imageState);
    return names;
  }));
  // Dedicated image-generation surface: fixtures exercise layout without sending paid requests.
  saved.push(...await main(async () => {
    const { find, wait, page, save, path, fixtures, ipcMain, BrowserWindow, app, fs, out } = global.uiShots, names = [];
    if(global.uiShots.captureOnly)return names;
    const appearance = await page(find(), 'window.desktop.getState().then(s => ({fonts:s.settings.fonts, importedFonts:s.settings.importedFonts}))');
    // Use a bundled test font through the existing isolated lasso-font protocol; no user font is read or copied.
    const assets = path.join(process.cwd(), 'dist/renderer/assets'), fontDirectory = path.join(app.getPath('userData'), 'fonts');
    const bundledFont = fs.readdirSync(assets).find(name => name.startsWith('jetbrains-mono-latin-400-normal-') && name.endsWith('.woff2'));
    fs.mkdirSync(fontDirectory, { recursive: true }); fs.copyFileSync(path.join(assets, bundledFont), path.join(fontDirectory, 'ui-shots-font.woff2'));
    const importedFamily = 'UI Shots Imported Mono';
    const importedAppearance = { fonts: Object.fromEntries(['display', 'text', 'ui', 'mono'].map(role => [role, importedFamily])), importedFonts: [{ family: importedFamily, file: 'ui-shots-font.woff2' }] };
    const image = (await find().webContents.capturePage()).resize({ width: 400, height: 300 }).toDataURL();
    const ref = { id: 'fixture-reference', width: 1200, height: 900, thumbnail: image };
    const options = { aspect: '3:2', generationModel: 'configured-generation-model', editModel: 'configured-edit-model', quality: 'auto', background: 'auto', outputFormat: 'png' };
    const draft = { id: 'fixture-draft', presetId: 'draw', presetName: '自由作图', prompt: '一张纸上的暖白建筑草图，细节清晰。', options };
    const original = { ...options, id: 'fixture-original', requestId: 'fixture-first', prompt: '一张纸上的暖白建筑草图，细节清晰。', aspect: '3:2', status: 'succeeded', createdAt: '2026-10-25T01:00:00Z', updatedAt: '2026-10-25T01:01:00Z', images: [{ ...ref, id: 'fixture-original' }] };
    const edited = { ...original, id: 'fixture-edited', requestId: 'fixture-second', prompt: '保留构图，将屋顶改成陶土色。', parentId: original.id, referenceId: original.id, reference: original.images[0], createdAt: '2026-10-25T01:02:00Z', images: [{ ...ref, id: 'fixture-edited' }] };
    const failed = { ...edited, id: 'fixture-failed', images: undefined, status: 'failed', error: '图片请求失败（HTTP 503）；未自动重试', createdAt: '2026-10-25T01:03:00Z' };
    const interrupted = { ...failed, id: 'fixture-interrupted', status: 'interrupted', error: '应用已重启，请求结果未知；不会自动重发。上游可能仍在处理。' };
    let state, requests = [];
    ipcMain.handle('ui-shots:media-state', () => state);
    ipcMain.handle('ui-shots:media-reference', (_event, id) => { state.reference = id ? state.jobs.flatMap(job => job.images || []).find(image => image.id === id) || ref : null; return state; });
    ipcMain.handle('ui-shots:media-restore', (_event, id, edit, imageId) => {
      const job = state.jobs.find(job => job.id === id);
      state.reference = edit ? job.images.find(image => image.id === (imageId || job.images[0].id)) : job.reference || null;
      state.draft = { ...draft, id: 'restored-' + id, prompt: edit ? '' : job.prompt }; return state;
    });
    ipcMain.handle('ui-shots:media-generate', (_event, request) => {
      requests.push({ ...request, referenceId: state.reference?.id });
      if (!state.jobs.some(job => job.requestId === request.requestId)) {
        const id = 'fixture-generated-' + requests.length;
        state.jobs.unshift({ ...options, ...request, id, status: 'succeeded', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), images: [{ ...ref, id }], ...(state.reference ? { reference: state.reference } : {}) });
      }
      return state;
    });
    const states = {
      'quick-image-input': { jobs: [], reference: null, draft },
      'quick-image-multiple': { jobs: [{ ...original, count: 4, images: [original.images[0], ...[2,3,4].map(n => ({...ref, id: 'fixture-result-' + n, width: 1024 * n, height: 768 * n}))] }], reference: null, draft },
      'quick-image-versions': { jobs: [edited, original], reference: original.images[0], draft },
      'quick-image-failed': { jobs: [failed, edited, original], reference: original.images[0], draft },
      'quick-image-interrupted': { jobs: [interrupted, edited, original], reference: original.images[0], draft },
      'quick-image-running': { jobs: [{ ...failed, id: 'fixture-running', status: 'running', error: undefined }], reference: ref, draft },
      'quick-image-fonts': { jobs: [], reference: null, draft, ...importedAppearance },
      'quick-image-narrow': { jobs: [edited, original], reference: original.images[0], draft }
    };
    for (const [name, value] of Object.entries(states)) {
      state = { ...structuredClone(appearance), ...structuredClone(value) }; requests = [];
      const w = new BrowserWindow({ width: name === 'quick-image-narrow' ? 340 : 460, height: 720, frame: false, show: false,
        webPreferences: { preload: path.join(fixtures, 'media-preload.cjs'), contextIsolation: true, sandbox: true } });
      await w.loadFile(path.join(process.cwd(), 'dist/renderer/index.html'), { query: { surface: 'quick-image' } });
      await wait(700);
      if (value.jobs.length) { await page(w, `document.querySelector('.qi-results').scrollIntoView({block:'start'})`); await wait(300); }
      const overflow = await page(w, 'document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth');
      if (overflow) throw Error(name + ': horizontal overflow');
      names.push(await save(w, name));
      if (name === 'quick-image-multiple') {
        await page(w, `document.querySelector('[aria-label="选择第 3 张图片"]').click()`); await wait(250);
        if (!await page(w, `document.querySelector('.l-image-fig figcaption').textContent.includes('3072 × 2304')`)) throw Error('Selected result dimensions did not update');
        names.push(await save(w, 'quick-image-multiple-selected'));
        await page(w, `Array.from(document.querySelectorAll('.qi-result-actions button')).find(b => b.textContent === '基于此版本再改').click()`); await wait(200);
        if (state.reference.id !== 'fixture-result-3' || requests.length) throw Error('Multi-image edit used a different result');
      }
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
        if (requests.length !== 1 || requests[0].referenceId !== original.id) throw Error('Version edit did not use the selected image alone');
      }
      w.destroy();
    }
    ipcMain.removeHandler('ui-shots:media-state'); ipcMain.removeHandler('ui-shots:media-reference'); ipcMain.removeHandler('ui-shots:media-restore'); ipcMain.removeHandler('ui-shots:media-generate');
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
    const { find, wait, move, center, page, save, path, fixtures, ipcMain, BrowserWindow, app, fs, out } = global.uiShots, names = [];
    const W = 1280, H = 800, frame = (await find().webContents.capturePage()).resize({ width: W, height: H }), backdrop = frame.toDataURL();
    const sel = { x: 380, y: 170, width: 520, height: 320 }, crop = frame.crop(sel);
    const windows = [{ id: 1, x: 300, y: 120, width: 640, height: 430 }, { id: 2, x: 120, y: 60, width: 900, height: 620 }];
    const base = { id: 'ui-shots', editId: 'ui-shots-edit', candidates: [], status: '', selection: null };
    const longPixels=Buffer.concat([frame.toBitmap(),frame.toBitmap(),frame.toBitmap()]);
    const long=nativeImage.createFromBitmap(longPixels,{width:W,height:H*3});
    const scrolling={status:'running',width:W,height:H*3,segments:3,seams:[H,H*2],message:'在选区内缓慢向下滚动，每次保留至少三分之一重叠'};
    // A PNG created from the fixture frame uses the same screenshot preload and Editor as local-file editing.
    const localPath = path.join(app.getPath('temp'), 'ui-shots-local.png'); fs.writeFileSync(localPath, frame.toPNG());
    const localImage = nativeImage.createFromPath(localPath);
    const transparentPixels=Buffer.alloc(300*200*4);for(let y=20;y<180;y++)for(let x=20;x<280;x++){const offset=(y*300+x)*4;transparentPixels[offset]=transparentPixels[offset+1]=transparentPixels[offset+2]=transparentPixels[offset+3]=255;}
    const transparentImage=nativeImage.createFromBitmap(transparentPixels,{width:300,height:200});
    const retinaPixels=Buffer.alloc(W*2*H*2*4);for(let offset=0;offset<retinaPixels.length;offset+=4){retinaPixels[offset]=0x56;retinaPixels[offset+1]=0x34;retinaPixels[offset+2]=0x12;retinaPixels[offset+3]=255;}
    const retinaSample=(301*W*2+401)*4;retinaPixels[retinaSample]=0xab;retinaPixels[retinaSample+1]=0xcd;retinaPixels[retinaSample+2]=0xef;
    const retinaBackdrop=nativeImage.createFromBitmap(retinaPixels,{width:W*2,height:H*2}).toDataURL();
    const states = {
      'overlay-loupe-retina': { ...base, image:'',backdrop:retinaBackdrop,width:W,height:H,pixelWidth:W*2,pixelHeight:H*2,pointer:{x:200.5,y:150.5},candidates:[],windows:[],mode:'rect',phase:'selecting',origin:'screen' },
      'overlay-handoff-error': { ...base,image:'',backdrop,width:W,height:H,windows,candidates:[{...sel,source:'element'}],mode:'area',phase:'selecting',origin:'screen' },
      'overlay-rect': { ...base, image: '', backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, candidates: [], windows: [], mode: 'rect', phase: 'selecting', origin: 'screen' },
      'overlay-area': { ...base, image: '', backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, candidates: [{ ...sel, source: 'element' }, { ...windows[0], source: 'window' }], windows, mode: 'area', phase: 'selecting', origin: 'screen' },
      'overlay-window': { ...base, image: '', backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, windows, mode: 'window', phase: 'selecting', origin: 'screen' },
      'overlay-scroll': { ...base, image: '', backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, candidates:[{...sel,source:'element'}],windows,mode:'scroll',phase:'selecting',origin:'screen' },
      'scroll-running': {...base,image:'',width:W,height:H,pixelWidth:W,pixelHeight:H,phase:'scrolling',scroll:scrolling,origin:'screen'},
      'scroll-paused': {...base,image:'',width:W,height:H,pixelWidth:W,pixelHeight:H,phase:'scrolling',scroll:{...scrolling,status:'paused',message:'匹配不可靠，已暂停并保留结果。请向上回到上次采集位置，再继续慢滚。'},origin:'screen'},
      'scroll-review': {...base,image:long.toDataURL(),width:W,height:H*3,pixelWidth:W,pixelHeight:H*3,phase:'review',scroll:{...scrolling,status:'review',message:'已结束采集。检查接缝后进入编辑；可撤回末段。'},origin:'screen'},
      'editor-inline': { ...base, image: crop.toDataURL(), backdrop, placement: sel, width: sel.width, height: sel.height, pixelWidth: sel.width, pixelHeight: sel.height, selection: { x: 0, y: 0, width: sel.width, height: sel.height }, phase: 'result', origin: 'screen' },
      'editor-transparent': { ...base, image: transparentImage.toDataURL(), width: 300, height: 200, pixelWidth: 300, pixelHeight: 200, selection: {x:0,y:0,width:300,height:200}, phase:'result', origin:'screen', presentation:'window' },
      'editor-capture-window': { ...base, image: backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, selection: { x: 0, y: 0, width: W, height: H }, phase: 'result', origin: 'screen', presentation: 'window', captureKind: 'screen' },
      'editor-output-failure': { ...base, image: backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, selection: { x: 0, y: 0, width: W, height: H }, phase: 'result', origin: 'screen', presentation: 'window', outputStatus: '已复制', outputError: '保存失败：文件夹不可写，请另选位置保存。' },
      'editor-crop-active': { ...base, image: backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, selection: { x: 0, y: 0, width: W, height: H }, phase: 'result', origin: 'screen', presentation: 'window' },
      'editor-window': { ...base, image: backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, selection: { x: 0, y: 0, width: W, height: H }, phase: 'result', origin: 'clipboard' },
      'editor-local-file': { ...base, image: localImage.toDataURL(), width: W, height: H, pixelWidth: W, pixelHeight: H, selection: { x: 0, y: 0, width: W, height: H }, phase: 'result', origin: 'clipboard', annotations: {
        objects: [{ type: 'Rect', left: 80, top: 60, width: 120, height: 45, originX: 'left', originY: 'top', fill: '#171717', strokeWidth: 0, lassoTool: 'redact' }],
        crop: { x: 0, y: 0, width: W, height: H }, nextNumber: 1, privacy: [{ x: 80, y: 60, width: 120, height: 45 }]
      } },
      'editor-picker-hex': { ...base, image: backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, selection: { x: 0, y: 0, width: W, height: H }, phase: 'result', origin: 'clipboard' },
      'editor-picker-rgb': { ...base, image: backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, selection: { x: 0, y: 0, width: W, height: H }, phase: 'result', origin: 'clipboard' },
      'editor-selected-annotation': { ...base, image: backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, selection: { x: 0, y: 0, width: W, height: H }, phase: 'result', origin: 'clipboard', annotations: {
        objects: [{ type: 'Rect', left: 300, top: 200, width: 260, height: 120, fill: 'transparent', stroke: '#e24a35', strokeWidth: 4, lassoTool: 'rectangle' }],
        crop: { x: 0, y: 0, width: W, height: H }, nextNumber: 1, privacy: []
      } }
    };
    let state = null, exports = [];
    ipcMain.removeHandler('ui-shots:state'); ipcMain.handle('ui-shots:state', () => state);
    ipcMain.removeHandler('ui-shots:export'); ipcMain.handle('ui-shots:export', (_event, frame, action, format) => { exports.push({ frame, action, format }); return { error: null }; });
    ipcMain.removeHandler('ui-shots:pixels');ipcMain.handle('ui-shots:pixels',(_event,id)=>{
      const image=nativeImage.createFromDataURL(id==='fixture-backdrop'?state.backdrop:state.image),size=image.getSize(),data=image.toBitmap();
      for(let i=0;i<data.length;i+=4){const a=data[i+3],b=data[i],r=data[i+2];data[i]=a?Math.min(255,Math.round(r*255/a)):0;data[i+1]=a?Math.min(255,Math.round(data[i+1]*255/a)):0;data[i+2]=a?Math.min(255,Math.round(b*255/a)):0;}
      return {...size,data};
    });
    const native=process.mainModule.require(path.join(process.cwd(),'dist/native/capture-native.node'));
    for (const [name, value] of Object.entries(states)) {
      state = value; exports = [];
      if(name.startsWith('overlay-')){
        const source=nativeImage.createFromDataURL(value.backdrop),size=source.getSize(),frame=native.createFrame({...size,data:source.toBitmap(),logicalWidth:W,logicalHeight:H});
        const options={frameId:frame.id,session:'ui-shots-native',mode:value.mode,windows:value.windows||[],candidates:value.candidates||[],pointer:value.pointer||{x:420,y:240}};
        native.show(options);if(name==='overlay-handoff-error')native.update({session:'ui-shots-native',message:'编辑器未能准备好，请重试或取消'});await wait(150);
        const saveNative=name=>{const pixels=native.render();fs.writeFileSync(path.join(out,name+'.png'),nativeImage.createFromBitmap(pixels.data,{width:pixels.width,height:pixels.height}).toPNG());names.push(name);};
        if(name==='overlay-loupe-retina'){
          const sample=native.snapshot();if(sample.color!=='#EFCDAB'||!sample.position.includes('X 401 · Y 301'))throw Error('Native Retina loupe sampled the wrong pixel: '+JSON.stringify(sample));
          saveNative(name);
          for(const [x,y] of [[1,1],[W-1,1],[1,H-1],[W-1,H-1]]){native.show({...options,pointer:{x,y}});await wait(30);const r=native.snapshot().loupe;if(r.x<0||r.y<0||r.x+r.width>W||r.y+r.height>H)throw Error('Native loupe leaves viewport');}
          saveNative('overlay-loupe-edge');
        }else saveNative(name);
        native.hide();native.release(frame.id);continue;
      }

      const w = new BrowserWindow({ x: 40, y: 40, width: name.startsWith('scroll-')&&name!=='scroll-review'?700:W, height:name.startsWith('scroll-')&&name!=='scroll-review'?118:H, frame: false, show: true, backgroundColor: value.origin === 'clipboard' ? '#E9E6DD' : '#222222', webPreferences: { preload: path.join(fixtures, 'screenshot-preload.cjs'), contextIsolation: true, sandbox: true } });
      await w.loadFile(path.join(process.cwd(), 'dist/renderer/index.html'), { query: { surface: 'screenshot' } });
      await wait(900);
      if (name === 'scroll-review') {await page(w,`document.querySelector('.scroll-seams button')?.click()`);await wait(300);}
      // The editor enables its tools once the image has loaded; then pick the arrow so the style panel shows.
      if (name === 'editor-transparent' && await page(w, `document.querySelector('canvas.lower-canvas').getContext('2d').getImageData(0,0,1,1).data[3]`) !== 0) throw Error('Transparent image was flattened in editor');
      if (name === 'editor-capture-window' && await page(w, `Boolean(document.querySelector('.editor-crop'))`)) throw Error('Capture result unexpectedly shows crop handles');
      if (name === 'editor-crop-active') { await page(w, `document.querySelector('.ed-tool[data-tip^="裁剪"]').click()`); await wait(250); if (!await page(w, `Boolean(document.querySelector('.editor-crop'))`)) throw Error('Crop tool did not show handles'); }
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
      names.push(await save(w, name));
      if (name === 'editor-local-file') {
        await page(w, `(() => { const button = document.querySelector('[aria-label="用于生图"]'); if (!button || button.disabled) throw Error('Editor generation entry is unavailable'); button.click(); })()`);
        for (let pass = 0; pass < 40 && !exports.length; pass++) await wait(100);
        if (exports.length !== 1 || exports[0].action !== 'media' || exports[0].format !== 'png') throw Error('Local-file editor did not emit exactly one fixture media output');
        const output = exports[0].frame, png = Buffer.from(output.png);
        if (png.length < 24 || png.readUInt32BE(16) !== output.crop.width || png.readUInt32BE(20) !== output.crop.height) throw Error('Editor fixture media output did not contain its flattened crop');
        const pixels = nativeImage.createFromBuffer(png).toBitmap(), pixel = (80 * output.crop.width + 100) * 4;
        if (![0, 1, 2].every(channel => pixels[pixel + channel] === 23) || pixels[pixel + 3] !== 255) throw Error('Editor fixture media output lost its privacy mask');
      }
      w.destroy();
    }
    ipcMain.removeHandler('ui-shots:state'); ipcMain.removeHandler('ui-shots:export');
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
