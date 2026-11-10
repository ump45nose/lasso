import { Worker } from 'node:worker_threads';
import { app } from 'electron';
import { join } from 'node:path';
import { migrateScreenshotSettings, screenshotDefaults } from '../shared/screenshot-settings';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { defaultFonts, type GeneralSettings, type Preset, type Settings } from '../shared/contracts';
import { memoryDefaults, validMemorySettings } from '../shared/memory';
import { captureModes } from '../shared/capture';
import { defaultEditorShortcuts } from '../shared/shortcuts';
import { normalizeVisionConfig, visionDefaults } from '../shared/intelligence';
import { normalizeTranslationSettings, translationDefaults } from '../shared/media';
import type { MediaService } from './media-service';
import { writePresets } from './presets';
import { writeFileAtomic } from './files';

/** New action entries win; absent entries migrate from their legacy aliases. */
function syncActionShortcuts(settings: Settings): Settings {
  const actionShortcuts = { ...settings.actionShortcuts };
  actionShortcuts['open-launcher'] ??= settings.shortcut;
  actionShortcuts['open-clipboard-history'] ??= 'Alt+V';
  actionShortcuts['open-translator'] ??= '';
  for (const mode of captureModes) actionShortcuts[mode] ??= settings.captureShortcuts[mode];
  settings.actionShortcuts = actionShortcuts;
  settings.shortcut = actionShortcuts['open-launcher'];
  settings.captureShortcuts = Object.fromEntries(captureModes.map(mode => [mode, actionShortcuts[mode]])) as Settings['captureShortcuts'];
  return settings;
}
export function defaultSettings(): Settings {
  const executable = (name: string) => ['/opt/homebrew/bin/', '/usr/local/bin/'].map(p => p + name).find(existsSync) || '';
  return syncActionShortcuts({ launchAtLogin:false, themeMode:'paper', toolbarTools:[], mouseActions:{doubleClick:'copy',rightClick:'cancel',middleClick:'pin'}, scriptActions:[], autoCheckUpdates:true, memory: memoryDefaults(), vision:visionDefaults(), translation:translationDefaults(), windowDragSnap:true, screenshot: screenshotDefaults(join(app.getPath('pictures'), 'Lasso')), shortcut: '', captureShortcuts: { rect: '', area: '', window: '', screen: '', front: '' }, actionShortcuts: {}, editorShortcuts: defaultEditorShortcuts(), ignoredApps: [], lastTarget: 'chatgpt', selectionEnabled: true, clipboardFallback: false, appPrompts: [], local: {
    codex: { executable: executable('codex'), cwd: homedir() }, pi: { executable: executable('pi'), cwd: homedir() }
  }, fonts: { ...defaultFonts }, importedFonts: [] });
}
export function migrateSettings(value: Partial<Settings> & { screenshotShortcut?: string }, defaults: Settings): Settings {
  // Before capture modes existed, the area shortcut was stored as `screenshotShortcut`.
  const { screenshotShortcut, ...settings } = value;
  if (settings.shortcut !== undefined && typeof settings.shortcut !== 'string') throw new Error('设置文件中的 shortcut 必须是字符串');
  settings.memory = validMemorySettings(settings.memory!) ? settings.memory : defaults.memory;
  return syncActionShortcuts({
    ...defaults, ...settings,
    mouseActions: { ...defaults.mouseActions, ...settings.mouseActions },
    vision: normalizeVisionConfig(settings.vision??defaults.vision),
    translation: normalizeTranslationSettings(settings.translation ?? defaults.translation),
    windowDragSnap: typeof settings.windowDragSnap === 'boolean' ? settings.windowDragSnap : defaults.windowDragSnap,
    screenshot: migrateScreenshotSettings(settings.screenshot, defaults.screenshot.directory),
    captureShortcuts: { ...defaults.captureShortcuts, ...(typeof screenshotShortcut === 'string' ? { area: screenshotShortcut } : {}), ...settings.captureShortcuts },
    // Do not copy the defaults' alias entries before migrating a legacy file.
    actionShortcuts: { ...settings.actionShortcuts },
    editorShortcuts: { ...defaults.editorShortcuts, ...settings.editorShortcuts },
    ignoredApps: settings.ignoredApps ?? defaults.ignoredApps,
    fonts: { ...defaults.fonts, ...settings.fonts },
    lastTarget: ['chatgpt', 'gemini', 'codex', 'pi'].includes(settings.lastTarget || '') ? settings.lastTarget! : 'chatgpt'
  });
}
export function readSettings(path: string): Settings {
  return existsSync(path) ? migrateSettings(JSON.parse(readFileSync(path, 'utf8')), defaultSettings()) : defaultSettings();
}
export function writeSettings(path: string, settings: Settings) {
  writeFileAtomic(path, JSON.stringify(syncActionShortcuts(settings), null, 2) + '\n');
}

