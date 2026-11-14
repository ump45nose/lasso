// Captures every Lasso v4 surface (Boards B1–B9) into outputs/ui-shots for visual review: `npm run ui:shots`.
// Runs the built app with all runtime data isolated below outputs/ui-shots/runtime-* and drives it
// through the main-process inspector. No external network, system clipboard, or real screen capture is used.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const fixtures = join(root, 'scripts/ui-shots');
const out = process.env.LASSO_UI_OUTPUT_DIR ? resolve(root, process.env.LASSO_UI_OUTPUT_DIR) : join(root, 'outputs/ui-shots');
if (relative(join(root, 'outputs'), out).startsWith('..') || !relative(root, out).startsWith('outputs')) {
  throw Error('UI shots output must stay inside workspace outputs/');
}
mkdirSync(out, { recursive: true });
const runtime = mkdtempSync(join(out, 'runtime-'));
const bootstrap = join(runtime, 'main.cjs');
const runtimePaths = Object.fromEntries(
  ['appData', 'userData', 'sessionData', 'temp', 'crashDumps', 'logs'].map(name => [
    name,
    join(runtime, name === 'userData' ? 'lasso-ui-shots' : name)
  ])
);
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
  symlinkSync(join(root, 'dist/native'), join(runtime, 'native'), 'dir');
  symlinkSync(join(root, 'assets'), join(runtime, 'assets'), 'dir');

  // Disable selection hooks in isolated test profile so macOS Accessibility prompt never triggers.
  writeFileSync(
    join(runtimePaths.userData, 'settings.json'),
    JSON.stringify({
      shortcut: '',
      selectionEnabled: false,
      clipboardFallback: false,
      actionShortcuts: {}
    })
  );

  mkdirSync(join(runtimePaths.userData, 'nook-cache'));
  writeFileSync(
    join(runtimePaths.userData, 'nook-cache/google.json'),
    JSON.stringify({
      taskLists: [
        { title: 'Lasso · 今日重点', items: [{ id: 'nook-1', title: '整理截图编辑器工具条层级', status: 'open' }] },
        { title: 'Lasso · 验收', items: [{ id: 'nook-2', title: '检查 WebDAV 同步无后台轮询', status: 'open' }] }
      ]
    })
  );

  writeFileSync(
    bootstrap,
    `const electron = require('electron');
const { app, dialog, session } = electron;
global.uiShotsLogin = { settings:{openAtLogin:false},calls:[] };
app.setLoginItemSettings = options => { global.uiShotsLogin.calls.push(options);global.uiShotsLogin.settings={...global.uiShotsLogin.settings,...options}; };
app.getLoginItemSettings = () => ({...global.uiShotsLogin.settings});

const loopback=host=>['localhost','127.0.0.1','::1','[::1]'].includes(String(host).toLowerCase());
const localURL=value=>{try{return loopback(new URL(value).hostname);}catch{return false;}};
const nodeAudit={blocked:[],allowedLocal:[],guards:[]},nodeGuards=[];
function nodeGate(kind,target,local){if(local){nodeAudit.allowedLocal.push({kind,target});return;}nodeAudit.blocked.push({kind,target});const err=Error('UI shots blocked external runtime access: '+kind);err.code='UI_SHOTS_EXTERNAL_BLOCKED';throw err;}
function urlTarget(value){const url=new URL(typeof value==='object'&&value?.url?value.url:value);return {target:url.origin,local:['file:','data:','lasso-font:'].includes(url.protocol)||loopback(url.hostname)};}
function socketTarget(args){let value=args[0];if(Array.isArray(value))return socketTarget(value);if(value&&typeof value==='object'){if(value.path)return {target:'unix-socket',local:true};const host=value.hostname||value.host||'localhost';return {target:String(host),local:loopback(host)};}if(typeof value==='string'&&!/^\\d+$/.test(value))return {target:'unix-socket',local:true};const host=typeof args[1]==='string'?args[1]:'localhost';return {target:host,local:loopback(host)};}
function requestTarget(args){const value=args[0];if(typeof value==='string'||value instanceof URL)return urlTarget(value);if(value?.url)return urlTarget(value.url);if(value?.socketPath)return {target:'unix-socket',local:true};const host=value?.hostname||value?.host||'localhost';return {target:String(host),local:loopback(host)};}
function guard(owner,key,kind,resolve){const original=owner[key];const wrapped=function(...args){const route=resolve(args);nodeGate(kind,route.target,route.local);return Reflect.apply(original,this,args);};owner[key]=wrapped;nodeGuards.push(()=>owner[key]===wrapped);nodeAudit.guards.push(kind);}
const nodeHttp=require('node:http'),nodeHttps=require('node:https'),nodeNet=require('node:net'),nodeTls=require('node:tls'),nodeChild=require('node:child_process');
guard(global,'fetch','fetch',args=>urlTarget(args[0]));const guardedFetch=global.fetch,asyncFetch=async(...args)=>guardedFetch(...args);global.fetch=asyncFetch;nodeGuards.pop();nodeGuards.push(()=>global.fetch===asyncFetch);
for(const [mod,name]of [[nodeHttp,'http'],[nodeHttps,'https']])for(const method of ['request','get'])guard(mod,method,name+'.'+method,requestTarget);
for(const method of ['connect','createConnection'])guard(nodeNet,method,'net.'+method,socketTarget);
guard(nodeNet.Socket.prototype,'connect','net.Socket.connect',socketTarget);guard(nodeTls,'connect','tls.connect',socketTarget);
guard(electron.net,'fetch','electron.net.fetch',args=>urlTarget(args[0]));guard(electron.net,'request','electron.net.request',requestTarget);
for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])guard(nodeChild,method,'child_process.'+method,()=>({target:'blocked',local:false}));
require('node:module').syncBuiltinESMExports();
global.uiShotsNode={audit:nodeAudit,verify:()=>nodeGuards.every(check=>check())};

const networkSessions = new WeakSet();
function isolateNetwork(currentSession) {
  if (networkSessions.has(currentSession)) return;
  currentSession.webRequest.onBeforeRequest({urls:['<all_urls>']}, (request, callback) => {
    const protocol = request.url.split(':',1)[0].toLowerCase();
    if (['http','https','ws','wss','ftp'].includes(protocol) && !localURL(request.url)) callback({cancel:true});
    else callback({cancel:false});
  });
  networkSessions.add(currentSession);
}
app.on('session-created', isolateNetwork);

let items = [];
class MemoryClipboardItem {
  constructor(values) { this.values = values; this.types = Object.keys(values); }
  async getType(type) { const value = await this.values[type]; return value instanceof Blob ? value : new Blob([value], { type }); }
  static supports() { return true; }
}
const memoryClipboard = {
  __uiShotsMemory: true,
  read: async () => items,
  write: async value => { items = Array.isArray(value) ? value : [new MemoryClipboardItem(value)]; },
  readText: async () => { const item = items.find(i => i.types.includes('text/plain')); return item ? (await item.getType('text/plain')).text() : ''; },
  writeText: async value => { items = [new MemoryClipboardItem({ 'text/plain': String(value) })]; },
  clear: () => { items = []; },
  availableFormats: () => items.flatMap(i => i.types),
  has: type => items.some(i => i.types.includes(type)),
  readImage: () => electron.nativeImage.createEmpty(),
  readBuffer: () => Buffer.alloc(0),
  readHTML: () => '', readRTF: () => '', readBookmark: () => ({title:'',url:''}), readFindText: () => '',
  writeImage: image => { items = [new MemoryClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], {type:'image/png'}) })]; },
  writeBuffer: () => {}, writeHTML: () => {}, writeRTF: () => {}, writeBookmark: () => {}, writeFindText: () => {}
};
const safeStorage = { isEncryptionAvailable:()=>true, encryptString:v=>Buffer.from('ui-shots:'+v), decryptString:v=>v.toString().replace(/^ui-shots:/,'') };
const memoryElectron = Object.create(electron, {clipboard:{value:memoryClipboard},ClipboardItem:{value:MemoryClipboardItem},safeStorage:{value:safeStorage}});
const Module = require('node:module'), originalLoad = Module._load;
Module._load = function(request, ...args) { return request==='electron' ? memoryElectron : originalLoad.call(this,request,...args); };

app.whenReady().then(() => {
  isolateNetwork(session.defaultSession);
  session.defaultSession.registerPreloadScript({type:'frame',id:'ui-shots-memory-clipboard',filePath:${JSON.stringify(join(fixtures, 'preload.cjs'))}});
});
dialog.showErrorBox = (title, message) => console.error(title, message);
const { mkdirSync } = require('node:fs');
const paths = ${JSON.stringify(runtimePaths)};
for (const key of ['appData', 'userData', 'sessionData', 'temp', 'crashDumps']) {
  mkdirSync(paths[key], { recursive: true }); app.setPath(key, paths[key]);
}
app.setAppLogsPath(paths.logs);
app.on('web-contents-created', (_event, contents) => contents.setBackgroundThrottling(false));
require(${JSON.stringify(join(root, 'dist/main.cjs'))});
`
  );

  child = spawn(electron, ['--inspect=127.0.0.1:0', bootstrap], {
    cwd: root,
    env: { ...process.env, LASSO_PROFILE: 'lasso-ui-shots', LASSO_DATA_ROOT: runtime, TMPDIR: join(runtime, 'temp') },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.on('error', error => {
    childError = error;
  });
  child.stderr.on('data', data => {
    appendFileSync(join(out, 'runtime.log'), data);
    const match = data.toString().match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/);
    if (match) inspectorURL = match[1];
  });

  ws = new WebSocket(await inspector());
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  for (let pass = 0; pass < 100; pass++) {
    if (await main(({ app }) => app.isReady())) break;
    await sleep(100);
  }

  // Bootstrap helpers and synthetic art generator inside Electron main
  await main(
    async ({ app, BrowserWindow, ipcMain, nativeImage }, out, fixtures, runtime) => {
      const fs = process.mainModule.require('fs');
      const path = process.mainModule.require('path');
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

      const find = surface =>
        BrowserWindow.getAllWindows().find(w => {
          if (w.isDestroyed()) return false;
          const url = w.webContents.getURL();
          if (!url.startsWith('file:') || !url.includes('/renderer/index.html')) return false;
          const current = new URL(url).searchParams.get('surface');
          return surface ? current === surface : current === null;
        });

      for (let i = 0; i < 60 && !(find() && find('action-bar') && find('island')); i++) await wait(200);
      if (!find() || !find('action-bar')) throw Error('Main or action-bar window failed to start');

      const page = async (w, script) => {
        try {
          return await w.webContents.executeJavaScript(script);
        } catch (error) {
          throw Error(error.message + '\nScript: ' + script);
        }
      };
      const ready = async (w, expression) => {
        for (let pass = 0; pass < 100; pass++) {
          if (await page(w, expression)) return;
          await wait(60);
        }
        throw Error('UI did not become ready: ' + expression);
      };
      const move = async (w, x, y) => {
        w.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
        await wait(250);
      };
      const save = async (w, name) => {
        await page(
          w,
          `(async () => {
            await document.fonts.ready;
            for (let f = 0; f < 60; f++) {
              await new Promise(requestAnimationFrame);
              const running = document.getAnimations().some(a => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime));
              if (!running) break;
            }
          })()`
        );
        await wait(120);
        fs.writeFileSync(path.join(out, name + '.png'), (await w.webContents.capturePage()).toPNG());
        return name;
      };

      // Build warm landscape artwork bitmap (matching v4 clay sun + oat hills)
      const makeArtwork = (width = 640, height = 420) => {
        const pixels = Buffer.alloc(width * height * 4);
        const cx = Math.round(width * 0.72),
          cy = Math.round(height * 0.28),
          rSun = Math.round(Math.min(width, height) * 0.12);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            let r = 239,
              g = 230,
              b = 216; // warm sky #EFE6D8
            const dx = x - cx,
              dy = y - cy;
            if (dx * dx + dy * dy <= rSun * rSun) {
              r = 217;
              g = 119;
              b = 87; // clay sun #D97757
            }
            const h1 = height * 0.62 + Math.sin(x / (width * 0.22)) * (height * 0.08);
            const h2 = height * 0.74 + Math.cos(x / (width * 0.18)) * (height * 0.06);
            if (y > h1) {
              r = 205;
              g = 191;
              b = 169;
            }
            if (y > h2) {
              r = 92;
              g = 110;
              b = 69; // olive foreground hill
            }
            const o = (y * width + x) * 4;
            pixels[o] = b;
            pixels[o + 1] = g;
            pixels[o + 2] = r;
            pixels[o + 3] = 255;
          }
        }
        return nativeImage.createFromBitmap(pixels, { width, height });
      };

      const artImage = makeArtwork(640, 420);
      const artDataUrl = artImage.toDataURL();

      global.uiShots = { app, BrowserWindow, ipcMain, nativeImage, fs, path, out, fixtures, runtime, wait, find, page, ready, move, save, artImage, artDataUrl };
    },
    out,
    fixtures,
    runtime
  );

  // Seed realistic API connections & presets via real IPC so B1, B2, B8, and B9 share consistent data
  await main(async () => {
    const { find, page, ipcMain } = global.uiShots;
    const m = find();

    // Stub model pulling so it never touches external network
    const saveConnHandler = ipcMain._invokeHandlers.get('shell:api-connection-save');
    const connsHandler = ipcMain._invokeHandlers.get('shell:api-connections');
    ipcMain.removeHandler('shell:api-connection-models');
    ipcMain.handle('shell:api-connection-models', async (event, id) => {
      const conns = await connsHandler(event);
      const target = conns.find(c => c.id === id);
      if (!target || !target.baseURL) return { models: [], error: '请先填写 Base URL' };
      const models = ['deepseek-chat', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-image-1', 'gemini-2.5-flash'];
      await saveConnHandler(event, { id: target.id, name: target.name, baseURL: target.baseURL, models });
      return { models, error: null };
    });

    const deepseek = await page(
      m,
      `window.desktop.saveApiConnection({ name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', credential: 'sk-fixture-deepseek', models: ['deepseek-chat', 'deepseek-reasoner'] })`
    );
    const visionGw = await page(
      m,
      `window.desktop.saveApiConnection({ name: 'New API 视觉网关', baseURL: 'https://vision.example.invalid/v1', credential: 'sk-fixture-vision', models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-image-1', 'gemini-2.5-flash'] })`
    );
    await page(
      m,
      `window.desktop.saveApiConnection({ name: 'Gemini API', baseURL: 'https://generativelanguage.example.invalid/v1beta', models: [] })`
    );

    const dsId = deepseek.connection.id;
    const vgId = visionGw.connection.id;

    await page(m, `window.desktop.saveDefaultApiChat({ connectionId: ${JSON.stringify(dsId)}, model: 'deepseek-chat' })`);
    await page(
      m,
      `window.desktop.saveTranslationSettings({ provider: 'llm', connectionId: ${JSON.stringify(dsId)}, model: 'deepseek-chat', targetLang: 'auto', copyTranslateEnabled: true, copyTranslateTrigger: 'double-cmd-c' })`
    );
    await page(
      m,
      `window.desktop.saveVisionConfig({ connectionId: ${JSON.stringify(vgId)}, baseURL: 'https://vision.example.invalid/v1', model: 'gpt-4.1', targetLanguage: '简体中文' })`
    );

    const state = await page(m, 'window.desktop.getState()');
    const updatedPresets = [
      ...state.presets.slice(0, 2),
      {
        id: 'ask-fast',
        kind: 'chat',
        name: '问 AI',
        template: '用通俗精简的中文解释选中内容：\n\n{{selection}}',
        target: 'api',
        connectionId: dsId,
        model: 'deepseek-chat',
        mode: 'send',
        needsSelection: true,
        enabled: true
      },
      {
        id: 'illustrate',
        kind: 'image',
        name: '内容配图',
        template: '生成暖白纸面与陶土配色的清爽插画：\n\n{{selection}}',
        target: 'api',
        connectionId: vgId,
        image: {
          aspect: '3:2',
          count: 2,
          generationModel: 'gpt-image-1',
          editModel: 'gpt-image-1',
          quality: 'high',
          background: 'auto',
          outputFormat: 'png'
        },
        mode: 'send',
        needsSelection: false,
        enabled: true
      },
      ...state.presets.slice(2).filter(p => !(p.kind === 'image' && p.name === '内容配图'))
    ];
    await page(m, `window.desktop.savePresets(${JSON.stringify(updatedPresets)})`);
  });

  /* ═══════════════ B1: Selection Action Bar & Fast API Card ═══════════════ */
  saved.push(
    ...(await main(async () => {
      const { find, page, wait, move, save } = global.uiShots;
      const w = find('action-bar');
      const names = [];
      w.setOpacity(1);
      w.showInactive();
      w.webContents.send('bar:enter', { tip: 'above', menu: 'above' });
      await wait(400);

      const hasTranslateAndNote = await page(
        w,
        `Boolean(document.querySelector('button[aria-label="翻译"]') || [...document.querySelectorAll('.ab-buttons button')].some(b => b.textContent.includes('翻译'))) && Boolean(document.querySelector('button[aria-label="存入便签"]'))`
      );
      if (!hasTranslateAndNote) throw Error('B1 ActionBar missing 翻译 or 存入便签');

      const btnRect = await page(w, `(() => { const r = document.querySelectorAll('.ab-buttons button')[1]?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null; })()`);
      if (btnRect) {
        await move(w, btnRect[0], btnRect[1]);
        await wait(450);
      }
      names.push(await save(w, 'v4-b1-action-bar'));

      await move(w, 2, 2);
      await page(w, `document.querySelector('.ab-bar')?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))`);
      await page(w, `document.querySelector('[aria-haspopup="menu"]').click()`);
      await wait(350);
      names.push(await save(w, 'v4-b1-action-bar-menu'));
      await page(w, `document.querySelector('[aria-haspopup="menu"]').click()`);
      await wait(200);

      const barState = await page(w, 'window.actionBar.getState()');
      w.setBounds({ x: 160, y: 160, width: 492, height: 340 });
      w.webContents.send('bar:changed', {
        ...barState,
        fastCard: {
          presetId: 'ask-fast',
          presetName: '问 AI',
          connectionId: 'ds',
          model: 'deepseek-chat',
          status: 'done',
          text: '这段命令读取 `~/.config/lasso/settings.json` 中的快捷键与翻译配置，并将合并后的 JSON 复制到剪贴板。',
          error: null,
          firstTokenMs: 138
        }
      });
      await wait(350);
      const hasContinue = await page(w, `[...document.querySelectorAll('.ab-fast-card button')].some(b => b.textContent.includes('继续追问'))`);
      if (!hasContinue) throw Error('B1 FastApiCard missing 继续追问 button');
      names.push(await save(w, 'v4-b1-fast-card'));

      w.webContents.send('bar:changed', { ...barState, fastCard: null });
      w.hide();
      return names;
    }))
  );

  /* ═══════════════ B2: Main AI Chat Window (Launcher, Delivery, API Chat, Palette) ═══════════════ */
  saved.push(
    ...(await main(async () => {
      const { find, page, wait, ready, save, artDataUrl } = global.uiShots;
      const m = find();
      const names = [];
      await page(m, `window.desktop.getState().then(s => s.pinned ? undefined : window.desktop.act('pin'))`);
      m.setSize(480, 660);
      m.show();
      m.focus();
      await wait(500);

      // Ensure clean launcher state
      await page(
        m,
        `(async () => {
          const s = await window.desktop.getState();
          for (const t of s.tasks) await window.desktop.closeTask(t.id);
        })()`
      );
      await ready(m, `Boolean(document.querySelector('.l-launch'))`);
      const hasRetiredCli = await page(m, `document.body.textContent.includes('Codex') || document.body.textContent.includes('本地 CLI')`);
      if (hasRetiredCli) throw Error('B2 Launcher still mentions retired Codex / 本地 CLI');
      names.push(await save(m, 'v4-b2-launcher'));

      // Command Palette with selection chip
      const baseShell = await page(m, 'window.desktop.getState()');
      m.webContents.send('shell:changed', { ...baseShell, selection: { length: 128, sourceApp: 'Safari' } });
      await page(m, `window.desktop.openPalette('all')`);
      await wait(350);
      names.push(await save(m, 'v4-b2-palette'));
      await page(m, `window.desktop.closePalette()`);
      await wait(250);

      // Native Multi-turn API Chat
      await page(m, `window.desktop.newTask({ target: 'api' })`);
      await ready(m, `Boolean(document.querySelector('.l-apichat'))`);
      const chatShell = await page(m, 'window.desktop.getState()');
      const taskId = chatShell.activeTaskId;
      const chatState = await page(m, `window.desktop.getApiChat(${JSON.stringify(taskId)})`);
      m.webContents.send('apichat:changed', {
        taskId,
        state: {
          ...chatState,
          messages: [
            {
              id: 'u-1',
              role: 'user',
              text: '帮我看下这张插画的配色比例为什么看起来很舒服？',
              image: { id: 'img-1', thumbnail: artDataUrl, width: 1280, height: 840 }
            },
            {
              id: 'a-1',
              role: 'assistant',
              text: '画面大面积使用了暖白与燕麦色作为安静底色，前景用低饱和橄榄绿稳住重心，只在右上角太阳这一处点缀了实心陶土色（`#D97757`），视觉焦点非常集中。',
              firstTokenMs: 146
            }
          ]
        }
      });
      await wait(350);
      names.push(await save(m, 'v4-b2-api-chat'));

      // Transient web delivery progress bar
      m.webContents.send('shell:changed', {
        ...chatShell,
        delivery: {
          phase: 'sending',
          message: '正在填入提示词并发送至 ChatGPT…',
          canCopy: true,
          steps: ['open', 'model', 'fill', 'send'],
          step: 'fill'
        }
      });
      await wait(300);
      names.push(await save(m, 'v4-b2-delivery'));
      m.webContents.send('shell:changed', chatShell);
      await wait(200);
      return names;
    }))
  );

  /* ═══════════════ B3, B4, B5, B6, B7: Desktop Suite Surfaces ═══════════════ */
  saved.push(
    ...(await main(async () => {
      const { find, page, wait, ready, save, artDataUrl } = global.uiShots;
      const names = [];

      // B3 Translator (folded selection vs expanded input)
      const transWin = find('translate');
      await ready(transWin, `Boolean(window.island && document.querySelector('.sw-win'))`);
      transWin.setSize(440, 340);
      transWin.setOpacity(1);
      transWin.showInactive();
      const foldedTrans = await page(transWin, `window.island.getTranslatorState().then(b => window.__uiShotsFixtures.translatorState(b, 'folded'))`);
      transWin.webContents.send('translator:changed', foldedTrans);
      await wait(350);
      if (!(await page(transWin, `Boolean(document.querySelector('.sw-src-fold'))`))) throw Error('B3 Translator folded source bar missing');
      names.push(await save(transWin, 'v4-b3-translator-folded'));

      transWin.setSize(440, 420);
      const expandedTrans = await page(transWin, `window.island.getTranslatorState().then(b => window.__uiShotsFixtures.translatorState(b, 'expanded'))`);
      transWin.webContents.send('translator:changed', expandedTrans);
      await wait(350);
      if (!(await page(transWin, `Boolean(document.querySelector('.sw-src-box'))`))) throw Error('B3 Translator expanded source box missing');
      names.push(await save(transWin, 'v4-b3-translator-expanded'));
      transWin.hide();

      // B4 Notch Island & Focus Board
      const isl = find('island');
      await ready(isl, `Boolean(window.island && document.querySelector('.isl-shell'))`);
      isl.setOpacity(1);
      isl.showInactive();
      const islFixtures = await page(isl, `window.island.getState().then(b => window.__uiShotsFixtures.islandStates(b))`);

      isl.setSize(520, 64);
      isl.webContents.send('island:changed', islFixtures.focusCapsule);
      await wait(300);
      names.push(await save(isl, 'v4-b4-island-focus'));

      isl.webContents.send('island:changed', islFixtures.pomodoroCapsule);
      await wait(300);
      names.push(await save(isl, 'v4-b4-island-pomodoro'));

      isl.webContents.send('island:changed', islFixtures.alertCapsule);
      await wait(300);
      names.push(await save(isl, 'v4-b4-island-alert'));

      isl.setSize(440, 680);
      isl.webContents.send('island:changed', islFixtures.board);
      await wait(400);
      if (await page(isl, `document.body.textContent.includes('Codex')`)) throw Error('B4 Island board still contains retired CLI');
      names.push(await save(isl, 'v4-b4-island-board'));
      isl.hide();

      // B5 Dual-Pane Clipboard History (680×480)
      const clipWin = find('clipboard');
      await ready(clipWin, `Boolean(window.island && document.querySelector('.sw-win'))`);
      clipWin.setSize(680, 480);
      clipWin.setOpacity(1);
      clipWin.showInactive();
      const mWin = find();
      const safariIcon = await page(mWin, `window.desktop.appIcon('com.apple.Safari')`);
      const finderIcon = await page(mWin, `window.desktop.appIcon('com.apple.finder')`);
      const clipPayload = await page(
        clipWin,
        `window.island.getClipboardState().then(b => window.__uiShotsFixtures.clipboardState(b, ${JSON.stringify({ safariIcon, finderIcon, thumbnailDataUrl: artDataUrl })}))`
      );
      clipWin.webContents.send('clipboard-history:changed', clipPayload);
      await wait(350);
      names.push(await save(clipWin, 'v4-b5-clipboard-text'));

      await page(clipWin, `document.querySelectorAll('.sw-crow')[1].click()`);
      await wait(250);
      names.push(await save(clipWin, 'v4-b5-clipboard-image'));
      clipWin.hide();

      // B6 EdgeNotes (Persistent edit + Preview + Unfocused header)
      const notesWin = find('edge-notes');
      await ready(notesWin, `Boolean(window.island && document.querySelector('.en-stage'))`);
      notesWin.setSize(420, 500);
      notesWin.setOpacity(1);
      notesWin.showInactive();
      const baseNotes = await page(notesWin, `window.island.getNotesState()`);
      const notesPayload = {
        ...baseNotes,
        open: true,
        focused: true,
        pinnedOnTop: true,
        activeFile: 'Scratchpad.md',
        files: ['Scratchpad.md', 'release-v4.md'],
        content:
          '# 今日推进备忘\n\n- [x] 收敛截图工具条为两排紧凑布局\n- [ ] 核对独立设置窗 8 个模块自动保存\n- [ ] 验证访达面板发给 AI 动作\n\n失焦时不退出编辑态，保留光标与滚动位置。'
      };
      notesWin.webContents.send('notes:changed', notesPayload);
      await wait(350);
      // Verify persistent edit mode is default AND blur on textarea does NOT exit edit mode!
      await page(notesWin, `document.querySelector('textarea')?.dispatchEvent(new FocusEvent('blur', { bubbles: true }))`);
      await wait(150);
      if (!(await page(notesWin, `Boolean(document.querySelector('textarea'))`))) {
        throw Error('B6 EdgeNotes exited edit mode on blur!');
      }
      names.push(await save(notesWin, 'v4-b6-notes-edit'));

      await page(notesWin, `[...document.querySelectorAll('[aria-label="编辑与预览切换"] button, .l-seg button')].find(b => b.textContent.includes('预览'))?.click()`);
      await wait(250);
      names.push(await save(notesWin, 'v4-b6-notes-preview'));

      // Switch back to edit mode and then simulate window blur — verify edit mode persists on blur!
      await page(notesWin, `[...document.querySelectorAll('[aria-label="编辑与预览切换"] button, .l-seg button')].find(b => b.textContent.includes('编辑'))?.click()`);
      await wait(150);
      notesWin.webContents.send('notes:changed', { ...notesPayload, focused: false });
      await wait(250);
      if (!(await page(notesWin, `Boolean(document.querySelector('textarea'))`))) {
        throw Error('B6 EdgeNotes exited edit mode when focused=false!');
      }
      names.push(await save(notesWin, 'v4-b6-notes-blurred'));
      notesWin.hide();

      // B7 Finder Action Panel (400px Ink)
      const finderWin = find('finder-panel');
      await ready(finderWin, `Boolean(window.island && document.querySelector('.fp-stage'))`);
      finderWin.setSize(416, 600);
      finderWin.setOpacity(1);
      finderWin.showInactive();
      const baseFinder = await page(finderWin, `window.island.getFinderState()`);
      finderWin.webContents.send('finder:changed', {
        ...baseFinder,
        folder: '/Users/demo/Projects/lasso',
        selection: ['/Users/demo/Projects/lasso/docs/design/v4/preview.png'],
        hasImageSelection: true,
        cutPaths: ['/Users/demo/Downloads/sketch-notes.md', '/Users/demo/Downloads/diagram.png'],
        terminal: 'Ghostty',
        editor: 'Cursor',
        moveTargets: [
          { id: 'dir-notes', label: 'LassoNotes', path: '~/Documents/LassoNotes', kind: 'common' },
          { id: 'repo-lasso', label: 'Personal / lasso', path: '~/Developer/Repos/Personal/lasso', kind: 'repo' },
          { id: 'wt-v4', label: 'lasso · v4-overhaul', path: '~/Developer/Repos/Personal/lasso.worktrees/v4-overhaul', kind: 'worktree' }
        ]
      });
      await wait(350);
      const hasAskAi = await page(finderWin, `document.body.textContent.includes('发给 AI') && Boolean(document.querySelector('.fp-cutbar'))`);
      if (!hasAskAi) throw Error('B7 FinderPanel missing 发给 AI or cutbar');
      names.push(await save(finderWin, 'v4-b7-finder-panel'));
      finderWin.hide();

      return names;
    }))
  );

  /* ═══════════════ B8: Screenshot, Editor, Recording, Pin & QuickImage ═══════════════ */
  saved.push(
    ...(await main(async () => {
      const { find, page, wait, ready, move, save, ipcMain, BrowserWindow, path, fixtures, artImage, artDataUrl } = global.uiShots;
      const names = [];
      const m = find();

      // B8A & B8B/C: Screenshot RegionControls + 2-Row Ink Editor
      const W = 980,
        H = 580;
      const sel = { x: 180, y: 68, width: 620, height: 320 };
      const shellSettings = (await page(m, 'window.desktop.getState()')).settings;
      const fullArt = artImage.resize({ width: W, height: H }).toDataURL();
      const shotState = {
        id: 'v4-shot-1',
        editId: 'v4-edit-1',
        phase: 'result',
        presentation: 'inline',
        mode: 'area',
        origin: 'screen',
        width: W,
        height: H,
        pixelWidth: W,
        pixelHeight: H,
        pixelScale: { x: 1, y: 1 },
        backdrop: fullArt,
        image: fullArt,
        imageCrop: { x: 0, y: 0, width: W, height: H },
        selection: sel,
        placement: sel,
        editableRegion: {
          display: { id: 1, bounds: { x: 0, y: 0, width: W, height: H }, scaleFactor: 1 },
          sourceSize: { width: W, height: H },
          initialCrop: sel,
          currentCrop: sel,
          ratio: null
        },
        candidates: [],
        saveFormat: 'png',
        screenshotSettings: shellSettings.screenshot,
        annotationMemory: shellSettings.screenshot.annotationMemory,
        editorShortcuts: shellSettings.editorShortcuts,
        mouseActions: shellSettings.mouseActions,
        toolbarTools: shellSettings.toolbarTools,
        regionPresets: [
          { id: 'p-16-9', name: '已保存', width: 1280, height: 720, ratio: 16 / 9, delay: 0 },
          { id: 'p-cover', name: '公众号头图', width: 900, height: 383, ratio: null, delay: 0 }
        ],
        presets: (await page(m, 'window.desktop.getState()')).presets
      };

      ipcMain.removeHandler('ui-shots:state');
      ipcMain.handle('ui-shots:state', () => shotState);
      ipcMain.removeHandler('ui-shots:pixels');
      ipcMain.handle('ui-shots:pixels', (_e, id) => {
        const img = global.uiShots.nativeImage.createFromDataURL(id === 'fixture-backdrop' ? shotState.backdrop : shotState.image);
        const size = img.getSize();
        const data = img.toBitmap();
        for (let i = 0; i < data.length; i += 4) {
          const b = data[i],
            r = data[i + 2];
          data[i] = r;
          data[i + 2] = b;
        }
        return { ...size, data };
      });
      ipcMain.removeHandler('ui-shots:recognize');
      ipcMain.handle('ui-shots:recognize', (_e, req) => ({
        id: req.id,
        revision: req.revision,
        lines: [
          {
            x: 60,
            y: 60,
            width: 280,
            height: 28,
            text: '纸上的套索 · 截图选中文字直达翻译与 AI',
            confidence: 0.98,
            glyphs: [...'纸上的套索 · 截图选中文字直达翻译与 AI'].map((ch, idx) => ({
              x: 60 + idx * 13,
              y: 60,
              width: 13,
              height: 28,
              text: ch
            }))
          }
        ]
      }));
      ipcMain.removeHandler('ui-shots:screenshot-action');
      ipcMain.handle('ui-shots:screenshot-action', () => ({ error: null }));
      ipcMain.removeHandler('ui-shots:export');
      ipcMain.handle('ui-shots:export', () => ({ error: null }));
      ipcMain.removeHandler('ui-shots:region');
      ipcMain.handle('ui-shots:region', () => {});

      const sw = new BrowserWindow({
        x: 60,
        y: 60,
        width: W,
        height: H,
        frame: false,
        show: true,
        backgroundColor: '#222222',
        webPreferences: { preload: path.join(fixtures, 'screenshot-preload.cjs'), contextIsolation: true, sandbox: true }
      });
      await sw.loadFile(path.join(process.cwd(), 'dist/renderer/index.html'), { query: { surface: 'screenshot' } });
      await ready(sw, `Boolean(document.querySelector('.ed-primary'))`);
      await wait(450);

      // Open RegionControls preset menu for B8A shot
      await page(sw, `document.querySelector('button[aria-label="比例与固定尺寸预设"]')?.click()`);
      await wait(250);
      names.push(await save(sw, 'v4-b8a-region-controls'));
      await page(sw, `document.querySelector('button[aria-label="比例与固定尺寸预设"]')?.click()`);
      await wait(200);

      // B8B: Switch to clean confirmed selection (2-row compact editor)
      sw.webContents.send('ui-shots:changed', { ...shotState, editId: 'v4-edit-2', editableRegion: undefined, imageFrame: 'fixture-image', backdropFrame: 'fixture-backdrop' });
      await ready(sw, `Boolean(document.querySelector('.cap-size'))`);
      await wait(350);
      names.push(await save(sw, 'v4-b8b-editor'));

      // Open "问 AI ▾" direct preset menu
      await page(sw, `[...document.querySelectorAll('.ed-bar button')].find(b => b.textContent.includes('问 AI'))?.click()`);
      await wait(300);
      names.push(await save(sw, 'v4-b8b-editor-ask-ai'));

      // Open "更多特效 ▾" menu
      await page(sw, `[...document.querySelectorAll('.ed-bar button')].find(b => b.textContent.includes('更多特效'))?.click()`);
      await wait(300);
      names.push(await save(sw, 'v4-b8c-editor-effects'));
      await page(sw, `[...document.querySelectorAll('.ed-bar button')].find(b => b.textContent.includes('更多特效'))?.click()`);
      await wait(200);

      // Select OCR text on canvas to verify floating OCR action bar
      await ready(sw, `Boolean(document.querySelector('.editor-text-line'))`);
      await page(
        sw,
        `(() => {
          const line = document.querySelector('.editor-text-line');
          const range = document.createRange();
          range.selectNodeContents(line);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.dispatchEvent(new Event('selectionchange'));
        })()`
      );
      await wait(300);
      if (!(await page(sw, `Boolean(document.querySelector('.ed-ocr-bar'))`))) {
        throw Error('B8B Editor OCR selection action bar did not appear');
      }
      names.push(await save(sw, 'v4-b8b-editor-ocr-bar'));
      sw.destroy();

      // B8D: Recording Panel (live bar + review)
      const recChannels = ['shell:recording-state', 'shell:recording-action'];
      const recOrig = recChannels.map(ch => ipcMain._invokeHandlers.get(ch));
      let recState = {
        id: 'v4-rec-1',
        status: 'recording',
        mode: 'rect',
        bounds: { x: 0, y: 0, width: 640, height: 360 },
        countdownLeft: 0,
        durationMs: 12400,
        frameCount: 372,
        settings: { ...shellSettings.screenshot.recording, showKeystrokes: true, showMouseClicks: true, cameraOverlay: true },
        trimStartMs: 0,
        trimEndMs: 12400,
        previewFrames: [artDataUrl, artDataUrl, artDataUrl, artDataUrl],
        previewTimestampsMs: [0, 4100, 8200, 12400],
        recentKeys: [{ key: 'K', modifiers: ['Meta'], timestampMs: 12000 }],
        recentClicks: [{ x: 200, y: 140, button: 'left', timestampMs: 12200 }],
        message: ''
      };
      ipcMain.removeHandler(recChannels[0]);
      ipcMain.handle(recChannels[0], () => recState);
      ipcMain.removeHandler(recChannels[1]);
      ipcMain.handle(recChannels[1], async () => ({ state: recState, error: null }));

      await page(m, `window.desktop.recordingPanel(true)`);
      const rw = find('recording');
      rw.setSize(620, 190);
      await wait(450);
      names.push(await save(rw, 'v4-b8d-recording-live'));

      recState = { ...recState, status: 'review' };
      rw.setSize(640, 620);
      rw.webContents.send('shell:recording-changed', recState);
      await wait(450);
      names.push(await save(rw, 'v4-b8d-recording-review'));
      rw.destroy();
      recChannels.forEach((ch, idx) => {
        ipcMain.removeHandler(ch);
        if (recOrig[idx]) ipcMain.handle(ch, recOrig[idx]);
      });

      // B8E: Pin Hover Bar
      const pinData = {
        id: 'v4-pin-1',
        revision: 0,
        image: artImage.resize({ width: 380, height: 240 }).toDataURL(),
        width: 380,
        height: 240,
        lines: [],
        status: '',
        topmost: true,
        opacity: 1,
        passthrough: false,
        kind: 'image',
        title: '风景插画贴图',
        groupId: 'default',
        groups: [{ id: 'default', name: '默认分组', color: '#D97757', visible: true }],
        zoomPercent: 100,
        wheelAction: 'zoom',
        locked: false,
        thumbnail: false,
        presets: (await page(m, 'window.desktop.getState()')).presets
      };
      ipcMain.removeHandler('ui-shots:pin');
      ipcMain.handle('ui-shots:pin', () => pinData);
      ipcMain.removeHandler('ui-shots:pin-action');
      ipcMain.handle('ui-shots:pin-action', () => ({ error: null }));
      const pw = new BrowserWindow({
        x: 100,
        y: 100,
        width: 380,
        height: 240,
        frame: false,
        show: true,
        webPreferences: { preload: path.join(fixtures, 'pin-preload.cjs'), contextIsolation: true, sandbox: true }
      });
      await pw.loadFile(path.join(process.cwd(), 'dist/renderer/index.html'), { query: { surface: 'pin' } });
      pw.focus();
      await wait(400);
      await move(pw, 190, 120);
      await move(pw, 195, 120);
      names.push(await save(pw, 'v4-b8e-pin-hover'));
      pw.destroy();

      // B8F: Standalone AI 生图 Window (560×680)
      const appearance = await page(m, `window.desktop.getState().then(s => ({ fonts: s.settings.fonts, importedFonts: s.settings.importedFonts }))`);
      const mediaState = {
        ...appearance,
        pinnedOnTop: false,
        presets: [{ id: 'illustrate', name: '内容配图' }],
        reference: { id: 'ref-1', width: 1536, height: 1024, thumbnail: artDataUrl },
        draft: {
          id: 'draft-v4',
          presetId: 'illustrate',
          presetName: '内容配图',
          prompt: '一张安静的风景插画：暖白天空、陶土色太阳，远处是起伏的燕麦色山丘，前景一片橄榄绿',
          options: {
            aspect: '3:2',
            count: 2,
            generationModel: 'gpt-image-1',
            editModel: 'gpt-image-1',
            quality: 'high',
            background: 'auto',
            outputFormat: 'png'
          }
        },
        jobs: [
          {
            id: 'job-run',
            requestId: 'req-4',
            prompt: '加入柔和晨雾',
            status: 'running',
            aspect: '3:2',
            generationModel: 'gpt-image-1',
            editModel: 'gpt-image-1',
            quality: 'high',
            background: 'auto',
            outputFormat: 'png'
          },
          {
            id: 'job-3',
            requestId: 'req-3',
            prompt: '一张安静的风景插画：暖白天空、陶土色太阳',
            status: 'succeeded',
            aspect: '3:2',
            generationModel: 'gpt-image-1',
            editModel: 'gpt-image-1',
            quality: 'high',
            background: 'auto',
            outputFormat: 'png',
            images: [{ id: 'img-v3', width: 1536, height: 1024, thumbnail: artDataUrl }]
          },
          {
            id: 'job-2',
            requestId: 'req-2',
            prompt: '初版山丘草图',
            status: 'succeeded',
            aspect: '3:2',
            generationModel: 'gpt-image-1',
            editModel: 'gpt-image-1',
            quality: 'high',
            background: 'auto',
            outputFormat: 'png',
            images: [{ id: 'img-v2', width: 1536, height: 1024, thumbnail: artDataUrl }]
          }
        ]
      };
      ipcMain.removeHandler('ui-shots:media-state');
      ipcMain.handle('ui-shots:media-state', () => mediaState);
      ipcMain.removeHandler('ui-shots:media-pin');
      ipcMain.handle('ui-shots:media-pin', (_e, pinned) => ({ ...mediaState, pinnedOnTop: pinned }));
      ipcMain.removeHandler('ui-shots:media-preset');
      ipcMain.handle('ui-shots:media-preset', () => mediaState);

      const qw = new BrowserWindow({
        width: 560,
        height: 680,
        frame: false,
        show: true,
        webPreferences: { preload: path.join(fixtures, 'media-preload.cjs'), contextIsolation: true, sandbox: true }
      });
      await qw.loadFile(path.join(process.cwd(), 'dist/renderer/index.html'), { query: { surface: 'quick-image' } });
      await ready(qw, `Boolean(document.querySelector('.qi-stage'))`);
      // Select the succeeded v2/v3 version so large artwork displays while running bar stays in strip
      await page(qw, `document.querySelectorAll('.qi-ver')[1]?.click()`);
      await wait(350);
      const qiOverflow = await page(qw, `document.documentElement.scrollWidth > innerWidth`);
      if (qiOverflow) throw Error('B8F QuickImage horizontal overflow');
      names.push(await save(qw, 'v4-b8f-quick-image'));
      qw.destroy();

      return names;
    }))
  );

  /* ═══════════════ B9: Standalone 760×560 Settings Window (All 8 Modules) ═══════════════ */
  saved.push(
    ...(await main(async () => {
      const { find, page, wait, ready, save } = global.uiShots;
      const m = find();
      const names = [];

      await page(m, `window.desktop.openSettings('general')`);
      let sw;
      for (let i = 0; i < 40 && !(sw = find('settings')); i++) await wait(100);
      if (!sw) throw Error('B9 Standalone SettingsWindow did not open');

      sw.setSize(760, 560);
      sw.show();
      sw.focus();
      await ready(sw, `document.querySelectorAll('.l-set-nav-item').length === 8`);

      const navCount = await page(sw, `document.querySelectorAll('.l-set-nav-item').length`);
      if (navCount !== 8) throw Error('Expected 8 settings modules, got ' + navCount);
      if (await page(sw, `Boolean(document.querySelector('.l-save-bar'))`)) {
        throw Error('Retired SaveBar leaked into standalone Settings window');
      }

      const sections = [
        ['通用与外观', 'v4-b9-1-general'],
        ['划词与动作条', 'v4-b9-2-selection'],
        ['AI 预设与生图', 'v4-b9-3-presets'],
        ['翻译', 'v4-b9-4-translation'],
        ['模型与 API 连接', 'v4-b9-5-connections'],
        ['截图、贴图与录屏', 'v4-b9-6-capture'],
        ['桌面套件', 'v4-b9-7-suite'],
        ['快捷键与同步', 'v4-b9-8-shortcuts']
      ];

      for (const [label, shotName] of sections) {
        await page(
          sw,
          `[...document.querySelectorAll('.l-set-nav-item')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`
        );
        await wait(350);

        if (shotName === 'v4-b9-5-connections') {
          // Expand "New API 视觉网关" inline form just like B9-B mockup!
          await page(
            sw,
            `[...document.querySelectorAll('.l-set-row.clickable')].find(r => r.textContent.includes('New API 视觉网关'))?.click()`
          );
          await wait(250);
        }

        const overflow = await page(sw, `document.documentElement.scrollWidth > innerWidth`);
        if (overflow) throw Error(`${shotName}: horizontal overflow in standalone Settings`);
        names.push(await save(sw, shotName));

        if (shotName === 'v4-b9-3-presets') {
          await page(sw, `document.querySelector('.l-set-row.clickable')?.click()`);
          await wait(250);
          names.push(await save(sw, 'v4-b9-3b-preset-editor'));
        }
      }

      // Verify true shortcut unbinding persistence (`""` stays unbound)
      await page(sw, `window.desktop.saveActionShortcut('open-translator', '')`);
      const afterUnbind = await page(sw, `window.desktop.getState().then(s => s.settings.actionShortcuts['open-translator'])`);
      if (afterUnbind !== '') throw Error('Shortcut unbinding did not persist empty string: ' + JSON.stringify(afterUnbind));

      sw.hide();
      return names;
    }))
  );

  console.log(`Saved ${saved.length} v4 shots to ${out}:\n` + saved.map(name => `  ${name}.png`).join('\n'));
  rmSync(join(out, 'runtime.log'), { force: true });
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    await Promise.race([
      main(({ app }) => {
        setTimeout(() => app.quit(), 50);
        return true;
      }).catch(() => {}),
      sleep(1000)
    ]);
  }
  ws?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {
      const terminate = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => {
        clearTimeout(terminate);
        resolve();
      });
      child.kill();
    });
  }
  rmSync(runtime, { recursive: true, force: true });
}
