import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';

export const result = async (action: () => unknown) => { try { await action(); return { error: null }; } catch (error) { return { error: (error as Error).message }; } };
export const fromMainFrame = (event: IpcMainEvent | IpcMainInvokeEvent, win: BrowserWindow | null | undefined) => !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
export const sealLocal = (contents: WebContents) => { contents.setWindowOpenHandler(() => ({ action: 'deny' })); contents.on('will-navigate', event => event.preventDefault()); };
// The application menu binds Cmd+W to the launcher. Close this window instead,
// including when one of its text fields has keyboard focus.
export const closeOnCommandW = (win: BrowserWindow) => { win.webContents.on('before-input-event', (event, input) => { if (input.type === 'keyDown' && input.meta && !input.control && !input.alt && !input.shift && input.key.toLowerCase() === 'w') { event.preventDefault(); win.close(); } }); };
