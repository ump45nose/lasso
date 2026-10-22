import type { WebContents } from 'electron';
import type { TaskActivity } from '../../shared/contracts';
import { setTimeout as delay } from 'node:timers/promises';

export interface PageSnapshot {
  url: string;
  title: string;
  ready: boolean;
  login: boolean;
  draft: string;
  running: boolean;
  userMessages: number;
  emptyHome: boolean;
  canSend: boolean;
  activity: TaskActivity;
  hasDraft: boolean;
  restoreUrl: string | null;
  lastInputAt: number;
  progress: string;
  responseId: string | null;
  historyLoaded: boolean;
  recoveryError: boolean;
  refusal?: string;
  clicked?: boolean;
}
// This function runs in the website. Keep site-specific DOM knowledge here.
function pageBridge(command: 'read' | 'focus' | 'clear-new' | 'retry-restore' | 'submit', expected = ''): PageSnapshot {
  // Isolated-world state observes interaction without exposing a local IPC bridge to the site.
  const context = window as Window & { __quickAskActivity?: { lastInputAt: number } };
  if (!context.__quickAskActivity) {
    const activity = context.__quickAskActivity = { lastInputAt: 0 };
    for (const name of ['pointerdown', 'keydown', 'input', 'change', 'wheel', 'submit']) {
      document.addEventListener(name, event => { if (event.isTrusted) activity.lastInputAt = Date.now(); }, { capture: true, passive: true });
    }
  }
  const visible = (e: Element) => e.getClientRects().length > 0;
  const normalize = (value: string) => value.replace(/\r\n?/g, '\n');
  const editors = [...document.querySelectorAll<HTMLElement>('#prompt-textarea, [data-composer-markdown][contenteditable="true"], .ProseMirror[contenteditable="true"][role="textbox"]')].filter(visible);
  const editor = editors.length === 1 ? editors[0] : null;
  const form = editor?.closest('form');
  const textOf = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    const element = node as HTMLElement;
    if (element.tagName === 'BR') return element.classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
    const children = [...node.childNodes];
    const hasBlocks = children.some(child => child instanceof HTMLElement && ['P', 'DIV'].includes(child.tagName));
    return children.map(textOf).join(hasBlocks ? '\n' : '');
  };
  const draft = editor ? normalize(editor instanceof HTMLTextAreaElement ? editor.value : textOf(editor)) : '';
  const login = location.hostname !== 'chatgpt.com' || [...document.querySelectorAll('button, a')].some(e => visible(e) && /^(登录|登录或注册|Log in|Sign in)$/i.test(e.textContent?.trim() || ''));
  const buttons = [...(form?.querySelectorAll<HTMLButtonElement>('button') || [])];
  const stop = buttons.find(button => visible(button) && (button.matches('[data-testid="stop-button"]') || /^(停止|Stop)(生成|流式传输|回答| generating| streaming| response)?$/i.test(button.getAttribute('aria-label') || '')));
  const send = form?.querySelector<HTMLButtonElement>('[data-testid="send-button"], button[type="submit"]') || null;
  const turns = [...document.querySelectorAll<HTMLElement>('[data-talvt-turn-state]')];
  const lastTurn = turns.at(-1);
  const turnState = lastTurn?.getAttribute('data-talvt-turn-state');
  const attachments = Boolean(form && (
    [...form.querySelectorAll('[data-composer-attachments]')].some(element => visible(element) && element.childElementCount > 0)
    || form.querySelector('[data-testid*="attachment"], [data-testid*="file-thumbnail"], [aria-label*="Remove"], [aria-label*="移除"], img')
    || [...form.querySelectorAll<HTMLInputElement>('input[type="file"]')].some(input => input.files?.length)
  ));
  const waiting = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"]')].some(visible)
    || [...(lastTurn?.querySelectorAll('button') || [])].some(button => visible(button) && /^(确认|允许|继续|重试|Confirm|Allow|Continue|Retry)$/i.test(button.textContent?.trim() || ''));
  const ready = Boolean(editor && !login);
  const running = Boolean(stop) || ['streaming', 'in_progress', 'running'].includes(turnState || '');
  const hasDraft = Boolean(draft || attachments);
  const emptyHome = Boolean(ready && !hasDraft && location.pathname === '/' && !running && !waiting);
  const activity: TaskActivity = !ready ? (login ? 'waiting' : 'unknown') : running ? 'running' : waiting ? 'waiting'
    : hasDraft ? 'draft' : turnState === 'complete' ? 'complete' : emptyHome ? 'idle' : 'unknown';
  const restoreUrl = location.protocol === 'https:' && location.hostname === 'chatgpt.com' && /^(?:\/g\/[^/]+)?\/c\/[a-zA-Z0-9-]+\/?$/.test(location.pathname)
    ? location.origin + location.pathname : null;
  const conversationId = restoreUrl?.split('/').filter(Boolean).at(-1);
  const historyRequests = conversationId ? performance.getEntriesByType('resource').filter(entry => {
    const path = new URL(entry.name).pathname;
    return [`/backend-api/conversations/${conversationId}`, `/backend-api/conversation/${conversationId}`].includes(path);
  }) as PerformanceResourceTiming[] : [];
  const historyLoaded = historyRequests.at(-1)?.responseStatus === 200;
  const recoveryError = !ready && /无法加载此.*对话|Unable to load (?:this )?(?:ChatGPT )?conversation/i.test(document.querySelector('main')?.textContent || '');
  const userBubbles = document.querySelectorAll('[data-user-message-bubble]');
  const snapshot: PageSnapshot = {
    url: location.href, title: document.title, ready, login, draft, running, hasDraft,
    userMessages: userBubbles.length || document.querySelectorAll('[data-message-author-role="user"]').length,
    emptyHome, activity, restoreUrl, historyLoaded, recoveryError, lastInputAt: context.__quickAskActivity.lastInputAt,
    progress: `${lastTurn?.getAttribute('data-content-search-turn-key') || ''}:${turnState || ''}:${lastTurn?.textContent?.length || 0}`,
    responseId: [...(lastTurn?.querySelectorAll('[data-chatgpt-selection-message-id]') || [])].at(-1)?.getAttribute('data-chatgpt-selection-message-id') || null,
    canSend: Boolean(send && visible(send) && !send.disabled && send.getAttribute('aria-disabled') !== 'true')
  };
  if (command === 'read') return snapshot;
  if (command === 'retry-restore') {
    const retry = [...(document.querySelector('main')?.querySelectorAll<HTMLButtonElement>('button') || [])]
      .find(button => visible(button) && /^(再试一次|重试|Try again|Retry)$/i.test(button.textContent?.trim() || ''));
    if (recoveryError && retry) { retry.click(); return { ...snapshot, clicked: true }; }
    return snapshot;
  }
  if (!snapshot.ready || !editor) return { ...snapshot, refusal: '网页输入框尚未就绪' };
  if (command === 'focus' || command === 'clear-new') {
    if (location.pathname !== '/') return { ...snapshot, refusal: '当前不是新对话，已停止填入，避免混入已有会话' };
    if (command === 'focus' && draft) return { ...snapshot, refusal: '网页里已有草稿，请先处理草稿，再运行预设' };
    editor.focus();
    if (editor instanceof HTMLTextAreaElement) editor.setSelectionRange(0, command === 'clear-new' ? editor.value.length : 0);
    else {
      const range = document.createRange(); range.selectNodeContents(editor); if (command !== 'clear-new') range.collapse(false);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    }
    if (command === 'clear-new' && draft) document.execCommand('delete');
    return snapshot;
  }
  if (draft !== normalize(expected)) return { ...snapshot, refusal: '网页内容已变动，已停止自动发送，请在网页中确认' };
  if (!snapshot.canSend || !send) return { ...snapshot, refusal: '网页发送按钮不可用，请在网页中确认内容或限制提示' };
  send.click();
  return { ...snapshot, clicked: true };
}

