import type { WebContents } from 'electron';
import { ChatGPTAdapter, type PageSnapshot, type PageCommand } from './chatgpt';
function geminiBridge(command: PageCommand, expected = ''): PageSnapshot {
  const visible = (node: Element) => node.getClientRects().length > 0;
  const normalize = (text: string) => text.replace(/\r\n?/g, '\n');
  const context = window as Window & { __quickAskActivity?: { lastInputAt: number } };
  if (!context.__quickAskActivity) {
    const activity = context.__quickAskActivity = { lastInputAt: 0 };
    for (const name of ['pointerdown', 'keydown', 'input', 'change', 'wheel']) document.addEventListener(name, event => { if (event.isTrusted) activity.lastInputAt = Date.now(); }, { capture: true, passive: true });
  }
  const editors = [...document.querySelectorAll<HTMLElement>('rich-textarea .ql-editor[contenteditable="true"], rich-textarea [role="textbox"][contenteditable="true"]')].filter(visible);
  const editor = editors.length === 1 ? editors[0] : null;
  const input = editor?.closest('input-container') || editor?.closest('form') || editor?.parentElement?.parentElement;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(visible);
  const label = (button: HTMLElement) => (button.getAttribute('aria-label') || button.textContent || '').trim();
  const send = buttons.find(b => b.matches('button.send-button, [data-test-id="send-button"]') && !/stop|停止/i.test(label(b))) || buttons.find(b => /^(发送|提交|Send message|Send|Submit)$/i.test(label(b)));
  const running = buttons.some(b => b.matches('[data-test-id="stop-button"]') || /停止回答|停止生成|Stop response|Stop generating/i.test(label(b)));
  const login = location.hostname === 'accounts.google.com' || buttons.some(b => /^(登录|Sign in)$/i.test(label(b))) || Boolean(document.querySelector('a[href*="accounts.google.com/ServiceLogin"]'));
  // Quill stores each logical line in a block; innerText uses visual paragraph
  // spacing and collapses empty lines, so it cannot verify lossless input.
  const textOf = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    const element = node as HTMLElement;
    if (element.tagName === 'BR') return '\n';
    if (element.childNodes.length === 1 && element.firstChild instanceof HTMLBRElement) return '';
    const children = [...node.childNodes];
    const blocks = children.some(child => child instanceof HTMLElement && ['P', 'DIV'].includes(child.tagName));
    return children.map(textOf).join(blocks ? '\n' : '');
  };
  const draft = editor ? textOf(editor).replace(/\r\n?/g, '\n') : '';
  const responses = [...document.querySelectorAll<HTMLElement>('model-response')];
  const last = responses.at(-1);
  const completed = Boolean(last && [...last.querySelectorAll<HTMLElement>('button, [role="button"]')].some(b => /复制|Copy|重新生成|Regenerate|Good response|Bad response/i.test(label(b))));
  const attachment = input?.querySelector('file-preview, uploaded-file, [data-test-id="file-preview"], .file-preview, .attachment-container, img[alt="attachment"]');
  const uploading = Boolean(input && [...input.querySelectorAll('mat-progress-spinner, [role="progressbar"], .uploading')].some(visible));
  const hasAttachment = Boolean(attachment && visible(attachment));
  const uploadError = [...(input?.querySelectorAll('[role="alert"], .error-message') || [])].filter(visible).map(e => e.textContent).join('\n');
  const ready = Boolean(editor && !login);
  const temporary = Boolean(document.querySelector('chat-window.is-temporary-chat'));
  const restoreUrl = !temporary && location.hostname === 'gemini.google.com' && /^\/app\/[\w-]+$/.test(location.pathname) ? location.origin + location.pathname : null;
  const responseId = last?.getAttribute('data-response-id') || last?.id || (last?.innerText.trim() || null);
  const waiting = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(visible);
  const hasDraft = Boolean(draft || hasAttachment || uploading);
  const snapshot: PageSnapshot = {
    url: location.href, title: document.title, ready, login, draft, running, hasDraft,
    userMessages: document.querySelectorAll('user-query').length, emptyHome: ready && !restoreUrl && !hasDraft && !running,
    canSend: Boolean(send && !send.disabled && send.getAttribute('aria-disabled') !== 'true'),
    activity: !ready ? login ? 'waiting' : 'unknown' : running ? 'running' : waiting ? 'waiting' : hasDraft ? 'draft' : completed ? 'complete' : !restoreUrl ? 'idle' : 'unknown',
    restoreUrl, responseId, historyLoaded: Boolean(restoreUrl && last && completed), recoveryError: false, temporary,
    lastInputAt: context.__quickAskActivity.lastInputAt, progress: `${responses.length}:${last?.innerText.length || 0}:${running}`,
    attachmentReady: hasAttachment && !uploading && !uploadError && Boolean(send && !send.disabled && send.getAttribute('aria-disabled') !== 'true'), attachmentPresent: hasAttachment, uploadError
  };
  if (command === 'read' || command === 'retry-restore') return snapshot;
  if (!ready || !editor) return { ...snapshot, refusal: 'Gemini 输入框尚未就绪，请先完成登录。' };
  if (command === 'temporary') {
    if (temporary) return snapshot;
    if (snapshot.userMessages || snapshot.hasDraft) return { ...snapshot, refusal: '当前不是空白新对话，已停止切换临时对话。' };
    const toggle = buttons.find(button => /^(临时对话|临时聊天|Temporary chat)$/i.test(button.getAttribute('aria-label') || ''));
    if (!toggle) return { ...snapshot, refusal: '此账号没有可用的 Gemini 临时对话入口；尚未填入或发送。' };
    toggle.click(); return snapshot;
  }
  if (command === 'attachment') {
    const upload = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="button"], button')].find(b => visible(b) && /(?:^|\s)(文件|Files|上传文件|Upload files|Upload from computer)$/i.test(label(b)));
    if (upload) upload.click();
    else buttons.find(b => b.getAttribute('aria-expanded') !== 'true' && /添加文件|上传文件|上传和工具|Add files|Upload files|Uploads and tools/i.test(label(b)))?.click();
    return snapshot;
  }
  if (command === 'focus' || command === 'clear-new') {
    if (restoreUrl) return { ...snapshot, refusal: '当前不是新对话，已停止填入。' };
    if (command === 'focus' && draft) return { ...snapshot, refusal: 'Gemini 已有草稿，请先在网页处理。' };
    editor.focus(); const range = document.createRange(); range.selectNodeContents(editor);
    if (command === 'focus') range.collapse(false);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    if (command === 'clear-new' && draft) document.execCommand('delete');
    return snapshot;
  }
  if (draft !== normalize(expected)) return { ...snapshot, refusal: '网页内容已改变，已停止自动发送。' };
  if (!snapshot.canSend || !send) return { ...snapshot, refusal: 'Gemini 发送按钮不可用，请在网页检查。' };
  send.click(); return { ...snapshot, clicked: true };
}
export class GeminiAdapter extends ChatGPTAdapter {
  constructor(contents: WebContents) { super(contents, geminiBridge, 'gemini'); }
}
