import { BrowserWindow, screen, systemPreferences } from 'electron';
import SelectionHook from 'selection-hook';
import type { TextSelectionData } from 'selection-hook';
import type { CaptureStatus, SelectionContext, Settings } from '../shared/contracts';

export class SelectionCapture {
  private hook: SelectionHook | null = null;
  private suppressUntil = 0;
  constructor(
    private onSelection: (selection: SelectionContext) => void,
    private onStatus: (status: CaptureStatus) => void,
    private onOutside: (point: { x: number; y: number }) => void,
    private onDismiss: () => void
  ) {}
  configure(settings: Settings) {
    this.hook?.stop();
    this.onDismiss();
    if (!settings.selectionEnabled) return this.onStatus({ status: 'paused', message: '划词已暂停' });
    if (!systemPreferences.isTrustedAccessibilityClient(false)) return this.onStatus({ status: 'permission', message: '需要辅助功能权限才能读取选中文字' });
    try {
      if (!this.hook) {
        this.hook = new SelectionHook();
        this.hook.on('error', error => this.onStatus({ status: 'error', message: error.message }));
        this.hook.on('text-selection', data => this.receive(data));
        this.hook.on('mouse-down', point => this.onOutside(point));
        this.hook.on('mouse-wheel', () => this.onDismiss());
        this.hook.on('key-down', ({ uniKey }) => { if (uniKey === 'Escape') this.onDismiss(); });
      }
      const started = this.hook.start({ enableClipboard: settings.clipboardFallback, enableMouseMoveEvent: false, debug: false });
      this.onStatus(started ? { status: 'active', message: '划词已开启' } : { status: 'error', message: '划词监听未能启动，请检查辅助功能权限后重试' });
    } catch (error) { this.onStatus({ status: 'error', message: String(error) }); }
  }
  private receive(data: TextSelectionData) {
    if (Date.now() < this.suppressUntil || BrowserWindow.getFocusedWindow() || !data.text.trim()) return;
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
  cleanup() { this.hook?.cleanup(); }
}