export class ChatGPTAdapter {
  private submitAttempted = false;
  constructor(private contents: WebContents) {}
  private read(command: 'read' | 'focus' | 'clear-new' | 'retry-restore' | 'submit' = 'read', expected = ''): Promise<PageSnapshot> {
    return this.contents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${pageBridge.toString()})(${JSON.stringify(command)}, ${JSON.stringify(expected)})` }]);
  }
  snapshot() { return this.read(); }
  async waitReady(signal: AbortSignal, onLogin: (login: boolean) => void) {
    let loadingSince = Date.now();
    while (!signal.aborted) {
      const result = await this.read();
      onLogin(result.login);
      if (result.ready) return;
      if (result.login) loadingSince = Date.now();
      else if (Date.now() - loadingSince > 45_000) throw new Error('未找到可编辑的 ChatGPT 输入框。请检查网页是否加载完成；原文仍保留。');
      await delay(500, undefined, { signal });
    }
    signal.throwIfAborted();
  }
  async waitRestored(url: string, responseId: string, signal: AbortSignal) {
    let retried = false;
    let matched = false;
    while (!signal.aborted) {
      const saved = await this.read();
      const complete = saved.historyLoaded && saved.activity === 'complete' && saved.restoreUrl === url && saved.responseId === responseId;
      // History fetch can finish while the UI still briefly shows a cached turn.
      if (complete && matched) return;
      matched = complete;
      if (saved.recoveryError && saved.historyLoaded && !retried) {
        signal.throwIfAborted();
        retried = true;
        await this.read('retry-restore'); // Website's retry only reloads saved history; no prompt is sent.
      }
      await delay(500, undefined, { signal });
    }
    signal.throwIfAborted();
  }
  async clearNewDraft(signal: AbortSignal) {
    signal.throwIfAborted();
    const before = await this.read('clear-new');
    if (before.refusal) throw new Error(before.refusal);
    if (before.draft) {
      // Only called on an app-created, not-yet-exposed new page. Other tasks keep their editors.
      await delay(100, undefined, { signal });
    }
    const after = await this.read();
    if (after.hasDraft) throw new Error('新页面仍有网站恢复的草稿或附件，请在网页中处理；尚未发送。');
  }
  async fill(text: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const result = await this.read('focus');
    if (result.refusal) throw new Error(result.refusal);
    signal.throwIfAborted();
    // Native Chromium text insertion updates the site's editor without using the clipboard.
    await this.contents.insertText(text);
    await delay(100, undefined, { signal });
    const actual = await this.read();
    if (actual.draft !== text.replace(/\r\n?/g, '\n')) throw new Error('网页未完整接收文本，已停止自动发送。可复制保留的原文后在网页处理。');
  }
  async submit(text: string, signal: AbortSignal) {
    if (this.submitAttempted) throw new Error('已尝试提交，不会重复发送');
    let snapshot = await this.read();
    const deadline = Date.now() + 5000;
    while (!snapshot.canSend && Date.now() < deadline) {
      await delay(200, undefined, { signal });
      snapshot = await this.read();
    }
    signal.throwIfAborted();
    this.submitAttempted = true;
    const before = await this.read('submit', text);
    if (before.refusal) throw new Error(before.refusal);
    const submittedBy = Date.now() + 10_000;
    while (Date.now() < submittedBy) {
      await delay(300, undefined, { signal });
      const after = await this.read();
      if (!after.draft && (after.running || after.userMessages > before.userMessages || /\/c\//.test(after.url))) return;
    }
    throw new Error('已经点击发送，但未能确认提交结果。请查看网页，不会自动重发。');
  }
}
