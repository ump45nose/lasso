import { BrowserWindow, screen, systemPreferences } from 'electron';
import SelectionHook from 'selection-hook';
import type { TextSelectionData } from 'selection-hook';
import type { CaptureStatus, SelectionContext, Settings } from '../shared/contracts';

export class SelectionCapture {
  private hook: SelectionHook | null = null;
  private suppressUntil = 0;
  private permissionPrompted = false;
  private trustTimer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private onSelection: (selection: SelectionContext) => void,
    private onStatus: (status: CaptureStatus) => void,
    private onOutside: (point: { x: number; y: number }) => void,
    private onDismiss: () => void
  ) {}
  configure(settings: Settings) {
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
      if (!this.hook) {
        this.hook = new SelectionHook();
        this.hook.on('error', error => this.onStatus({ status: 'error', message: error.message }));
        this.hook.on('text-selection', data => this.receive(data));
        this.hook.on('mouse-down', point => this.onOutside(point));
        this.hook.on('mouse-wheel', () => this.onDismiss());
        // Editing or moving the caret invalidates the previous selection. Modifier
        // keys alone leave it intact so shortcuts can still use the selected text.
        this.hook.on('key-down', ({ uniKey, flags }) => {
          // Copy keeps the selection; clipboard fallback may also synthesize Cmd+C.
          const command = (flags & (1 << 20)) !== 0; // kCGEventFlagMaskCommand
          if (command && uniKey.toLowerCase() === 'c') return;
          if (!['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'].includes(uniKey)) this.onDismiss();
        });
      }
      const started = this.hook.start({ enableClipboard: settings.clipboardFallback, enableMouseMoveEvent: false, debug: false });
      this.onStatus(started ? { status: 'active', message: '划词已开启' } : { status: 'error', message: '划词监听未能启动，请检查辅助功能权限后重试' });
    } catch (error) { this.onStatus({ status: 'error', message: String(error) }); }
  }
  private receive(data: TextSelectionData) {
    if (Date.now() < this.suppressUntil || BrowserWindow.getFocusedWindow()) return;
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
    const data = this.hook?.getCurrentSelection();
    if (data) this.receive(data);
  }
  suppress() { this.suppressUntil = Date.now() + 500; }
  cleanup() {
    if (this.trustTimer) clearInterval(this.trustTimer);
    this.hook?.cleanup();
  }
}
