import { app, BrowserWindow } from 'electron';

const windows = new Map<BrowserWindow, boolean>();
let policy: 'regular' | 'accessory' = 'accessory';
let quitting = false;

function refresh() {
  if (quitting) return;
  let hasContent = false;
  for (const [window, content] of windows) {
    const open = !app.isHidden() && (window.isVisible() || window.isMinimized());
    window.excludedFromShownWindowsMenu = !content || !open;
    hasContent ||= content && open;
  }
  const next = hasContent ? 'regular' : 'accessory';
  if (next !== policy) { policy = next; app.setActivationPolicy(next); }
}

/** Only open content windows participate in the Dock and macOS window menu. */
export function setWindowPresence(window: BrowserWindow, content: boolean) {
  if (!windows.has(window)) {
    window.on('show', refresh);
    window.on('hide', refresh);
    window.on('minimize', refresh);
    window.on('restore', refresh);
    window.on('closed', () => { windows.delete(window); refresh(); });
  }
  windows.set(window, content);
  refresh();
}

export function initializeWindowPresence() {
  app.setActivationPolicy('accessory');
  app.on('browser-window-created', (_event, window) => setWindowPresence(window, Boolean(window.getParentWindow())));
  app.on('did-become-active', refresh);
  app.on('did-resign-active', () => setImmediate(refresh));
  app.prependListener('before-quit', () => { quitting = true; });
}
