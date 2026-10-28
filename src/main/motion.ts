import { BrowserWindow, systemPreferences, type WebContents } from 'electron';

/** Animate the native window as a whole so embedded webpages stay in sync. */
export class WindowMotion {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private window: BrowserWindow) {}
  private cancel() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private fade(to: number, done?: () => void) {
    this.cancel();
    if (this.window.isDestroyed()) return;
    if (systemPreferences.getAnimationSettings().prefersReducedMotion) { this.window.setOpacity(to); done?.(); return; }
    const from = this.window.getOpacity(); const started = Date.now();
    if (from === to) { done?.(); return; }
    this.timer = setInterval(() => {
      if (this.window.isDestroyed()) { this.cancel(); return; }
      const progress = Math.min(1, (Date.now() - started) / (to === 1 ? 240 : 150));
      this.window.setOpacity(from + (to - from) * (0.5 - Math.cos(Math.PI * progress) / 2));
      if (progress === 1) { this.cancel(); done?.(); }
    }, 16);
  }
  show(inactive = false) {
    if (this.window.isDestroyed()) return;
    const hidden = !this.window.isVisible();
    if (hidden) this.window.setOpacity(0);
    if (inactive) this.window.showInactive(); else this.window.show();
    this.fade(1);
  }
  hide(immediate = false) { if (immediate) { this.cancel(); if (!this.window.isDestroyed()) this.window.hide(); } else if (!this.window.isDestroyed() && this.window.isVisible()) this.fade(0, () => this.window.hide()); }
  dispose() { this.cancel(); }
}

/** Native WebContentsView sits above React; animate that document on reveal. */
export function revealPage(contents: WebContents) {
  if (contents.isDestroyed() || systemPreferences.getAnimationSettings().prefersReducedMotion) return;
  void contents.executeJavaScriptInIsolatedWorld(1001, [{ code: `
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.documentElement.animate([
        { opacity: 0, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'translateY(0)' }
      ], { duration: 280, easing: 'cubic-bezier(.22,.68,0,1)' });
    }
  ` }]).catch(() => {});
}
