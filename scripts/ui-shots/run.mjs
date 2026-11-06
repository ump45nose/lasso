// Captures every Lasso surface into outputs/ui-shots for visual review: `npm run ui:shots`.
// Runs the built app with all runtime data isolated below outputs and drives it
// through the main-process inspector. Screen capture needs no permission: overlay, editor and pin
// surfaces are rendered from fixture states with the preloads in this folder.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const fixtures = join(root, 'scripts/ui-shots');
const focusedCases = (process.env.LASSO_UI_CASES || '').split(',').map(value=>value.trim()).filter(Boolean);
const out = process.env.LASSO_UI_OUTPUT_DIR ? resolve(root, process.env.LASSO_UI_OUTPUT_DIR) : join(root, focusedCases.length ? 'outputs/stage-9/ui-shots-focused' : 'outputs/ui-shots');
if (relative(join(root, 'outputs'), out).startsWith('..') || !relative(root, out).startsWith('outputs/')) throw Error('UI shots output must stay inside workspace outputs/');
const surfacesOnly = focusedCases.length > 0 || process.env.LASSO_UI_SCOPE === 'capture';
const captureOnly = surfacesOnly || process.env.LASSO_UI_SCOPE === 'screenshot';
mkdirSync(out, { recursive: true });
const runtime = mkdtempSync(join(out, 'runtime-'));
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
  // Exercise the production encoders/migration functions without exposing test hooks in the app.
  for (const [name, source] of [['output', 'capture/output'], ['settings', 'settings'], ['native', 'capture/native']]) writeFileSync(join(runtime, `stage-9-${name}.cjs`), createRequire(import.meta.url)('esbuild').buildSync({ entryPoints: [join(root, `src/main/${source}.ts`)], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false }).outputFiles[0].contents);
  // The production appearance adapter resolves its generated theme/icons beside its bundle.
  symlinkSync(join(root, 'dist/native'), join(runtime, 'native'), 'dir');
  // Fixture runs must never start global selection hooks or ask for accessibility permission.
  writeFileSync(join(runtimePaths.userData, 'settings.json'), JSON.stringify({ shortcut: '', selectionEnabled: false, clipboardFallback: false }));
  // The Island reads open tasks from the Nook cache under userData when LASSO_DATA_ROOT is set.
  mkdirSync(join(runtimePaths.userData, 'nook-cache'));
  writeFileSync(join(runtimePaths.userData, 'nook-cache/google.json'), JSON.stringify({ taskLists: [
    { title: 'Lasso · 今日重点', items: [{ id: 'nook-1', title: '核对 New API 翻译流式延迟与回填', status: 'open' }] },
    { title: 'Nook · 运维巡检', items: [{ id: 'nook-2', title: '检查 launchd 守护服务状态与错误日志', status: 'open' }] },
    { title: 'Lasso · 工程验收', items: [{ id: 'nook-3', title: '整理本周设计规范与截图回归', status: 'open' }] }
  ] }));
  // Electron uses the bootstrap directory as app.getAppPath(); keep icon reads local.
  symlinkSync(join(root, 'assets'), join(runtime, 'assets'), 'dir');
  // This runs before the real entrypoint. LASSO_DATA_ROOT and LASSO_PROFILE derive
  // the same userData path, so the disabled-selection settings are read on boot.
  writeFileSync(bootstrap, `const electron = require('electron');
const { app, dialog, session } = electron;
global.uiShotsLogin = { settings:{openAtLogin:false},calls:[],systemReads:0,systemWrites:0 };
app.setLoginItemSettings = options => { global.uiShotsLogin.calls.push(options);global.uiShotsLogin.settings={...global.uiShotsLogin.settings,...options}; };
app.getLoginItemSettings = () => ({...global.uiShotsLogin.settings});
// Guard Node entry points before product imports cache them. Never record request bodies or CLI arguments.
const nodeAudit={scope:'main-process JS fetch, http(s), net, tls, Electron net and child_process; not an OS firewall',blocked:[],allowedLocal:[],guards:[]},nodeGuards=[];
const loopback=host=>['localhost','127.0.0.1','::1','[::1]'].includes(String(host).toLowerCase());
const localURL=value=>{try{return loopback(new URL(value).hostname);}catch{return false;}};
function nodeGate(kind,target,local){const entry={kind,target};if(local){nodeAudit.allowedLocal.push(entry);return;}nodeAudit.blocked.push(entry);const error=Error('UI shots blocked external runtime access: '+kind);error.code='UI_SHOTS_EXTERNAL_BLOCKED';throw error;}
function urlTarget(value){const url=new URL(typeof value==='object'&&value?.url?value.url:value);return {target:url.origin,local:['file:','data:','lasso-font:'].includes(url.protocol)||loopback(url.hostname)};}
function socketTarget(args){let value=args[0];if(Array.isArray(value))return socketTarget(value);if(value&&typeof value==='object'){if(value.path)return {target:'unix-socket',local:true};const host=value.hostname||value.host||'localhost';return {target:String(host),local:loopback(host)};}if(typeof value==='string'&&!/^\\d+$/.test(value))return {target:'unix-socket',local:true};const host=typeof args[1]==='string'?args[1]:'localhost';return {target:host,local:loopback(host)};}
function requestTarget(args){const value=args[0];if(typeof value==='string'||value instanceof URL)return urlTarget(value);if(value?.url)return urlTarget(value.url);if(value?.socketPath)return {target:'unix-socket',local:true};const host=value?.hostname||value?.host||'localhost';return {target:String(host),local:loopback(host)};}
function guard(owner,key,kind,resolve){const original=owner[key];if(typeof original!=='function')throw Error('Missing runtime guard entry point: '+kind);const wrapped=function(...args){const route=resolve(args);nodeGate(kind,route.target,route.local);return Reflect.apply(original,this,args);};owner[key]=wrapped;nodeGuards.push(()=>owner[key]===wrapped);nodeAudit.guards.push(kind);}
const nodeHttp=require('node:http'),nodeHttps=require('node:https'),nodeNet=require('node:net'),nodeTls=require('node:tls'),nodeChild=require('node:child_process');
guard(global,'fetch','fetch',args=>urlTarget(args[0]));const guardedFetch=global.fetch,asyncFetch=async(...args)=>guardedFetch(...args);global.fetch=asyncFetch;nodeGuards.pop();nodeGuards.push(()=>global.fetch===asyncFetch);
for(const [module,name]of [[nodeHttp,'http'],[nodeHttps,'https']])for(const method of ['request','get'])guard(module,method,name+'.'+method,requestTarget);
for(const method of ['connect','createConnection'])guard(nodeNet,method,'net.'+method,socketTarget);
guard(nodeNet.Socket.prototype,'connect','net.Socket.connect',socketTarget);guard(nodeTls,'connect','tls.connect',socketTarget);
guard(electron.net,'fetch','electron.net.fetch',args=>urlTarget(args[0]));guard(electron.net,'request','electron.net.request',requestTarget);
for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])guard(nodeChild,method,'child_process.'+method,args=>({target:method==='exec'||method==='execSync'?'shell-command':require('node:path').basename(String(args[0])).slice(0,120),local:false}));
guard(nodeChild.ChildProcess.prototype,'spawn','ChildProcess.spawn',args=>({target:require('node:path').basename(String(args[0]?.file)).slice(0,120),local:false}));
require('node:module').syncBuiltinESMExports();
global.uiShotsNode={audit:nodeAudit,verify:()=>nodeGuards.every(check=>check())};
// Install before product modules can create sessions or warm a remote page.
const networkSessions = new WeakSet();
const networkAudit = { scope:'Electron session.webRequest only', guardedSessions:0, blockedRequests:0, blockedByProtocol:{http:0,https:0,ws:0,wss:0,ftp:0}, blockedOrigins:{}, allowedLocalByProtocol:{} };
function isolateNetwork(currentSession) {
  if (networkSessions.has(currentSession)) return;
  currentSession.webRequest.onBeforeRequest({urls:['<all_urls>']}, (request, callback) => {
    const protocol = request.url.split(':',1)[0].toLowerCase();
    if (Object.hasOwn(networkAudit.blockedByProtocol,protocol) && !localURL(request.url)) {
      networkAudit.blockedRequests++; networkAudit.blockedByProtocol[protocol]++;
      const origin = new URL(request.url).origin;
      networkAudit.blockedOrigins[origin] = (networkAudit.blockedOrigins[origin] || 0) + 1;
      callback({cancel:true});
    } else {
      networkAudit.allowedLocalByProtocol[protocol] = (networkAudit.allowedLocalByProtocol[protocol] || 0) + 1;
      callback({cancel:false});
    }
  });
  networkSessions.add(currentSession); networkAudit.guardedSessions++;
}
global.uiShotsNetwork = { audit:networkAudit, hasSession:currentSession=>networkSessions.has(currentSession) };
app.on('session-created', isolateNetwork);
// Replace every native clipboard entry point before loading product modules.
// Calls are recorded by name only; the user's clipboard is never inspected.
let items = [];
const calls = [];
class MemoryClipboardItem {
  constructor(values) { this.values = values; this.types = Object.keys(values); }
  async getType(type) { const value = await this.values[type]; if(value===undefined)throw Error('Missing fixture clipboard type');return value instanceof Blob ? value : new Blob([value], { type }); }
  static supports() { return true; }
}
const methods = {
  read: async () => items,
  write: async value => { items = Array.isArray(value) ? value : [new MemoryClipboardItem(Object.fromEntries(Object.entries(value).map(([type, data]) => [type === 'text' ? 'text/plain' : type, data])))]; },
  readText: async () => { const item = items.find(item => item.types.includes('text/plain')); return item ? (await item.getType('text/plain')).text() : ''; },
  writeText: async value => { items = [new MemoryClipboardItem({ 'text/plain': String(value) })]; },
  clear: () => { items = []; },
  availableFormats: () => items.flatMap(item => item.types),
  has: type => items.some(item => item.types.includes(type)),
  readImage: () => electron.nativeImage.createEmpty(),
  readBuffer: () => Buffer.alloc(0),
  readHTML: () => '', readRTF: () => '', readBookmark: () => ({title:'',url:''}), readFindText: () => '',
  writeImage: image => { items = [new MemoryClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], {type:'image/png'}) })]; },
  writeBuffer: (type, value) => { items = [new MemoryClipboardItem({ [type]: new Blob([new Uint8Array(value)], {type}) })]; },
  writeHTML: value => { items = [new MemoryClipboardItem({ 'text/html': value })]; },
  writeRTF: value => { items = [new MemoryClipboardItem({ 'text/rtf': value })]; },
  writeBookmark: () => {}, writeFindText: () => {}
};
const memoryClipboard = Object.fromEntries(Object.entries(methods).map(([name,method])=>[name,(...args)=>{calls.push(name);return method(...args);} ]));
memoryClipboard.__uiShotsMemory = true;
const safeStorage = { isEncryptionAvailable:()=>true, encryptString:value=>Buffer.from('ui-shots:'+value), decryptString:value=>value.toString().replace(/^ui-shots:/,'') };
const memoryElectron = Object.create(electron, {clipboard:{value:memoryClipboard},ClipboardItem:{value:MemoryClipboardItem},safeStorage:{value:safeStorage}});
const Module = require('node:module'), originalLoad = Module._load;
Module._load = function(request, ...args) { return request==='electron' ? memoryElectron : originalLoad.call(this,request,...args); };
global.uiShotsClipboard = {calls,systemReads:0,systemWrites:0};
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
  await main(async ({ app, BrowserWindow, ipcMain }, out, fixtures, runtime, captureOnly, surfacesOnly, focusedCases) => {
    const fs = process.mainModule.require('fs'), path = process.mainModule.require('path');
    for (let i = 0; i < 200 && (!app.isReady() || !BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('renderer/index.html'))); i++) await new Promise(resolve => setTimeout(resolve, 50));
    for (const name of ['appData', 'userData', 'sessionData', 'temp', 'crashDumps', 'logs']) {
      const relative = path.relative(runtime, app.getPath(name));
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Unisolated test path: ' + name);
    }
    if (app.getPath('userData') !== path.join(runtime, 'lasso-ui-shots')) throw Error('Unexpected fixture profile path');
    if (JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')).selectionEnabled !== false) throw Error('Fixture selection hooks were not disabled before boot');
    if (!global.uiShotsNetwork?.hasSession(process.mainModule.require('electron').session.defaultSession) || BrowserWindow.getAllWindows().some(win=>!global.uiShotsNetwork.hasSession(win.webContents.session))) throw Error('Fixture network session isolation missing');
    if (!global.uiShotsNode?.verify()) throw Error('Fixture Node runtime isolation missing before product startup');
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const find = surface => BrowserWindow.getAllWindows().find(w => surface ? w.webContents.getURL().includes('surface=' + surface) : !w.webContents.getURL().includes('surface='));
    for (let i = 0; i < 40 && !(find() && find('action-bar')); i++) await wait(250);
    const page = async (w, script) => { try { return await w.webContents.executeJavaScript(script); } catch (error) { throw Error(error.message + '\nScript: ' + script); } };
    const move = async (w, x, y) => { w.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) }); await wait(450); };
    const center = async (w, selector) => page(w, `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null; })()`);
    const ready = async (w, expression) => { for (let pass = 0; pass < 100; pass++) { if (await page(w, expression)) return; await wait(50); } throw Error('UI did not become ready: ' + expression); };
    // Inactive settings sub-panes stay mounted but hidden; select the owning tab before scrolling to or acting on a control inside one.
    const showPane = `async element => { const pane = element.closest('[role="tabpanel"][hidden]'); if (!pane) return; document.querySelector('[role="tab"][aria-controls="' + pane.id + '"]').click(); for (let frame = 0; pane.hidden; frame++) { if (frame === 60) throw Error('Settings pane did not open: ' + pane.id); await new Promise(requestAnimationFrame); } }`;
    const reveal = async (w, selector) => { await page(w, `(${showPane})(document.querySelector(${JSON.stringify(selector)}))`); };
    const scrollTo = async (w, selector, block = 'start') => {
      await ready(w, `Boolean(document.querySelector(${JSON.stringify(selector)}))`);
      await page(w, `(async () => {
        const element=document.querySelector(${JSON.stringify(selector)});
        await (${showPane})(element);
        element.scrollIntoView({block:${JSON.stringify(block)},behavior:'instant'});
        let previous='',stable=0;
        for(let frame=0;frame<120;frame++){
          await new Promise(requestAnimationFrame);
          const rect=element.getBoundingClientRect(),positions=[rect.x,rect.y,rect.width,rect.height];
          let top=0,bottom=innerHeight;
          for(let parent=element.parentElement;parent;parent=parent.parentElement){
            positions.push(parent.scrollLeft,parent.scrollTop);
            if(/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)){const bounds=parent.getBoundingClientRect();top=Math.max(top,bounds.top);bottom=Math.min(bottom,bounds.bottom);}
          }
          const current=positions.map(value=>value.toFixed(2)).join(',');
          stable=current===previous?stable+1:0;previous=current;
          if(stable>=2&&rect.width>0&&rect.height>0&&rect.top>=top-.5&&rect.bottom<=bottom+.5)return;
        }
        throw Error('Scroll target did not settle visibly: '+${JSON.stringify(selector)});
      })()`);
    };
    const settingsTab = async (w, label) => {
      // Custom capture has view priority; wait for actual navigation after its exit animation.
      await page(w, `(async () => { const s=await window.desktop.getState();if (s.customCaptureOpen) await window.desktop.act('close-custom-capture');if (!s.settingsOpen) await window.desktop.act('settings'); })()`);
      await ready(w, `Array.from(document.querySelectorAll('.l-set-nav button')).some(b => b.textContent === ${JSON.stringify(label)})`);
      await page(w, `Array.from(document.querySelectorAll('.l-set-nav button')).find(b => b.textContent === ${JSON.stringify(label)}).click()`); await wait(400);
    };
    if(!find()||!find('action-bar'))throw Error('UI startup failed: '+JSON.stringify(BrowserWindow.getAllWindows().map(w=>({id:w.id,url:w.webContents.getURL()}))));
    global.uiShots = { captureOnly, surfacesOnly, focusedCases, fs, path, wait, ready, showPane, reveal, scrollTo, settingsTab, find, page, move, center, out, fixtures, ipcMain, BrowserWindow, app,
      save: async (w, name) => {
        await page(w, `(async()=>{await document.fonts.ready;for(let frame=0;frame<120;frame++){await new Promise(requestAnimationFrame);if(!document.getAnimations().some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime))&&[...document.querySelectorAll('.l-seg')].every(group=>{const active=group.querySelector('[aria-checked="true"]'),thumbs=group.querySelectorAll('.l-seg-thumb');if(!active)return thumbs.length===0;if(thumbs.length!==1||!active.contains(thumbs[0]))return false;const style=getComputedStyle(thumbs[0]);return Number(style.opacity)===1&&new DOMMatrixReadOnly(style.transform).isIdentity&&!thumbs[0].getAnimations().some(animation=>animation.playState==='running');}))return;}throw Error('Motion did not settle before capture');})()`);
        fs.writeFileSync(path.join(out, name + '.png'), (await w.webContents.capturePage()).toPNG()); return name;
      } };
  }, out, fixtures, runtime, captureOnly, surfacesOnly, focusedCases);

  // S2 uses the public IPC contracts against a deterministic, persisted fixture store.
  // No native pickers, WebDAV requests, real pins, or user files are used by these panels.
  await main(async ({nativeImage}) => {
    const { fs, path, app, out, find, ipcMain, BrowserWindow } = global.uiShots;
    const pixels=Buffer.alloc(280*160*4);for(let y=0;y<160;y++)for(let x=0;x<280;x++){const rgb=y<24?[20,20,19]:x>24&&x<220&&y>50&&y<65?[189,118,88]:x>24&&x<180&&y>84&&y<96?[120,128,101]:[250,249,245],offset=(y*280+x)*4;pixels[offset]=rgb[2];pixels[offset+1]=rgb[1];pixels[offset+2]=rgb[0];pixels[offset+3]=255;}
    const thumbnailDataUrl=nativeImage.createFromBitmap(pixels,{width:280,height:160}).toDataURL();
    const groups = [{id:'default',name:'默认分组',color:'#bd7658',visible:true},{id:'research',name:'产品研究',color:'#788065',visible:true}];
    const filePath = path.join(out,'fixture-file.txt'); fs.writeFileSync(filePath,'Lasso UI fixture — only this workspace file is used.\n');
    const timestamp = Date.parse('2026-11-04T09:10:00+08:00');
    const state = {
      history: {items:[
        {id:'history-marked',createdAt:timestamp,updatedAt:timestamp,width:1440,height:900,byteSize:1843200,captureKind:'area',ocrSnippet:'设计评审 · 截图中的文字可再次编辑',thumbnailDataUrl,hasAnnotations:true},
        {id:'history-clean',createdAt:timestamp-3600000,updatedAt:timestamp-3600000,width:960,height:640,byteSize:614400,captureKind:'window',ocrSnippet:'工作空间和贴图分组',thumbnailDataUrl,hasAnnotations:false}
      ],totalBytes:2457600,policy:{enabled:true,maxItems:50,maxDays:30,maxBytesMB:512}},
      workspace: {settings:{restoreOnLaunch:true,floatingToolbar:false,wheelAction:'zoom',activeGroupId:'default',groups},closedCount:2,pins:[
        {id:'pin-image',title:'设计评审截图',kind:'image',groupId:'default',locked:false,thumbnail:false,topmost:true,visible:true,opacity:1,width:360,height:225,preview:'设计评审',updatedAt:timestamp},
        {id:'pin-text',title:'评审笔记',kind:'text',groupId:'research',locked:true,thumbnail:false,topmost:true,visible:true,opacity:.85,width:340,height:240,preview:'把想法留在桌面上，继续手头的工作。',updatedAt:timestamp},
        {id:'pin-color',title:'陶土色',kind:'color',groupId:'default',locked:false,thumbnail:true,topmost:true,visible:true,opacity:1,width:280,height:200,preview:'#BD7658',updatedAt:timestamp},
        {id:'pin-file',title:'fixture-file.txt',kind:'file',groupId:'research',locked:false,thumbnail:false,topmost:false,visible:false,opacity:1,width:360,height:225,preview:filePath,updatedAt:timestamp}
      ]},
      webdav:{enabled:true,url:'https://nas.example.invalid/webdav',remotePath:'/Lasso/config.json',username:'lasso-fixture',hasPassword:true,autoSync:false,status:'synced',lastSyncedAt:timestamp,message:'已同步到飞牛 NAS'},
      receipts:[]
    };
    const store = path.join(app.getPath('userData'),'stage-4-fixtures.json');
    const persist = () => fs.writeFileSync(store,JSON.stringify(state,null,2));
    const receipt = (method,args=[]) => {state.receipts.push({method,args});persist();};
    const originalState = ipcMain._invokeHandlers.get('shell:state');
    // Seed the real isolated configuration before fixture overlays are installed;
    // ordinary screenshot saves and their disk-equality assertion keep one source.
    const sender=find().webContents,seedEvent={sender,senderFrame:sender.mainFrame},seedShell=await originalState(seedEvent);
    const seeded=await ipcMain._invokeHandlers.get('shell:screenshot-settings')(seedEvent,{...seedShell.settings.screenshot,pinWorkspace:structuredClone(state.workspace.settings)});if(seeded.error)throw Error(seeded.error);
    const fixtureShell = async event => {const shell=await originalState(event);return {...shell,settings:{...shell.settings,screenshot:{...shell.settings.screenshot,pinWorkspace:state.workspace.settings}}};};
    const publish = async () => {for(const win of BrowserWindow.getAllWindows())win.webContents.send('pin-workspace:changed',state.workspace);const sender=find().webContents;sender.send('shell:changed',await fixtureShell({sender,senderFrame:sender.mainFrame}));persist();};
    const handlers = {
      'shell:state': fixtureShell,
      'shell:capture-history': async (event,query='') => { const shell=await ipcMain._invokeHandlers.get('shell:state')(event);state.history.policy=shell.settings.screenshot.history;receipt('captureHistory',[query]);return {...state.history,items:state.history.items.filter(item=>(item.ocrSnippet+' '+item.captureKind+' '+item.width+'×'+item.height).toLowerCase().includes(query.toLowerCase()))}; },
      'shell:capture-history-act': (_event,id,action) => {if(!state.history.items.some(item=>item.id===id))throw Error('Unknown fixture history');if(action==='delete')state.history.items=state.history.items.filter(item=>item.id!==id);receipt('actCaptureHistory',[id,action]);return {error:null};},
      'shell:capture-history-clear': () => {state.history.items=[];state.history.totalBytes=0;receipt('clearCaptureHistory');return {error:null};},
      'shell:pin-workspace': () => state.workspace,
      'shell:pin-workspace-save': async (event,settings) => {state.workspace.settings=structuredClone(settings);for(const pin of state.workspace.pins)if(!settings.groups.some(group=>group.id===pin.groupId))pin.groupId=settings.activeGroupId;receipt('savePinWorkspace',[settings]);await publish(event);return {error:null};},
      'shell:pin-create': (_event,input) => {state.workspace.pins.push({...state.workspace.pins[0],id:'created-'+state.receipts.length,title:input.text?.slice(0,24)||'新贴图',kind:input.kind,preview:input.text||input.color||input.filePath||'',groupId:input.groupId||state.workspace.settings.activeGroupId});receipt('createPin',[input]);publish();return {error:null};},
      'shell:pin-clipboard': () => {receipt('pinClipboard');return {error:null};},
      'shell:pin-reopen': () => {state.workspace.closedCount=Math.max(0,state.workspace.closedCount-1);receipt('reopenClosedPin');publish();return {error:null};},
      'shell:pins-arrange': (_event,mode,groupId) => {receipt('arrangePins',[mode,groupId]);return {error:null};},
      'shell:pin-act': (_event,id,action,groupId) => {const pin=state.workspace.pins.find(pin=>pin.id===id);if(!pin)throw Error('Unknown fixture pin');if(groupId)pin.groupId=groupId;for(const [name,key]of [['toggle-visible','visible'],['toggle-lock','locked'],['toggle-thumbnail','thumbnail']])if(action===name)pin[key]=!pin[key];if(action==='close'){state.workspace.pins=state.workspace.pins.filter(pin=>pin.id!==id);state.workspace.closedCount++;}receipt('actPin',[id,action,groupId]);publish();return {error:null};},
      'shell:config-export': () => {const file=path.join(out,'fixture-config.json');fs.writeFileSync(file,JSON.stringify({schemaVersion:1,exportedAt:new Date(timestamp).toISOString(),settings:{selectionEnabled:false},presets:[]},null,2));receipt('exportConfig');return {path:file,error:null};},
      'shell:config-import': () => {receipt('importConfig');return {error:null};},
      'shell:webdav-config': () => state.webdav,
      'shell:webdav-config-save': (_event,input) => {const {password,clearPassword,...config}=input;state.webdav={...state.webdav,...config,hasPassword:clearPassword?false:!!password||state.webdav.hasPassword};receipt('saveWebdavConfig',[{...config,hasPassword:state.webdav.hasPassword}]);return state.webdav;},
      'shell:webdav-sync': async (_event,direction) => {receipt('syncWebdav',[direction]);state.webdav={...state.webdav,status:'syncing',message:'正在同步配置…'};persist();await new Promise(resolve=>setTimeout(resolve,350));state.webdav={...state.webdav,status:'synced',lastSyncedAt:timestamp,message:direction==='pull'?'已拉取远端配置':'已同步到飞牛 NAS'};persist();return {state:state.webdav,error:null};},
      'ui-shots:pin-drop': (_event,files,text,groupId) => {receipt('dropFiles',[files,text,groupId]);return {error:null};}
    };
    for(const [channel,handler]of Object.entries(handlers)){ipcMain.removeHandler(channel);ipcMain.handle(channel,handler);}
    ipcMain.handle('ui-shots:editor-text',(_event,action,request)=>{receipt('editorText',[action,request]);return {error:null};});
    global.uiShots.stage4={state,persist,store,filePath,groups,thumbnailDataUrl,publish,fixtureShell};persist();
  });

  // Main window: current view, command palette, settings.
  saved.push(...await main(async () => {
    const { find, page, wait, save, settingsTab, scrollTo, reveal } = global.uiShots, m = find(), names = [];
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
    await settingsTab(m, '截图');
    await scrollTo(m, '.l-set-row-head:has(+ .l-group .l-shot-policy)');await wait(200);
    names.push(await save(m, 'settings-screenshot-actions'));
    await page(m,`window.desktop.act('custom-capture')`);await wait(400);names.push(await save(m,'custom-capture'));await settingsTab(m,'截图');
    await reveal(m, '[aria-label="全屏截图后复制"]'); await page(m, `document.querySelector('[aria-label="全屏截图后复制"]').click(); document.querySelector('[aria-label="全屏截图后保存"]').click(); document.querySelector('[aria-label="截图保存格式"] button:last-child').click()`); await wait(250);
    await scrollTo(m, '#screenshot-directory', 'center'); await wait(200); names.push(await save(m, 'settings-screenshot-save'));
    await page(m, `document.querySelector('[aria-label="窗口截图背景"] button:last-child').click(); document.querySelector('[aria-label="保留窗口阴影"]').click()`); await wait(200); await scrollTo(m, '#screenshot-color', 'center'); await wait(350); names.push(await save(m, 'settings-screenshot-background'));
    await scrollTo(m, '#screenshot-height'); await page(m, `Array.from(document.querySelectorAll('button')).find(button => button.textContent === '添加语言').click()`); await wait(250); names.push(await save(m, 'settings-screenshot-ocr'));
    if(global.uiShots.captureOnly)return names;
    await settingsTab(m, '通用');
    m.webContents.send('shell:changed', { ...shell, settingsOpen: true, settings: { ...shell.settings, shortcut: 'F1', captureShortcuts: { ...shell.settings.captureShortcuts, area: 'F2' }, actionShortcuts: { ...shell.settings.actionShortcuts, 'open-launcher': 'F1', area: 'F2' } } }); await wait(250);
    await scrollTo(m, '#shortcut-open-launcher', 'center'); await wait(150);
    if (!await page(m, `document.getElementById('shortcut-open-launcher').textContent.includes('F1') && document.getElementById('shortcut-area').textContent.includes('F2')`)) throw Error('Single function keys did not render in shortcut settings');
    names.push(await save(m, 'settings-shortcuts'));
    await scrollTo(m, '#shortcut-rect', 'center'); await wait(150); names.push(await save(m, 'settings-rect-shortcut'));
    m.webContents.send('shell:changed', { ...shell, settingsOpen: true });
    await scrollTo(m, '#resident-suite'); await wait(200);
    names.push(await save(m, 'settings-resident-suite'));
    await scrollTo(m, '#memory-settings'); await wait(250);
    names.push(await save(m, 'settings-memory'));
    m.webContents.send('shell:changed', { ...shell, settingsOpen: true, settings: { ...shell.settings, memory: {enabled:false,idleMinutes:45} } }); await wait(200);
    names.push(await save(m, 'settings-memory-disabled'));
    m.webContents.send('shell:changed', { ...shell, settingsOpen: true, settings: { ...shell.settings, appPrompts: [
      { name: 'Safari', bundleId: 'com.apple.Safari', prompt: '这段内容来自浏览器。', enabled: true },
      { name: '未安装的应用', bundleId: 'local.lasso.not-installed', prompt: '', enabled: true }
    ] } });
    await settingsTab(m, '应用背景');
    if (!await page(m, `Boolean(document.querySelector('.l-app-icon img')?.src.startsWith('data:image/png;base64,'))`)) throw Error('Installed application icon did not load');
    names.push(await save(m, 'settings-app-icons'));
    m.webContents.send('shell:changed', { ...shell, settingsOpen: true });
    await settingsTab(m, '预设');
    names.push(await save(m, 'preset-list'));
    await page(m, `document.querySelector('.l-preset').focus()`); await wait(150); names.push(await save(m, 'preset-list-selected'));
    const catalogIPC = global.uiShots.ipcMain;
    const originalCatalog = catalogIPC._invokeHandlers.get('shell:execution-catalog');
    catalogIPC.removeHandler('shell:execution-catalog');
    catalogIPC.handle('shell:execution-catalog', (event, target, ...args) => target === 'chatgpt' ? { catalog: {
      models: [{ id: '6', label: '6' }], efforts: [0, 1, 2, 3, 4].map(index => `slider:0:4:${index}`),
      effortOptions: ['6 即时', '6 中', '6 高', '6 极高', '6 Pro'].map((label, index) => ({ id: `slider:0:4:${index}`, label })),
      currentModel: '6', currentEffort: 'slider:0:4:0'
    }, error: null } : originalCatalog(event, target, ...args));
    m.webContents.send('shell:changed', { ...shell, settingsOpen: true, presets: shell.presets.map((preset, index) => index ? preset : { ...preset, model: '6', effort: '6 Instant' }) }); await wait(150);
    await page(m, `document.querySelector('.l-preset').click()`); await wait(450);
    await page(m, `document.getElementById('preset-effort').scrollIntoView({block:'center'})`); await wait(150);
    if (!await page(m, `document.getElementById('preset-effort').value === 'slider:0:4:0' && document.getElementById('preset-effort').selectedOptions[0].textContent === '6 即时'`)) throw Error('Legacy effort label did not resolve across website locales');
    names.push(await save(m, 'preset-effort-localized'));
    await page(m, `(() => { const select = document.getElementById('preset-effort'); select.value = 'slider:0:4:2'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`); await wait(150);
    if (!await page(m, `document.getElementById('preset-effort').selectedOptions[0].textContent === '6 高'`)) throw Error('Native effort ID leaked into the displayed option');
    names.push(await save(m, 'preset-effort-native'));
    catalogIPC.removeHandler('shell:execution-catalog'); catalogIPC.handle('shell:execution-catalog', originalCatalog);
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
  // Stage 2 settings use the real isolated configuration IPC; only native pickers are fixtures.
  saved.push(...await main(async () => {
    const { find, page, wait, ready, showPane, scrollTo, settingsTab, save, ipcMain, fs, path, app, out } = global.uiShots, names = [], checks = [], m = find();
    if (global.uiShots.surfacesOnly) return names;
    const original = await page(m, 'window.desktop.getState().then(s => s.settings)');
    const expect = (ok, message) => { if (!ok) throw Error(message); };
    const click = async selector => { await page(m, `(async () => { const e=document.querySelector(${JSON.stringify(selector)});await (${showPane})(e);e.click(); })()`); await wait(180); };
    const fill = async (id, value) => { await page(m, `(async () => { const e=document.getElementById(${JSON.stringify(id)});await (${showPane})(e);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true})); })()`); await wait(100); };
    const choice = async (label, text) => { await page(m, `(async () => { const b=Array.from(document.querySelectorAll('[aria-label="${label}"] button')).find(b=>b.textContent===${JSON.stringify(text)});await (${showPane})(b);b.click(); })()`); await wait(120); };
    const record = async (id, key, code) => { await click('#' + id); await page(m, `document.getElementById(${JSON.stringify(id)}).dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},code:${JSON.stringify(code)},bubbles:true}))`); await wait(250); };
    const settings = () => page(m, 'window.desktop.getState().then(s => s.settings)');
    const picker = ipcMain._invokeHandlers.get('shell:choose-path');
    ipcMain.removeHandler('shell:choose-path'); ipcMain.handle('shell:choose-path', (_event, kind) => kind === 'application' ? { path:'/System/Applications/Preview.app', bundleId:'com.apple.Preview', name:'Preview' } : { path:app.getPath('temp') });
    try {
      await settingsTab(m, '通用');
      await record('shortcut-rect', 'F20', 'F20'); expect((await settings()).actionShortcuts.rect === 'F20', 'Global shortcut recorder did not save');
      await record('shortcut-window', 'F20', 'F20'); expect(await page(m, `Boolean(document.querySelector('#shortcut-window').closest('li').querySelector('[role="alert"]'))`), 'Global shortcut conflict did not appear');
      await scrollTo(m, '#global-shortcuts'); names.push(await save(m, 'settings-shortcuts-conflict'));
      await click('[aria-label="取消绑定框选截图"]'); expect((await settings()).actionShortcuts.rect === '', 'Global shortcut did not clear');
      await record('editor-shortcut-arrow', 'q', 'KeyQ'); expect((await settings()).editorShortcuts.arrow === 'Q', 'Editor shortcut recorder did not save');
      await record('editor-shortcut-rectangle', 'q', 'KeyQ'); expect(await page(m, `Boolean(document.querySelector('#editor-shortcut-rectangle').closest('li').querySelector('[role="alert"]'))`), 'Editor shortcut conflict did not appear');
      await scrollTo(m, '#editor-shortcuts'); names.push(await save(m, 'settings-editor-shortcuts'));
      await click('[aria-label="取消绑定箭头"]'); expect((await settings()).editorShortcuts.arrow === '', 'Editor shortcut did not clear'); checks.push('全局/编辑器快捷键录制、冲突提示与清空');
      await page(m, `Array.from(document.querySelectorAll('#ignored-apps button')).find(b=>b.textContent==='选择忽略应用…').click()`); await ready(m, `Boolean(document.querySelector('[aria-label="Preview：忽略划词"]'))`);
      await click('[aria-label="Preview：忽略快捷键"]'); await click('[aria-label="启用忽略 Preview"]');
      const ignored = (await settings()).ignoredApps.find(rule => rule.bundleId === 'com.apple.Preview');
      expect(ignored && !ignored.enabled && ignored.scopes.join(',') === 'selection,capture-candidates', 'Ignored app scopes did not persist');
      await scrollTo(m, '#ignored-apps'); names.push(await save(m, 'settings-ignored-apps'));
      await click('[aria-label="删除忽略应用 Preview"]'); expect(!(await settings()).ignoredApps.some(rule => rule.bundleId === 'com.apple.Preview'), 'Ignored app did not delete'); checks.push('忽略应用添加、范围、启停与删除');
      await settingsTab(m, '截图');
      await click('[aria-label="记住标注工具样式"]'); await scrollTo(m, '#screenshot-editing'); names.push(await save(m, 'settings-annotation-memory'));
      for (const format of ['PNG','JPEG','WEBP','BMP','PDF']) await choice('截图保存格式', format);
      await fill('screenshot-quality', 76); await click('[aria-label="选择快速保存目录"]'); await fill('screenshot-template', '../invalid');
      expect(await page(m, `document.querySelector('.l-save-bar').textContent.includes('有未保存')`), 'Output settings did not become dirty');
      await page(m, `Array.from(document.querySelectorAll('.l-save-bar button')).find(b=>b.textContent==='保存').click()`); await wait(200);
      expect(await page(m, `document.querySelector('.l-save-bar').textContent.includes('模板')`), 'Invalid file template did not show an error'); names.push(await save(m, 'settings-output-validation'));
      await fill('screenshot-template', '{YYYY}/{MM}/{DD}/{app}-{width}x{height}-{seq}'); await choice('默认复制方式','文件'); await choice('默认导出内容','原始底图'); await choice('保存后动作','复制路径');
      await scrollTo(m, '#screenshot-output'); names.push(await save(m, 'settings-screenshot-output'));
      await scrollTo(m, '[aria-label="默认复制方式"]', 'center'); names.push(await save(m, 'settings-screenshot-output-policy'));
      await page(m, `Array.from(document.querySelectorAll('.l-save-bar button')).find(b=>b.textContent==='保存').click()`); await wait(300);
      const output = (await settings()).screenshot, disk = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'settings.json'),'utf8'));
      expect(output.format === 'pdf' && output.jpegQuality === 76 && output.quickSaveDirectory === app.getPath('temp') && output.copyMode === 'file' && output.exportContentMode === 'original' && output.afterSaveAction === 'copy-path' && !output.annotationMemory.rememberToolStyles && output.fileNameTemplate.includes('{seq}'), 'Output settings did not persist');
      expect(JSON.stringify(disk.screenshot) === JSON.stringify(output), 'Output settings differ from persisted file');
      await settingsTab(m, '通用'); await settingsTab(m, '截图'); expect(await page(m, `document.getElementById('screenshot-template').value.includes('{seq}') && document.querySelector('[aria-label="截图保存格式"] [aria-checked="true"]').textContent==='PDF'`), 'Saved output settings did not restore'); checks.push('五格式、输出策略、样式记忆开关、脏状态、模板校验与保存恢复');
      fs.writeFileSync(path.join(out,'stage-2-settings.json'), JSON.stringify({status:'passed',checks,configurationPersistence:'real isolated Electron IPC and settings.json',pickers:'fixture application and workspace temp directory'},null,2));
    } finally {
      ipcMain.removeHandler('shell:choose-path'); ipcMain.handle('shell:choose-path', picker);
      await page(m, `(async()=>{await window.desktop.saveActionShortcut('rect',${JSON.stringify(original.actionShortcuts.rect || '')});await window.desktop.saveEditorShortcuts(${JSON.stringify(original.editorShortcuts)});await window.desktop.saveIgnoredApps(${JSON.stringify(original.ignoredApps)});await window.desktop.saveScreenshot(${JSON.stringify(original.screenshot)});await window.desktop.act('close-settings');})()`); await wait(250);
    }
    return names;
  }));
  // Vision settings use the real service/configuration IPC with synthetic safeStorage.
  saved.push(...await main(async () => {
    const {find,page,wait,ready,showPane,reveal,scrollTo,settingsTab,save,ipcMain,fs,path,app,out}=global.uiShots,names=[],receipts=[],m=find();
    if(global.uiShots.surfacesOnly)return names;
    const original=await page(m,'window.desktop.visionConfig()'),media=await page(m,'window.desktop.mediaConfig()'),handler=ipcMain._invokeHandlers.get('shell:vision-config-save');
    const expect=(ok,message)=>{if(!ok)throw Error(message);};
    ipcMain.removeHandler('shell:vision-config-save');ipcMain.handle('shell:vision-config-save',async(event,input)=>{const {credential,...config}=input;receipts.push({...config,credentialAction:credential===undefined?'keep':credential?'replace':'clear'});const result=await handler(event,input);expect(!('credential'in result),'Vision response leaked credential');return result;});
    const click=async selector=>{await page(m,`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});await (${showPane})(e);e.click();})()`);await wait(200);};
    const fill=async(id,value)=>{await page(m,`(async()=>{const e=document.getElementById(${JSON.stringify(id)});await (${showPane})(e);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(120);};
    const shot=async name=>{await scrollTo(m,'#screenshot-vision .l-set-row-head');names.push(await save(m,name));};
    const commit=async()=>{await page(m,`(async()=>{const b=[...document.querySelectorAll('#screenshot-vision button')].find(b=>b.textContent==='保存智能服务');await (${showPane})(b);b.click();})()`);await ready(m,`document.querySelector('#screenshot-vision [role="status"]')?.textContent.includes('已保存')`);};
    try {
      await page(m,`window.desktop.saveMediaConfig({baseURL:'https://images.example.invalid/v1',credential:'synthetic-media-key'})`);
      await settingsTab(m,'截图');await ready(m,`Boolean(document.querySelector('#screenshot-vision input'))`);await shot('settings-vision-reuse');
      await click('[aria-label="复用生图 API 凭据"]');await fill('vision-base-url','file:///invalid');await fill('vision-model','vision-fixture');await fill('vision-api-key','synthetic-vision-key');
      await page(m,`[...document.querySelectorAll('[aria-label="默认翻译语言"] button')].find(b=>b.textContent==='日文').click()`);await shot('settings-vision-independent');
      await page(m,`[...document.querySelectorAll('#screenshot-vision button')].find(b=>b.textContent==='保存智能服务').click()`);await ready(m,`Boolean(document.querySelector('#screenshot-vision [role="alert"]'))`);await shot('settings-vision-validation');expect(receipts.length===0,'Invalid vision configuration reached IPC');
      await fill('vision-base-url','https://vision.example.invalid/v1/');await commit();await shot('settings-vision-saved');
      let config=await page(m,'window.desktop.visionConfig()');expect(config.hasCredential&&!config.useMediaCredential&&config.targetLanguage==='日本語'&&config.baseURL==='https://vision.example.invalid/v1','Vision configuration did not persist');
      expect(await page(m,`document.getElementById('vision-api-key').value===''&&document.getElementById('vision-api-key').type==='password'`),'Vision secret remained in input');
      await fill('vision-model','vision-fixture-edited');await commit();expect(receipts.at(-1).credentialAction==='keep'&&(await page(m,'window.desktop.visionConfig()')).hasCredential,'Blank key did not preserve saved secret');
      await settingsTab(m,'通用');await settingsTab(m,'截图');await ready(m,`document.getElementById('vision-model')?.value==='vision-fixture-edited'`);expect(await page(m,`document.querySelector('[aria-label="默认翻译语言"] [aria-checked="true"]').textContent==='日文'`),'Vision language did not restore');
      const disk=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'settings.json'),'utf8')),secretDisk=fs.readFileSync(path.join(app.getPath('userData'),'vision-service/config.json'),'utf8');
      const {hasCredential,...persisted}=await page(m,'window.desktop.visionConfig()');expect(JSON.stringify(disk.vision)===JSON.stringify(persisted)&&!secretDisk.includes('synthetic-vision-key'),'Vision settings persistence or secret isolation failed');
      await reveal(m,'#screenshot-vision');await page(m,`[...document.querySelectorAll('#screenshot-vision button')].find(b=>b.textContent==='清除已存独立凭据').click()`);await wait(100);await commit();expect(!(await page(m,'window.desktop.visionConfig()')).hasCredential&&receipts.at(-1).credentialAction==='clear','Independent key did not clear');await shot('settings-vision-cleared');
      await click('[aria-label="复用生图 API 凭据"]');await commit();expect((await page(m,'window.desktop.visionConfig()')).hasCredential,'Media credential was not reused');
      fs.writeFileSync(path.join(out,'stage-6-settings.json'),JSON.stringify({status:'passed',receipts,persisted,checks:['复用凭据、独立凭据保存/留空保留/清除','URL校验、默认语言、切页恢复','真实IPC与磁盘一致、返回值/输入/文件脱敏'],secrets:'synthetic safeStorage; no system keychain'},null,2));
    } finally {ipcMain.removeHandler('shell:vision-config-save');ipcMain.handle('shell:vision-config-save',handler);await page(m,`(async()=>{await window.desktop.saveVisionConfig({...${JSON.stringify(original)},credential:''});await window.desktop.saveMediaConfig({baseURL:${JSON.stringify(media.baseURL)},credential:''});await window.desktop.act('close-settings');})()`);}
    return names;
  }));
  // Stage 4 settings: actions are checked against the persisted fixture receipts.
  saved.push(...await main(async () => {
    const {find,page,wait,ready,showPane,reveal,scrollTo,settingsTab,save,fs,path,out,stage4}=global.uiShots,names=[],checks=[],m=find(),s=stage4.state;
    if(global.uiShots.surfacesOnly)return names;
    const originalWorkspace=structuredClone(s.workspace.settings),originalScreenshot=await page(m,'window.desktop.getState().then(s=>s.settings.screenshot)');
    const expect=(ok,text)=>{if(!ok)throw Error(text);};
    const click=async(scope,text)=>{await page(m,`(async()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}));if(!b||b.disabled)throw Error('Unavailable stage 4 button: '+${JSON.stringify(text)});await (${showPane})(b);b.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});b.click();})()`);await wait(240);};
    const fill=async(selector,value)=>{await page(m,`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing stage 4 input');await (${showPane})(e);e.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(260);};
    const shot=async(selector,name)=>{await scrollTo(m,selector);await wait(180);names.push(await save(m,name));};
    await settingsTab(m,'截图');await ready(m,`document.querySelectorAll('.l-history-list > li').length===2`);
    await shot('#capture-history .l-set-row-head','settings-history');await shot('#capture-history .l-history-search','settings-history-list');
    {
      const savedItems=structuredClone(s.history.items);
      s.history.items=Array.from({length:6},(_,i)=>({...savedItems[i%2],id:'history-overflow-'+i,ocrSnippet:`第 ${i+1} 条截图历史 · 验证长列表滚动不收缩不重叠`}));
      await click('#capture-history','刷新历史');await ready(m,`document.querySelectorAll('.l-history-list > li').length===6`);
      expect(await page(m,`(()=>{const items=[...document.querySelectorAll('.l-history-list > li')];return items.length===6&&items.every((li,i)=>li.getBoundingClientRect().height>=li.scrollHeight-1&&(!i||li.getBoundingClientRect().top>=items[i-1].getBoundingClientRect().bottom-.5));})()`),'Capture history items shrunk or overlapped when exceeding max-height');
      s.history.items=savedItems;await click('#capture-history','刷新历史');await ready(m,`document.querySelectorAll('.l-history-list > li').length===2`);
    }
    await fill('[aria-label="搜索截图历史"]','设计评审');expect(await page(m,`document.querySelectorAll('.l-history-list > li').length===1 && document.querySelector('.l-history-list').textContent.includes('含标注')`),'History search did not retain marked result');await shot('#capture-history .l-history-search','settings-history-search');
    for(const label of ['再编辑','贴图','复制'])await click('#capture-history .l-history-list',label);
    await click('#capture-history .l-history-list','删除');expect(s.history.items.length===2,'History delete skipped inline confirmation');await shot('#capture-history .l-history-search','settings-history-delete-confirm');await click('#capture-history .l-history-list','确认删除');expect(s.history.items.length===1,'History delete did not persist');
    await fill('[aria-label="搜索截图历史"]','');await click('#capture-history','清空历史');expect(s.history.items.length===1,'History clear skipped inline confirmation');await click('#capture-history','确认清空');expect(!s.history.items.length,'History did not clear');await shot('#capture-history .l-history-search','settings-history-empty');
    for(const [label,value]of [['保留条数',80],['保留天数',14],['容量上限',256]])await fill('[aria-label="'+label+'"]',value);
    await click('.l-save-bar','保存');expect((await page(m,'window.desktop.getState().then(s=>s.settings.screenshot.history)')).maxBytesMB===256,'History policy did not save');checks.push('历史搜索、编辑/贴图/复制回执、删除/清空二次确认、容量策略保存');
    await reveal(m,'#pin-workspace');await page(m,`document.querySelector('[aria-label="桌面悬浮工具栏"]').click();document.querySelector('[aria-label="启动自动恢复贴图"]').click();[...document.querySelectorAll('[aria-label="贴图滚轮默认动作"] button')].find(b=>b.textContent==='透明度').click()`);await wait(160);
    await click('#pin-workspace','新建分组');await fill('[aria-label="分组名称 新分组"]','验收分组');await fill('[aria-label="分组颜色 验收分组"]','#788065');await page(m,`document.querySelector('[aria-label="显示分组 验收分组"]').click()`);await shot('#pin-workspace .l-set-row-head','settings-pin-workspace');await click('#pin-workspace','保存工作空间');
    expect(s.workspace.settings.floatingToolbar&&!s.workspace.settings.restoreOnLaunch&&s.workspace.settings.wheelAction==='opacity'&&s.workspace.settings.groups.at(-1).name==='验收分组','Workspace preferences or groups did not persist');
    await click('#pin-workspace','剪贴板贴图');await click('#pin-workspace','新建文字贴图');await fill('[aria-label="文字贴图内容"]','下一步：核对截图历史与同步状态。');await shot('#pin-workspace textarea','settings-pin-create-text');await click('#pin-workspace','创建文字贴图');await click('#pin-workspace','恢复刚关闭贴图');for(const label of ['网格排列','左对齐','顶对齐'])await click('#pin-workspace',label);
    await page(m,`[...document.querySelectorAll('#pin-workspace h3')].find(e=>e.textContent==='活跃贴图').id='ui-shots-active-pins'`);await shot('#ui-shots-active-pins','settings-pin-active');
    await click('#pin-workspace','锁定');await click('#pin-workspace','隐藏');await click('#pin-workspace','分组');await click('#pin-workspace','产品研究');expect(s.workspace.pins[0].locked&&!s.workspace.pins[0].visible&&s.workspace.pins[0].groupId==='research','Active pin controls did not persist');
    for(let i=0;i<2;i++){await page(m,`document.querySelector('[aria-label="删除分组 验收分组"]').click()`);await wait(160);}await click('#pin-workspace','保存工作空间');expect(s.workspace.settings.groups.length===2,'Group delete did not save');checks.push('工作空间偏好、分组增改删/显隐、活跃贴图锁定/隐藏/分组、文字创建、恢复与三种排列回执');
    await settingsTab(m,'通用');await shot('#config-transfer .l-set-row-head','settings-config-transfer');await click('#config-transfer','导出配置');await click('#config-transfer','导入配置');expect(!s.receipts.some(r=>r.method==='importConfig'),'Config import skipped inline confirmation');await click('#config-transfer','选择配置并导入');
    await fill('#webdav-username','lasso-review');await fill('#webdav-password','fixture-only-password');await page(m,`document.querySelector('[aria-label="WebDAV 自动同步"]').click()`);await click('#webdav-settings','保存 WebDAV 配置');expect(s.webdav.username==='lasso-review'&&s.webdav.autoSync&&s.webdav.hasPassword,'WebDAV fields did not persist');await shot('#webdav-settings .l-set-row-head','settings-webdav');
    for(const [status,message]of [['synced','已同步到飞牛 NAS'],['syncing','正在同步配置…'],['offline','无法连接服务器，请检查地址与网络'],['error','远端响应无效，请检查 WebDAV 路径'],['conflict','本机与远端配置都有更新，请选择保留哪一份']]){Object.assign(s.webdav,{status,message});stage4.persist();await click('#webdav-settings','刷新同步状态');await shot('#webdav-settings .l-sync-status','settings-webdav-'+status);}
    for(const [label,confirmation]of [['采用本机配置','确认上传'],['立即拉取','确认拉取']]){const before=s.receipts.filter(r=>r.method==='syncWebdav').length;await click('#webdav-settings',label);expect(s.receipts.filter(r=>r.method==='syncWebdav').length===before,'WebDAV skipped inline confirmation');await shot('#webdav-settings .l-sync-confirm','settings-webdav-'+(confirmation==='确认上传'?'push':'pull')+'-confirm');await click('#webdav-settings',confirmation);await wait(220);}
    await click('#webdav-settings','检查同步');await wait(220);expect(s.receipts.filter(r=>r.method==='syncWebdav').map(r=>r.args[0]).join(',')==='push,pull,auto','WebDAV direction receipts differ');checks.push('配置迁移确认、WebDAV凭据脱敏保存、同步/离线/错误/冲突状态、上传/拉取二次确认');
    const persisted=JSON.parse(fs.readFileSync(stage4.store,'utf8'));expect(persisted.workspace.settings.groups.length===2&&!JSON.stringify(persisted).includes('fixture-only-password'),'Fixture state was not persisted or leaked its password');
    fs.writeFileSync(path.join(out,'stage-4-settings.json'),JSON.stringify({status:'passed',checks,receipts:s.receipts,workspace:s.workspace,webdav:s.webdav,configuration:'public DesktopAPI with isolated fixture persistence; no real WebDAV or native pickers'},null,2));
    s.workspace.settings=originalWorkspace;await page(m,`window.desktop.saveScreenshot(${JSON.stringify(originalScreenshot)})`);await stage4.publish({sender:m.webContents});await page(m,"window.desktop.act('close-settings')");return names;
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

  // Selection action bar: hover on the first preset, then the ··· menu with its first row hovered, plus inline Fast API card and system suite surfaces.
  saved.push(...await main(async () => {
    const { find, page, wait, ready, move, center, save } = global.uiShots, w = find('action-bar'), names = [];
    if(global.uiShots.focusedCases.length)return names;
    w.setOpacity(1); w.showInactive(); w.webContents.send('bar:enter', { tip: 'above', menu: 'above' }); await wait(500);
    const first = await center(w, '.ab-buttons button'); if (first) await move(w, ...first);
    names.push(await save(w, 'action-bar'));
    await page(w, "document.querySelector('[aria-haspopup=menu]').click()"); await wait(450);
    const row = await center(w, '.ab-menu button'); if (row) await move(w, ...row);
    names.push(await save(w, 'action-bar-menu'));
    await page(w, "document.querySelector('[aria-haspopup=menu]').click()"); await wait(200);
    const barState = await page(w, 'window.actionBar.getState()');
    w.setBounds({ x: 180, y: 180, width: 456, height: 340 });
    w.webContents.send('bar:changed', {
      ...barState,
      fastCard: {
        presetId: 'translate',
        presetName: '翻译',
        model: 'gpt-4.1-mini',
        status: 'done',
        text: '划词后直接通过 New API 流式输出译文，按回车即可原地替换选中文本，或一键钉为桌面贴图。',
        error: null,
        firstTokenMs: 186,
        isTranslation: true,
        targetLang: 'zh'
      }
    });
    await wait(450);
    names.push(await save(w, 'action-bar-fast-card'));
    w.webContents.send('bar:changed', { ...barState, fastCard: null });
    w.hide();

    const isl = find('island');
    if (!isl) throw Error('Island surface unavailable');
    {
      await ready(isl, 'Boolean(window.island && document.querySelector(".isl-shell"))');
      isl.setOpacity(1); isl.showInactive();
      const baseIsl = await page(isl, 'window.island.getState()');
      isl.webContents.send('island:changed', {
        ...baseIsl,
        mode: 'focus-hover',
        glow: false,
        pomodoro: {
          active: true,
          paused: false,
          kind: 'focus',
          taskId: 'nook-1',
          taskTitle: '核对 New API 翻译流式延迟与回填',
          remainingSeconds: 1125,
          totalSeconds: 1500
        }
      });
      await wait(450);
      names.push(await save(isl, 'island-focus'));

      isl.webContents.send('island:changed', {
        ...baseIsl,
        mode: 'nook-alert',
        glow: true,
        alerts: [
          { id: 'alert-1', kind: 'task', title: '下午 16:00 复盘 Nook 提醒桥接', subtitle: 'Nook · 今日重点待办', target: 'nook-1' },
          { id: 'alert-2', kind: 'launchd', title: 'com.personalhub.app 异常退出 (Exit 1)', subtitle: '~/Library/LaunchAgents · 点击一键重启', target: 'com.personalhub.app' }
        ]
      });
      await wait(450);
      names.push(await save(isl, 'island-alert'));

      isl.webContents.send('island:changed', {
        ...baseIsl,
        mode: 'board',
        glow: true
      });
      await wait(450);
      names.push(await save(isl, 'island-board'));
      isl.hide();
    }

    const notesWin = find('edge-notes');
    if (!notesWin) throw Error('EdgeNotes surface unavailable');
    {
      await ready(notesWin, 'Boolean(window.island && document.querySelector(".en-stage"))');
      notesWin.setOpacity(1); notesWin.showInactive();
      const baseNotes = await page(notesWin, 'window.island.getNotesState()');
      notesWin.webContents.send('notes:changed', { ...baseNotes, open: true });
      await wait(450);
      names.push(await save(notesWin, 'edge-notes'));
      notesWin.webContents.send('notes:changed', { ...baseNotes, open: false });
      notesWin.hide();
    }

    const finderWin = find('finder-panel');
    if (!finderWin) throw Error('Finder panel surface unavailable');
    {
      await ready(finderWin, 'Boolean(window.island && document.querySelector(".fp-stage"))');
      finderWin.setOpacity(1); finderWin.showInactive();
      const baseFinder = await page(finderWin, 'window.island.getFinderState()');
      finderWin.webContents.send('finder:changed', {
        ...baseFinder,
        folder: '/Users/sm5145/WorkSpace/Code/Github/mac-ai-prompt',
        selection: ['/Users/sm5145/WorkSpace/Code/Github/mac-ai-prompt/src/main/island.ts']
      });
      await wait(450);
      names.push(await save(finderWin, 'finder-panel'));
      finderWin.hide();
    }
    const mainWin = find();
    if (mainWin) { mainWin.show(); mainWin.focus(); }
    return names;
  }));

  // Region presets: configuration IPC and form interactions; acquisition is stubbed.
  saved.push(...await main(async () => {
    const {find,page,wait,save,settingsTab,scrollTo,reveal,ipcMain,app,fs,path,out}=global.uiShots,names=[],checks=[];let m;
    if(global.uiShots.focusedCases.length)return names;
    await wait(1800);
    m=global.uiShots.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/renderer/index.html')&&!w.webContents.getURL().includes('surface='));
    if(!m)throw Error('Main renderer unavailable');m.show();m.focus();await wait(300);
    await page(m,`(async()=>{const s=await window.desktop.getState();if(!s.pinned)await window.desktop.act('pin');for(const t of s.tasks)await window.desktop.closeTask(t.id);})()`);await wait(800);
    const expect=(value,message)=>{if(!value)throw Error(message);};
    const fill=async(label,value)=>{await page(m,`(()=>{const el=document.querySelector('[aria-label="${label}"]');if(!el)throw Error('Missing ${label}');const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(100);};
    const click=async(text)=>{await page(m,`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing button ${text}');b.click();})()`);await wait(250);};
    const val=label=>page(m,`document.querySelector('[aria-label="${label}"]').value`);
    const presets=()=>page(m,'window.desktop.captureRegions().then(c=>c.presets)');
    await page(m,"window.desktop.act('custom-capture')");await wait(500);
    expect(await val('截图宽度')==='800'&&await val('截图高度')==='600','Initial dimensions');
    expect(Boolean(await val('目标显示器')),'Default display must be selected');
    await fill('自定义区域名称','预设回归');await click('保存预设');
    let items=await presets();expect(items.length===1,'Create preset');const id=items[0].id;
    expect(await val('选择区域预设')===id,'Saved preset must become selected');
    await click('更新预设');items=await presets();expect(items.length===1&&items[0].id===id,'Second save must update same preset');checks.push('新建后连续保存保持同一 ID');
    await click('1:1');expect(await val('截图高度')==='800','Ratio updates height');
    await fill('截图宽度','600');expect(await val('截图高度')==='600','Locked ratio updates dimension');
    await click('16:9');expect(await val('截图高度')==='338','Ratio rounds to integer pixels');
    await fill('截图高度','450');expect(await val('截图宽度')==='800','Height updates locked width');
    await fill('自定义截图宽高比','2:3');await click('应用比例');expect(await val('截图高度')==='1200','Custom ratio updates dimensions');
    await fill('自定义区域名称','已重命名');await page(m,`[...document.querySelectorAll('[aria-label="自定义截图延时"] button')].find(b=>b.textContent==='5秒').click()`);await click('更新预设');
    items=await presets();expect(items.length===1&&items[0].name==='已重命名'&&items[0].ratio===2/3&&items[0].delay===5,'Rename ratio delay persist');checks.push('尺寸双向联动、常用/自定义比例、重命名和延时更新');names.push(await save(m,'custom-preset-saved'));
    await fill('选择区域预设','');expect(await val('截图宽度')==='800'&&await val('截图高度')==='600'&&await val('自定义区域名称')==='','New region resets form');
    expect(await page(m,`document.querySelector('[aria-label="锁定当前宽高比"]').getAttribute('aria-pressed')`)==='false','New region unlocks ratio');checks.push('切换新区域重置尺寸名称比例延时');
    await fill('选择区域预设',id);expect(await val('截图高度')==='1200','Select restores preset');
    let requests=[];ipcMain.removeHandler('shell:custom-screenshot');ipcMain.handle('shell:custom-screenshot',(_e,r)=>{requests.push(r);return {error:null};});
    await fill('截图宽度','900');await click('开始截图');expect(requests.length===1&&!requests[0].presetId&&requests[0].height===1350,'Unsaved size must not overwrite preset placement');
    await fill('选择区域预设',id);await click('开始截图');expect(requests.length===2&&requests[1].presetId===id,'Saved dimensions reuse binding');checks.push('未保存尺寸不关联原位置、已保存尺寸继续携带预设 ID');
    await fill('选择区域预设','');await click('开始截图');expect(requests.length===3&&requests[2].width===800&&!requests[2].presetId,'Unnamed custom capture allowed');checks.push('空名称可直接截图，保存仍要求名称');
    await fill('截图宽度','100000');await click('开始截图');expect(requests.length===3,'Oversize must not start capture');expect((await page(m,`document.querySelector('[role="alert"]').textContent`)).includes('换显示器'),'Oversize recovery message');expect(await page(m,`(()=>{const r=document.querySelector('[role="alert"]').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()`),'Oversize error should be visible');names.push(await save(m,'custom-preset-oversize'));checks.push('超出屏幕尺寸时保留参数并提示换屏或修改');
    await fill('选择区域预设',id);await click('删除');expect((await presets()).length===0&&await val('选择区域预设')==='','Delete clears selected preset');checks.push('删除后清空选择并恢复新区域');
    // The optional display mapping is provided by the output owner's integration hook.
    const cfg=await page(m,'window.desktop.captureRegions()');const mapped={id:'display-preset',name:'显示器预设',width:400,height:300,ratio:null,delay:0};
    ipcMain.removeHandler('shell:regions');ipcMain.handle('shell:regions',()=>({...cfg,presets:[mapped],displays:[...cfg.displays,{...cfg.displays[0],id:999,label:'映射测试显示器'}],presetDisplayIds:{[mapped.id]:999}}));
    await page(m,"window.desktop.act('close-custom-capture')");for(let i=0;i<40&&await page(m,`Boolean(document.querySelector('.custom-capture'))`);i++)await wait(50);await page(m,"window.desktop.act('custom-capture')");for(let i=0;i<40&&!await page(m,`Boolean(document.querySelector('option[value="display-preset"]'))`);i++)await wait(50);await fill('选择区域预设',mapped.id);expect(await val('目标显示器')==='999','Valid local display mapping');checks.push('显示器映射契约 fixture 选择有效本机绑定');
    await page(m,"window.desktop.act('close-custom-capture')");for(let i=0;i<40&&await page(m,`Boolean(document.querySelector('.custom-capture'))`);i++)await wait(50);
    await settingsTab(m,'截图');
    await reveal(m,'[aria-label="重启后记住上次区域"]');await page(m,`document.querySelector('[aria-label="重启后记住上次区域"]').click()`);await wait(100);
    const external={id:'external',name:'外部添加',width:800,height:600,ratio:null,delay:0};await page(m,`window.desktop.saveRegionPreset(${JSON.stringify(external)})`);await wait(200);
    await page(m,`[...document.querySelectorAll('.l-save-bar button')].find(b=>b.textContent==='保存').click()`);await wait(300);
    const settings=await page(m,'window.desktop.getState().then(s=>s.settings.screenshot)');expect(settings.regionPresets.some(p=>p.id==='external'),'Screenshot settings must preserve concurrently updated preset list');expect(settings.rememberRegionAcrossLaunches===false,'Memory setting saved');checks.push('截图设置草稿保留外部新增预设并保存记忆开关');await scrollTo(m,'[aria-label="重启后记住上次区域"]','center');await wait(150);names.push(await save(m,'preset-memory-settings'));
    const disk=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'settings.json'),'utf8'));expect(disk.screenshot.regionPresets.some(p=>p.id==='external'),'Persisted settings');
    fs.writeFileSync(path.join(out,'presets-results.json'),JSON.stringify({status:'passed',checks,configurationPersistence:'real isolated Electron IPC and settings.json',capture:'stubbed to avoid initiating screen acquisition',localDisplayMapping:'fixture pending owner integration'},null,2));
    return names;
  }));

  // S4 uses the production desktop preload against a controlled recording source.
  // Every action is consumed here; native desktop/media acquisition is never started.
  saved.push(...await main(async ({ nativeImage }) => {
    const { find, page, wait, ready, save, scrollTo, settingsTab, ipcMain, fs, path, app, out } = global.uiShots, names = [], checks = [], receipts = [], m = find();
    if(global.uiShots.focusedCases.length)return names;
    const expect = (ok, text) => { if (!ok) throw Error(text); };
    const makeFrame = index => {
      const width = 640, height = 360, pixels = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const rgb = y < 44 ? [20,20,19] : x > 42 + index * 120 && x < 180 + index * 120 && y > 90 && y < 250 ? [189,118,88] : y > 286 && x > 42 && x < 470 ? [120,128,101] : [250,249,245], offset = (y * width + x) * 4;
        pixels[offset] = rgb[2]; pixels[offset + 1] = rgb[1]; pixels[offset + 2] = rgb[0]; pixels[offset + 3] = 255;
      }
      return nativeImage.createFromBitmap(pixels, { width, height }).toDataURL();
    };
    const frames = [0, 1, 2].map(makeFrame), points = [0, 1770, 3540, 5310, 7080, 8850, 10620, 12399];
    const frameAt = timestamp => makeFrame(timestamp / 12400 * 3.5);
    const previewState = (start=0,end=12400) => {
      const timestamps = [...new Set([...points,...(start ? [start,end] : [])])].sort((a,b)=>a-b);
      return {previewFrames:timestamps.map(frameAt),previewTimestampsMs:timestamps};
    };
    global.uiShots.stage8Frames = frames;
    const originalScreenshot = await page(m, 'window.desktop.getState().then(s=>s.settings.screenshot)'), preferences = originalScreenshot.recording;
    const channels = ['shell:recording-state', 'shell:recording-action'], originals = channels.map(channel => ipcMain._invokeHandlers.get(channel));
    let state = null, failure = false, cameraFailure = false, holdCamera = false, releaseCamera, w;
    const session = status => ({ id:'stage-8-recording',status,mode:'rect',bounds:{x:0,y:0,width:640,height:360},countdownLeft:3,durationMs:12400,frameCount:372,settings:{...preferences,showKeystrokes:true,showMouseClicks:true,cameraOverlay:true},trimStartMs:0,trimEndMs:12400,...previewState(),recentKeys:[{key:'4',modifiers:['Meta','Shift'],timestampMs:12400}],recentClicks:[{x:300,y:150,button:'left',timestampMs:12400}],message:'' });
    const publish = value => { state = value; if (w && !w.isDestroyed()) w.webContents.send('shell:recording-changed', state); };
    ipcMain.removeHandler(channels[0]); ipcMain.handle(channels[0], () => state);
    ipcMain.removeHandler(channels[1]); ipcMain.handle(channels[1], async (_event, action) => {
      const receipt = {...structuredClone(action),before:{status:state?.status,cameraOverlay:state?.settings.cameraOverlay}}; receipts.push(receipt);
      const respond = result => { receipt.response={status:result.state?.status,cameraOverlay:result.state?.settings.cameraOverlay,trimStartMs:result.state?.trimStartMs,trimEndMs:result.state?.trimEndMs,previewTimestampsMs:result.state?.previewTimestampsMs,error:result.error,path:result.path};return result; };
      if (action.type === 'start') publish({...session('countdown'),mode:action.mode,durationMs:0,frameCount:0,trimEndMs:0,previewFrames:[],previewTimestampsMs:[],recentKeys:[],recentClicks:[]});
      else if (action.type === 'recover') publish({...state,status:'review'});
      else if (['discard-recovery','cancel'].includes(action.type)) publish(null);
      else if (action.type === 'pause') publish({...state,status:'paused'});
      else if (action.type === 'resume') publish({...state,status:'recording'});
      else if (action.type === 'stop') publish({...state,status:'review'});
      else if (action.type === 'camera') {
        expect(state&&['countdown','recording','paused'].includes(state.status)&&typeof action.enabled==='boolean','Invalid camera fixture action');
        if (holdCamera) await new Promise(resolve=>{releaseCamera=resolve;});
        if (cameraFailure) return respond({state,error:'摄像头切换失败：fixture 设备不可用'});
        publish({...state,settings:{...state.settings,cameraOverlay:action.enabled}});
      }
      else if (action.type === 'trim') publish({...state,trimStartMs:action.startMs,trimEndMs:action.endMs,...previewState(action.startMs,action.endMs)});
      else if (action.type === 'export') { if (failure) return respond({state,error:'录制导出失败：fixture 编码器不可用'}); publish({...state,message:'录制输出完成'});return respond({state,path:action.action==='pin'?null:path.join(out,'fixture-recording.'+action.format),error:null}); }
      else throw Error('Unhandled recording fixture action: '+action.type);
      return respond({state,error:null});
    });
    const click = async (win, label) => { await page(win, `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Unavailable recording control: '+${JSON.stringify(label)});b.click();})()`); await wait(180); };
    const choose = async (win, label, text) => { await page(win, `(()=>{const b=[...document.querySelectorAll('[aria-label="${label}"] button')].find(b=>b.textContent===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Unavailable recording choice');b.click();})()`); await wait(120);expect(await page(win,`document.querySelector('[aria-label="${label}"] [aria-checked="true"]')?.textContent===${JSON.stringify(text)}`),'Recording choice did not select: '+label+' '+text); };
    const shot = async name => { await wait(420); expect(await page(w, `document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight`), 'Recording panel overflow: '+name); names.push(await save(w,name)); };
    const status = async value => { await ready(w, `document.querySelector('[aria-label="屏幕录制"]')?.dataset.recordingStatus===${JSON.stringify(value)}`);w.setSize(...(value==='review'?[680,680]:['idle','recoverable'].includes(value)?[520,350]:[720,200]));await wait(120); };
    const cameraControl = () => page(w,`(()=>{const b=document.querySelector('button[aria-label="摄像头画中画"]');return b&&{pressed:b.getAttribute('aria-pressed'),busy:b.getAttribute('aria-busy')==='true',disabled:b.disabled,text:b.textContent};})()`);
    const changeCamera = async (enabled,{fail=false,held=false,busyShot}={}) => {
      const before=state.settings.cameraOverlay,phase=state.status,count=receipts.length;cameraFailure=fail;holdCamera=held;
      expect(before!==enabled,'Camera exercise must request a real change');await click(w,'摄像头画中画');
      if (held) {
        await ready(w,`document.querySelector('button[aria-label="摄像头画中画"]')?.getAttribute('aria-busy')==='true'`);
        const control=await cameraControl();expect(control.disabled&&control.pressed===String(before)&&control.text.includes(enabled?'正在开启':'正在关闭'),'Pending camera action changed its confirmed state');
        expect(state.settings.cameraOverlay===before&&!receipts.at(-1).response,'Camera fixture replied before release');
        await page(w,`document.querySelector('button[aria-label="摄像头画中画"]').click()`);expect(receipts.length===count+1,'Busy camera control accepted a duplicate request');
        if(busyShot)await shot(busyShot);releaseCamera();releaseCamera=undefined;
      }
      await ready(w,`!document.querySelector('button[aria-label="摄像头画中画"]')?.disabled`);
      const result=receipts.at(-1),control=await cameraControl(),confirmed=fail?before:enabled;
      expect(result.type==='camera'&&result.enabled===enabled&&result.response?.cameraOverlay===confirmed&&state.settings.cameraOverlay===confirmed,'Camera action or confirmed result lost at preload boundary');
      expect(state.status===phase&&control.pressed===String(confirmed)&&!control.busy,'Camera switch changed recording phase or ARIA state');
      if(fail)expect(result.response.error&&await page(w,`document.querySelector('[role="alert"]')?.textContent.includes('fixture 设备不可用')`),'Camera error was not visible');
      else expect(!result.response.error&&control.text.includes(confirmed?'摄像头已开启':'摄像头已关闭'),'Camera completion did not show confirmed state');
      cameraFailure=false;holdCamera=false;
    };
    const exerciseCamera = async phase => {
      await changeCamera(false);await shot('recording-camera-'+phase+'-off');
      await changeCamera(true,{fail:true});await shot('recording-camera-'+phase+'-error');
      await changeCamera(true,{held:true,busyShot:'recording-camera-'+phase+'-busy'});
      await changeCamera(false,{fail:true});await changeCamera(false,{held:true,busyShot:phase==='recording'?'recording-camera-closing-busy':undefined});await changeCamera(true);
      checks.push(phase+'摄像头开/关真实动作回执、双向失败保留旧值、忙态禁止重复操作');
    };
    try {
      if (!global.uiShots.surfacesOnly) {
        await settingsTab(m,'截图'); await ready(m,`Boolean(document.querySelector('#screenshot-recording'))`);
        await scrollTo(m,'#screenshot-recording .l-set-row-head'); names.push(await save(m,'settings-recording-defaults'));
        const groups = [['录制帧率',['15','24','30','60']],['录制画质',['低','中','高']],['录制默认格式',['GIF','WEBP','MP4']],['录制倒计时',['无','3 秒','5 秒']]];
        for (const [label, options] of groups) for (const option of options) await choose(m,label,option);
        for (const label of ['录制系统声音','录制麦克风','显示按键提示','显示鼠标点击','摄像头画中画']) await click(m,label);
        for (const corner of ['右下','左下','右上','左上']) await choose(m,'摄像头位置',corner);
        const overlayRow='#screenshot-recording li:has(> [aria-label="录制系统声音"])';
        await page(m,`document.querySelector(${JSON.stringify(overlayRow)}).style.scrollMarginTop='12px'`);await scrollTo(m,overlayRow);await wait(180);
        expect(await page(m,`(()=>{const bounds=document.querySelector('.l-shot-settings').getBoundingClientRect(),rows=[...document.querySelectorAll('#screenshot-recording [role="switch"],#screenshot-recording [aria-label="摄像头位置"]')].map(control=>control.closest('li').getBoundingClientRect());return rows.length===6&&rows.every(row=>row.top>=bounds.top+8&&row.bottom<=bounds.bottom);})()`),'Recording overlay rows were clipped');names.push(await save(m,'settings-recording-overlays'));
        await page(m,`[...document.querySelectorAll('.l-save-bar button')].find(b=>b.textContent==='保存').click()`); await ready(m,`document.querySelector('.l-save-bar')?.textContent.includes('已保存')`);
        const persisted = await page(m,'window.desktop.getState().then(s=>s.settings.screenshot.recording)'), disk = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'settings.json'),'utf8'));
        expect(persisted.fps===60&&persisted.quality==='high'&&persisted.format==='mp4'&&persisted.countdown===5&&persisted.cameraPosition==='top-left','Recording choices did not save');
        for (const [key,value] of Object.entries(preferences)) if (typeof value==='boolean') expect(persisted[key]===!value,'Recording switch did not save: '+key);
        expect(JSON.stringify(persisted)===JSON.stringify(disk.screenshot.recording),'Recording settings differ from persisted disk');
        await settingsTab(m,'通用'); await settingsTab(m,'截图');
        for (const [label,text] of [['录制帧率','60'],['录制画质','高'],['录制默认格式','MP4'],['录制倒计时','5 秒'],['摄像头位置','左上']]) expect(await page(m,`document.querySelector('[aria-label="${label}"] [aria-checked="true"]')?.textContent===${JSON.stringify(text)}`),'Recording choice did not restore: '+label);
        for (const [label,key] of [['录制系统声音','systemAudio'],['录制麦克风','microphone'],['显示按键提示','showKeystrokes'],['显示鼠标点击','showMouseClicks'],['摄像头画中画','cameraOverlay']]) expect(await page(m,`document.querySelector('[aria-label="${label}"]').getAttribute('aria-checked')===${JSON.stringify(String(persisted[key]))}`),'Recording switch did not restore: '+key);
        await scrollTo(m,'#screenshot-recording .l-set-row-head'); names.push(await save(m,'settings-recording-restored')); checks.push('全部帧率/画质/格式/倒计时/摄像头位置选项、五开关、真实IPC保存/磁盘一致/切页恢复');
        await page(m,'window.desktop.act("close-settings")');
      }
      await page(m,'window.desktop.recordingPanel(true)');w=find('recording');expect(w,'Production recording window did not open');await status('idle');
      for (const [mode,label] of [['rect','区域录制'],['window','窗口录制'],['screen','全屏录制']]) {
        await choose(w,'录制模式',label); await shot('recording-idle-'+mode); await click(w,'开始录制'); await status('countdown'); expect(state.mode===mode,'Recording mode lost at preload boundary'); await shot('recording-countdown-'+mode);
        if(mode==='rect'){await exerciseCamera('countdown');for(const remaining of [2,1]){publish({...state,countdownLeft:remaining});await ready(w,`document.querySelector('.l-record-badge')?.textContent.includes('倒计时 ${remaining}')`);await shot('recording-countdown-'+remaining);}publish({...session('recording'),mode});await status('recording');}
        await click(w,'取消录制');if(state?.frameCount){await shot('recording-cancel-confirm');expect(state.status==='recording','Cancel confirmation discarded recording early');await click(w,'确认取消录制');}await status('idle');
      }
      publish(session('recoverable')); await status('recoverable'); await shot('recording-recoverable'); await click(w,'丢弃未完成录制');expect(state.status==='recoverable','Recovery was discarded without confirmation');await shot('recording-discard-confirm');await click(w,'确认丢弃未完成录制');await status('idle');expect(state===null,'Interrupted recording was not discarded');
      publish(session('recoverable')); await status('recoverable'); await click(w,'恢复未完成录制'); await status('review'); expect(state.status==='review','Interrupted recording did not recover into review'); await shot('recording-recovered');
      publish({...session('recording'),id:'stage-8-camera-narrow'});await status('recording');await changeCamera(false);await click(w,'取消录制');w.setSize(375,260);await wait(120);
      expect(await page(w,`['摄像头画中画','确认取消录制','暂停录制','结束录制'].every(label=>{const r=document.querySelector('button[aria-label="'+label+'"]')?.getBoundingClientRect();return r&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})`),'Narrow camera/cancel confirmation controls were clipped');
      await shot('recording-camera-narrow-confirm');await click(w,'确认取消录制');await status('idle');expect(state===null,'Camera narrow confirmation did not cancel');
      publish({...session('recording'),id:'stage-8-live'}); await status('recording'); await shot('recording-active');
      expect(await page(w,`document.body.textContent.includes('⌘')&&document.body.textContent.includes('⇧')&&document.querySelector('[aria-label="鼠标点击提示"]')?.textContent.includes('点击脉冲')&&document.querySelector('.l-record-camera')?.textContent.includes('摄像头已开启')`),'Recording teaching cues are missing');
      await exerciseCamera('recording');await click(w,'暂停录制'); await status('paused'); await shot('recording-paused');await exerciseCamera('paused'); await click(w,'继续录制'); await status('recording'); await click(w,'结束录制'); await status('review'); await shot('recording-review');
      const preview = () => page(w,`document.querySelector('[aria-label="关键帧预览"] img')?.src`);
      const selectFrame = async index => {await click(w,'预览关键帧 '+(index+1));expect(await preview()===state.previewFrames[index],'Timeline did not select the requested keyframe');expect(await page(w,`document.querySelector('[aria-label="预览位置"]').value===${JSON.stringify(String(state.previewTimestampsMs[index]))}&&document.querySelector('[aria-label="预览关键帧 ${index+1}"]').getAttribute('aria-pressed')==='true'`),'Timeline timestamp or selected ARIA state differs from image');};
      expect(state.previewFrames.length===8&&state.previewTimestampsMs.at(-1)>state.durationMs*.99,'Review fixture does not cover the entire recording');
      for(let index=0;index<state.previewFrames.length;index++)await selectFrame(index);await shot('recording-review-end');
      await page(w,`(()=>{const e=document.querySelector('[aria-label="预览位置"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,6900);e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(100);const first=await preview();
      await click(w,'播放关键帧预览'); await ready(w,`document.querySelector('[aria-label="关键帧预览"] img')?.src!==${JSON.stringify(first)}`); await click(w,'暂停关键帧预览'); const frozen = await preview(); await wait(300); expect((await preview())===frozen,'Paused keyframe preview changed'); await shot('recording-review-paused');
      for (const [label,value] of [['裁剪起点',1600],['裁剪终点',9800]]) {
        await page(w,`(()=>{const e=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${value});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new Event('pointerup',{bubbles:true}));})()`); await wait(200);
      }
      expect(state.trimStartMs===0&&state.trimEndMs===12400,'Trim draft was applied before confirmation');await shot('recording-review-trim-draft');await click(w,'应用裁剪');expect(state.trimStartMs===1600&&state.trimEndMs===9800,'Dual trim sliders did not consume both bounds');
      expect(state.previewFrames.length===10&&state.previewFrames.length===state.previewTimestampsMs.length&&state.previewTimestampsMs.includes(1600)&&state.previewTimestampsMs.includes(9800),'Applied trim did not refresh representative frames with both endpoints');
      expect(await page(w,`[...document.querySelectorAll('[aria-label="关键帧时间轴"] button')].every((button,index)=>button.disabled===(${JSON.stringify(state.previewTimestampsMs)}[index]<1600||${JSON.stringify(state.previewTimestampsMs)}[index]>9800))`),'Timeline allowed frames outside trim');
      await selectFrame(state.previewTimestampsMs.indexOf(1600));await shot('recording-review-trimmed');await selectFrame(state.previewTimestampsMs.indexOf(9800));await shot('recording-review-trim-end');
      for (const format of ['GIF','WEBP','MP4']) {
        await choose(w,'录制导出格式',format);
        for (const [label,action] of [['保存录制','save'],['快速保存录制','quick-save'],['复制录制文件','copy-file'],['转为动态贴图','pin']]) { await click(w,label);expect(receipts.at(-1).type==='export'&&receipts.at(-1).format===format.toLowerCase()&&receipts.at(-1).action===action,'Recording export action/format lost');expect(await page(w,`document.querySelector('.l-record-notice')?.textContent===${JSON.stringify(action==='pin'?'已转为动态贴图':action==='copy-file'?'已复制录制文件':'录制已保存')}`),'Recording output completion was not shown');if(format==='GIF')await shot('recording-output-'+action); }
        await shot('recording-review-'+format.toLowerCase());
      }
      failure=true; await click(w,'保存录制'); await ready(w,`document.querySelector('[role="alert"]')?.textContent.includes('fixture 编码器不可用')`); expect(state.status==='review'&&state.trimStartMs===1600&&state.trimEndMs===9800,'Failed export discarded review or trim'); await shot('recording-export-error');
      checks.push('三模式开始/倒计时/取消、恢复/丢弃、按键/点击/摄像头指示、暂停/继续/结束','375px摄像头开关与原地取消确认完整可见','整段8点时间戳/图像/选中态逐点一致、跨时间戳播放/暂停、裁剪后10点含首尾端点与范围外禁用','双滑块边界回执、三格式×四输出、失败保留裁剪');
      const clipboard=await page(w,'window.__uiShotsClipboard');expect(clipboard&&clipboard.systemReads===0&&clipboard.systemWrites===0,'Recording renderer clipboard isolation missing');
      await click(w,'关闭并丢弃录制');expect(!w.isDestroyed()&&state.status==='review','Close skipped inline discard confirmation');await shot('recording-close-confirm');await click(w,'确认关闭并丢弃录制');expect(w.isDestroyed(),'Confirmed recording close left the window open');
      fs.writeFileSync(path.join(out,'stage-8-recording.json'),JSON.stringify({status:'passed',checks,receipts,shots:names,clipboard,mediaSource:'controlled synthetic frames and camera action responses; no physical devices or desktop capture',electronSessionNetworkAtCapture:global.uiShotsNetwork.audit,systemClipboardReads:0,systemClipboardWrites:0},null,2));
    } finally {
      if (w && !w.isDestroyed()) w.destroy();
      for (const [index,channel] of channels.entries()) { ipcMain.removeHandler(channel); if(originals[index]) ipcMain.handle(channel,originals[index]); }
      await page(m,`(async()=>{await window.desktop.saveScreenshot(${JSON.stringify(originalScreenshot)});await window.desktop.act('close-settings');})()`); await wait(180);
    }
    return names;
  }));

  // The grid switch uses the real draft/save/reopen flow and remains selectable in focused runs.
  saved.push(...await main(async () => {
    const { find, page, wait, ready, reveal, scrollTo, settingsTab, save, fs, path, out, app, focusedCases, captureOnly } = global.uiShots, m=find(), names=[],checks=[];
    const cases=['settings-loupe-grid-off','settings-loupe-grid-on'];
    if(focusedCases.length?!focusedCases.some(name=>cases.includes(name)):captureOnly)return names;
    const original=await page(m,'window.desktop.getState().then(s=>s.settings.screenshot)'),selector='[aria-label="显示放大镜像素网格"]';
    const expect=(ok,message)=>{if(!ok)throw Error(message);};
    const fixtureRoot=path.dirname(app.getPath('userData')),legacy=path.join(fixtureRoot,'stage-9-grid-legacy.json');
    fs.writeFileSync(legacy,JSON.stringify({shortcut:'',selectionEnabled:false,clipboardFallback:false,screenshot:{directory:app.getPath('temp')}}));
    expect(process.mainModule.require(path.join(fixtureRoot,'stage-9-settings.cjs')).readSettings(legacy).screenshot.showLoupeGrid===true,'Legacy configuration without showLoupeGrid must default to grid enabled');
    try {
      await page(m,`(async()=>{const result=await window.desktop.saveScreenshot(${JSON.stringify({...original,showLoupeGrid:true})});if(result.error)throw Error(result.error);})()`);
      await settingsTab(m,'截图');
      for(const enabled of [false,true]){
        await ready(m,`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
        expect(await page(m,`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-checked')===${JSON.stringify(String(!enabled))}`),'Grid switch did not restore its previous saved value');
        await reveal(m,selector);await page(m,`document.querySelector(${JSON.stringify(selector)}).click()`);
        await ready(m,`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-checked')===${JSON.stringify(String(enabled))}&&Boolean(document.querySelector('.l-save-bar .primary'))`);
        await page(m,`(()=>{const button=[...document.querySelectorAll('.l-save-bar button')].find(button=>button.textContent==='保存');if(!button||button.disabled)throw Error('Grid settings save unavailable');button.click();})()`);
        await ready(m,`!document.querySelector('.l-save-bar .primary')&&document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-checked')===${JSON.stringify(String(enabled))}`);
        const screenshot=await page(m,'window.desktop.getState().then(s=>s.settings.screenshot)'),disk=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'settings.json'),'utf8')).screenshot;
        expect(screenshot.showLoupeGrid===enabled&&disk.showLoupeGrid===enabled&&screenshot.showCrosshair===original.showCrosshair&&JSON.stringify(screenshot)===JSON.stringify(disk),'Grid switch did not persist independently from crosshair');
        await settingsTab(m,'通用');await settingsTab(m,'截图');
        expect(await page(m,`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-checked')===${JSON.stringify(String(enabled))}`),'Grid switch did not restore after reopening settings');
        const name='settings-loupe-grid-'+(enabled?'on':'off');
        if(!focusedCases.length||focusedCases.includes(name)){await scrollTo(m,'#screenshot-advanced .l-set-row-head');names.push(await save(m,name));}
        checks.push({enabled,persisted:disk.showLoupeGrid,reopened:true,crosshairUnchanged:true});
      }
      fs.writeFileSync(path.join(out,'stage-9-loupe-grid-settings.json'),JSON.stringify({status:'passed',source:'production readSettings migration, ScreenshotSettings Switch, saveScreenshot IPC, settings.json and reopen',legacyConfigWithoutGridDefaultsTo:true,checks,shots:names},null,2));
    } finally {await page(m,`(async()=>{await window.desktop.saveScreenshot(${JSON.stringify(original)});await window.desktop.act('close-settings');})()`);await wait(180);}
    return names;
  }));

  // S5 settings use production IPC and VM execution; only desktop pin creation is receipted.
  saved.push(...await main(async ({ app, nativeTheme, clipboard }) => {
    const { find, page, wait, ready, showPane, scrollTo, settingsTab, save, fs, path, out, stage4, focusedCases } = global.uiShots, names=[],checks=[],m=find();
    if(global.uiShots.captureOnly&&!focusedCases.some(name=>['settings-advanced-capture','settings-advanced-narrow-capture'].includes(name)))return names;
    const expect=(ok,message)=>{if(!ok)throw Error(message);},get=()=>page(m,'window.desktop.getState().then(s=>s.settings)'),original=await get(),bounds=m.getBounds(),minimum=m.getMinimumSize(),theme=nativeTheme.themeSource;
    const general=s=>Object.fromEntries(['launchAtLogin','themeMode','toolbarTools','mouseActions','scriptActions','autoCheckUpdates'].map(key=>[key,s[key]]));
    const click=async selector=>{await page(m,`(async()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)throw Error('Unavailable S5 control');await (${showPane})(b);b.click();})()`);await wait(180);};
    const text=async(scope,label)=>{await page(m,`(async()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Unavailable S5 action: '+${JSON.stringify(label)});await (${showPane})(b);b.click();})()`);await wait(220);};
    const fill=async(id,value)=>{await page(m,`(async()=>{const e=document.getElementById(${JSON.stringify(id)});await (${showPane})(e);Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(100);};
    const choice=async(label,value)=>{await text('[aria-label="'+label+'"]',value);};
    const shot=async(selector,name)=>{if(focusedCases.length&&!focusedCases.includes(name))return;await scrollTo(m,selector);names.push(await save(m,name));};
    const fixtureRoot=path.dirname(app.getPath('userData')),legacyPath=path.join(fixtureRoot,'stage-9-legacy.json');
    fs.writeFileSync(legacyPath,JSON.stringify({shortcut:'',selectionEnabled:false,clipboardFallback:false,screenshot:{directory:app.getPath('temp')}}));
    const migrated=process.mainModule.require(path.join(fixtureRoot,'stage-9-settings.cjs')).readSettings(legacyPath);
    expect(migrated.themeMode==='paper'&&!migrated.launchAtLogin&&migrated.autoCheckUpdates&&!migrated.toolbarTools.length&&!migrated.scriptActions.length&&migrated.mouseActions.doubleClick==='copy'&&migrated.screenshot.selectionShape==='rect'&&migrated.screenshot.showLoupeGrid===true&&migrated.screenshot.loupeMagnification===8,'Legacy S5 defaults did not migrate');checks.push('production readSettings migrates legacy general/capture settings, including grid enabled by default');
    try {
      await settingsTab(m,'截图');await choice('选区形状','多边形');await choice('放大镜倍率','12×');await choice('取色色值格式','HSL');await click('[aria-label="截图包含鼠标指针"]');await click('[aria-label="显示十字辅助线"]');
      for(const [id,value]of [['screenshot-cornerRadius',24],['screenshot-borderWidth',6],['screenshot-border-color','#bd7658'],['screenshot-watermark','LASSO · 内部评审'],['screenshot-watermark-opacity',.28]])await fill(id,value);
      await shot('#screenshot-advanced .l-set-row-head','settings-advanced-capture');await shot('#screenshot-cornerRadius','settings-output-decoration');await text('.l-save-bar','保存');
      let settings=await get();const screenshot=settings.screenshot,disk=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'settings.json'),'utf8'));
      expect(screenshot.selectionShape==='polygon'&&screenshot.loupeMagnification===12&&screenshot.loupeColorFormat==='hsl'&&screenshot.cornerRadius===24&&screenshot.borderWidth===6&&screenshot.watermarkOpacity===.28&&JSON.stringify(screenshot)===JSON.stringify(disk.screenshot),'Advanced capture preferences did not persist');
      await settingsTab(m,'通用');await settingsTab(m,'截图');expect(await page(m,`document.getElementById('screenshot-cornerRadius').value==='24'&&document.querySelector('[aria-label="选区形状"] [aria-checked="true"]').textContent==='多边形'`),'Advanced capture settings did not restore');checks.push('advanced capture/decorations/watermark save and reopen; native cursor/crosshair/loupe effects are not exercised');
      if(focusedCases.length){
        // Use the same saved S5 draft and geometry as the canonical full-suite screenshot.
        if(focusedCases.includes('settings-advanced-narrow-capture')){m.setMinimumSize(375,400);m.setSize(375,740);await wait(250);await shot('#screenshot-advanced .l-set-row-head','settings-advanced-narrow-capture');expect(await page(m,'document.documentElement.scrollWidth<=innerWidth'),'S5 settings overflow narrow window');}
        fs.writeFileSync(path.join(out,'stage-9-settings.json'),JSON.stringify({status:'passed',focusedCases,checks,shots:names,source:'canonical S5 capture-settings controls and persistence; focused run stops before general/script settings'},null,2));
        return names;
      }
      await settingsTab(m,'通用');await click('[aria-label="开机自启"]');await click('[aria-label="自动检查更新"]');await choice('双击动作','保存');await choice('中键动作','快速保存');await choice('右键动作','重新选区');await shot('#mouse-actions','settings-mouse-actions');
      await text('.l-toolbar-options','画笔');settings=await get();expect(settings.launchAtLogin!==original.launchAtLogin&&settings.autoCheckUpdates!==original.autoCheckUpdates&&settings.mouseActions.doubleClick==='save'&&settings.mouseActions.middleClick==='quick-save'&&settings.mouseActions.rightClick==='reselect'&&!settings.toolbarTools.includes('pen')&&settings.toolbarTools.includes('spotlight'),'General S5 controls did not persist');await shot('#toolbar-tools','settings-toolbar-tools');
      for(const [mode,source]of [['纸面','light'],['跟随系统','light'],['跟随系统','dark']]){await choice('界面主题',mode);if(mode==='跟随系统')nativeTheme.themeSource=source;await ready(m,`matchMedia('(prefers-color-scheme: dark)').matches===${source==='dark'}`);await shot('#system-settings','settings-theme-'+(mode==='纸面'?'paper':'system-'+source));}
      const darkBackground=await page(m,`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`);await choice('界面主题','纸面');await ready(m,`!matchMedia('(prefers-color-scheme: dark)').matches`);expect(darkBackground!==await page(m,`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`),'System dark theme did not change paper colors');checks.push('mouse actions/tool filtering/system toggles persist; paper and system light/dark media render');
      const success="return input.text.trim().toUpperCase() + ' · ' + [typeof process, typeof require, typeof fetch].join('/');",expected='LASSO · undefined/undefined/undefined';
      await text('#script-actions','新建脚本');await fill('script-name','整理评审文字');await fill('script-code',success);await fill('script-input','  lasso  ');await shot('#script-name','settings-script-editor');await text('#script-actions','保存并运行');await ready(m,`document.getElementById('script-output')?.value===${JSON.stringify(expected)}`);
      expect(await clipboard.readText()===expected,'Production VM output did not reach isolated main clipboard');await text('#script-actions','复制结果');expect(await page(m,'navigator.clipboard.readText()')===expected,'Script copy result did not reach isolated renderer clipboard');const receipts=stage4.state.receipts.length;await text('#script-actions','贴到桌面');expect(stage4.state.receipts.slice(receipts).some(r=>r.method==='createPin'&&r.args[0].kind==='text'&&r.args[0].text===expected),'Script result pin lost output');await shot('#script-output','settings-script-result');
      for(const [code,error,name]of [["throw Error('fixture deliberate failure');",'fixture deliberate failure','error'],['while (true) {}','超时','timeout']]){await fill('script-code',code);await text('#script-actions','保存并运行');await ready(m,`document.querySelector('#script-actions [role="alert"]')?.textContent.includes(${JSON.stringify(error)})`);expect(!await page(m,`Boolean(document.getElementById('script-output'))`),'Failed script retained stale output');await shot('#script-actions [role="alert"]','settings-script-'+name);}
      await fill('script-code',success);await text('#script-actions','保存脚本');const actions=(await get()).scriptActions;expect(actions.some(action=>action.name==='整理评审文字'&&action.code===success),'Script save did not persist');await click('[aria-label="启用脚本动作"]');await text('#script-actions','保存脚本');expect(await page(m,`[...document.querySelectorAll('#script-actions button')].find(b=>b.textContent.includes('运行并复制')).disabled`),'Disabled script remained runnable');expect(JSON.stringify(general(await get()))===JSON.stringify(general(JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'settings.json'),'utf8')))),'General settings/scripts differ from disk');checks.push('JS create/save/run/sandbox globals/success/copy/pin/error/timeout/disabled use real VM and public controls');
      m.setMinimumSize(375,400);m.setSize(375,740);await wait(250);for(const [selector,name]of [['#system-settings','system'],['#mouse-actions','mouse'],['#toolbar-tools','toolbar'],['#script-name','script']]){await shot(selector,'settings-advanced-narrow-'+name);expect(await page(m,`document.documentElement.scrollWidth<=innerWidth`),'S5 settings overflow narrow window');}await settingsTab(m,'截图');await shot('#screenshot-advanced .l-set-row-head','settings-advanced-narrow-capture');
      expect(global.uiShotsLogin.systemReads===0&&global.uiShotsLogin.systemWrites===0,'System login preferences were accessed');fs.writeFileSync(path.join(out,'stage-9-settings.json'),JSON.stringify({status:'passed',checks,shots:names,login:global.uiShotsLogin,clipboard:{systemReads:0,systemWrites:0},scriptExecution:'production IPC/node:vm Worker; pin creation fixture only'},null,2));
    } finally {await page(m,`(async()=>{await window.desktop.saveGeneral(${JSON.stringify(general(original))});await window.desktop.saveScreenshot(${JSON.stringify(original.screenshot)});await window.desktop.act('close-settings');})()`);m.setMinimumSize(...minimum);m.setBounds(bounds);nativeTheme.themeSource=theme;await wait(180);}
    return names;
  }));

  // Capture surfaces from fixture states over a frame of the main window.
  saved.push(...await main(async ({ nativeImage }) => {
    const { find, wait, ready, move, center, page, save, path, fixtures, ipcMain, BrowserWindow, app, fs, out, focusedCases } = global.uiShots, names = [];
    const W = 1280, H = 800, frame = (await find().webContents.capturePage()).resize({ width: W, height: H }), backdrop = frame.toDataURL();
    const sel = { x: 380, y: 170, width: 520, height: 320 }, crop = frame.crop(sel);
    const windows = [{ id: 1, x: 300, y: 120, width: 640, height: 430 }, { id: 2, x: 120, y: 60, width: 900, height: 620 }];
    const preferences = await page(find(), 'window.desktop.getState().then(s => ({annotationMemory:s.settings.screenshot.annotationMemory,editorShortcuts:s.settings.editorShortcuts}))');
    const base = { ...preferences, saveFormat:'png', id: 'ui-shots', editId: 'ui-shots-edit', candidates: [], status: '', selection: null };
    const longPixels=Buffer.concat([frame.toBitmap(),frame.toBitmap(),frame.toBitmap()]);
    const long=nativeImage.createFromBitmap(longPixels,{width:W,height:H*3});
    const scrolling={status:'running',width:W,height:H*3,segments:3,seams:[H,H*2],direction:'vertical',segmentSizes:[H,H,H],message:'在选区内缓慢向下滚动，每次保留至少三分之一重叠'};
    // A PNG created from the fixture frame uses the same screenshot preload and Editor as local-file editing.
    const localPath = path.join(app.getPath('temp'), 'ui-shots-local.png'); fs.writeFileSync(localPath, frame.toPNG());
    const localImage = nativeImage.createFromPath(localPath);
    const transparentPixels=Buffer.alloc(300*200*4);for(let y=20;y<180;y++)for(let x=20;x<280;x++){const offset=(y*300+x)*4;transparentPixels[offset]=transparentPixels[offset+1]=transparentPixels[offset+2]=transparentPixels[offset+3]=255;}
    const transparentImage=nativeImage.createFromBitmap(transparentPixels,{width:300,height:200});
    const retinaPixels=Buffer.alloc(W*2*H*2*4);for(let offset=0;offset<retinaPixels.length;offset+=4){retinaPixels[offset]=0x56;retinaPixels[offset+1]=0x34;retinaPixels[offset+2]=0x12;retinaPixels[offset+3]=255;}
    const retinaSample=(301*W*2+401)*4;retinaPixels[retinaSample]=0xab;retinaPixels[retinaSample+1]=0xcd;retinaPixels[retinaSample+2]=0xef;
    const retinaBackdrop=nativeImage.createFromBitmap(retinaPixels,{width:W*2,height:H*2}).toDataURL(),nativeRetinaPixels=Buffer.from(retinaPixels);
    // Distinct neighboring source pixels reveal real magnification and orientation in the saved native PNG.
    const loupeRGB=(x,y)=>x===401&&y===301?[239,205,171]:[40+(x%17)*9,55+(y%17)*8,60+((x+y)%13)*10];
    for(let y=277;y<=325;y++)for(let x=377;x<=425;x++){const [r,g,b]=loupeRGB(x,y),i=(y*W*2+x)*4;nativeRetinaPixels[i]=b;nativeRetinaPixels[i+1]=g;nativeRetinaPixels[i+2]=r;}
    const nativeRetinaBackdrop=nativeImage.createFromBitmap(nativeRetinaPixels,{width:W*2,height:H*2}).toDataURL();
    const states = {
      'overlay-loupe-retina': { ...base, image:'',backdrop:nativeRetinaBackdrop,width:W,height:H,pixelWidth:W*2,pixelHeight:H*2,pointer:{x:200.5,y:150.5},candidates:[],windows:[],mode:'rect',phase:'selecting',origin:'screen',nativePreferences:{showLoupeGrid:false} },
      'overlay-handoff-error': { ...base,image:'',backdrop,width:W,height:H,windows,candidates:[{...sel,source:'element'}],mode:'area',phase:'selecting',origin:'screen' },
      'overlay-fixed-region': { ...base,image:'',backdrop,width:W,height:H,mode:'rect',fixedSize:{width:400,height:240},phase:'selecting',origin:'screen'},
      'overlay-rect': { ...base, image: '', backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, candidates: [], windows: [], mode: 'rect', phase: 'selecting', origin: 'screen' },
      'overlay-area': { ...base, image: '', backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, candidates: [{ ...sel, source: 'element' }, { ...windows[0], source: 'window' }], windows, mode: 'area', phase: 'selecting', origin: 'screen' },
      'overlay-window': { ...base, image: '', backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, windows, mode: 'window', phase: 'selecting', origin: 'screen' },
      'overlay-scroll': { ...base, image: '', backdrop, width: W, height: H, pixelWidth: W, pixelHeight: H, candidates:[{...sel,source:'element'}],windows,mode:'scroll',phase:'selecting',origin:'screen' },
      'overlay-cross-display-small': { ...base, image: '', backdrop:frame.crop({x:0,y:0,width:960,height:680}).toDataURL(),width:960,height:680,candidates:[],windows:[],mode:'rect',phase:'selecting',origin:'screen' },
      'overlay-cross-display-return': { ...base, image: '', backdrop,width:W,height:H,candidates:[],windows:[],mode:'rect',phase:'selecting',origin:'screen' },
      'scroll-running': {...base,image:'',width:W,height:H,pixelWidth:W,pixelHeight:H,phase:'scrolling',scroll:scrolling,origin:'screen'},
      'scroll-paused': {...base,image:'',width:W,height:H,pixelWidth:W,pixelHeight:H,phase:'scrolling',scroll:{...scrolling,status:'paused',message:'匹配不可靠，已暂停并保留结果。请向上回到上次采集位置，再继续慢滚。'},origin:'screen'},
      'scroll-review': {...base,image:long.toDataURL(),width:W,height:H*3,pixelWidth:W,pixelHeight:H*3,phase:'review',scroll:{...scrolling,status:'review',message:'已结束采集。检查接缝后进入编辑；可撤回末段。'},origin:'screen'},
      'editor-region': {...base,image:backdrop,backdrop,placement:sel,width:sel.width,height:sel.height,pixelWidth:sel.width,pixelHeight:sel.height,selection:{x:0,y:0,width:sel.width,height:sel.height},phase:'result',origin:'screen',editableRegion:{display:{id:1,bounds:{x:0,y:0,width:W,height:H},scaleFactor:1,rotation:0},sourceSize:{width:W,height:H},initialCrop:sel,currentCrop:sel,ratio:null}},
      'editor-region-size': {...base,image:backdrop,backdrop,placement:sel,width:sel.width,height:sel.height,pixelWidth:sel.width,pixelHeight:sel.height,selection:{x:0,y:0,width:sel.width,height:sel.height},phase:'result',origin:'screen',editableRegion:{display:{id:1,bounds:{x:0,y:0,width:W,height:H},scaleFactor:1,rotation:0},sourceSize:{width:W,height:H},initialCrop:sel,currentCrop:sel,ratio:null}},
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
    for(const [name,nativePreferences,pointer] of [
      ['overlay-loupe-default',{}],['overlay-loupe-4x',{loupeMagnification:4}],['overlay-loupe-8x',{loupeMagnification:8}],['overlay-loupe-12x',{loupeMagnification:12}],
      ['overlay-loupe-rgb',{loupeColorFormat:'rgb'}],['overlay-loupe-hsl',{loupeColorFormat:'hsl'}],['overlay-crosshair-off',{showCrosshair:false}],
      ['overlay-loupe-rgb-edge',{loupeColorFormat:'rgb'},{x:W-1,y:H-1}],['overlay-loupe-hsl-edge',{loupeColorFormat:'hsl'},{x:W-1,y:H-1}],
      ['overlay-loupe-top-left',{}, {x:1,y:1}],['overlay-loupe-top-right',{}, {x:W-1,y:1}],['overlay-loupe-bottom-left',{}, {x:1,y:H-1}],['overlay-loupe-edge',{}, {x:W-1,y:H-1}]
    ])states[name]={...states['overlay-loupe-retina'],nativePreferences:{showLoupeGrid:false,...nativePreferences},pointer:pointer||states['overlay-loupe-retina'].pointer};
    // Keep the original source-pixel evidence free of grid lines; new cases exercise the default and all grid/crosshair combinations.
    for(const [name,nativePreferences]of [
      ['overlay-loupe-grid-on',{}],['overlay-loupe-grid-off',{showLoupeGrid:false}],
      ['overlay-loupe-grid-4x',{loupeMagnification:4}],['overlay-loupe-grid-8x',{loupeMagnification:8}],['overlay-loupe-grid-12x',{loupeMagnification:12}],
      ['overlay-loupe-grid-crosshair-off',{showCrosshair:false}],['overlay-loupe-grid-off-crosshair-off',{showLoupeGrid:false,showCrosshair:false}]
    ])states[name]={...states['overlay-loupe-retina'],nativePreferences};
    states['editor-region-retina']={...states['editor-region'],image:retinaBackdrop,backdrop:retinaBackdrop,editableRegion:{...states['editor-region'].editableRegion,display:{...states['editor-region'].editableRegion.display,scaleFactor:2},sourceSize:{width:W*2,height:H*2},initialCrop:{x:sel.x*2,y:sel.y*2,width:sel.width*2,height:sel.height*2},currentCrop:{x:sel.x*2,y:sel.y*2,width:sel.width*2,height:sel.height*2}}};
    states['editor-stage-2']={...states['editor-window'],editorShortcuts:{...preferences.editorShortcuts,arrow:'Q',copy:'F16',save:'F17','quick-save':'F18',pin:'F19'},annotationMemory:{...preferences.annotationMemory,lastTool:'arrow',perTool:{arrow:{arrowType:'double',width:8},text:{textBackground:true,fontSize:40},mosaic:{mosaicSize:32},blur:{blurRadius:18}}}};
    states['editor-shared-style']={...states['editor-stage-2'],annotationMemory:{...states['editor-stage-2'].annotationMemory,rememberToolStyles:false}};
    states['scroll-direction']={...states['scroll-running'],scroll:{...scrolling,direction:'auto',reversedTrimmed:120}};
    states['scroll-review-horizontal']={...states['scroll-review'],image:frame.resize({width:W*3,height:H}).toDataURL(),width:W*3,height:H,pixelWidth:W*3,pixelHeight:H,scroll:{...scrolling,status:'review',direction:'horizontal',width:W*3,height:H,seams:[W,W*2],segmentSizes:[W,W,W]}};
    states['scroll-corrections']={...states['scroll-review']};
    for(const kind of ['barcode','translate','table','formula'])states['editor-intelligence-'+kind]={...states['editor-window'],stage6:kind,viewSize:{width:1100,height:800}};
    states['editor-region-marks']={...states['editor-region'],annotations:{crop:sel,nextNumber:1,privacy:[],objects:[
      {type:'Rect',left:430,top:220,width:100,height:60,fill:'transparent',stroke:'#e24a35',strokeWidth:4,lassoTool:'rectangle'},
      {type:'Path',path:[['M',0,0],['L',120,40]],left:600,top:260,fill:'transparent',stroke:'#e24a35',strokeWidth:4,lassoTool:'arrow'},
      {type:'Group',left:700,top:350,width:80,height:60,objects:[{type:'Rect',left:-40,top:-30,width:80,height:60,fill:'#171717',strokeWidth:0}],lassoTool:'number'}
    ]}};
    const layouts=[
      ['bottom',{x:600,y:530,width:900,height:900},W,H],
      ['top-left',{x:0,y:0,width:800,height:500},W,H],
      ['top-right',{x:1760,y:0,width:800,height:500},W,H],
      ['bottom-left',{x:0,y:1100,width:800,height:500},W,H],
      ['bottom-right',{x:1760,y:1100,width:800,height:500},W,H],
      ['large',{x:8,y:8,width:2544,height:1584},W,H],
      ['narrow',{x:40,y:700,width:1400,height:500},760,650]
    ];
    for(const [name,crop,width,height] of layouts){
      const image=frame.resize({width:width*2,height:height*2}).toDataURL();
      states['editor-layout-'+name]={...states['editor-region'],image,backdrop:image,viewSize:{width,height},editableRegion:{display:{id:1,bounds:{x:0,y:0,width,height},scaleFactor:2,rotation:0},sourceSize:{width:width*2,height:height*2},initialCrop:crop,currentCrop:crop,ratio:null}};
    }
    const advancedWidth=640,advancedHeight=400,advancedPixels=Buffer.alloc(advancedWidth*advancedHeight*4);
    for(let y=0;y<advancedHeight;y++)for(let x=0;x<advancedWidth;x++){const rgb=x>=100&&x<260&&y>=80&&y<220?((Math.floor(x/8)+Math.floor(y/8))%2?[100,140,200]:[220,170,100]):x>=340&&x<380&&y>=240&&y<280?[20,20,19]:x>=20&&x<70&&y>=280&&y<340?[20,100,180]:[220,210,190],offset=(y*advancedWidth+x)*4;advancedPixels[offset]=rgb[2];advancedPixels[offset+1]=rgb[1];advancedPixels[offset+2]=rgb[0];advancedPixels[offset+3]=255;}
    const advancedImage=nativeImage.createFromBitmap(advancedPixels,{width:advancedWidth,height:advancedHeight}),advancedSettings=await page(find(),'window.desktop.getState().then(s=>s.settings.screenshot)');
    for(const kind of ['spotlight','magnifier-circle','magnifier-rect','watermark','inpaint','auto-mosaic','transform','crop-freehand','crop-polygon','crop-multi-rect','mouse','toolbar','narrow'])states['editor-advanced-'+kind]={...base,stage9:kind,image:advancedImage.toDataURL(),width:advancedWidth,height:advancedHeight,pixelWidth:advancedWidth,pixelHeight:advancedHeight,selection:{x:0,y:0,width:advancedWidth,height:advancedHeight},phase:'result',origin:'clipboard',viewSize:{width:kind==='narrow'?375:1050,height:740},annotationMemory:{...base.annotationMemory,lastTool:'text-select'},screenshotSettings:{...advancedSettings,selectionShape:'rect',watermarkText:'LASSO',watermarkOpacity:.28},mouseActions:{doubleClick:'save',middleClick:'quick-save',rightClick:'reselect'},...(kind==='toolbar'?{toolbarTools:['text-select','spotlight','image-adjust']}: {})};
    const inlineWidth=1120,inlineHeight=820,inlineCrop={x:930,y:680,width:180,height:100},inlinePixels=Buffer.alloc(inlineWidth*inlineHeight*4);
    for(let y=0;y<inlineHeight;y++)for(let x=0;x<inlineWidth;x++){const i=(y*inlineWidth+x)*4;inlinePixels[i]=40+(x+2*y)%180;inlinePixels[i+1]=40+y%180;inlinePixels[i+2]=40+x%180;inlinePixels[i+3]=255;}
    const inlineImage=nativeImage.createFromBitmap(inlinePixels,{width:inlineWidth,height:inlineHeight}).toDataURL();
    states['editor-advanced-inline-rotation']={...states['editor-advanced-transform'],stage9:'inline-rotation',image:inlineImage,backdrop:inlineImage,width:inlineWidth,height:inlineHeight,pixelWidth:inlineWidth,pixelHeight:inlineHeight,selection:inlineCrop,placement:inlineCrop,presentation:'inline',origin:'screen',viewSize:{width:inlineWidth,height:inlineHeight},editableRegion:{display:{id:1,bounds:{x:0,y:0,width:inlineWidth,height:inlineHeight},scaleFactor:1,rotation:0},sourceSize:{width:inlineWidth,height:inlineHeight},initialCrop:inlineCrop,currentCrop:inlineCrop,ratio:null}};
    const settingsCases=['settings-loupe-grid-off','settings-loupe-grid-on','settings-advanced-capture','settings-advanced-narrow-capture'];
    if(focusedCases.some(name=>!Object.hasOwn(states,name)&&!settingsCases.includes(name)))throw Error('Unknown UI case: '+focusedCases.filter(name=>!Object.hasOwn(states,name)&&!settingsCases.includes(name)).join(', '));
    let state = null, exports = [], regionUpdates=[],exportDelay=0; const memorySaves = [], intelligenceReceipts=[],scrollReceipts=[],clipboardAudits=[],advancedChecks=[],screenshotActions=[];
    const verify=(ok,message)=>{if(!ok)throw Error(message);};
    const record=(method,args)=>intelligenceReceipts.push({method,args});
    const fixtureRequire=process.mainModule.require('node:module').createRequire(path.join(process.cwd(),'package.json'));
    const renderFormula=latex=>{const {mathjax}=fixtureRequire('mathjax-full/js/mathjax.js'),{TeX}=fixtureRequire('mathjax-full/js/input/tex.js'),{SVG}=fixtureRequire('mathjax-full/js/output/svg.js'),{liteAdaptor}=fixtureRequire('mathjax-full/js/adaptors/liteAdaptor.js'),{RegisterHTMLHandler}=fixtureRequire('mathjax-full/js/handlers/html.js'),adaptor=liteAdaptor();fixtureRequire('mathjax-full/js/input/tex/ams/AmsConfiguration.js');RegisterHTMLHandler(adaptor);return adaptor.serializeXML(adaptor.tags(mathjax.document('',{InputJax:new TeX({packages:['base','ams']}),OutputJax:new SVG({fontCache:'none'})}).convert(latex,{display:true}),'svg')[0]);};
    ipcMain.handle('ui-shots:vision-language',()=> '简体中文');
    ipcMain.handle('ui-shots:recognize',(_event,request)=>{const text='示例识别文字',line={x:24,y:40,width:260,height:26,text,confidence:.95,glyphs:[...text].map((text,i)=>({x:24+i*43,y:40,width:42,height:26,text}))};return {id:request.id,revision:request.revision,lines:state.stage9==='auto-mosaic'?[80,150].map((y,i)=>({x:320+i*100,y,width:80,height:24,text:'LASSO',confidence:1,glyphs:[...'LASSO'].map((text,j)=>({x:320+i*100+j*16,y,width:16,height:24,text}))})):[line],...(state.stage6==='barcode'?{barcodes:[{x:60,y:120,width:140,height:140,symbology:'QR',payload:'https://example.invalid/lasso'},{x:240,y:120,width:260,height:80,symbology:'Code128',payload:'LASSO-2026-001'}]}:{})};});
    ipcMain.handle('ui-shots:screenshot-action',(_event,action)=>{screenshotActions.push(action);return {error:null};});
    ipcMain.handle('ui-shots:analyze',(_event,request)=>{verify(request.id&&Number.isInteger(request.revision)&&request.png?.length>24&&Buffer.from(request.png).subarray(1,4).toString()==='PNG'&&request.crop.width>0&&request.crop.height>0,'Intelligence request lost image/owner/crop');record('analyze',{id:request.id,revision:request.revision,kind:request.kind,targetLanguage:request.targetLanguage,pngBytes:request.png.length,crop:request.crop,lines:request.lines});const kind=request.kind;return {error:null,result:kind==='translate'?{kind,blocks:[{original:'Design with clarity',translated:'清晰表达设计',box:{x:24,y:40,width:260,height:26}},{original:'A quiet workspace',translated:'安静的工作空间',box:{x:24,y:90,width:260,height:26}}],sourceText:'Design with clarity\nA quiet workspace',translatedText:'清晰表达设计\n安静的工作空间'}:kind==='table'?{kind,table:[['项目','数量','状态'],['图像翻译','12','完成'],['表格识别','8','复核中']]}:{kind,latex:'E=mc^2',formulaSvg:renderFormula('E=mc^2')}};});
    ipcMain.handle('ui-shots:formula-preview',(_event,request)=>{verify(request.id&&Number.isInteger(request.revision)&&request.latex,'Formula preview lost owner or source');record('previewFormula',request);return {svg:renderFormula(request.latex),error:null};});
    ipcMain.handle('ui-shots:open-url',(_event,request)=>{record('openURL',request);verify(request.url==='https://example.invalid/lasso','Wrong barcode URL');return {error:null};});
    ipcMain.handle('ui-shots:table-export',(_event,rows)=>{record('exportTable',rows);return {path:path.join(out,'fixture-table.xlsx'),error:null};});
    ipcMain.handle('ui-shots:formula-pin',(_event,latex)=>{record('pinFormula',latex);return {error:null};});
    ipcMain.handle('ui-shots:scroll-action',(event,action)=>{scrollReceipts.push(action);const type=typeof action==='string'?action:action.type,scroll={...state.scroll};if(type==='direction')scroll.direction=action.direction;if(type==='remove-segment'){scroll.segmentSizes=[...scroll.segmentSizes];scroll.segmentSizes.splice(action.index,1);scroll.segments--;scroll.seams=scroll.segmentSizes.slice(0,-1).map((_,i)=>scroll.segmentSizes.slice(0,i+1).reduce((a,b)=>a+b,0));}if(type==='adjust-seam'){scroll.segmentSizes=[...scroll.segmentSizes];scroll.segmentSizes[action.index]-=action.delta;scroll.seams=scroll.seams.map((value,index)=>index>=action.index?value-action.delta:value);}const horizontal=scroll.direction==='horizontal';if(['remove-segment','adjust-seam'].includes(type)){const length=scroll.segmentSizes.reduce((a,b)=>a+b,0);scroll[horizontal?'width':'height']=length;state={...state,image:nativeImage.createFromDataURL(state.image).resize({width:scroll.width,height:scroll.height}).toDataURL(),width:scroll.width,height:scroll.height,pixelWidth:scroll.width,pixelHeight:scroll.height};}state={...state,scroll};event.sender.send('ui-shots:changed',{...state,imageFrame:state.image?'fixture-image-'+scrollReceipts.length:undefined});return {error:null};});
    ipcMain.removeHandler('ui-shots:region');ipcMain.handle('ui-shots:region',(_e,r)=>{regionUpdates.push(r);});
    ipcMain.removeHandler('ui-shots:clear-region');ipcMain.handle('ui-shots:clear-region',e=>{const old=state;const w=BrowserWindow.fromWebContents(e.sender);w.webContents.send('ui-shots:changed',{...old,phase:'selecting'});setTimeout(()=>{state={...old,editId:'after-clear',annotations:undefined};w.webContents.send('ui-shots:changed',{...state,imageFrame:'fixture-image',backdropFrame:'fixture-backdrop'});},150);});
    ipcMain.removeHandler('ui-shots:state'); ipcMain.handle('ui-shots:state', () => state);
    ipcMain.removeHandler('ui-shots:export'); ipcMain.handle('ui-shots:export', async (_event, frame, action, format, contentMode) => { exports.push({ frame, action, format, contentMode });if(exportDelay)await wait(exportDelay);return { error: null }; });
    ipcMain.removeHandler('ui-shots:annotation-memory'); ipcMain.handle('ui-shots:annotation-memory', (_event, memory) => { memorySaves.push(memory); });
    ipcMain.removeHandler('ui-shots:pixels');ipcMain.handle('ui-shots:pixels',(_event,id)=>{
      const image=nativeImage.createFromDataURL(id==='fixture-backdrop'?state.backdrop:state.image),size=image.getSize(),data=image.toBitmap();
      for(let i=0;i<data.length;i+=4){const a=data[i+3],b=data[i],r=data[i+2];data[i]=a?Math.min(255,Math.round(r*255/a)):0;data[i+1]=a?Math.min(255,Math.round(data[i+1]*255/a)):0;data[i+2]=a?Math.min(255,Math.round(b*255/a)):0;}
      return {...size,data};
    });
    const native=process.mainModule.require(path.join(process.cwd(),'dist/native/capture-native.node'));
    const fixtureRoot=path.dirname(app.getPath('userData')),nativeAdapter=process.mainModule.require(path.join(fixtureRoot,'stage-9-native.cjs'));
    const legacyNativePath=path.join(fixtureRoot,'stage-9-native-legacy.json');
    fs.writeFileSync(legacyNativePath,JSON.stringify({shortcut:'',selectionEnabled:false,clipboardFallback:false,screenshot:{directory:app.getPath('temp')}}));
    const nativeDefaults=process.mainModule.require(path.join(fixtureRoot,'stage-9-settings.cjs')).readSettings(legacyNativePath).screenshot,nativeChecks=[];
    verify(nativeDefaults.showLoupeGrid===true,'Legacy screenshot configuration without showLoupeGrid must default to grid enabled');
    const persistNativePreferences=async preferences=>{
      await page(find(),`(async()=>{const result=await window.desktop.saveScreenshot(${JSON.stringify(preferences)});if(result.error)throw Error(result.error);})()`);
      const settings=await page(find(),'window.desktop.getState().then(s=>s.settings)');
      const persisted=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'settings.json'),'utf8')).screenshot;
      for(const key of ['includeCursor','showCrosshair','showLoupeGrid','loupeMagnification','loupeColorFormat'])verify(settings.screenshot[key]===preferences[key]&&persisted[key]===preferences[key],'Native preference did not persist: '+key);
      return settings;
    };
    const applyNativePreferences=async preferences=>{
      const settings=await persistNativePreferences(preferences);
      nativeAdapter.updateNativeAppearance(native,settings,settings.screenshot);
      return settings;
    };
    const nativePixel=(image,x,y,logicalWidth=W)=>{const scale=image.width/logicalWidth,i=(Math.floor(y*scale)*image.width+Math.floor(x*scale))*4;return [image.data[i+2],image.data[i+1],image.data[i],image.data[i+3]];};
    const nearRGB=(actual,expected)=>actual[3]===255&&expected.every((value,i)=>Math.abs(actual[i]-value)<=2);
    const inside=(inner,outer)=>inner.width>0&&inner.height>0&&inner.x>=outer.x-.01&&inner.y>=outer.y-.01&&inner.x+inner.width<=outer.x+outer.width+.01&&inner.y+inner.height<=outer.y+outer.height+.01;
    for (const [name, value] of Object.entries(states)) {
      if(focusedCases.length&&!focusedCases.includes(name))continue;
      state = value; exports = [];regionUpdates=[];
      if(name.startsWith('overlay-')){
        const source=nativeImage.createFromDataURL(value.backdrop),size=source.getSize(),frame=native.createFrame({...size,data:source.toBitmap(),logicalWidth:value.width,logicalHeight:value.height});
        const options={fixedSize:value.fixedSize,frameId:frame.id,session:'ui-shots-native',mode:value.mode,windows:value.windows||[],candidates:value.candidates||[],pointer:value.pointer||{x:420,y:240}};
        try {
          const preferences={...nativeDefaults,...value.nativePreferences};
          // Public persistence and the production adapter feed the actual AppKit controls.
          const liveKey=name==='overlay-crosshair-off'?'showCrosshair':name.startsWith('overlay-loupe-grid-')?'showLoupeGrid':null;
          const beforeSettings=liveKey?await persistNativePreferences({...preferences,[liveKey]:!preferences[liveKey]}):null,settings=await applyNativePreferences(preferences);
          native.show(options);await wait(150); // Let AppKit lay out before synchronously restoring the fixture pointer.
          let before;
          if(beforeSettings)nativeAdapter.updateNativeAppearance(native,beforeSettings,beforeSettings.screenshot);
          native.show(options); // No await until snapshot/render: live mouse events must not replace the pointer.
          if(beforeSettings){
            before={snapshot:native.snapshot(),image:native.render()};
            nativeAdapter.updateNativeAppearance(native,settings,settings.screenshot); // Live warmup, no await or show().
          }
          if(name==='overlay-handoff-error'){native.update({session:'ui-shots-native',message:'编辑器未能准备好，请重试或取消'});await wait(150);}
          const sample=native.snapshot(),pixels=native.render(),file=path.join(out,name+'.png');
          fs.writeFileSync(file,nativeImage.createFromBitmap(pixels.data,{width:pixels.width,height:pixels.height}).toPNG());names.push(name);
          const decoded=nativeImage.createFromPath(file),image={...decoded.getSize(),data:decoded.toBitmap()};
          verify(sample.showCrosshair===Number(preferences.showCrosshair)&&sample.showLoupeGrid===Number(preferences.showLoupeGrid)&&sample.loupeMagnification===preferences.loupeMagnification&&sample.loupeColorFormat===preferences.loupeColorFormat,'Production native appearance disagrees with persisted preferences: '+name);
          const evidence={name,preferences:Object.fromEntries(['showCrosshair','showLoupeGrid','loupeMagnification','loupeColorFormat'].map(key=>[key,preferences[key]])),snapshot:sample,layoutWaitMs:150,pointerResetBeforeSample:true,png:{width:image.width,height:image.height}};
          if(name.startsWith('overlay-loupe-')||name==='overlay-crosshair-off'){
            const viewport={x:0,y:0,width:value.width,height:value.height},px=Math.floor(options.pointer.x*size.width/value.width),py=Math.floor(options.pointer.y*size.height/value.height),center={x:sample.loupeCenter.x+sample.loupeCenter.width/2,y:sample.loupeCenter.y+sample.loupeCenter.height/2};
            const sampled=px===401&&py===301,rgb=sampled?[239,205,171]:[18,52,86],expected=preferences.loupeColorFormat==='rgb'?`rgb(${rgb.join(', ')})`:preferences.loupeColorFormat==='hsl'?(sampled?'hsl(30, 68%, 80%)':'hsl(210, 65%, 20%)'):sampled?'#EFCDAB':'#123456';
            verify(sample.color===expected&&sample.position===`X ${px} · Y ${py} px`,'Native loupe sampled/formatted the wrong source pixel: '+name+' '+JSON.stringify(sample));
            verify(inside(sample.loupe,viewport)&&inside(sample.loupePicture,sample.loupe)&&inside(sample.loupeCenter,sample.loupePicture)&&inside(sample.colorBounds,sample.loupe)&&sample.colorTextWidth<=sample.colorBounds.width+.01,'Native loupe content or full color value leaves its panel: '+name);
            verify(sample.loupePicture.width===136&&sample.loupePicture.height===136&&sample.loupeCenter.width===preferences.loupeMagnification&&sample.loupeCenter.height===preferences.loupeMagnification,'Native pixel grid does not use the requested magnification: '+name);
            verify(sample.crosshairVisible===Number(preferences.showCrosshair),'Native crosshair visibility disagrees with preference: '+name);
            verify(sample.loupeGridVisible===Number(preferences.showLoupeGrid),'Native loupe grid visibility disagrees with preference: '+name);
            verify(nearRGB(nativePixel(image,center.x,center.y),rgb),'Saved native PNG lost the loupe center pixel: '+name);
            evidence.grid=[];
            if(px===401&&py===301)for(let y=-2;y<=2;y++)for(let x=-2;x<=2;x++){
              const actual=nativePixel(image,center.x+x*preferences.loupeMagnification,center.y+y*preferences.loupeMagnification),expected=loupeRGB(px+x,py+y);
              verify(nearRGB(actual,expected),'Saved native PNG has the wrong pixel grid at '+name+' '+x+','+y+': '+actual+' expected '+expected);
              evidence.grid.push({source:{x:px+x,y:py+y},actual,expected});
            }
            if(['overlay-loupe-default','overlay-loupe-retina'].includes(name))verify(sample.loupe.width===160&&sample.loupe.height===200,'Legacy default loupe dimensions changed');
            if(liveKey==='showLoupeGrid'){
              const beforePNG=nativeImage.createFromBuffer(nativeImage.createFromBitmap(before.image.data,{width:before.image.width,height:before.image.height}).toPNG()),beforeImage={...beforePNG.getSize(),data:beforePNG.toBitmap()};
              const on=preferences.showLoupeGrid?image:beforeImage,off=preferences.showLoupeGrid?beforeImage:image,grid=sample.loupeGrid,step=sample.loupeGridStep,lineWidth=sample.loupeGridLineWidth,boundaryPixels=[];
              verify(before.snapshot.showLoupeGrid===Number(!preferences.showLoupeGrid)&&before.snapshot.loupeGridVisible===Number(!preferences.showLoupeGrid)&&before.snapshot.crosshairVisible===sample.crosshairVisible&&before.snapshot.color===sample.color,'Live grid warmup changed crosshair/color or did not toggle visibility: '+name);
              const expectedOffset=((136-step)/2)%step;
              verify(grid.x===sample.loupePicture.x&&grid.y===sample.loupePicture.y&&grid.width===136&&grid.height===136&&step===preferences.loupeMagnification&&sample.loupeGridOffset===expectedOffset&&sample.loupeRasterScale===image.width/value.width&&Math.abs(lineWidth*sample.loupeRasterScale-1)<.001,'Native grid does not match source-pixel boundaries or one-raster-pixel stroke: '+name);
              verify(nearRGB(nativePixel(on,center.x,center.y),rgb)&&nearRGB(nativePixel(off,center.x,center.y),rgb),'Grid toggle changed the center source color: '+name);
              const crosshairProbes=[{x:options.pointer.x-60,y:options.pointer.y},...(preferences.showCrosshair?[{x:sample.loupeCenter.x+.25,y:center.y}]:[])];
              const crosshairPixels=crosshairProbes.map(point=>({point,on:nativePixel(on,point.x,point.y),off:nativePixel(off,point.x,point.y)}));
              verify(crosshairPixels.every(pixel=>nearRGB(pixel.on,pixel.off.slice(0,3))),'Grid toggle changed crosshair lines or the center frame PNG: '+name);
              for(const axis of ['x','y'])for(let boundary=sample.loupeGridOffset;boundary<136;boundary+=step){
                if(boundary<20||boundary>116)continue; // Avoid the rounded picture clip; inspect real interior boundaries.
                const point=axis==='x'?{x:grid.x+boundary+lineWidth/2,y:center.y+step*2}:{x:center.x+step*2,y:grid.y+boundary+lineWidth/2};
                const at=nativePixel(on,point.x,point.y),without=nativePixel(off,point.x,point.y);
                verify(at[3]===255&&at.slice(0,3).some((value,i)=>Math.abs(value-without[i])>5),'Saved native PNG lacks a grid boundary: '+name+' '+axis+' '+boundary);
                const adjacent=[-1.5,1.5].map(distance=>{const p={...point,[axis]:point[axis]+distance*lineWidth};return {point:p,on:nativePixel(on,p.x,p.y),off:nativePixel(off,p.x,p.y)};});
                verify(adjacent.every(pixel=>nearRGB(pixel.on,pixel.off.slice(0,3))),'Grid stroke bleeds beyond one raster pixel: '+name+' '+axis+' '+boundary);
                boundaryPixels.push({axis,boundary,point,on:at,off:without,adjacent});
              }
              verify(boundaryPixels.length>=12,'Too few native grid boundaries checked: '+name);
              evidence.gridToggle={from:!preferences.showLoupeGrid,to:preferences.showLoupeGrid,beforeSnapshot:before.snapshot,beforePNGDecoded:true,centerOriginalRGB:rgb,crosshairPixels,boundaryPixels};
              evidence.livePreferenceUpdate='synchronous production warmup(on/off), no await/show before after-snapshot/render';
            }
            if(liveKey==='showCrosshair'){
              const line={x:options.pointer.x-60,y:options.pointer.y},border={x:sample.loupeCenter.x+.25,y:center.y};
              evidence.crosshairPixels=[line,border].map(point=>({point,before:nativePixel(before.image,point.x,point.y),after:nativePixel(image,point.x,point.y)}));
              verify(before.snapshot.crosshairVisible===1&&before.snapshot.loupeGridVisible===sample.loupeGridVisible&&evidence.crosshairPixels.every(pixel=>pixel.before.some((value,i)=>Math.abs(value-pixel.after[i])>5)),'Live crosshair preference did not remove the rendered lines and center frame independently of grid');
              evidence.livePreferenceUpdate='synchronous production warmup(off), no await/show before after-snapshot/render';
            }
          }
          nativeChecks.push(evidence);
          if(name==='overlay-handoff-error'){
            const image=nativeImage.createFromPath(path.join(out,name+'.png')),scale=image.getSize().width/value.width,guide=image.crop({x:Math.round((value.width-600)/2*scale),y:Math.round((value.height-80)*scale),width:Math.round(600*scale),height:Math.round(70*scale)}),vision=process.mainModule.require(path.join(process.cwd(),'dist/native/capture-vision.node'));
            const result=await vision.recognize(guide.toPNG(),9001,'text',false,['zh-Hans','en-US']),lines=result.lines.map(({text,x,y,width,height})=>({text,x,y,width,height})),normalized=lines.map(line=>line.text.replace(/\s/g,''));
            verify(normalized.includes('编辑器未能准备好，请重试或取消')&&normalized.includes('重试')&&normalized.some(text=>/^Esc取消$/i.test(text)),'Native handoff guide is missing error/retry/cancel in rendered PNG: '+normalized.join(' | '));
            const size=guide.getSize();verify(lines.every(line=>line.width>0&&line.height>0&&line.x>=0&&line.y>=0&&line.x+line.width<=size.width+.1&&line.y+line.height<=size.height+.1),'Native handoff guide labels leave the PNG viewport');
            fs.writeFileSync(path.join(out,'overlay-handoff-error.json'),JSON.stringify({status:'passed',waitAfterUpdateMs:150,source:'saved native.render PNG, local Vision OCR of bottom guide',lines,snapshot:native.snapshot(),interaction:'rendered controls verified; physical click acceptance excluded'},null,2));
          }
        } finally {native.hide();native.release(frame.id);await applyNativePreferences(advancedSettings);}
        continue;
      }

      const controls=name.startsWith('scroll-')&&value.phase==='scrolling';
      const w = new BrowserWindow({ x: 40, y: 40, width: value.viewSize?.width??(controls?700:W), height:value.viewSize?.height??(controls?144:H), enableLargerThanScreen: true, frame: false, show: true, backgroundColor: value.origin === 'clipboard' ? '#E9E6DD' : '#222222', webPreferences: { preload: path.join(fixtures, 'screenshot-preload.cjs'), contextIsolation: true, sandbox: true } });
      if (value.viewSize) w.setSize(value.viewSize.width, value.viewSize.height);
      await w.loadFile(path.join(process.cwd(), 'dist/renderer/index.html'), { query: { surface: 'screenshot' } });
      await wait(900);
      if(value.stage9){
        const kind=value.stage9,encoder=process.mainModule.require(path.join(path.dirname(app.getPath('userData')),'stage-9-output.cjs'));let evidence;
        const click=async selector=>{await page(w,`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)throw Error('Unavailable S5 editor control: '+${JSON.stringify(selector)});b.click();})()`);await wait(180);};
        const label=text=>click('[aria-label="'+text+'"]'),choice=async(group,text)=>{await page(w,`[...document.querySelectorAll('[aria-label="${group}"] [role="radio"]')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);await wait(180);};
        const fill=async(label,value)=>{await page(w,`(()=>{const e=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(120);};
        const point=async([x,y])=>page(w,`(()=>{const r=document.querySelector('canvas.upper-canvas').getBoundingClientRect();return {x:Math.round(r.x+${x}/640*r.width),y:Math.round(r.y+${y}/400*r.height)};})()`);
        const gesture=async(points,polygon=false)=>{app.focus({steal:true});w.focus();w.webContents.focus();if(polygon){for(const p of points){const xy=await point(p);await move(w,xy.x,xy.y);for(const type of ['mouseDown','mouseUp'])w.webContents.sendInputEvent({type,button:'left',clickCount:1,...xy});await wait(70);}}else{const first=await point(points[0]);await move(w,first.x,first.y);w.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...first});for(const p of points.slice(1)){w.webContents.sendInputEvent({type:'mouseMove',modifiers:['leftButtonDown'],...await point(p)});await wait(60);}w.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...await point(points.at(-1))});}await wait(220);};
        const output=async()=>{const count=exports.length;await click('.ed-primary');await ready(w,`document.querySelector('.ed')?.getAttribute('aria-busy')==='false'`);verify(exports.length===count+1&&exports.at(-1).action==='copy','S5 output did not export once');const frame=exports.at(-1).frame,image=encoder.decodeFrameImage(frame);verify(Buffer.from(frame.png).subarray(1,4).toString()==='PNG','S5 export did not contain production PNG');return {frame,image,bytes:image.toBitmap(),size:image.getSize()};};
        const pixel=(result,x,y)=>{const i=(Math.floor(y)*result.size.width+Math.floor(x))*4,b=result.bytes;return [b[i+2],b[i+1],b[i],b[i+3]];},source=(x,y)=>{const i=(y*640+x)*4;return [advancedPixels[i+2],advancedPixels[i+1],advancedPixels[i],255];},same=(a,b,tolerance=2)=>a.every((v,i)=>Math.abs(v-b[i])<=tolerance);
        await ready(w,`Boolean(document.querySelector('.ed-primary:not(:disabled)'))`);
        if(kind==='spotlight'){await label('聚光灯 · 框选重点');await gesture([[100,80],[260,220]]);const r=await output();verify(r.frame.annotations.objects.some(o=>o.lassoTool==='spotlight')&&same(pixel(r,180,140),source(180,140))&&pixel(r,500,350)[0]<110,'Spotlight failed highlight/dim PNG pixels');}
        else if(kind.startsWith('magnifier-')){await label('局部放大镜 · 2×');await choice('放大镜形状',kind.endsWith('circle')?'圆形':'矩形');await gesture([[100,80],[260,220]]);const r=await output();verify(r.frame.annotations.objects.some(o=>o.lassoTool==='magnifier'),'Magnifier annotation missing');verify(same(pixel(r,130,150),source(155,150),10),'Magnifier PNG does not sample at 2x');verify(kind.endsWith('circle')?same(pixel(r,102,85),source(102,85)):!same(pixel(r,102,85),source(102,85)),'Magnifier circle/rectangle clip pixels differ');if(kind.endsWith('circle'))verify(same(pixel(r,103,150),source(103,150)),'Non-square magnifier drag produced an ellipse instead of a circle');}
        else if(kind==='watermark'){await label('平铺水印');await page(w,`[...document.querySelectorAll('.ed-panel button')].find(b=>b.textContent==='添加平铺水印').click()`);await wait(180);const r=await output();let changed=0;for(let i=0;i<r.bytes.length;i+=4)if(Math.abs(r.bytes[i]-advancedPixels[i])>3||Math.abs(r.bytes[i+1]-advancedPixels[i+1])>3||Math.abs(r.bytes[i+2]-advancedPixels[i+2])>3)changed++;verify(r.frame.annotations.objects.some(o=>o.lassoTool==='watermark')&&changed>1000,'Tiled watermark did not affect PNG');}
        else if(kind==='inpaint'){await label('智能消除 · 框选后以周围像素填补');await gesture([[335,235],[385,285]]);const r=await output();verify(r.frame.annotations.privacy.length===1&&same(pixel(r,360,260),source(500,350),3),'Inpaint PNG did not interpolate surrounding pixels');}
        else if(kind==='auto-mosaic'){
          await ready(w,`document.querySelectorAll('.editor-text-line').length===2`);await label('联动遮挡相同文字');await fill('联动遮挡词条','LASSO');await page(w,`[...document.querySelectorAll('.ed-panel button')].find(b=>b.textContent==='联动遮挡相同文字').click()`);await wait(180);const r=await output(),expected=[{x:320,y:80,width:80,height:24},{x:420,y:150,width:80,height:24}],privacy=r.frame.annotations.privacy;
          verify(privacy.length===expected.length&&expected.every((box,i)=>Object.entries(box).every(([key,value])=>privacy[i][key]===value)),'Repeated OCR mask privacy bounds shifted from glyph coordinates: '+JSON.stringify(privacy));
          for(const box of expected){for(let y=box.y;y<box.y+box.height;y++)for(let x=box.x;x<box.x+box.width;x++)verify(same(pixel(r,x,y),[20,20,19,255],0),'Repeated OCR mask missed PNG pixel '+x+','+y);for(const [x,y]of [[box.x+box.width,box.y+12],[box.x+40,box.y+box.height]])verify(same(pixel(r,x,y),source(x,y)),'Repeated OCR mask extended past the right/bottom edge');}
          evidence={expected,privacy,coverage:'every word pixel including final column/row, plus unchanged pixels immediately outside right/bottom edges'};
        }
        else if(kind==='inline-rotation'){
          const layouts=[],sourcePixel=(x,y)=>{const i=(y*inlineWidth+x)*4;return [inlinePixels[i+2],inlinePixels[i+1],inlinePixels[i],255];};
          const check=async(crop,expectedRect)=>{await label('图像调整');await label('旋转90°');const result=await output(),rect=await page(w,`(()=>{const r=document.querySelector('.cap-rect.ed-hole').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,viewport:{width:innerWidth,height:innerHeight}};})()`);verify(rect.viewport.width===inlineWidth&&rect.viewport.height===inlineHeight&&rect.x>=0&&rect.y>=0&&rect.right<=rect.viewport.width+.01&&rect.bottom<=rect.viewport.height+.01,'Rotated inline preview leaves viewport: '+JSON.stringify(rect));verify(Object.entries(expectedRect).every(([key,value])=>Math.abs(rect[key]-value)<.6),'Rotated inline preview geometry differs: '+JSON.stringify(rect));verify(result.size.width===crop.height&&result.size.height===crop.width&&Object.entries(crop).every(([key,value])=>result.frame.crop[key]===value),'Inline preview fit changed exported dimensions/crop');
            const samples=[[0,0],[crop.width-1,0],[0,crop.height-1],[crop.width-1,crop.height-1],[30,20]];for(const [x,y]of samples)verify(same(pixel(result,crop.height-1-y,x),sourcePixel(crop.x+x,crop.y+y)),'Inline preview fit resampled rotated export at '+x+','+y);layouts.push({crop,preview:rect,outputSize:result.size,samples});};
          await check(inlineCrop,{x:930,y:640,width:100,height:180});names.push(await save(w,'editor-advanced-inline-rotation-edge'));
          const full={x:0,y:0,width:inlineWidth,height:inlineHeight};state={...state,editId:'ui-shots-inline-full',selection:full,placement:full,editableRegion:{...state.editableRegion,initialCrop:full,currentCrop:full}};w.webContents.send('ui-shots:changed',{...state,imageFrame:'fixture-image',backdropFrame:'fixture-backdrop'});await ready(w,`document.querySelector('.ed-primary:not(:disabled)')&&document.querySelector('[aria-label="图像调整"]')?.getAttribute('aria-pressed')==='false'`);await check(full,{x:0,y:0,width:inlineHeight*inlineHeight/inlineWidth,height:inlineHeight});evidence=layouts;
        }
        else if(kind==='transform'){
          await label('图像调整');const initial=await output();await label('旋转90°');let r=await output();verify(r.size.width===400&&r.size.height===640&&same(pixel(r,399-300,40),pixel(initial,40,300)),'Rotation PNG dimensions/pixels mismatch');names.push(await save(w,'editor-advanced-rotation'));
          await label('水平翻转');r=await output();verify(r.frame.annotations.effects.flipX&&same(pixel(r,399-300,639-40),pixel(initial,40,300)),'Horizontal flip PNG pixels mismatch');names.push(await save(w,'editor-advanced-flip-horizontal'));
          await label('垂直翻转');r=await output();verify(r.frame.annotations.effects.flipY&&same(pixel(r,300,639-40),pixel(initial,40,300)),'Vertical flip PNG pixels mismatch');names.push(await save(w,'editor-advanced-flip-vertical'));
          await label('灰度');const gray=await output(),p=pixel(gray,300,599);verify(Math.max(...p.slice(0,3))-Math.min(...p.slice(0,3))<=1&&gray.frame.annotations.effects.grayscale,'Grayscale PNG channels mismatch');names.push(await save(w,'editor-advanced-grayscale'));await fill('亮度',130);r=await output();verify(r.frame.annotations.effects.brightness===130&&pixel(r,300,599)[0]>p[0]+8,'Brightness did not affect PNG');
          const decorated=encoder.encodeScreenshot(initial.image,{...advancedSettings,background:'transparent',cornerRadius:24,borderWidth:6,borderColor:'#bd7658'},'png'),image=nativeImage.createFromBuffer(decorated),d={image,size:image.getSize(),bytes:image.toBitmap()};verify(pixel(d,0,0)[3]===0&&same(pixel(d,320,1),[189,118,88,255])&&same(pixel(d,500,350),pixel(initial,500,350)),'Production PNG decoration lost corner/border/interior pixels');fs.writeFileSync(path.join(out,'editor-advanced-decoration-export.png'),decorated);names.push('editor-advanced-decoration-export');
        }
        else if(kind.startsWith('crop-')){await label('裁剪 · 可撤销');await choice('裁剪形状',kind==='crop-freehand'?'自由':kind==='crop-polygon'?'多边形':'多矩形');if(kind==='crop-multi-rect'){await gesture([[50,50],[180,150]]);await gesture([[340,220],[500,340]]);}else{await gesture([[80,50],[280,50],[80,250]],kind==='crop-polygon');if(kind==='crop-polygon')await page(w,`[...document.querySelectorAll('.ed-panel button')].find(b=>b.textContent==='闭合选区 ↵').click()`);}await wait(150);const r=await output(),polygons=r.frame.annotations.cropPolygons;verify(polygons.length===(kind==='crop-multi-rect'?2:1)&&r.size.width<640&&r.size.height<400,'Masked crop did not export path/size');verify(kind==='crop-multi-rect'?pixel(r,250-r.frame.crop.x,180-r.frame.crop.y)[3]===0:pixel(r,r.size.width-5,r.size.height-5)[3]===0,'Masked crop PNG did not preserve transparent excluded area');verify(pixel(r,20,20)[3]===255,'Masked crop removed included pixels');}
        else if(kind==='mouse'){
          for(const [field,type,button,actions]of [['doubleClick','dblclick',0,['copy','save','pin','none']],['middleClick','auxclick',1,['pin','quick-save','none']],['rightClick','contextmenu',2,['reselect','cancel']]])for(const action of actions){state={...state,mouseActions:{...state.mouseActions,[field]:action}};w.webContents.send('ui-shots:changed',{...state,imageFrame:'fixture-image'});await wait(100);const count=exports.length,commands=screenshotActions.length;await page(w,`document.querySelector('.ed-viewport').dispatchEvent(new MouseEvent('${type}',{bubbles:true,button:${button}}))`);await ready(w,`document.querySelector('.ed')?.getAttribute('aria-busy')==='false'`);await wait(80);verify(field==='rightClick'?screenshotActions.length===commands+1&&screenshotActions.at(-1)===action:action==='none'?exports.length===count:exports.length===count+1&&exports.at(-1).action===action,'Configured editor mouse action failed: '+field+'/'+action);}
        }
        else if(kind==='toolbar'){verify(await page(w,`document.querySelector('[aria-label="聚光灯 · 框选重点"]')&&document.querySelector('[aria-label="图像调整"]')&&!document.querySelector('[aria-label="画笔"]')&&!document.querySelector('[aria-label="局部放大镜 · 2×"]')`),'Toolbar filter did not hide unchecked tools');await label('聚光灯 · 框选重点');await gesture([[100,80],[260,220]]);verify((await output()).frame.annotations.objects.length===1,'Filtered toolbar tool did not remain usable');}
        else if(kind==='narrow'){await label('局部放大镜 · 2×');await choice('放大镜形状','矩形');const layout=await page(w,`(()=>{const p=document.querySelector('.ed-primary'),r=p.getBoundingClientRect();return {visible:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&Boolean(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.ed-primary')),overflow:document.documentElement.scrollWidth>innerWidth};})()`);verify(layout.visible&&!layout.overflow,'375px advanced editor output is clipped or covered');}
        advancedChecks.push({kind,status:'passed',outputs:exports.length,...(evidence?{evidence}:{})});names.push(await save(w,name+(kind==='inline-rotation'?'-oversized':'')));w.destroy();continue;
      }
      if(name==='scroll-direction'||name==='scroll-corrections'||name==='scroll-review-horizontal'){
        const click=async label=>{await page(w,`document.querySelector('[aria-label="${label}"]').click()`);await wait(200);};
        if(name==='scroll-direction'){
          verify(await page(w,`document.querySelector('.scroll-trimmed')?.textContent.includes('120px')`),'Reverse trim status missing');
          for(const [label,direction]of [['纵向','vertical'],['横向','horizontal'],['自动','auto']]){await page(w,`[...document.querySelectorAll('[aria-label="滚动方向"] button')].find(b=>b.textContent==='${label}').click()`);await wait(200);verify(scrollReceipts.at(-1)?.direction===direction&&state.scroll.direction===direction,'Scroll direction did not reach bridge');if(direction!=='auto')names.push(await save(w,'scroll-direction-'+direction));}
        }else{
          await click('选择分段 2');names.push(await save(w,name+'-segment'));
          if(name==='scroll-corrections'){await click('删除所选分段');verify(state.scroll.segments===2&&state.scroll.height===H*2&&scrollReceipts.at(-1)?.index===1,'Middle segment deletion did not refresh review');names.push(await save(w,'scroll-segment-removed'));}
          await click('选择接缝 1');const axis=state.scroll.direction==='horizontal'?'width':'height',before=state.scroll[axis];
          for(const delta of name==='scroll-corrections'?[-5,-1,1,5]:[5]){const size=state.scroll[axis];await click('接缝微调 '+(delta>0?'+':'')+delta+'px');verify(scrollReceipts.at(-1)?.delta===delta&&state.scroll[axis]===size-delta,'Seam adjustment did not refresh image size');}
          verify(state.scroll[axis]===before-(name==='scroll-corrections'?0:5),'Seam size sum differs');
        }
      }
      if(value.stage6){
        const click=async text=>{await page(w,`(()=>{const b=[...document.querySelectorAll('.ed-intelligence button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Unavailable intelligence action: '+${JSON.stringify(text)});b.click();})()`);await wait(180);};
        const fill=async(label,text)=>{
          app.focus({steal:true});w.show();w.focus();w.webContents.focus();await wait(100);
          const point=await page(w,`(()=>{const e=document.querySelector('[aria-label="${label}"]');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
          for(const type of ['mouseDown','mouseUp'])w.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});await wait(100);
          await page(w,`(()=>{const e=document.querySelector('[aria-label="${label}"]');e.focus();Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(180);
        };
        const copied=text=>global.uiShots.stage4.state.receipts.some(r=>r.method==='editorText'&&r.args[0]==='copy'&&r.args[1].text===text);
        const label=value.stage6==='barcode'?'条码结果':{translate:'翻译',table:'表格',formula:'公式'}[value.stage6];
        await ready(w,`Boolean(document.querySelector('button[aria-label="${label}"]:not(:disabled)'))`);await page(w,`document.querySelector('button[aria-label="${label}"]').click()`);
        await ready(w,`document.querySelector('[aria-label="智能处理"]')?.getAttribute('aria-busy')==='false'`);
        await ready(w, `(()=>{const panel=document.querySelector('[aria-label="智能处理"]'),style=getComputedStyle(panel);return Number(style.opacity)===1&&new DOMMatrixReadOnly(style.transform).isIdentity&&!panel.getAnimations().some(animation=>animation.playState==='running');})()`);
        if(value.stage6==='barcode'){
          verify(await page(w,`document.querySelectorAll('.ed-barcode-list article').length===2&&document.querySelector('.ed-barcode-list').textContent.includes('Code128')`),'Barcode payload or symbology missing');await click('复制内容');verify(copied('https://example.invalid/lasso'),'Barcode copy lost payload');await click('打开链接');verify(intelligenceReceipts.at(-1)?.args.url==='https://example.invalid/lasso','URL was not sent through bridge');
          await page(w,`document.querySelectorAll('.ed-barcode-list article')[1].querySelector('button').click()`);await wait(120);verify(copied('LASSO-2026-001'),'Linear barcode copy lost payload');verify(await page(w,`document.querySelectorAll('.ed-barcode-list article')[1].querySelectorAll('button').length===1`),'Non-URL barcode offered open link');
        }else if(value.stage6==='translate'){
          await ready(w,`document.querySelectorAll('.ed-translation-list article').length===2`);names.push(await save(w,'editor-translation-comparison'));
          for(const [label,target]of [['英文','English'],['日文','日本語'],['韩文','한국어'],['中文','简体中文']]){await page(w,`[...document.querySelectorAll('[aria-label="翻译目标语言"] button')].find(b=>b.textContent==='${label}').click()`);await wait(250);await ready(w,`document.querySelector('[aria-label="智能处理"]').getAttribute('aria-busy')==='false'`);verify(intelligenceReceipts.filter(r=>r.method==='analyze').at(-1)?.args.targetLanguage===target,'Translation target language lost');}
          await page(w,`document.querySelector('[aria-label="图上译文覆盖"]').click()`);await wait(180);verify(await page(w,`document.querySelector('[aria-label="图上译文"]')?.textContent.includes('清晰表达设计')`),'Translation overlay did not appear');await click('复制全部译文');verify(copied('清晰表达设计\n安静的工作空间'),'Translation copy lost content');
        }else if(value.stage6==='table'){
          await ready(w,`document.querySelectorAll('[aria-label="识别表格"] tr').length===3`);await fill('第 2 行第 2 列','20');names.push(await save(w,'editor-table-edited'));await click('添加行');await click('添加列');await fill('第 4 行第 4 列','临时');verify(await page(w,`document.querySelectorAll('[aria-label="识别表格"] tr').length===4&&document.querySelectorAll('[aria-label="识别表格"] tr:first-child td').length===4`),'Table row/column addition failed');names.push(await save(w,'editor-table-expanded'));await click('删除所选行');await click('删除所选列');await click('复制 Markdown');await click('复制 TSV');await click('导出 XLSX');const rows=[['项目','数量','状态'],['图像翻译','20','完成'],['表格识别','8','复核中']];verify(JSON.stringify(intelligenceReceipts.find(r=>r.method==='exportTable')?.args)===JSON.stringify(rows),'Edited table export differs');verify(copied(rows.map(row=>row.join('\t')).join('\n'))&&copied('| 项目 | 数量 | 状态 |\n| --- | --- | --- |\n| 图像翻译 | 20 | 完成 |\n| 表格识别 | 8 | 复核中 |'),'Table text export differs');
        }else{
          await ready(w,`document.querySelector('[alt="公式排版"]')?.naturalWidth>0`);names.push(await save(w,'editor-formula-initial'));const latex='\\frac{a+b}{2}=c';await fill('LaTeX 源码',latex);await ready(w,`document.querySelector('[alt="公式排版"]')?.naturalWidth>0&&document.querySelector('[aria-label="智能处理"] [aria-label="LaTeX 源码"]').value===${JSON.stringify(latex)}`);verify(intelligenceReceipts.some(r=>r.method==='previewFormula'&&r.args.latex===latex),'Edited formula did not request preview');await click('复制 LaTeX');await click('转为公式贴图');verify(copied(latex)&&intelligenceReceipts.some(r=>r.method==='pinFormula'&&r.args===latex),'Formula copy/pin lost edited LaTeX');
        }
        const audit=await page(w,'window.__uiShotsClipboard');verify(audit&&audit.systemReads===0&&audit.systemWrites===0,'Intelligence renderer clipboard isolation missing');clipboardAudits.push({name,...audit});
        const layout=await page(w,`(()=>{const p=document.querySelector('[aria-label="智能处理"]'),r=p.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,overflow:document.documentElement.scrollWidth>innerWidth};})()`);verify(layout.x>=0&&layout.y>=0&&layout.right<=1100&&layout.bottom<=800&&!layout.overflow,'Intelligence panel left viewport: '+JSON.stringify(layout));
      }
      if (name === 'scroll-review') {await page(w,`document.querySelector('.scroll-seams button')?.click()`);await wait(300);}
      // The editor enables its tools once the image has loaded; then pick the arrow so the style panel shows.
      if (name === 'editor-transparent' && await page(w, `document.querySelector('canvas.lower-canvas').getContext('2d').getImageData(0,0,1,1).data[3]`) !== 0) throw Error('Transparent image was flattened in editor');
      if (name === 'editor-capture-window' && await page(w, `Boolean(document.querySelector('.editor-crop'))`)) throw Error('Capture result unexpectedly shows crop handles');
      if (name === 'editor-crop-active') { await page(w, `document.querySelector('.ed-tool[data-tip^="裁剪"]').click()`); await wait(250); if (!await page(w, `Boolean(document.querySelector('.editor-crop'))`)) throw Error('Crop tool did not show handles'); }
      if(name==='editor-region'){
        const regionRect=()=>page(w,`(()=>{const r=document.querySelector('.region-border').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);
        const before=await regionRect();
        w.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});w.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await wait(150);
        let r=await regionRect();if(r.x!==before.x+1||r.width!==before.width)throw Error('Region 1px nudge failed');
        w.webContents.sendInputEvent({type:'keyDown',keyCode:'z',modifiers:['meta']});w.webContents.sendInputEvent({type:'keyUp',keyCode:'z',modifiers:['meta']});await wait(150);
        r=await regionRect();if(r.x!==before.x)throw Error('Region undo failed');
        const handle=await center(w,'.region-border [data-region-handle="w"]');
        await move(w,...handle);
        w.webContents.sendInputEvent({type:'mouseDown',x:Math.round(handle[0]),y:Math.round(handle[1]),button:'left',clickCount:1});await wait(80);
        w.webContents.sendInputEvent({type:'mouseMove',x:Math.round(handle[0]-70),y:Math.round(handle[1]),modifiers:['leftButtonDown']});await wait(80);
        w.webContents.sendInputEvent({type:'mouseUp',x:Math.round(handle[0]-70),y:Math.round(handle[1]),button:'left',clickCount:1});await wait(200);
        r=await regionRect();if(r.x!==before.x-70||r.width!==before.width+70)throw Error('Outward region resize failed: '+JSON.stringify({before,r}));
        await page(w,`document.querySelector('[aria-label="用于生图"]').click()`);for(let i=0;i<30&&!exports.length;i++)await wait(100);
        if(exports.length!==1||exports[0].frame.crop.width!==before.width+70||exports[0].frame.crop.x!==before.x-70)throw Error('Expanded region output differs from geometry '+JSON.stringify({before,r,exports:exports.map(o=>({action:o.action,crop:o.frame.crop})),toast:await page(w,`document.querySelector('.ed-toast')?.textContent`)}));
        fs.writeFileSync(path.join(out,'region-interactions.json'),JSON.stringify({nudge:true,undo:true,outwardResize:true,outputCrop:exports[0].frame.crop},null,2));
      }
      if(name==='editor-region-size'){
        const result={};
        const query=script=>page(w,script);
        const rect=()=>query(`(()=>{const r=document.querySelector('.region-border').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);
        const click=async selector=>{await query(`document.querySelector(${JSON.stringify(selector)}).click()`);await wait(150);};
        const press=async(key,modifiers=[])=>{w.webContents.sendInputEvent({type:'keyDown',keyCode:key,modifiers});w.webContents.sendInputEvent({type:'keyUp',keyCode:key,modifiers});await wait(150);};
        const setInput=async(selector,text)=>{app.focus({steal:true});w.focus();w.webContents.focus();await wait(80);await query(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();el.select();})()`);await w.webContents.insertText(String(text));await wait(100);};
        const dims=()=>query(`Array.from(document.querySelectorAll('[aria-label="选区宽度"],[aria-label="选区高度"]')).map(e=>Number(e.value))`);
        const expect=(ok,text)=>{if(!ok)throw Error(text);};
        await click('[aria-label="设置选区尺寸"]');
        await click('[aria-label="选区比例"] [role="radio"]:nth-child(2)');
        let d=await dims();expect(d[0]===520&&d[1]===520,'Ratio did not synchronize inputs: '+JSON.stringify(d));
        await setInput('[aria-label="自定义比例"]','1:2');
        await query(`Array.from(document.querySelectorAll('.region-panel button')).find(b=>b.textContent==='应用比例').click()`);await wait(150);
        d=await dims();const fitted=await rect();expect(d[0]===315&&d[1]===630&&fitted.y+fitted.height===800,'Ratio did not fit screen bottom: '+JSON.stringify({d,fitted}));
        await query(`Array.from(document.querySelectorAll('.region-panel button')).find(b=>b.textContent==='恢复选区').click()`);await wait(150);
        expect(await query(`document.querySelector('[aria-label="锁定当前宽高比"]').getAttribute('aria-pressed')`)==='false','Restore did not restore initial ratio');
        await click('[aria-label="设置选区尺寸"]');await click('[aria-label="选区比例"] [role="radio"]:nth-child(2)');
        await setInput('[aria-label="选区宽度"]','480');await query(`document.querySelector('[aria-label="选区宽度"]').blur()`);await wait(150);
        d=await dims();expect(d[0]===480&&d[1]===480,'Locked input pair differs: '+JSON.stringify(d));
        const focused=await rect();const updates=regionUpdates.length;
        await query(`document.querySelector('[aria-label="选区宽度"]').focus()`);await press('Right');
        expect(JSON.stringify(await rect())===JSON.stringify(focused)&&regionUpdates.length===updates,'Input arrow changed region');
        await setInput('[aria-label="选区高度"]','333');await press('Escape');
        expect(!await query(`Boolean(document.querySelector('.region-panel'))`),'Escape did not close dimensions');
        await click('[aria-label="设置选区尺寸"]');d=await dims();expect(d[0]===480&&d[1]===480,'Escape applied uncommitted input: '+JSON.stringify(d));
        result.ratioInputEscape=true;
        names.push(await save(w,'region-dimensions-verified'));
        await press('Escape');
        await query(`document.querySelector('[aria-label="锁定当前宽高比"]').click()`);await wait(150);
        const before=await rect(),commits=regionUpdates.length;
        for(let i=0;i<3;i++){w.webContents.sendInputEvent({type:'keyDown',keyCode:'Right',isAutoRepeat:i>0});await wait(50);}
        expect(regionUpdates.length===commits,'Key repeats committed before keyup');
        expect((await rect()).x===before.x+3,'Repeat preview failed');
        w.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await wait(150);
        expect(regionUpdates.length===commits+1,'Keyboard gesture did not commit once');
        await press('z',['meta']);expect(JSON.stringify(await rect())===JSON.stringify(before),'Keyboard repeats were not one undo');
        await press('Right',['shift']);expect((await rect()).width===before.width-1,'Shift shrink failed');
        await press('Right',['meta']);expect((await rect()).width===before.width,'Command expansion failed');
        result.keyboardBatchAndUndo=true;
        const drag=async(dx,dy,{cancel=false,alt=false}={})=>{
          const r=await rect(),x=r.x+r.width/2,y=r.y+r.height/2;
          await move(w,x,y);app.focus({steal:true});w.focus();w.webContents.focus();
          if(alt){w.webContents.sendInputEvent({type:'keyDown',keyCode:'Alt',modifiers:['alt']});await wait(80);}
          w.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1,modifiers:alt?['alt']:[]});await wait(80);
          w.webContents.sendInputEvent({type:'mouseMove',x:x+dx,y:y+dy,modifiers:alt?['leftButtonDown','alt']:['leftButtonDown']});await wait(100);
          if(cancel)await press('Escape');
          w.webContents.sendInputEvent({type:'mouseUp',x:x+dx,y:y+dy,button:'left',clickCount:1,modifiers:alt?['alt']:[]});await wait(150);
          if(alt){w.webContents.sendInputEvent({type:'keyUp',keyCode:'Alt'});await wait(80);}
          return {before:r,after:await rect()};
        };
        const moved=await drag(20,10,{alt:true});expect(moved.after.x===moved.before.x+20&&moved.after.y===moved.before.y+10,'Option move failed '+JSON.stringify(moved));
        expect(await query(`document.querySelector('[aria-label^="选字"]').getAttribute('aria-pressed')`)==='true','Option changed active tool');
        await press('c');const canceled=await drag(30,15,{cancel:true});expect(JSON.stringify(canceled.after)===JSON.stringify(canceled.before),'Escape failed to roll back drag');
        result.optionAndGestureCancel=true;
        await click('[aria-label="设置选区尺寸"]');
        await query(`document.querySelector('[aria-label="选区比例"] [role="radio"]:nth-child(2)').click()`);await wait(100);
        await click('[aria-label="关闭尺寸面板"]');await press('o');
        names.push(await save(w,'region-moved-verified'));
        await query(`document.querySelector('.ed').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);await wait(1000);
        expect(await query(`Boolean(document.querySelector('.region-border'))`),'Same-frame reselect failed');
        expect(await query(`document.querySelector('canvas.lower-canvas').width`)===1280,'Cached source was cleared when editor disposed');
        result.sameFrameReselect=true;
        exportDelay=700;await click('[aria-label="用于生图"]');
        expect(await query(`document.querySelector('.region-size').inert`),'Output did not make dimensions inert');
        const frozen=await rect();await press('Right');expect(JSON.stringify(await rect())===JSON.stringify(frozen),'Output allowed geometry mutation');
        for(let i=0;i<100&&await query(`document.querySelector('.ed').getAttribute('aria-busy')==='true'`);i++)await wait(50);
        expect(await query(`document.querySelector('.ed').getAttribute('aria-busy')==='false'`),'Output did not finish');exportDelay=0;result.outputBusy=true;
        exports=[];await click('[aria-label="设置选区尺寸"]');
        await query(`document.querySelector('[aria-label="选区宽度"]').focus()`);await press('Return');
        expect(exports.length===0,'Dimension Enter triggered output');await press('Escape');
        app.focus({steal:true});w.focus();w.webContents.focus();await press('Return');for(let i=0;i<100&&!exports.length;i++)await wait(50);
        expect(exports.length===1&&exports[0].action==='copy','Enter did not copy current region once: '+JSON.stringify({exports:exports.map(e=>e.action),ui:await query(`({busy:document.querySelector('.ed').getAttribute('aria-busy'),focus:document.activeElement?.tagName,error:document.querySelector('.ed-toast')?.textContent})`)}));
        for(let i=0;i<100&&await query(`document.querySelector('.ed').getAttribute('aria-busy')==='true'`);i++)await wait(50);
        exports=[];const copyBox=await rect(),cx=copyBox.x+copyBox.width*.8,cy=copyBox.y+copyBox.height*.8;
        await move(w,cx,cy);w.webContents.sendInputEvent({type:'mouseDown',x:cx,y:cy,button:'left',clickCount:2});w.webContents.sendInputEvent({type:'mouseUp',x:cx,y:cy,button:'left',clickCount:2});
        for(let i=0;i<100&&!exports.length;i++)await wait(50);
        expect(exports.length===1&&exports[0].action==='copy','Double click did not copy current region once');result.enterAndDoubleClick=true;


        fs.writeFileSync(path.join(out,'interaction-verification.json'),JSON.stringify(result,null,2));
      }
      if (name === 'editor-inline') { await wait(800); await page(w, `document.querySelector('[aria-label="箭头"]')?.click()`); await wait(500); }
      if (name === 'editor-stage-2') {
        const checks = [], previewChecks = [], expect = (ok, message) => { if (!ok) throw Error(message); };
        const click = async selector => { await page(w, `document.querySelector(${JSON.stringify(selector)}).click()`); await wait(220); };
        const choice = async (label, text) => { await page(w, `Array.from(document.querySelectorAll('[aria-label="${label}"] [role="radio"]')).find(b=>b.textContent===${JSON.stringify(text)}).click()`); await wait(160); };
        const range = async (label, value) => { await page(w, `(()=>{const e=document.querySelector('input[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'${value}');e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await wait(180); };
        const press = async keyCode => { w.webContents.sendInputEvent({type:'keyDown',keyCode});w.webContents.sendInputEvent({type:'keyUp',keyCode});await wait(180); };
        const output = async action => { const count=exports.length;await click(action==='pin'?'[aria-label="贴图"]':'[aria-label="保存"]');await global.uiShots.ready(w, `document.querySelector('.ed').getAttribute('aria-busy')==='false'`);expect(exports.length===count+1,'Editor did not export once');return exports.at(-1); };
        const drag = async (tool, region) => {
          const [x,y,width,height]=region, points=await page(w, `(()=>{const r=document.querySelector('canvas.upper-canvas').getBoundingClientRect();return [r.x+${x}/1280*r.width,r.y+${y}/800*r.height,r.x+${x+width}/1280*r.width,r.y+${y+height}/800*r.height];})()`);
          await move(w,points[0],points[1]);w.webContents.sendInputEvent({type:'mouseDown',x:Math.round(points[0]),y:Math.round(points[1]),button:'left',clickCount:1});
          w.webContents.sendInputEvent({type:'mouseMove',x:Math.round(points[2]),y:Math.round(points[3]),modifiers:['leftButtonDown']});await wait(180);
          const pixels=`(()=>{const c=document.createElement('canvas');c.width=1280;c.height=800;const ctx=c.getContext('2d');for(const s of ['.editor-source','canvas.lower-canvas','canvas.upper-canvas'])ctx.drawImage(document.querySelector(s),0,0);return ctx.getImageData(${x-20},${y-20},${width+40},${height+40}).data;})()`;
          await page(w, `window.__stage2Preview=${pixels}`);names.push(await save(w, 'editor-'+tool+'-preview'));
          w.webContents.sendInputEvent({type:'mouseUp',x:Math.round(points[2]),y:Math.round(points[3]),button:'left',clickCount:1});await wait(200);
          const difference=await page(w, `(()=>{const after=${pixels};let delta=0;for(let i=0;i<after.length;i++)delta+=Math.abs(after[i]-window.__stage2Preview[i]);delete window.__stage2Preview;return delta/after.length;})()`);
          expect(difference < (tool==='arrow'?4:0.5),tool+' preview differs from committed pixels: '+difference);previewChecks.push({tool,meanChannelDifference:difference});names.push(await save(w, 'editor-'+tool+'-committed'));
        };
        app.focus({steal:true});w.focus();w.webContents.focus();
        expect(await page(w, `document.querySelector('[aria-label="箭头"]').getAttribute('aria-pressed')==='true' && document.querySelector('[aria-label="箭头样式"] [aria-checked="true"]').textContent==='双向' && document.querySelector('[aria-label="线条粗细"]').value==='8'`), 'Arrow memory was not restored');
        await drag('arrow',[220,170,300,100]);const initialOutput=await output('pin'),arrow=initialOutput.frame.annotations.objects.find(o=>o.lassoTool==='arrow');expect(arrow?.path.length===8,'Double arrow did not commit both arrowheads');expect(initialOutput.contentMode===undefined,'Default export did not defer to screenshot settings');
        await range('线条粗细',10);await click('[aria-label="矩形"]');await press('q');expect(await page(w, `document.querySelector('[aria-label="线条粗细"]').value==='10'`), 'Configured tool key did not restore per-tool style');
        await click('[aria-label="文字 · 点击添加"]');expect(await page(w, `document.querySelector('[aria-label="文字背景衬底"]').getAttribute('aria-checked')==='true'`), 'Text background memory did not restore');
        const point=await page(w, `(()=>{const r=document.querySelector('canvas.upper-canvas').getBoundingClientRect();return [Math.round(r.x+r.width*.25),Math.round(r.y+r.height*.45)];})()`);
        w.webContents.sendInputEvent({type:'mouseDown',x:point[0],y:point[1],button:'left',clickCount:1});w.webContents.sendInputEvent({type:'mouseUp',x:point[0],y:point[1],button:'left',clickCount:1});await wait(150);await w.webContents.insertText('文字背景');await press('Escape');
        const text=(await output('pin')).frame.annotations.objects.find(o=>o.lassoTool==='text');expect(Boolean(text?.backgroundColor),'Text background did not commit');names.push(await save(w,'editor-text-background'));
        await click('[aria-label="文字背景衬底"]');const changedText=(await output('pin')).frame.annotations.objects.find(o=>o.lassoTool==='text');expect(!changedText?.backgroundColor,'Selected text background did not toggle');
        for(const [tool,label,value,region] of [['mosaic','马赛克强度',40,[650,170,180,100]],['blur','模糊强度',24,[650,350,180,100]]]) { await click('[aria-label="'+(tool==='mosaic'?'马赛克':'模糊')+'"]');await range(label,value);await drag(tool,region); }
        await click('[aria-label="箭头"]');expect(await page(w, `document.querySelector('[aria-label="线条粗细"]').value==='10'`), 'Tool switch lost its style');expect(memorySaves.some(m=>m.perTool.arrow?.width===10)&&memorySaves.some(m=>m.perTool.mosaic?.mosaicSize===40)&&memorySaves.some(m=>m.perTool.blur?.blurRadius===24),'Style changes did not reach persistence bridge');checks.push('双向箭头、文字背景、强度预览/成图与按工具记忆');
        for(const format of ['PNG','JPEG','WEBP','BMP','PDF']) { await click('button[aria-label="保存格式"]');await choice('保存格式',format);await click('button[aria-label="保存格式"]');expect((await output('save')).format===format.toLowerCase(),'Wrong export format '+format); }
        for(const [mode,label,action,text] of [['result','编辑结果','quick-save','快速保存'],['original','原始底图','copy-file','复制文件'],['display','显示效果','copy-path','复制路径']]) {
          await click('button[aria-label="保存格式"]');await choice('导出内容',label);names.push(await save(w,'editor-export-'+mode));const count=exports.length;
          await page(w, `Array.from(document.querySelectorAll('[aria-label="保存与导出"] [role="menuitem"]')).find(b=>b.textContent===${JSON.stringify(text)}).click()`);await global.uiShots.ready(w, `document.querySelector('.ed').getAttribute('aria-busy')==='false'`);
          expect(exports.length===count+1&&exports.at(-1).action===action&&exports.at(-1).contentMode===mode,'Export menu lost '+action+'/'+mode);
        }
        for(const [key,action] of [['F16','copy'],['F17','save'],['F18','quick-save'],['F19','pin']]) { const count=exports.length;app.focus({steal:true});w.focus();w.webContents.focus();await page(w,'document.activeElement.blur()');await press(key);await global.uiShots.ready(w, `document.querySelector('.ed').getAttribute('aria-busy')==='false'`);expect(exports.length===count+1&&exports.at(-1).action===action,'Configured action shortcut failed: '+action); }
        checks.push('五格式、快速保存、复制文件/路径、三种导出内容与可配置动作键');fs.writeFileSync(path.join(out,'stage-2-editor.json'),JSON.stringify({status:'passed',checks,previewChecks,memoryWrites:memorySaves.length,exports:exports.map(({action,format,contentMode})=>({action,format,contentMode})),output:'fixture bridge; pixel buffers and serialized annotations inspected'},null,2));
      }
      if (name === 'editor-shared-style') {
        if (!await page(w, `document.querySelector('[aria-label="线条粗细"]').value==='4'`)) throw Error('Disabled tool memory restored per-tool style');
        await page(w, `(()=>{const e=document.querySelector('[aria-label="线条粗细"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'11');e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await wait(150);
        await page(w, `document.querySelector('[aria-label="矩形"]').click()`); await wait(250);
        if (!await page(w, `document.querySelector('[aria-label="线条粗细"]').value==='11'`) || memorySaves.at(-1)?.defaultStyle.width !== 11 || memorySaves.at(-1)?.perTool.arrow.width !== 8) throw Error('Disabled tool memory failed to share default style or overwrote tool memory');
        const resultPath=path.join(out,'stage-2-editor.json'),result=JSON.parse(fs.readFileSync(resultPath,'utf8'));result.sharedStyleMemory=true;fs.writeFileSync(resultPath,JSON.stringify(result,null,2));
      }
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
      if(name==='editor-region-retina'){
        const left=await page(w,`document.querySelector('.region-border').getBoundingClientRect().x`);
        w.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});w.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await wait(150);
        const after=await page(w,`document.querySelector('.region-border').getBoundingClientRect().x`);
        if(after-left!==.5)throw Error('Retina region did not move one physical pixel');
        fs.writeFileSync(path.join(out,'retina-region-verification.json'),JSON.stringify({sourcePixelStep:1,displayPointStep:after-left},null,2));
      }
      if(name==='editor-region-marks'){
        await page(w,`document.querySelector('[aria-label="贴图"]').click()`);for(let i=0;i<30&&!exports.length;i++)await wait(100);
        const first=exports[0]?.frame.annotations; if(first?.objects.length!==3)throw Error('Marked source lost objects');exports=[];
        await wait(80); // The export flag clears after the IPC reply; a faster bitmap export can otherwise swallow the next key.
        w.webContents.sendInputEvent({type:'keyDown',keyCode:'Right',modifiers:['meta']});w.webContents.sendInputEvent({type:'keyUp',keyCode:'Right',modifiers:['meta']});await wait(150);
        await page(w,`document.querySelector('[aria-label="贴图"]').click()`);for(let i=0;i<30&&!exports.length;i++)await wait(100);
        const second=exports[0]?.frame.annotations;
        if(second.crop.width!==first.crop.width+1||JSON.stringify(second.objects)!==JSON.stringify(first.objects))throw Error('Region resizing moved annotation coordinates');
        fs.writeFileSync(path.join(out,'annotation-region-verification.json'),JSON.stringify({objects:second.objects.map(o=>o.type),samePositions:true,crop:second.crop},null,2));
      }
      if(name.startsWith('editor-layout-')){
        const checks=[];
        const inspect=async label=>{
          await wait(400);
          const result=await page(w,`(()=>{const selectors=['.region-size','.ed-chip','.ed-dock > .ed-panel','[aria-label="标注工具"]','[aria-label="输出"]','.ed-format-panel'];const boxes=selectors.flatMap(s=>[...document.querySelectorAll(s)].map(e=>{const r=e.getBoundingClientRect();return {s,x:r.x,y:r.y,width:r.width,height:r.height};}));const overlaps=[];for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];if(a.x<b.x+b.width-.5&&a.x+a.width>b.x+.5&&a.y<b.y+b.height-.5&&a.y+a.height>b.y+.5)overlaps.push([a.s,b.s]);}const outside=boxes.filter(b=>b.x<0||b.y<0||b.x+b.width>innerWidth+.5||b.y+b.height>innerHeight+.5);const blocked=[...document.querySelectorAll('.ed-dock button:not(:disabled),.ed-dock input')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}).map(e=>e.getAttribute('aria-label')||e.textContent);return {boxes,overlaps,outside,blocked};})()`);
          if(result.overlaps.length||result.outside.length||result.blocked.length)throw Error(name+' '+label+' '+JSON.stringify(result));
          checks.push({label,...result});
        };
        const click=async selector=>{const p=await center(w,selector);const hit=await page(w,`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);if(!hit)throw Error(name+' cannot hit '+selector);w.webContents.sendInputEvent({type:'mouseDown',x:Math.round(p[0]),y:Math.round(p[1]),button:'left',clickCount:1});w.webContents.sendInputEvent({type:'mouseUp',x:Math.round(p[0]),y:Math.round(p[1]),button:'left',clickCount:1});await wait(350);};
        await click('[aria-label="矩形"]');await inspect('style');
        await click('[aria-label="设置选区尺寸"]');await inspect('dimensions');names.push(await save(w,name+'-dimensions'));
        await click('[aria-label="文字识别选项"]');await inspect('OCR');names.push(await save(w,name+'-ocr'));
        await click('[aria-label="保存格式"]');await inspect('format');
        await click('[aria-label="保存与导出"] [aria-label="保存格式"] [role="radio"]');await click('button[aria-label="保存格式"]');await inspect('closed');
        fs.writeFileSync(path.join(out,name+'.json'),JSON.stringify(checks,null,2));
      }
      names.push(await save(w, name));
      if (name === 'editor-window') {
        const checks=[];
        for (const width of [760,1020]) {
          w.setSize(width,650);await wait(250);
          const layout=await page(w,`(()=>{const z=document.querySelector('.ed-zoom').getBoundingClientRect(),b=document.querySelector('.ed-primary').getBoundingClientRect();return {zoom:{x:z.x,y:z.y,width:z.width,height:z.height},copy:{x:b.x,y:b.y,width:b.width,height:b.height},copyUncovered:Boolean(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.closest('.ed-primary'))&&b.x>=0&&b.y>=0&&b.right<=innerWidth&&b.bottom<=innerHeight,overlap:z.x<b.right&&z.right>b.x&&z.y<b.bottom&&z.bottom>b.y};})()`);
          if(layout.overlap||!layout.copyUncovered)throw Error('Window zoom obscures output at '+width+': '+JSON.stringify(layout));
          checks.push({width,...layout});names.push(await save(w,'editor-window-'+width));
        }
        fs.writeFileSync(path.join(out,'window-output-layout.json'),JSON.stringify(checks,null,2));
      }
      if (name === 'editor-local-file') {
        await page(w, `(() => { const button = document.querySelector('[aria-label="用于生图"]'); if (!button || button.disabled) throw Error('Editor generation entry is unavailable'); button.click(); })()`);
        for (let pass = 0; pass < 40 && !exports.length; pass++) await wait(100);
        if (exports.length !== 1 || exports[0].action !== 'media' || exports[0].format !== 'png') throw Error('Local-file editor did not emit exactly one fixture media output');
        const output = exports[0].frame, pixels = Buffer.from(output.pixels);
        if (pixels.byteLength !== output.crop.width * output.crop.height * 4) throw Error('Editor fixture media output did not contain its flattened crop');
        const pixel = (80 * output.crop.width + 100) * 4;
        if (pixels[pixel] !== 23 || pixels[pixel + 1] !== 23 || pixels[pixel + 2] !== 23 || pixels[pixel + 3] !== 255) throw Error('Editor fixture media output lost its privacy mask');
      }
      w.destroy();
    }
    if(nativeChecks.length)fs.writeFileSync(path.join(out,'stage-9-native.json'),JSON.stringify({status:'passed',focusedCases,source:'public saveScreenshot, production readSettings migration/updateNativeAppearance, generated native theme, createFrame/show/update/render, decoded PNG pixels (saved target and in-memory before-toggle PNG)',legacyConfigWithoutGridDefaultsTo:true,checks:nativeChecks,physicalCapture:'not exercised; no system display/cursor is acquired'},null,2));
    fs.writeFileSync(path.join(out,'stage-9-editor.json'),JSON.stringify({status:'passed',focusedCases,checks:advancedChecks,screenshotActions,output:'production Editor gestures, PNG export, decodeFrameImage and encodeScreenshot pixels; fixture OCR and output destination'},null,2));
    if(!focusedCases.length)fs.writeFileSync(path.join(out,'stage-6-surfaces.json'),JSON.stringify({status:'passed',scroll:scrollReceipts,intelligence:intelligenceReceipts,clipboardAudits,copies:global.uiShots.stage4.state.receipts.filter(r=>r.method==='editorText'),checks:['方向切换/反裁状态、中段删除、四档接缝修正与横向预览','QR/Code128内容复制与URL回执','四种目标语言、原文译文对照、图上覆盖与全文复制','改单元格/增删行列/Markdown/TSV/XLSX回执','初始公式/编辑后SVG排版/复制/转贴图回执'],electronSessionNetworkAtCapture:global.uiShotsNetwork.audit,linkOpens:'ui-shots:open-url fixture receipts only'},null,2));
    ipcMain.removeHandler('ui-shots:state');
    if(focusedCases.length)return names;
    // Pin at rest is just the image; hover shows the toolbar, ··· the options row.
    let pin = { id: 'ui-shots-pin', revision: 0, image: frame.resize({ width: 360, height: 225 }).toDataURL(), width: 360, height: 225, lines: [{ x: 24, y: 24, width: 120, height: 18, text: 'Lasso Pin', confidence: 0.98, glyphs: [{ x: 24, y: 24, width: 120, height: 18, text: 'Lasso Pin' }] }], status: '拖动贴图 · 点选字图标选择文字', topmost: true, opacity: 1, passthrough: false, kind:'image',title:'设计评审截图',groupId:'default',groups:global.uiShots.stage4.groups,zoomPercent:100,wheelAction:'zoom',locked:false,thumbnail:false };
    const basePin=structuredClone(pin),pinActions = [],pinUpdates=[],pinDrags=[];
    const changed=event=>{event.sender.send('ui-shots:pin-changed',pin);};
    ipcMain.removeHandler('ui-shots:pin'); ipcMain.handle('ui-shots:pin', () => pin);
    ipcMain.removeHandler('ui-shots:pin-action'); ipcMain.handle('ui-shots:pin-action', (event, action) => {pinActions.push(action);for(const [name,key]of [['lock','locked'],['thumbnail','thumbnail'],['topmost','topmost'],['passthrough','passthrough']])if(action===name)pin[key]=!pin[key];if(action==='reset-zoom')pin.zoomPercent=100;if(action==='thumbnail')BrowserWindow.fromWebContents(event.sender).setSize(pin.thumbnail?160:pin.width,pin.thumbnail?96:pin.height);changed(event);return { error: null }; });
    ipcMain.handle('ui-shots:pin-update',(event,key,value,...args)=>{pinUpdates.push({key,value,args});if(key==='updateText'){pin.payload={...pin.payload,text:value};pin.revision++;}else if(key==='zoom')pin.zoomPercent=Math.round(value*100);else if(key==='group')pin.groupId=value;else if(key!=='text')pin[key]=value;changed(event);return {error:null};});
    const pinDrag=(_event,phase)=>pinDrags.push(phase),toolbarHeight=(event,height)=>BrowserWindow.fromWebContents(event.sender).setSize(360,Math.ceil(height));ipcMain.on('ui-shots:pin-drag',pinDrag);ipcMain.on('ui-shots:toolbar-height',toolbarHeight);
    const p = new BrowserWindow({ x: 120, y: 120, width: 360, height: 225, frame: false, show: true, webPreferences: { preload: path.join(fixtures, 'pin-preload.cjs'), contextIsolation: true, sandbox: true } });
    await p.loadFile(path.join(process.cwd(), 'dist/renderer/index.html'), { query: { surface: 'pin' } }); p.focus(); await wait(600);
    names.push(await save(p, 'pin'));
    for (const x of [150, 170, 190]) await move(p, x, 140);
    names.push(await save(p, 'pin-hover'));
    await page(p, `(() => {
      if (document.querySelector('.editor-text-layer')?.classList.contains('enabled')) throw Error('Pin should default to dragging image, not selecting text');
      document.querySelector('button[aria-label="选择文字"]')?.click();
    })()`); await wait(250);
    if (!await page(p, `document.querySelector('.editor-text-layer')?.classList.contains('enabled') && document.querySelector('button[aria-label="选择文字"]')?.getAttribute('aria-pressed') === 'true'`)) {
      throw Error('Clicking text-select button did not enable text selection mode on pin');
    }
    names.push(await save(p, 'pin-text-select'));
    await page(p, `document.querySelector('button[aria-label="选择文字"]')?.click()`); await wait(200);
    await page(p, `document.querySelector('button[aria-label="贴图选项"]')?.click()`); await wait(400);
    names.push(await save(p, 'pin-options'));
    p.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'w', modifiers: ['meta'] });
    p.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'w', modifiers: ['meta'] });
    await wait(150);
    if (!pinActions.includes('close')) throw Error('Command+W on pin did not trigger close action');
    ipcMain.handle('ui-shots:pin-source',()=>({editId:'ui-shots-pin-edit',width:W,height:H,bgra:frame.toBitmap(),annotations:{objects:[],crop:{x:0,y:0,width:W,height:H},nextNumber:1,privacy:[]},saveFormat:'webp',annotationMemory:states['editor-stage-2'].annotationMemory,editorShortcuts:states['editor-stage-2'].editorShortcuts}));
    exports=[];p.setSize(W,H);p.webContents.send('ui-shots:pin-changed',{...pin,editing:true,editId:'ui-shots-pin-edit'});
    await global.uiShots.ready(p, `Boolean(document.querySelector('[aria-label="箭头样式"] [aria-checked="true"]'))`);await wait(350);
    if(!await page(p, `document.querySelector('[aria-label="箭头样式"] [aria-checked="true"]').textContent==='双向' && document.querySelector('[aria-label="线条粗细"]').value==='8'`))throw Error('PinEdit lost source annotation memory');
    await page(p, `document.querySelector('button[aria-label="保存格式"]').click()`);await wait(250);names.push(await save(p,'pin-edit-export'));
    if(!await page(p, `document.querySelector('[aria-label="保存与导出"] [aria-label="保存格式"] [aria-checked="true"]').textContent==='WEBP'`))throw Error('PinEdit lost source export format');
    await page(p, `Array.from(document.querySelectorAll('[aria-label="导出内容"] [role="radio"]')).find(b=>b.textContent==='原始底图').click()`);await wait(100);
    await page(p, `Array.from(document.querySelectorAll('[aria-label="保存与导出"] [role="menuitem"]')).find(b=>b.textContent==='复制路径').click()`);await global.uiShots.ready(p, `document.querySelector('.ed').getAttribute('aria-busy')==='false'`);
    if(exports.length!==1||exports[0].action!=='copy-path'||exports[0].format!=='webp'||exports[0].contentMode!=='original')throw Error('PinEdit did not forward extended export');
    fs.writeFileSync(path.join(out,'stage-2-pin.json'),JSON.stringify({status:'passed',restoredToolStyle:true,sourceFormat:'webp',export:{action:exports[0].action,contentMode:exports[0].contentMode}},null,2));
    p.destroy();
    // Each content type starts in a fresh renderer; fixture setters publish real PinState updates.
    const {stage4}=global.uiShots,pinChecks=[],expect=(ok,text)=>{if(!ok)throw Error(text);};
    const colorBytes=Buffer.alloc(80*80*4);for(let i=0;i<colorBytes.length;i+=4){colorBytes[i]=88;colorBytes[i+1]=118;colorBytes[i+2]=189;colorBytes[i+3]=255;}
    const colorImage=nativeImage.createFromBitmap(colorBytes,{width:80,height:80}).toDataURL();
    for(const kind of ['image','text','color','file','locked','thumbnail','animated','animated-thumbnail']){
      const [width,height]=kind==='text'?[320,160]:['color','file'].includes(kind)?[240,160]:[360,225];
      pin={...structuredClone(basePin),id:'stage-4-'+kind,width,height,kind:['locked','thumbnail'].includes(kind)?'image':kind,locked:kind==='locked',thumbnail:kind==='thumbnail',status:'',payload:kind==='text'?{kind,text:'把想法留在桌面上。\n核对历史、分组和同步状态。'}:kind==='color'?{kind,colorHex:'#BD7658',colorRgb:'rgb(189, 118, 88)'}:kind==='file'?{kind,fileName:'fixture-file.txt',filePath:stage4.filePath,fileSize:fs.statSync(stage4.filePath).size}:undefined};if(kind==='color')pin.image=colorImage;
      if(kind.startsWith('animated'))pin={...pin,kind:'image',thumbnail:kind==='animated-thumbnail',title:'教学演示 · 动态贴图',image:global.uiShots.stage8Frames[0],payload:{kind:'image',frames:global.uiShots.stage8Frames,frameDelayMs:120}};
      const w=new BrowserWindow({x:120,y:120,width:pin.thumbnail?160:width,height:pin.thumbnail?96:height,frame:false,show:true,webPreferences:{preload:path.join(fixtures,'pin-preload.cjs'),contextIsolation:true,sandbox:true}});
      await w.loadFile(path.join(process.cwd(),'dist/renderer/index.html'),{query:{surface:'pin'}});await wait(500);names.push(await save(w,'pin-'+kind));await move(w,pin.thumbnail?80:width/2,pin.thumbnail?48:height/2);
      const click=async label=>{await page(w,`(()=>{const b=document.querySelector('button[aria-label="${label}"]');if(!b||b.disabled)throw Error('Unavailable pin action: ${label}');b.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});b.click();})()`);await wait(180);};
      const fill=async(label,value)=>{await page(w,`(()=>{const e=document.querySelector('[aria-label="${label}"]');e.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(180);};
      const settle=()=>global.uiShots.ready(w,`Boolean(document.querySelector('.pin-options'))&&[...document.querySelectorAll('.pin-bar')].every(e=>{const style=getComputedStyle(e);return Number(style.opacity)===1&&new DOMMatrixReadOnly(style.transform).isIdentity&&!e.getAnimations().some(animation=>animation.playState==='running');})`);
      if(kind==='image'){await click('贴图选项');await fill('透明度',63);await fill('贴图缩放',135);expect(pin.opacity===.63&&pin.zoomPercent===135,'Continuous pin controls did not publish');await settle();names.push(await save(w,'pin-continuous-options'));await click('贴图分组');await page(w,`[...document.querySelectorAll('.pin-group-menu [role="option"]')].find(option=>option.textContent.includes('产品研究')).scrollIntoView({block:'nearest',behavior:'instant'})`);await settle();names.push(await save(w,'pin-group-menu'));await page(w,`(()=>{const b=[...document.querySelectorAll('[role="option"]')].find(b=>b.textContent.includes('产品研究'));b.scrollIntoView({block:'nearest',behavior:'instant'});b.click();})()`);await wait(180);expect(pin.groupId==='research','Pin group did not persist');await click('恢复100%缩放');await page(w,`document.querySelector('.pin').dispatchEvent(new WheelEvent('wheel',{deltaY:40,bubbles:true,cancelable:true}));`);await wait(180);expect(pin.zoomPercent<100,'Default wheel did not zoom');const opacity=pin.opacity;await page(w,`document.querySelector('.pin').dispatchEvent(new WheelEvent('wheel',{deltaY:40,altKey:true,bubbles:true,cancelable:true}));`);await wait(180);expect(pin.opacity<opacity,'Option wheel did not change opacity');await click('快速保存');await click('保存贴图');pinChecks.push('透明度/缩放连续值、复位、分组与两种滚轮、保存回执');}
      if(kind==='image'){await page(w,`(()=>{const data=new DataTransfer();data.setData('text/plain','拖放文字fixture');data.items.add(new File(['Lasso UI fixture'],'fixture-file.txt',{type:'text/plain'}));window.__pinFixtureDrop=data;document.querySelector('.pin').dispatchEvent(new DragEvent('dragenter',{bubbles:true,dataTransfer:data}));})()`);await wait(150);names.push(await save(w,'pin-drop'));await page(w,`document.querySelector('.pin').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.__pinFixtureDrop}));delete window.__pinFixtureDrop;`);await wait(150);expect(stage4.state.receipts.some(r=>r.method==='dropFiles'&&r.args[1]==='拖放文字fixture'),'Pin drop did not reach workspace bridge');pinChecks.push('文字与fixture文件拖放回执');}
      if(kind==='text'){await click('编辑文字');await fill('贴图文字','文字已内联更新，接着核对颜色和文件。');names.push(await save(w,'pin-text-edit'));await page(w,`[...document.querySelectorAll('button')].find(b=>b.textContent==='保存文字').click()`);await wait(180);expect(pin.payload.text.startsWith('文字已内联更新'),'Text pin did not update');await click('文字预设');await click('复制');pinChecks.push('文字内联编辑、复制与预设发送回执');}
      if(kind==='color'){await click('复制HEX色值');await click('复制RGB色值');expect(pinUpdates.some(update=>update.key==='text'&&update.value==='rgb(189, 118, 88)'),'RGB copy did not reach PinAPI');pinChecks.push('HEX/RGB显示与复制回执');}
      if(kind==='file'){await click('复制文件');await click('复制文件路径');pinChecks.push('工作区fixture文件信息与复制文件/路径回执');}
      if(kind==='locked'){const starts=pinDrags.filter(phase=>phase==='start').length;await page(w,`document.querySelector('.pin-viewport').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1}))`);expect(pinDrags.filter(phase=>phase==='start').length===starts,'Locked pin started dragging');await click('贴图选项');await settle();names.push(await save(w,'pin-locked-options'));expect(await page(w,`document.querySelector('[aria-label="贴图缩放"]').disabled`),'Locked pin zoom was enabled');pinChecks.push('锁定标记、禁止拖动与缩放');}
      if(kind==='thumbnail'){await click('展开贴图');expect(!pin.thumbnail,'Thumbnail did not expand');pinChecks.push('缩略态与展开回执');}
      if(kind.startsWith('animated')){
        const imageSelector=pin.thumbnail?'img[alt="贴图缩略图"]':'img[alt="贴图成品"]',src=()=>page(w,`document.querySelector(${JSON.stringify(imageSelector)})?.src`);
        expect(await page(w,`(async()=>{const seen=new Set();for(let i=0;i<12;i++){seen.add(document.querySelector(${JSON.stringify(imageSelector)})?.src);await new Promise(r=>setTimeout(r,50));}return seen.size===3;})()`),'Animated pin did not render all fixture frames');
        await click('暂停动态贴图');const frozen=await src();await wait(360);expect(await src()===frozen&&await page(w,`document.querySelector('[aria-label="播放动态贴图"]').getAttribute('aria-pressed')==='true'`),'Paused dynamic pin advanced');names.push(await save(w,'pin-'+kind+'-paused'));
        pin={...pin,locked:true,zoomPercent:135,payload:structuredClone(pin.payload)};w.webContents.send('ui-shots:pin-changed',pin);await wait(360);expect(await src()===frozen&&await page(w,`Boolean(document.querySelector('[aria-label="播放动态贴图"]'))`),'Ordinary cloned pin updates reset playback');
        await click('播放动态贴图');await ready(w,`document.querySelector(${JSON.stringify(imageSelector)})?.src!==${JSON.stringify(frozen)}`);
        await click('暂停动态贴图');pin={...pin,locked:false,payload:{...pin.payload,frames:[...pin.payload.frames].reverse()}};w.webContents.send('ui-shots:pin-changed',pin);await ready(w,`Boolean(document.querySelector('[aria-label="暂停动态贴图"]'))`);
        await click('暂停动态贴图');pin={...pin,id:pin.id+'-new'};w.webContents.send('ui-shots:pin-changed',pin);await ready(w,`Boolean(document.querySelector('[aria-label="暂停动态贴图"]'))`);
        if(!pin.thumbnail)expect(await page(w,`document.querySelector('[aria-label="动态贴图请在录制预览中裁剪"]').disabled`),'Animated pin exposed unsupported image editor');
        pinChecks.push(kind+':三帧真实变化、暂停/恢复、同源状态保留、新源/新Pin重置');
      }
      const overflow=await page(w,`document.documentElement.scrollWidth>innerWidth||document.body.scrollWidth>innerWidth`);expect(!overflow,'Pin horizontal overflow: '+kind);w.destroy();
    }
    const toolbar=new BrowserWindow({width:360,height:52,frame:false,show:true,webPreferences:{preload:path.join(fixtures,'pin-preload.cjs'),contextIsolation:true,sandbox:true}});
    await toolbar.loadFile(path.join(process.cwd(),'dist/renderer/index.html'),{query:{surface:'pin-toolbar'}});await wait(500);names.push(await save(toolbar,'pin-floating-toolbar'));
    await page(toolbar,`document.querySelector('[aria-label="当前分组"]').click()`);await wait(250);names.push(await save(toolbar,'pin-floating-groups'));await page(toolbar,`[...document.querySelectorAll('[role="option"]')].find(b=>b.textContent.includes('产品研究')).click()`);await wait(200);
    for(const label of ['剪贴板贴图','新建文字贴图','网格排列','左对齐','顶对齐','关闭悬浮工具栏']){await page(toolbar,`document.querySelector('[aria-label="${label}"]').click()`);await wait(180);}expect(stage4.state.workspace.settings.activeGroupId==='research'&&!stage4.state.workspace.settings.floatingToolbar,'Floating toolbar did not update workspace');toolbar.destroy();
    fs.writeFileSync(path.join(out,'stage-4-pins.json'),JSON.stringify({status:'passed',checks:pinChecks,actions:pinActions,updates:pinUpdates,dragStarts:pinDrags.filter(phase=>phase==='start').length,floatingToolbar:true},null,2));
    fs.writeFileSync(path.join(out,'stage-8-pins.json'),JSON.stringify({status:'passed',checks:pinChecks.filter(check=>check.startsWith('animated')),frames:global.uiShots.stage8Frames.length,frameDelayMs:120},null,2));
    for(const channel of ['ui-shots:pin','ui-shots:pin-action','ui-shots:pin-update','ui-shots:pin-source','ui-shots:export','ui-shots:annotation-memory'])ipcMain.removeHandler(channel);ipcMain.removeListener('ui-shots:pin-drag',pinDrag);ipcMain.removeListener('ui-shots:toolbar-height',toolbarHeight);
    return names;
  }));
  await main(async ({clipboard})=>{const {fs,path,out,BrowserWindow,page,stage4}=global.uiShots;if(!clipboard.__uiShotsMemory)throw Error('Native clipboard isolation was lost');const renderers=[];for(const win of BrowserWindow.getAllWindows()){if(!win.webContents.getURL().startsWith('file:'))continue;const audit=await page(win,'window.__uiShotsClipboard');if(!audit)throw Error('Renderer clipboard isolation missing');renderers.push({surface:new URL(win.webContents.getURL()).searchParams.get('surface')||'main',...audit});}fs.writeFileSync(path.join(out,'stage-4-isolation.json'),JSON.stringify({systemClipboardReads:0,systemClipboardWrites:0,main:global.uiShotsClipboard,renderers,receipts:stage4.state.receipts,fixtureState:JSON.parse(fs.readFileSync(stage4.store,'utf8'))},null,2));});
  console.log(`Saved ${saved.length} shots to ${out}:\n` + saved.map(name => `  ${name}.png`).join('\n'));
} finally {
  let networkAuditError, networkAuditTimer;
  try { if (ws?.readyState === WebSocket.OPEN) await Promise.race([main(({BrowserWindow},out)=>{
    const network=global.uiShotsNetwork;if(!network)throw Error('Fixture network audit missing');
    const guardedWindows=BrowserWindow.getAllWindows().map(win=>({id:win.id,guarded:network.hasSession(win.webContents.session)}));
    process.mainModule.require('node:fs').writeFileSync(process.mainModule.require('node:path').join(out,'electron-session-network.json'),JSON.stringify({...network.audit,guardedWindows},null,2));
    const runtime=global.uiShotsNode;if(!runtime)throw Error('Fixture Node runtime audit missing');const guardsIntact=runtime.verify();
    process.mainModule.require('node:fs').writeFileSync(process.mainModule.require('node:path').join(out,'node-runtime-isolation.json'),JSON.stringify({...runtime.audit,guardsIntact,cliPolicy:'all child_process execution blocked; no encoder CLI is needed',login:global.uiShotsLogin},null,2));
    if(!guardsIntact)throw Error('Fixture Node runtime isolation was replaced');
    if(guardedWindows.some(win=>!win.guarded)||network.audit.blockedRequests!==Object.values(network.audit.blockedByProtocol).reduce((sum,value)=>sum+value,0))throw Error('Fixture network isolation audit failed');
  },out),new Promise((_,reject)=>{networkAuditTimer=setTimeout(()=>reject(Error('Electron session network audit timed out')),2000);})]); } catch(error) { networkAuditError=error; } finally {clearTimeout(networkAuditTimer);}
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
  if(networkAuditError)throw networkAuditError;
}
