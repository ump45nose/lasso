import { dialog, safeStorage } from 'electron';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Preset, Settings } from '../shared/contracts';
import type { PortableConfigBundle, WebDavConfig, WebDavConfigInput, WebDavSyncDirection } from '../shared/history-sync';
import { screenshotDefaults, screenshotKinds, validateScreenshotSettings } from '../shared/screenshot-settings';
import { canonicalShortcut, editorActionIds, globalActionIds, isValidShortcut, validateEditorShortcuts } from '../shared/shortcuts';
import { validMemorySettings } from '../shared/memory';
import { validatePresets } from './presets';
import { migrateSettings, validateGeneralSettings } from './settings';
import { validateFonts } from './fonts';

interface ConfigAccess { readSettings(): Settings; writeSettings(settings: Settings): void; readPresets(): Preset[]; writePresets(presets: Preset[]): void }
const configDefaults = (): WebDavConfig => ({ enabled: false, url: '', remotePath: 'Lasso/config.json', username: '', autoSync: false });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const portableKeys = ['themeMode','toolbarTools','mouseActions','scriptActions','autoCheckUpdates','memory', 'vision', 'screenshot', 'shortcut', 'captureShortcuts', 'actionShortcuts', 'editorShortcuts', 'ignoredApps', 'lastTarget', 'selectionEnabled', 'clipboardFallback', 'appPrompts', 'fonts'];
const presetKeys = ['id', 'name', 'template', 'target', 'mode', 'needsSelection', 'enabled', 'model', 'effort', 'temporaryChat', 'kind', 'image'];
const pick = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const fields = (value: unknown, keys: string[]): unknown => record(value) ? pick(value, keys) : value;
const rows = (value: unknown, keys: string[]): unknown => Array.isArray(value) ? value.map(item => fields(item, keys)) : value;
const mapFields = (value: unknown, keys: string[]): unknown => record(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fields(item, keys)])) : value;
/** Each object has its own allowlist: unknown legacy account fields cannot enter a bundle. */
function portableSettings(value: Record<string, unknown>) {
  const settings = pick(value, portableKeys), styleKeys = Object.keys(screenshotDefaults().annotationMemory.defaultStyle);
  for (const [key, keys] of Object.entries({ vision: ['baseURL', 'model', 'targetLanguage', 'useMediaCredential'], memory: ['enabled', 'idleMinutes'], fonts: ['display', 'text', 'ui', 'mono'], captureShortcuts: ['rect', 'area', 'window', 'screen', 'front'], actionShortcuts: globalActionIds, editorShortcuts: editorActionIds })) if (key in settings) settings[key] = fields(settings[key], keys);
  if ('scriptActions' in settings) settings.scriptActions=rows(settings.scriptActions,['id','name','enabled','code']);
  if ('mouseActions' in settings) settings.mouseActions=fields(settings.mouseActions,['doubleClick','rightClick','middleClick']);
  if ('appPrompts' in settings) settings.appPrompts = rows(settings.appPrompts, ['bundleId', 'name', 'prompt', 'enabled']);
  if ('ignoredApps' in settings) settings.ignoredApps = rows(settings.ignoredApps, ['bundleId', 'name', 'enabled', 'scopes']);
  if (record(settings.screenshot)) {
    const screenshot = pick(settings.screenshot, Object.keys(screenshotDefaults())); settings.screenshot = screenshot;
    if ('actions' in screenshot) screenshot.actions = mapFields(fields(screenshot.actions, screenshotKinds), ['show', 'copy', 'save']);
    if ('regionPresets' in screenshot) screenshot.regionPresets = rows(screenshot.regionPresets, ['id', 'name', 'width', 'height', 'ratio', 'delay']);
    if ('recording' in screenshot) screenshot.recording = fields(screenshot.recording, ['fps', 'quality', 'format', 'countdown', 'systemAudio', 'microphone', 'showKeystrokes', 'showMouseClicks', 'cameraOverlay', 'cameraPosition']);
    if ('history' in screenshot) screenshot.history = fields(screenshot.history, ['enabled', 'maxItems', 'maxDays', 'maxBytesMB']);
    if (record(screenshot.pinWorkspace)) { const pins = pick(screenshot.pinWorkspace, ['restoreOnLaunch', 'floatingToolbar', 'wheelAction', 'activeGroupId', 'groups']); if ('groups' in pins) pins.groups = rows(pins.groups, ['id', 'name', 'color', 'visible']); screenshot.pinWorkspace = pins; }
    if (record(screenshot.annotationMemory)) { const memory = pick(screenshot.annotationMemory, ['rememberToolStyles', 'lastTool', 'defaultStyle', 'perTool']); if ('defaultStyle' in memory) memory.defaultStyle = fields(memory.defaultStyle, styleKeys); if ('perTool' in memory) memory.perTool = mapFields(memory.perTool, styleKeys); screenshot.annotationMemory = memory; }
  }
  return portable(settings) as Record<string, unknown>;
}
function portablePresets(value: unknown[]) {
  return portable(value.map(item => { if (!record(item)) return item; const preset = pick(item, presetKeys); if ('image' in preset) preset.image = fields(preset.image, ['aspect', 'resolution', 'count', 'customSize', 'generationModel', 'editModel', 'quality', 'background', 'outputFormat']); if (record(preset.image) && 'customSize' in preset.image) preset.image.customSize = fields(preset.image.customSize, ['width', 'height']); return preset; })) as unknown[];
}
/** Device resource fields and secrets are removed; prompt text keeps slash commands and path examples. */
function portable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(portable).filter(item => item !== undefined);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key==='useMediaCredential'||!/password|credential|secret|token|api.?key|authorization|cookie|private.?key|^(__proto__|constructor|prototype)$|^(local|importedFonts|directory|quickSaveDirectory)$/i.test(key)).flatMap(([key, child]) => { const clean = portable(child); return clean === undefined ? [] : [[key, clean]]; }));
}
function mergePreferences(current: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const next = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    const previous = current[key];
    if (previous !== undefined && (Array.isArray(previous) ? !Array.isArray(value) : record(previous) ? !record(value) : typeof previous !== typeof value)) throw Error('配置包字段类型无效：' + key);
    next[key] = record(previous) && record(value) ? mergePreferences(previous, value) : value;
  }
  return next;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const contentHash = (bundle: PortableConfigBundle) => createHash('sha256').update(canonical({ settings: bundle.settings, presets: bundle.presets })).digest('hex');

