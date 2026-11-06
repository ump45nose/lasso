import { BrowserWindow, screen, systemPreferences } from 'electron';
import SelectionHook from 'selection-hook';
import type { TextSelectionData } from 'selection-hook';
import type { KeystrokeCue, MouseClickCue } from '../shared/recording';
import type { CaptureStatus, SelectionContext, Settings } from '../shared/contracts';
import type { IgnoredAppRule, IgnoredAppScope } from '../shared/shortcuts';

export function ignoresApplication(rules: IgnoredAppRule[], bundleId: string, scope: IgnoredAppScope) {
  return rules.some(rule => rule.enabled && rule.bundleId === bundleId && rule.scopes.includes(scope));
}

export interface SelectionInputHandlers {
  keystroke(cue: Omit<KeystrokeCue, 'timestampMs'>): void;
  mouseClick(cue: Omit<MouseClickCue, 'timestampMs'>): void;
  error?(error: Error): void;
}

export class SelectionCapture {
  private hook: SelectionHook | null = null;
  private suppressUntil = 0;
  private permissionPrompted = false;
  private trustTimer: ReturnType<typeof setInterval> | null = null;
  private ignoredApps: IgnoredAppRule[] = [];
  private settings: Settings | null = null;
  private inputs = new Set<SelectionInputHandlers>();
  private inputStarting = false;
  private inputStartError: Error | null = null;
  private disposed = false;
  constructor(
    private onSelection: (selection: SelectionContext) => void,
    private onStatus: (status: CaptureStatus) => void,
    private onOutside: (point: { x: number; y: number }) => void,
    private onDismiss: () => void
  ) {}
  configure(settings: Settings) {
    if (this.disposed) return;
    this.settings = settings;
    this.ignoredApps = settings.ignoredApps;
    if (this.inputs.size) return this.onStatus({ status: 'paused', message: '录制中，划词已暂停' });
    this.hook?.stop();
    this.onDismiss();
    if (this.trustTimer) { clearInterval(this.trustTimer); this.trustTimer = null; }
    if (!settings.selectionEnabled) return this.onStatus({ status: 'paused', message: '划词已暂停' });
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      // Signed installs keep a stable identity. Only first-time/migration consent
      // needs a prompt; reopening settings must not repeatedly prompt the user.
      if (!this.permissionPrompted) {
        this.permissionPrompted = true;
        systemPreferences.isTrustedAccessibilityClient(true);
      }
      this.trustTimer = setInterval(() => {
        if (!systemPreferences.isTrustedAccessibilityClient(false)) return;
        this.configure(settings);
      }, 1000);
      return this.onStatus({ status: 'permission', message: '需要在「隐私与安全 → 设备控制和数据访问」中允许 Lasso，才能读取选中文字' });
    }
    try {
      const started = this.ensureHook().start({ enableClipboard: settings.clipboardFallback, selectionPassiveMode: false, enableMouseMoveEvent: false, debug: false, globalFilterMode: SelectionHook.FilterMode.EXCLUDE_LIST, globalFilterList: settings.ignoredApps.filter(rule => rule.enabled && rule.scopes.includes('selection')).map(rule => rule.bundleId) });
      this.onStatus(started ? { status: 'active', message: '划词已开启' } : { status: 'error', message: '划词监听未能启动，请检查辅助功能权限后重试' });
    } catch (error) { this.onStatus({ status: 'error', message: String(error) }); }
  }
  /** One native hook serves selection and recording; recording never invokes selection retrieval. */
  private ensureHook() {
    if (this.hook) return this.hook;
    const hook = this.hook = new SelectionHook();
    hook.on('error', error => {
      this.onStatus({ status: 'error', message: error.message });
      if (this.inputStarting) this.inputStartError = error;
      else for (const input of this.inputs) input.error?.(error);
    });
    hook.on('text-selection', data => this.receive(data));
    hook.on('mouse-down', point => {
      if (!this.inputs.size) return this.onOutside(point);
      if (point.button === 0 || point.button === 2) for (const input of this.inputs) input.mouseClick({ x: point.x, y: point.y, button: point.button === 0 ? 'left' : 'right' });
    });
    hook.on('mouse-wheel', () => { if (!this.inputs.size) this.onDismiss(); });
    hook.on('key-down', ({ uniKey, flags }) => {
      if (this.inputs.size) {
        const modifiers = ([[17, 'Shift'], [18, 'Control'], [19, 'Alt'], [20, 'Meta']] as const).filter(([bit]) => flags & (1 << bit)).map(([, key]) => key);
        for (const input of this.inputs) input.keystroke({ key: uniKey, modifiers: modifiers.filter(key => key !== uniKey) });
        return;
      }
      // Copy and modifier keys preserve the selected text for its shortcuts.
      if ((flags & (1 << 20)) && uniKey.toLowerCase() === 'c') return;
      if (!['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'].includes(uniKey)) this.onDismiss();
    });
    return hook;
  }
  async subscribeInput(handlers: SelectionInputHandlers): Promise<() => void> {
    if (this.disposed) throw Error('划词与键鼠监听已关闭');
    if (!systemPreferences.isTrustedAccessibilityClient(false)) throw Error('录制键鼠提示需要在系统设置允许 Lasso 辅助功能权限');
    const input = { ...handlers };
    if (!this.inputs.size) {
      this.inputStarting = true; this.inputStartError = null;
      this.inputs.add(input);
      try {
        if (this.hook?.isRunning() && !this.hook.stop()) throw Error('无法切换共享键鼠监听');
        if (this.trustTimer) { clearInterval(this.trustTimer); this.trustTimer = null; }
        this.onDismiss();
        const started = this.ensureHook().start({ enableClipboard: false, selectionPassiveMode: true, enableMouseMoveEvent: false, debug: false, globalFilterMode: SelectionHook.FilterMode.DEFAULT, globalFilterList: [] });
        if (!started || this.inputStartError) throw this.inputStartError ?? Error('原生键鼠监听未能启动');
        this.onStatus({ status: 'paused', message: '录制中，划词已暂停' });
      } catch (error) {
        this.inputs.delete(input); this.hook?.stop();
        if (this.settings) this.configure(this.settings);
        throw Error('录制键鼠监听未能启动：' + (error instanceof Error ? error.message : String(error)));
      } finally { this.inputStarting = false; this.inputStartError = null; }
    } else this.inputs.add(input);
    let released = false;
    return () => {
      if (released || this.disposed) return;
      released = true; this.inputs.delete(input);
      if (this.inputs.size) return;
      this.hook?.stop(); this.suppress();
      if (this.settings) this.configure(this.settings);
    };
  }
  private receive(data: TextSelectionData) {
    if (this.inputs.size || Date.now() < this.suppressUntil || BrowserWindow.getFocusedWindow()) return;
    if (ignoresApplication(this.ignoredApps, data.programName, 'selection')) { this.onDismiss(); return; }
    if (!data.text.trim()) { this.onDismiss(); return; }
    let anchor: SelectionContext['anchor'];
    // macOS selection-hook coordinates are already logical points, not Retina pixels.
    if (data.posLevel >= SelectionHook.PositionLevel.SEL_FULL) {
      const x = Math.min(data.startTop.x, data.endBottom.x);
      const y = Math.min(data.startTop.y, data.endBottom.y);
      anchor = { x, y, width: Math.abs(data.endBottom.x - data.startTop.x), height: Math.abs(data.endBottom.y - data.startTop.y) };
    } else {
      const mouse = data.mousePosEnd.x === SelectionHook.INVALID_COORDINATE ? screen.getCursorScreenPoint() : data.mousePosEnd;
      anchor = { x: mouse.x, y: mouse.y, width: 0, height: 0 };
    }
    this.onSelection({ text: data.text, sourceApp: data.programName, anchor });
  }
  current() {
    if (this.inputs.size || this.disposed) return;
    const data = this.hook?.getCurrentSelection();
    if (data) this.receive(data);
  }
  suppress() { this.suppressUntil = Date.now() + 500; }
  cleanup() {
    this.disposed = true; this.inputs.clear();
    if (this.trustTimer) { clearInterval(this.trustTimer); this.trustTimer = null; }
    this.hook?.cleanup();
  }
}