/** Pool writes happen before settings/presets acquire a connection binding; interrupted migrations can be retried. */
export function migrateApiConnectionSettings(service: MediaService, settingsPath: string, presetsPath: string, settings: Settings, presets: Preset[], visionDirectory: string): { settings: Settings; presets: Preset[] } {
  const visionPath = join(visionDirectory, 'config.json');
  const legacyVision = existsSync(visionPath) ? JSON.parse(readFileSync(visionPath, 'utf8')) : {};
  const next = service.migrateLegacyBindings(settings, presets, legacyVision);
  if (JSON.stringify(next.settings) !== JSON.stringify(settings)) writeSettings(settingsPath, next.settings);
  if (JSON.stringify(next.presets) !== JSON.stringify(presets)) writePresets(presetsPath, next.presets, service.connections());
  return next;
}

export function validateGeneralSettings(value: GeneralSettings): void {
  if (!value || typeof value.launchAtLogin !== 'boolean' || !['paper','system'].includes(value.themeMode) || typeof value.autoCheckUpdates !== 'boolean' ||
    !Array.isArray(value.toolbarTools) || value.toolbarTools.length > 50 || value.toolbarTools.some(id=>typeof id !== 'string' || !/^[a-z][a-z-]*$/.test(id)) || new Set(value.toolbarTools).size !== value.toolbarTools.length ||
    !value.mouseActions || !['copy','save','pin','none'].includes(value.mouseActions.doubleClick) || !['reselect','cancel'].includes(value.mouseActions.rightClick) || !['pin','quick-save','none'].includes(value.mouseActions.middleClick)) throw Error('常规设置无效');
  if (!Array.isArray(value.scriptActions) || value.scriptActions.length > 50 || new Set(value.scriptActions.map(s=>s?.id)).size !== value.scriptActions.length ||
    value.scriptActions.some(s=>!s || typeof s.id !== 'string' || !s.id || typeof s.name !== 'string' || !s.name.trim() || typeof s.enabled !== 'boolean' || typeof s.code !== 'string' || s.code.length > 100000)) throw Error('脚本动作无效');
}

/** Only JSON primitives cross the VM boundary; its code never receives a host object. */
export function runControlledScript(code: string, input: { text:string; width:number; height:number; app:string }): Promise<string> {
  const source = `(() => { try { const input = ${JSON.stringify(input)}; const output = (function(input) { "use strict";\n${code}\n})(input); if (typeof output !== 'string') throw Error('脚本必须同步返回文字'); if (output.length > 1000000) throw Error('脚本输出过长'); return JSON.stringify({output}); } catch(error) { return JSON.stringify({error:String(error)}); } })()`;
  return new Promise((resolve,reject)=>{
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); const vm=require('node:vm'); try { const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false},microtaskMode:'afterEvaluate'}); const result=new vm.Script(workerData).runInContext(context,{timeout:300}); if(typeof result!=='string')throw null;parentPort.postMessage({result}); } catch {parentPort.postMessage({error:'脚本执行失败或超时（300 ms）'});}`, {eval:true,workerData:source,resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8,stackSizeMb:2}});
    let settled=false;
    const finish=(error:Error|null,output='')=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();if(error)reject(error);else resolve(output);};
    const timer=setTimeout(()=>finish(Error('脚本执行超时')),1500);
    worker.once('message',(message:{error?:string;result?:string})=>{
      try { if(message.error)throw Error(message.error);const result=JSON.parse(message.result!);if(typeof result.error==='string')throw Error(result.error);if(typeof result.output!=='string'||result.output.length>1000000)throw Error('脚本输出无效');finish(null,result.output); } catch(error){finish(error as Error);}
    });
    worker.once('error',error=>finish(error));
    worker.once('exit',code=>{if(code!==0)finish(Error('脚本已终止'));});
  });
}