/** WebDAV account state stays beside, and never inside, portable preferences. */
export class WebDavSyncService {
  private saved: WebDavConfig = configDefaults();
  private active: Promise<{ state: WebDavConfig; error: string | null }> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingAutoSync = false;
  constructor(private directory: string, private access: ConfigAccess) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(this.path('webdav-config.json'))) {
      const saved = JSON.parse(readFileSync(this.path('webdav-config.json'), 'utf8'));
      this.validateConfig(saved);
      this.saved = { ...configDefaults(), ...pick(saved, ['enabled', 'url', 'remotePath', 'username', 'autoSync', 'lastSyncedAt', 'lastEtag', 'lastContentHash']), status: 'idle' };
    }
  }
  private path(name: string) { return join(this.directory, name); }
  private atomic(name: string, data: string | Buffer) {
    const path = this.path(name);
    writeFileSync(path + '.tmp', data, { mode: 0o600 }); chmodSync(path + '.tmp', 0o600); renameSync(path + '.tmp', path);
  }
  config(): WebDavConfig { return { ...this.saved, hasPassword: existsSync(this.path('webdav-secret.json')) }; }
  private persist() {
    const { hasPassword, status, message, ...saved } = this.saved;
    this.atomic('webdav-config.json', JSON.stringify(saved) + '\n');
  }
  private validateConfig(input: WebDavConfigInput) {
    if (!input || typeof input.enabled !== 'boolean' || typeof input.autoSync !== 'boolean' || typeof input.url !== 'string' || typeof input.username !== 'string' || /[\r\n:]/.test(input.username) || typeof input.remotePath !== 'string' || !input.remotePath.trim() || input.remotePath.split('/').filter(Boolean).some(part => part === '.' || part === '..') || /[\\\x00-\x1f?#]/.test(input.remotePath) || input.remotePath.endsWith('/')) throw Error('WebDAV 配置无效');
    if (input.url || input.enabled) {
      const url = new URL(input.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('WebDAV 地址需为不含凭据、查询或片段的 HTTP/HTTPS URL');
    }
    if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 16000)) throw Error('WebDAV 密码无效');
    if (input.clearPassword !== undefined && typeof input.clearPassword !== 'boolean') throw Error('WebDAV 密码选项无效');
  }
  saveConfig(input: WebDavConfigInput): WebDavConfig {
    if (this.active) throw Error('请等待本次同步完成');
    this.validateConfig(input);
    const next: WebDavConfig = { enabled: input.enabled, url: input.url.trim().replace(/\/+$/, ''), remotePath: input.remotePath.replace(/^\/+/, ''), username: input.username, autoSync: input.autoSync, status: 'idle' };
    if (next.url === this.saved.url && next.remotePath === this.saved.remotePath && next.username === this.saved.username) Object.assign(next, pick(this.saved as unknown as Record<string, unknown>, ['lastSyncedAt', 'lastEtag', 'lastContentHash']));
    if (input.clearPassword || input.password === '') { rmSync(this.path('webdav-secret.json'), { force: true }); rmSync(this.path('webdav-secret.key'), { force: true }); }
    else if (input.password !== undefined) this.savePassword(input.password);
    this.saved = next; this.persist(); this.scheduleAutoSync(); return this.config();
  }
  private savePassword(password: string) {
    if (safeStorage.isEncryptionAvailable()) { this.atomic('webdav-secret.json', JSON.stringify({ mode: 'system', value: safeStorage.encryptString(password).toString('base64') })); rmSync(this.path('webdav-secret.key'), { force: true }); return; }
    const keyPath = this.path('webdav-secret.key'), key = existsSync(keyPath) ? readFileSync(keyPath) : randomBytes(32);
    this.atomic('webdav-secret.key', key);
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    this.atomic('webdav-secret.json', JSON.stringify({ mode: 'local', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: encrypted.toString('base64') }));
  }
  private password(): string {
    if (!existsSync(this.path('webdav-secret.json'))) return '';
    try {
      const secret = JSON.parse(readFileSync(this.path('webdav-secret.json'), 'utf8'));
      if (secret.mode === 'system') return safeStorage.decryptString(Buffer.from(secret.value, 'base64'));
      if (secret.mode !== 'local') throw Error();
      const cipher = createDecipheriv('aes-256-gcm', readFileSync(this.path('webdav-secret.key')), Buffer.from(secret.iv, 'base64'));
      cipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
      return Buffer.concat([cipher.update(Buffer.from(secret.value, 'base64')), cipher.final()]).toString('utf8');
    } catch { throw Error('无法读取 WebDAV 密码，请重新保存密码'); }
  }
  bundle(): PortableConfigBundle {
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), settings: portableSettings(this.access.readSettings() as unknown as Record<string, unknown>), presets: portablePresets(this.access.readPresets()) };
  }
  private unpack(value: unknown): { bundle: PortableConfigBundle; settings: Settings; presets: Preset[] } {
    if (!record(value) || value.schemaVersion !== 1 || typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt)) || !record(value.settings) || !Array.isArray(value.presets)) throw Error('配置包格式或版本无效');
    const clean: PortableConfigBundle = { schemaVersion: 1, exportedAt: value.exportedAt, settings: portableSettings(value.settings), presets: portablePresets(value.presets) };
    validatePresets(clean.presets);
    const current = this.access.readSettings(), incoming = mergePreferences(current as unknown as Record<string, unknown>, clean.settings) as unknown as Settings;
    if (!validMemorySettings(incoming.memory) || !['chatgpt', 'gemini', 'codex', 'pi'].includes(incoming.lastTarget)) throw Error('配置包中的应用偏好无效');
    const settings = migrateSettings({ ...incoming, local: current.local, importedFonts: current.importedFonts, screenshot: { ...incoming.screenshot, directory: current.screenshot.directory, quickSaveDirectory: current.screenshot.quickSaveDirectory } }, current);
    validateGeneralSettings(settings);
    validateScreenshotSettings(settings.screenshot, settings.screenshot.languages); validateFonts(settings.fonts);
    if (!validMemorySettings(settings.memory) || [settings.selectionEnabled, settings.clipboardFallback].some(item => typeof item !== 'boolean') || !Array.isArray(settings.appPrompts) || !Array.isArray(settings.ignoredApps)) throw Error('配置包中的应用偏好无效');
    const promptIds = new Set<string>(), ignoredIds = new Set<string>();
    for (const rule of settings.appPrompts) {
      if (!rule || typeof rule.bundleId !== 'string' || !rule.bundleId.trim() || promptIds.has(rule.bundleId) || typeof rule.name !== 'string' || !rule.name.trim() || typeof rule.prompt !== 'string' || typeof rule.enabled !== 'boolean') throw Error('应用规则需要唯一的 bundle ID 和名称。');
      promptIds.add(rule.bundleId);
    }
    for (const rule of settings.ignoredApps) {
      if (!rule || typeof rule.bundleId !== 'string' || !/^[\w-]+(?:\.[\w-]+)+$/.test(rule.bundleId) || ignoredIds.has(rule.bundleId) || typeof rule.name !== 'string' || !rule.name.trim() || typeof rule.enabled !== 'boolean' || !Array.isArray(rule.scopes) || !rule.scopes.length || new Set(rule.scopes).size !== rule.scopes.length || rule.scopes.some(scope => !['selection', 'shortcuts', 'capture-candidates'].includes(scope))) throw Error('应用规则需要唯一的 bundle ID、名称和有效作用范围');
      ignoredIds.add(rule.bundleId);
    }
    settings.ignoredApps = settings.ignoredApps.map(rule => ({ ...rule, name: rule.name.trim() }));
    const shortcuts = globalActionIds.map(id => settings.actionShortcuts[id] ?? '');
    if (shortcuts.some(shortcut => !isValidShortcut(shortcut) || canonicalShortcut(shortcut) === 'alt+space') || new Set(shortcuts.filter(Boolean).map(canonicalShortcut)).size !== shortcuts.filter(Boolean).length || validateEditorShortcuts(settings.editorShortcuts)) throw Error('配置包中的快捷键无效或重复');
    return { bundle: clean, settings, presets: clean.presets as Preset[] };
  }
  applyBundle(value: unknown): void {
    const next = this.unpack(value), previous = this.access.readPresets();
    this.access.writePresets(next.presets);
    try { this.access.writeSettings(next.settings); }
    catch (error) { this.access.writePresets(previous); throw error; }
  }
  async exportConfig(): Promise<{ path: string | null; error: string | null }> {
    try {
      const choice = await dialog.showSaveDialog({ title: '导出 Lasso 配置', defaultPath: 'Lasso-config.json', filters: [{ name: 'JSON 配置', extensions: ['json'] }] });
      if (choice.canceled || !choice.filePath) return { path: null, error: null };
      writeFileSync(choice.filePath, JSON.stringify(this.bundle(), null, 2) + '\n', { mode: 0o600 });
      return { path: choice.filePath, error: null };
    } catch (error) { return { path: null, error: (error as Error).message }; }
  }
  async importConfig(): Promise<{ error: string | null }> {
    try {
      const choice = await dialog.showOpenDialog({ title: '导入 Lasso 配置', properties: ['openFile'], filters: [{ name: 'JSON 配置', extensions: ['json'] }] });
      if (!choice.canceled && choice.filePaths[0]) {
        const data = readFileSync(choice.filePaths[0]); if (data.length > MAX_CONFIG_BYTES) throw Error('配置包不能超过 8 MB');
        this.applyBundle(JSON.parse(data.toString('utf8'))); this.scheduleAutoSync();
      }
      return { error: null };
    } catch (error) { return { error: (error as Error).message }; }
  }
  scheduleAutoSync() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.saved.enabled && this.saved.autoSync) {
      if (this.active) this.pendingAutoSync = true;
      else this.timer = setTimeout(() => { this.timer = null; void this.sync('auto'); }, 600);
    }
  }
  dispose() { if (this.timer) clearTimeout(this.timer); this.timer = null; this.pendingAutoSync = false; }
  sync(direction: WebDavSyncDirection): Promise<{ state: WebDavConfig; error: string | null }> {
    if (this.active) return this.active;
    this.active = this.performSync(direction).finally(() => { this.active = null; if (this.pendingAutoSync) { this.pendingAutoSync = false; this.scheduleAutoSync(); } }); return this.active;
  }
  private async request(url: URL, method: string, headers: Record<string, string> = {}, body?: string): Promise<Response> {
    const response = await fetch(url, { method, headers: { Authorization: 'Basic ' + Buffer.from(this.saved.username + ':' + this.password()).toString('base64'), ...headers }, body, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (response.status === 401 || response.status === 403) throw Error('WebDAV 身份验证或访问权限失败（HTTP ' + response.status + '）');
    return response;
  }
  private async readRemote(url: URL) {
    const response = await this.request(url, 'GET');
    if (response.status === 404) return null;
    if (!response.ok) throw Error('读取 WebDAV 配置失败（HTTP ' + response.status + '）');
    const reader = response.body?.getReader(); let bytes = 0; const chunks: Buffer[] = [];
    if (reader) try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > MAX_CONFIG_BYTES) throw Error('远端配置包不能超过 8 MB'); chunks.push(Buffer.from(part.value)); } } finally { await reader.cancel(); }
    const bundle = this.unpack(JSON.parse(Buffer.concat(chunks).toString('utf8'))).bundle;
    return { bundle, hash: contentHash(bundle), etag: response.headers.get('etag') ?? '' };
  }
  private async performSync(direction: WebDavSyncDirection) {
    this.saved.status = 'syncing'; this.saved.message = '';
    try {
      if (!['push', 'pull', 'auto'].includes(direction)) throw Error('同步方向无效');
      if (!this.saved.enabled || !this.saved.url) throw Error('请先启用并保存 WebDAV 配置');
      const base = new URL(this.saved.url.replace(/\/+$/, '') + '/');
      const probe = await this.request(base, 'PROPFIND', { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>');
      if (!probe.ok) throw Error('连接 WebDAV 失败（HTTP ' + probe.status + '）');
      await probe.body?.cancel();
      const parts = this.saved.remotePath.split('/').filter(Boolean), url = new URL(parts.map(encodeURIComponent).join('/'), base);
      const remote = await this.readRemote(url), local = this.bundle(), hash = contentHash(local), baseline = this.saved.lastContentHash;
      const localChanged = hash !== baseline, remoteChanged = !!remote && (remote.etag !== this.saved.lastEtag || remote.hash !== baseline) && remote.hash !== baseline;
      if (direction === 'auto' && remote && hash !== remote.hash && localChanged && remoteChanged) { this.saved.status = 'conflict'; this.saved.message = '本机与远端配置均有变化，请选择推送或拉取'; return { state: this.config(), error: null }; }
      const pull = direction === 'pull' || direction === 'auto' && !!remote && remoteChanged && !localChanged;
      let etag = remote?.etag ?? '', syncedHash = hash;
      if (pull) {
        if (!remote) throw Error('远端尚无可拉取的配置');
        // Do not discard edits made while the network request was in progress.
        if (contentHash(this.bundle()) !== hash) { this.saved.status = 'conflict'; this.saved.message = '同步期间本机配置已变化，请重新选择同步方向'; return { state: this.config(), error: null }; }
        this.applyBundle(remote.bundle); syncedHash = remote.hash;
      } else if (!remote || hash !== remote.hash) {
        for (let index = 1; index < parts.length; index++) {
          const collection = new URL(parts.slice(0, index).map(encodeURIComponent).join('/') + '/', base), created = await this.request(collection, 'MKCOL');
          if (!created.ok && created.status !== 405) throw Error('创建 WebDAV 目录失败（HTTP ' + created.status + '）');
          await created.body?.cancel();
        }
        // RFC 4918 collections; RFC 9110 conditional PUT prevents a racing overwrite.
        const condition: Record<string, string> = !remote ? { 'If-None-Match': '*' } : etag && !etag.startsWith('W/') ? { 'If-Match': etag } : {};
        const sent = await this.request(url, 'PUT', { 'Content-Type': 'application/json; charset=utf-8', ...condition }, JSON.stringify(local) + '\n');
        if (sent.status === 412) { this.saved.status = 'conflict'; this.saved.message = '远端配置在同步期间变化，请重试推送或拉取'; return { state: this.config(), error: null }; }
        if (!sent.ok) throw Error('推送 WebDAV 配置失败（HTTP ' + sent.status + '）');
        etag = sent.headers.get('etag') ?? ''; await sent.body?.cancel();
      }
      this.saved = { ...this.saved, lastSyncedAt: Date.now(), lastEtag: etag, lastContentHash: syncedHash, status: 'synced', message: '配置已同步' }; this.persist();
      return { state: this.config(), error: null };
    } catch (error) {
      const failure = error as Error;
      this.saved.status = failure instanceof TypeError || ['AbortError', 'TimeoutError'].includes(failure.name) ? 'offline' : 'error';
      this.saved.message = this.saved.status === 'offline' ? 'WebDAV 暂时离线，本机配置继续保留' : failure.message;
      return { state: this.config(), error: this.saved.message };
    }
  }
}
