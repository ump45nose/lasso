import { memo, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, Square, ImagePlus, X, RotateCw } from 'lucide-react';
import { mergeAgentEvent } from './agent-state';
import { targetLabels, type AgentState, type AgentRequest, type AgentAnswer, type AgentEvent, type ChatMessage } from '../shared/contracts';

function RequestCard({ request, answer }: { request: AgentRequest; answer(value: AgentAnswer): Promise<void> }) {
  const [value, setValue] = useState(request.prefill || '');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return <form className="request-card" onSubmit={event => { event.preventDefault(); void answer({ value, answers, confirmed: true }); }}>
    <strong>{request.title}</strong>{request.detail && <pre>{request.detail}</pre>}
    {request.kind === 'select' ? <select aria-label={request.title} required value={value} onChange={e => setValue(e.target.value)}><option value="">请选择</option>{request.options?.map(option => <option key={option}>{option}</option>)}</select>
      : ['input', 'editor', 'json'].includes(request.kind) ? <textarea aria-label={request.title} value={value} onChange={e => setValue(e.target.value)} rows={request.kind === 'input' ? 2 : 5} />
      : request.kind === 'questions' ? request.questions?.map(q => <label key={q.id}>{q.question}{q.options?.length ? <select required value={answers[q.id] || ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })}><option value="">请选择</option>{q.options.map(o => <option key={o}>{o}</option>)}</select> : <input required type={q.secret ? 'password' : 'text'} value={answers[q.id] || ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })} />}</label>) : null}
    <div className="save-row"><button className="primary" type="submit">{request.kind === 'confirm' ? '允许这一次' : '提交回答'}</button><button className="text-button" type="button" onClick={() => void answer({ cancelled: true, confirmed: false })}>{request.kind === 'confirm' ? '拒绝' : '取消'}</button></div>
  </form>;
}
const markdownPlugins = [remarkGfm];
const markdownComponents = { a: ({ href, children }: React.ComponentProps<'a'>) => <a href={href} onClick={event => { event.preventDefault(); if (href) void window.desktop.openLink(href); }}>{children}</a> };
const MessageView = memo(function MessageView({ message, name }: { message: ChatMessage; name: string }) {
  if (message.role === 'tool') return <details className="tool-message"><summary>{message.running ? '◌ ' : '✓ '}{message.title}</summary><pre>{message.text}</pre></details>;
  return <article className={'message ' + message.role}>
    <small>{message.role === 'user' ? '你' : message.role === 'notice' ? '提示' : name}</small>
    {message.image && <img className="message-image" src={message.image} alt="已发送图片" />}
    <Markdown remarkPlugins={markdownPlugins} components={markdownComponents}>{message.text || (message.running ? '正在思考…' : '')}</Markdown>
  </article>;
});
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
  if (!state) return <div className="agent-loading">正在连接 CLI…</div>;
  const busy = ['running', 'waiting'].includes(state.activity);
  const send = async () => {
    await window.desktop.agentDraft(taskId, currentDraft.current); await result(window.desktop.agentSend(taskId));
  };
  return <section className="agent-chat">
    <div className="agent-meta"><strong>{targetLabels[state.target]}</strong><span title={state.cwd}>{state.cwd}</span><button className="text-button" title="刷新模型选项" disabled={state.modelsLoading} onClick={() => void result(window.desktop.agentRefreshModels(taskId))}><RotateCw size={14} className={state.modelsLoading ? 'spinner' : ''} /></button></div>
    <div className="messages" ref={scroll} onScroll={() => { const el = scroll.current!; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      {!state.messages.length && <div className="agent-welcome"><h2>在这里接着聊。</h2><p>沿用 {targetLabels[state.target]} 的配置与工具。</p>{state.target === 'pi' && <p className="hint">Pi 沿用本机执行权限；终端专属扩展界面不在小窗显示。</p>}</div>}
      {state.messages.map(message => <MessageView key={message.id} message={message} name={targetLabels[state.target]} />)}
      {state.requests.map(request => <RequestCard key={request.id} request={request} answer={async answer => { await result(window.desktop.agentAnswer(taskId, request.id, answer)); }} />)}
    </div>
    {(error || state.error || state.modelsError) && <div role="alert" className="agent-error"><span>{error || state.error || state.modelsError}</span>{!state.resident && <button title="恢复原会话" onClick={() => { setError(''); void window.desktop.act('reload'); }}><RotateCw size={16} /></button>}</div>}
    {state.status && <p className="agent-status" role="status">{state.status}</p>}
    <form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}>
      {state.image && <div className="composer-image"><img src={state.image.thumbnail} alt="待发送图片" /><button type="button" title="移除图片" onClick={() => void window.desktop.removeImage(taskId)}><X size={14} /></button></div>}
      <textarea aria-label="发送给本地 agent" placeholder={busy ? '可以先写下一条，任务结束后发送…' : '问一句，或粘贴一张截图…'} value={draft} onChange={event => {
        const text = event.target.value; currentDraft.current = text; setDraft(text);
        void window.desktop.agentDraft(taskId, text);
      }} onBlur={() => { void window.desktop.agentDraft(taskId, currentDraft.current); }}
        onPaste={event => { if (!busy && [...event.clipboardData.items].some(i => i.type.startsWith('image/'))) { event.preventDefault(); void result(window.desktop.readImage(taskId)); } }}
        onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !busy) { event.preventDefault(); void send(); } }} />
      <div className="execution-toolbar">
        <select aria-label="当前模型" disabled={busy || state.controlsBusy || state.modelsLoading} value={state.model} onChange={event => void result(window.desktop.agentModel(taskId, event.target.value))}>
          {!state.models.some(model => model.id === state.model) && <option value={state.model}>{state.model || 'CLI 默认模型'}</option>}{state.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
        <select aria-label="当前思考强度" disabled={busy || state.controlsBusy || !state.efforts.length} value={state.effort} onChange={event => void result(window.desktop.agentEffort(taskId, event.target.value))}>
          {!state.efforts.includes(state.effort) && <option value={state.effort} disabled>{state.effort || '默认强度'}</option>}{state.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      </div>
      <div className="composer-actions"><button type="button" disabled={busy} className="icon-button" title="使用剪贴板图片" onClick={() => void result(window.desktop.readImage(taskId))}><ImagePlus size={18} /></button><span className="hint">⌘ Enter 发送</span>
        {busy ? <button type="button" className="primary" onClick={() => void result(window.desktop.agentStop(taskId))}><Square size={13} /> 停止</button> : <button className="primary" disabled={state.controlsBusy || (!draft.trim() && !state.image)} type="submit"><ArrowUp size={16} /> 发送</button>}
      </div>
    </form>
  </section>;
}
