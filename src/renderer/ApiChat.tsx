import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUp,
  Check,
  ChevronsUpDown,
  CircleAlert,
  Copy,
  Eraser,
  ImagePlus,
  PenLine,
  Pin,
  Plug,
  RotateCcw,
  Settings2,
  Square,
  X
} from 'lucide-react';
import type { ApiChatMessage, ApiChatState, ShellState } from '../shared/contracts';

function CodeBlock({ children, inline }: { children?: React.ReactNode; inline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const raw = String(children ?? '').replace(/\n$/, '');
  if (inline) {
    return <code className="l-inline-code mono">{raw}</code>;
  }
  return (
    <div className="l-code-block">
      <pre className="mono">{raw}</pre>
      <button
        type="button"
        className="l-icon small l-code-copy"
        aria-label="复制代码"
        title="复制代码"
        onClick={() => {
          void navigator.clipboard.writeText(raw);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

function AssistantMessageItem({
  msg,
  isLast,
  onRegenerate
}: {
  msg: ApiChatMessage;
  isLast: boolean;
  onRegenerate: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="l-amsg">
      {msg.text ? (
        <div className="l-amsg-prose">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ className, children }) {
                const text = String(children ?? '');
                const isBlock = Boolean(className) || text.includes('\n');
                return <CodeBlock inline={!isBlock}>{children}</CodeBlock>;
              }
            }}
          >
            {msg.text}
          </ReactMarkdown>
          {msg.streaming && <span className="l-caret" />}
        </div>
      ) : msg.streaming ? (
        <div className="l-amsg-prose faint">
          正在思考<span className="l-caret" />
        </div>
      ) : null}

      {msg.error && (
        <div className="l-amsg-error" role="alert">
          <CircleAlert size={14} />
          <span>{msg.error}</span>
          <button type="button" className="l-text-btn" onClick={() => onRegenerate(msg.id)}>
            重试
          </button>
        </div>
      )}

      {!msg.streaming && msg.text && (
        <div className="l-amsg-tools">
          <button
            type="button"
            className="l-icon small"
            aria-label="复制回答"
            title="复制回答"
            onClick={() => {
              void navigator.clipboard.writeText(msg.text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          {isLast && (
            <button type="button" className="l-icon small" aria-label="重新生成" title="重新生成" onClick={() => onRegenerate(msg.id)}>
              <RotateCcw size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ApiChat({ taskId, shell }: { taskId: string; shell: ShellState }) {
  const [chat, setChat] = useState<ApiChatState | null>(null);
  const [draft, setDraft] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftSyncedTask = useRef<string>('');

  useEffect(() => {
    let active = true;
    void window.desktop.getApiChat(taskId).then(initial => {
      if (!active || !initial) return;
      setChat(initial);
      setDraft(initial.draft);
      draftSyncedTask.current = taskId;
    });
    const stop = window.desktop.onApiChat(event => {
      if (event.taskId !== taskId) return;
      setChat(prev => {
        if (prev && event.state.draft !== prev.draft && !event.state.running) {
          setDraft(event.state.draft);
        }
        return event.state;
      });
    });
    return () => {
      active = false;
      stop();
    };
  }, [taskId]);

  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [chat?.messages.length, chat?.messages.at(-1)?.text]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [taskId]);

  const connections = shell.connections;
  const activeConn = connections.find(c => c.id === chat?.connectionId) || connections[0] || null;
  const activeModel = chat?.model || activeConn?.models[0] || '';

  async function handleSend() {
    if (!chat) return;
    if (chat.running) {
      await window.desktop.apiChatStop(taskId);
      return;
    }
    if (!draft.trim() && !chat.image) return;
    setLocalErr(null);
    const textToSend = draft;
    setDraft('');
    await window.desktop.apiChatDraft(taskId, textToSend);
    const res = await window.desktop.apiChatSend(taskId);
    if (res.error) {
      setDraft(textToSend);
      setLocalErr(res.error);
    }
  }

  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  function onPaste(event: React.ClipboardEvent) {
    if ([...event.clipboardData.items].some(item => item.type.startsWith('image/'))) {
      event.preventDefault();
      void window.desktop.readImage(taskId).then(r => {
        if (r.error) setLocalErr(r.error);
      });
    }
  }

  if (!chat) return null;

  const canSend = Boolean(draft.trim() || chat.image);

  return (
    <div className="l-apichat" onPaste={onPaste} onClick={() => pickerOpen && setPickerOpen(false)}>
      <div className="l-chat-ctrl">
        <div className="l-chat-picker-wrap" onClick={e => e.stopPropagation()}>
          <button
            type="button"
            className={'l-chat-picker' + (pickerOpen ? ' open' : '')}
            onClick={() => setPickerOpen(v => !v)}
          >
            <Plug size={14} />
            <span>{activeConn ? activeConn.name : '未配置连接'}</span>
            {activeModel && (
              <>
                <span className="faint">/</span>
                <span className="mono">{activeModel}</span>
              </>
            )}
            <ChevronsUpDown size={13} />
          </button>

          {pickerOpen && (
            <div className="l-menu l-chat-model-menu" role="menu">
              {connections.length === 0 ? (
                <div className="l-menu-empty">尚未配置 API 连接</div>
              ) : (
                connections.map(conn => {
                  const models = conn.models.length > 0 ? conn.models : [chat.model || 'gpt-4.1-mini'];
                  return (
                    <div key={conn.id} className="l-menu-group">
                      <div className="l-menu-head">{conn.name}</div>
                      {models.slice(0, 12).map(m => {
                        const selected = conn.id === chat.connectionId && m === chat.model;
                        return (
                          <button
                            key={`${conn.id}:${m}`}
                            type="button"
                            className={'l-menu-item' + (selected ? ' active' : '')}
                            onClick={() => {
                              setPickerOpen(false);
                              void window.desktop.apiChatModel(taskId, conn.id, m);
                            }}
                          >
                            <span className="mono trunc">{m}</span>
                            {selected && <Check size={13} className="l-menu-right clay" />}
                          </button>
                        );
                      })}
                    </div>
                  );
                })
              )}
              <div className="l-menu-sep" />
              <button
                type="button"
                className="l-menu-item"
                onClick={() => {
                  setPickerOpen(false);
                  void window.desktop.openSettings('connections');
                }}
              >
                <Settings2 size={14} />
                <span>管理模型与 API 连接…</span>
              </button>
            </div>
          )}
        </div>

        <span className="grow" />
        <button
          type="button"
          className="l-ghost small"
          disabled={chat.messages.length === 0}
          onClick={() => void window.desktop.apiChatClear(taskId)}
        >
          <Eraser size={14} />
          清空上下文
        </button>
        <button
          type="button"
          className="l-icon small"
          aria-label="钉为贴图"
          title="钉为贴图"
          disabled={chat.messages.length === 0}
          onClick={() => void window.desktop.apiChatPin(taskId)}
        >
          <Pin size={14} />
        </button>
      </div>

      <div ref={threadRef} className="l-chat-thread">
        {chat.messages.length === 0 ? (
          <div className="l-chat-empty">
            <p className="l-chat-empty-title">轻量连续对话</p>
            <p className="l-chat-empty-sub">输入问题直接开始，支持粘贴截图或多轮追问。</p>
          </div>
        ) : (
          chat.messages.map((msg, idx) =>
            msg.role === 'user' ? (
              <div key={msg.id} className="l-umsg">
                {msg.image && (
                  <div className="l-umsg-att">
                    <img src={msg.image.thumbnail} alt="对话附图" />
                  </div>
                )}
                {msg.text && <div className="l-ububble">{msg.text}</div>}
              </div>
            ) : (
              <AssistantMessageItem
                key={msg.id}
                msg={msg}
                isLast={idx === chat.messages.length - 1}
                onRegenerate={id => void window.desktop.apiChatRegenerate(taskId, id)}
              />
            )
          )
        )}
      </div>

      {(localErr || (chat.error && chat.messages.length === 0)) && (
        <div className="l-chat-banner-err" role="alert">
          <CircleAlert size={14} />
          <span className="grow">{localErr || chat.error}</span>
          {connections.length === 0 && (
            <button type="button" className="l-text-btn" onClick={() => void window.desktop.openSettings('connections')}>
              去配置
            </button>
          )}
          <button type="button" className="l-icon small" aria-label="关闭错误提示" onClick={() => setLocalErr(null)}>
            <X size={13} />
          </button>
        </div>
      )}

      <div className="l-composer">
        <textarea
          ref={textareaRef}
          className="l-composer-input"
          rows={Math.min(5, Math.max(1, draft.split('\n').length))}
          placeholder={chat.messages.length > 0 ? '继续追问…' : '输入问题，Enter 发送，Shift+Enter 换行…'}
          value={draft}
          onChange={e => {
            const val = e.target.value;
            setDraft(val);
            void window.desktop.apiChatDraft(taskId, val);
          }}
          onKeyDown={onComposerKeyDown}
        />
        <div className="l-composer-tools">
          <button
            type="button"
            className="l-icon small"
            aria-label="添加图片"
            title="选择图片或直接 ⌘V 粘贴截图"
            onClick={() =>
              void window.desktop.pickChatImage(taskId).then(r => {
                if (r.error) setLocalErr(r.error);
              })
            }
          >
            <ImagePlus size={15} />
          </button>

          {chat.image && (
            <span className="l-thumb-chip">
              <img src={chat.image.thumbnail} alt="" />
              <span className="mono">
                {chat.image.width}×{chat.image.height}
              </span>
              <button
                type="button"
                className="l-icon tiny"
                aria-label="标注图片"
                title="标注图片"
                onClick={() => void window.desktop.editImage(taskId, chat.image!.id)}
              >
                <PenLine size={11} />
              </button>
              <button
                type="button"
                className="l-icon tiny"
                aria-label="移除图片"
                title="移除图片"
                onClick={() => void window.desktop.removeImage(taskId)}
              >
                <X size={11} />
              </button>
            </span>
          )}

          <button
            type="button"
            className="l-send-btn"
            aria-label={chat.running ? '停止生成' : '发送'}
            disabled={!chat.running && !canSend}
            onClick={() => void handleSend()}
          >
            {chat.running ? <Square size={12} /> : <ArrowUp size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}
