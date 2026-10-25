import { memo, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, Check, ChevronDown, CircleAlert, Folder, Image, RotateCw, Terminal, X } from 'lucide-react';
import { mergeAgentEvent } from './agent-state';
import { folderName } from './targets';
import { targetLabels, type AgentState, type AgentRequest, type AgentAnswer, type AgentEvent, type ChatMessage } from '../shared/contracts';

function RequestCard({ request, answer }: { request: AgentRequest; answer(value: AgentAnswer): Promise<void> }) {
  const [value, setValue] = useState(request.prefill || '');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const confirm = request.kind === 'confirm';
  return <form className="l-req" aria-label="审批请求" onSubmit={event => { event.preventDefault(); void answer({ value, answers, confirmed: true }); }}>
    <div className="l-req-head"><Terminal size={14} /><span>{request.title}</span><span className="l-req-state"><span className="dot waiting" />等待你</span></div>
    <div className="l-req-body">
      {request.detail && <div className="l-req-code"><code>{request.detail}</code></div>}
      {request.kind === 'select' ? <select className="l-select" aria-label={request.title} required value={value} onChange={e => setValue(e.target.value)}><option value="">请选择</option>{request.options?.map(option => <option key={option}>{option}</option>)}</select>
        : ['input', 'editor', 'json'].includes(request.kind) ? <textarea className={'l-textarea' + (request.kind === 'json' ? ' mono' : '')} aria-label={request.title} value={value} onChange={e => setValue(e.target.value)} rows={request.kind === 'input' ? 2 : 5} />
        : request.kind === 'questions' ? request.questions?.map(q => <label key={q.id} className="l-field"><span className="l-field-label">{q.question}</span>{q.options?.length
          ? <select className="l-select" required value={answers[q.id] || ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })}><option value="">请选择</option>{q.options.map(o => <option key={o}>{o}</option>)}</select>
          : <input className="l-input" required type={q.secret ? 'password' : 'text'} value={answers[q.id] || ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })} />}</label>) : null}
    </div>
    <div className="l-req-actions"><button className="l-btn primary" type="submit">{confirm ? '允许这一次' : '提交回答'}</button><button className="l-btn" type="button" onClick={() => void answer({ cancelled: true, confirmed: false })}>{confirm ? '拒绝' : '取消'}</button></div>
  </form>;
}
const markdownPlugins = [remarkGfm];
const markdownComponents = { a: ({ href, children }: React.ComponentProps<'a'>) => <a href={href} onClick={event => { event.preventDefault(); if (href) void window.desktop.openLink(href); }}>{children}</a> };
const MessageView = memo(function MessageView({ message }: { message: ChatMessage }) {
  if (message.role === 'user') return <div className="l-user-wrap">
    {message.image && <div className="l-thumb"><img src={message.image} alt="已发送图片" /></div>}
    {message.text && <p className="l-user">{message.text}</p>}
  </div>;
  if (message.role === 'notice') return <p className="l-notice-msg">{message.text}</p>;
  return <article className="l-answer">
    {message.text ? <Markdown remarkPlugins={markdownPlugins} components={markdownComponents}>{message.text}</Markdown> : message.running && <p className="l-notice-msg">正在思考…</p>}
    {message.running && <span className="l-caret" aria-hidden="true" />}
  </article>;
});
/** Consecutive tool calls collapse into one line; it stays open while a step runs unless the user closed it. */
function Ledger({ tools }: { tools: ChatMessage[] }) {
  const running = tools.some(tool => tool.running);
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? running;
  const title = running ? `正在运行 · ${[...tools].reverse().find(tool => tool.running)!.title}` : `${tools.length} 个工具步骤`;
  return <div className="l-ledger">
    <button type="button" aria-expanded={expanded} onClick={() => setOpen(!expanded)}><ChevronDown size={12} />{title}</button>
    {expanded && <ul>{tools.map(tool => <li key={tool.id}><details><summary>{tool.running ? <span className="dot running" /> : <Check size={12} className="ok" />}<span>{tool.title}</span></summary>{tool.text && <pre>{tool.text}</pre>}</details></li>)}</ul>}
  </div>;
}
function groupMessages(messages: ChatMessage[]) {
  const out: (ChatMessage | ChatMessage[])[] = [];
  for (const message of messages) {
    const last = out.at(-1);
    if (message.role !== 'tool') out.push(message);
    else if (Array.isArray(last)) last.push(message);
    else out.push([message]);
  }
  return out;
}
export function AgentChat({ taskId }: { taskId: string }) {
  const [state, setState] = useState<AgentState | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const currentDraft = useRef('');
  useEffect(() => {
    let disposed = false; let loaded = false; let pending: AgentEvent[] = [];
    const off = window.desktop.onAgent(event => {
      if (event.taskId !== taskId || disposed) return;
      if (!loaded) pending.push(event); else setState(old => old ? mergeAgentEvent(old, event) : old);
    });
    void window.desktop.getAgent(taskId).then(snapshot => {
      if (disposed || !snapshot) return;
      for (const event of pending) snapshot = mergeAgentEvent(snapshot, event);
      pending = []; loaded = true; setState(snapshot);
    });
    return () => { disposed = true; off(); };
  }, [taskId]);
  useEffect(() => {
    if (!state) return;
    currentDraft.current = state.draft; setDraft(state.draft);
  }, [state?.draftRevision]);
  useEffect(() => {
    if (!follow.current || !scroll.current) return;
    const frame = requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [state?.messages, state?.requests]);
  const result = async (operation: Promise<{ error: string | null }>) => { const r = await operation; setError(r.error || ''); };
  if (!state) return <div className="l-empty"><p>正在连接 CLI…</p></div>;
  const name = targetLabels[state.target];
  const busy = ['running', 'waiting'].includes(state.activity);
  const locked = busy || state.controlsBusy;
  const send = async () => {
    await window.desktop.agentDraft(taskId, currentDraft.current); await result(window.desktop.agentSend(taskId));
  };
  const alert = error || state.error || state.modelsError;
  const modelLabel = state.models.find(model => model.id === state.model)?.label || state.model || 'CLI 默认模型';
  return <section className="l-chat l-surface-enter">
    <div className="l-msgs" ref={scroll} onScroll={() => { const el = scroll.current!; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      {!state.messages.length && <div className="l-welcome"><h2>在这里接着聊。</h2><p>沿用 {name} 的登录、模型、工具与权限设置。工作目录：<span className="mono l-small">{state.cwd}</span></p>{state.target === 'pi' && <p className="l-small">Pi 沿用本机执行权限；终端专属扩展界面不在小窗显示。</p>}</div>}
      {groupMessages(state.messages).map(item => Array.isArray(item) ? <Ledger key={item[0].id} tools={item} /> : <MessageView key={item.id} message={item} />)}
      {state.requests.map(request => <RequestCard key={request.id} request={request} answer={async answer => { await result(window.desktop.agentAnswer(taskId, request.id, answer)); }} />)}
    </div>
    {alert && <div role="alert" className="l-banner"><CircleAlert size={14} /><span>{alert}</span>{!state.resident && <button className="l-text-btn" onClick={() => { setError(''); void window.desktop.act('reload'); }}>立即恢复</button>}</div>}
    {state.status && <p className="l-chat-status" role="status">{state.status}</p>}
    <form className="l-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
      {state.image && <div className="l-thumb"><img src={state.image.thumbnail} alt="待发送图片" /><button type="button" aria-label="移除图片" title="移除图片" onClick={() => void window.desktop.removeImage(taskId)}><X size={12} /></button></div>}
      <textarea aria-label={'发送给 ' + name} rows={2} placeholder={busy ? '可以先写下一条，任务结束后发送…' : '问一句，或粘贴一张截图…'} value={draft} onChange={event => {
        const text = event.target.value; currentDraft.current = text; setDraft(text);
        void window.desktop.agentDraft(taskId, text);
      }} onBlur={() => { void window.desktop.agentDraft(taskId, currentDraft.current); }}
        onPaste={event => { if (!busy && [...event.clipboardData.items].some(i => i.type.startsWith('image/'))) { event.preventDefault(); void result(window.desktop.readImage(taskId)); } }}
        onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !busy) { event.preventDefault(); void send(); } }} />
      <div className="l-composer-row">
        <span className="l-chip mono" title={'工作目录：' + state.cwd + '（新任务可在 ⌘K 里选择）'}><Folder size={12} />{folderName(state.cwd) || '~'}</span>
        <label className="l-chip l-chip-select" title="模型"><span className="l-chip-text">{modelLabel}</span><ChevronDown size={12} />
          <select aria-label="当前模型" disabled={locked || state.modelsLoading} value={state.model} onChange={event => void result(window.desktop.agentModel(taskId, event.target.value))}>
            {!state.models.some(model => model.id === state.model) && <option value={state.model}>{state.model || 'CLI 默认模型'}</option>}{state.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select></label>
        <label className="l-chip l-chip-select" title="思考强度">强度 · {state.effort || '默认'}<ChevronDown size={12} />
          <select aria-label="当前思考强度" disabled={locked || !state.efforts.length} value={state.effort} onChange={event => void result(window.desktop.agentEffort(taskId, event.target.value))}>
            {!state.efforts.includes(state.effort) && <option value={state.effort} disabled>{state.effort || '默认强度'}</option>}{state.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
          </select></label>
        <button type="button" className="l-icon l-icon-sm" aria-label="刷新模型选项" title="刷新模型选项" disabled={state.modelsLoading} onClick={() => void result(window.desktop.agentRefreshModels(taskId))}><RotateCw size={13} className={state.modelsLoading ? 'l-spin' : ''} /></button>
        <button type="button" className="l-icon push" aria-label="使用剪贴板图片" title="使用剪贴板图片" disabled={busy} onClick={() => void result(window.desktop.readImage(taskId))}><Image size={16} /></button>
        {busy ? <button type="button" className="l-stop" onClick={() => void result(window.desktop.agentStop(taskId))}><i />停止</button>
          : <button className="l-send" type="submit" aria-label="发送" title="发送 ⌘↵" disabled={state.controlsBusy || (!draft.trim() && !state.image)}><ArrowUp size={16} /></button>}
      </div>
    </form>
  </section>;
}
