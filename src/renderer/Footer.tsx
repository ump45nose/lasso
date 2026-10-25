import { Fragment, useEffect } from 'react';
import { Check, CircleAlert, Copy, Timer, X } from 'lucide-react';
import type { DeliveryStatus, DeliveryStep } from '../shared/contracts';
import type { CaptureEfficiencyState } from '../shared/capture-efficiency';
import { Glide } from './motion';

const stepLabels: Record<DeliveryStep, string> = { open: '打开', model: '模型', fill: '填入', upload: '图片', send: '发送', edit: '交给你' };
const act = (action: Parameters<typeof window.desktop.act>[0]) => void window.desktop.act(action);

export function NoticeRow({ message, capture }: { message?: string | null; capture?: CaptureEfficiencyState }) {
  const active = capture && capture.phase !== 'idle';
  const text = active ? capture.phase === 'countdown' ? `倒计时 · ${capture.remaining} 秒后截图` : capture.phase === 'canceling' ? '正在取消截图…' : '正在采集截图…' : message;
  return <footer className={'l-foot' + (active ? '' : ' error')} role={active ? 'status' : 'alert'}>{active ? <Timer size={14} /> : <CircleAlert size={14} />}<span className="l-foot-msg" title={text || undefined}>{text}</span>
    {active ? <button className="l-icon" aria-label="取消延时截图" title="取消延时截图" disabled={capture.phase === 'canceling'} onClick={() => void window.desktop.cancelScreenshot()}><X size={14} /></button>
      : <button className="l-icon" aria-label="关闭提示" title="关闭提示" onClick={() => act('dismiss-notice')}><X size={14} /></button>}</footer>;
}

/** Steps mirror TaskManager's delivery order; restore and new-chat preparation carry none and show only the message. */
export function DeliveryRow({ delivery }: { delivery: DeliveryStatus }) {
  const { phase, steps, message } = delivery;
  const error = phase === 'error', finished = phase === 'sent' || phase === 'editing';
  const at = delivery.step ? steps.indexOf(delivery.step) : -1;
  useEffect(() => {
    if (phase !== 'sent') return;
    const timer = setTimeout(() => act('dismiss-delivery'), 2600);
    return () => clearTimeout(timer);
  }, [phase]);
  return <footer className={'l-foot' + (error ? ' error' : '')} role="status">
    {steps.length ? <ol className="l-steps" aria-label="投递进度">
      {steps.map((step, i) => {
        const done = finished || i < at, now = !finished && i === at;
        return <Fragment key={step}>
          {i > 0 && <li aria-hidden="true" className={'l-link-line' + (done || now ? '' : ' todo')} />}
          <li className={'l-step ' + (done ? 'done' : now ? (error ? 'fail' : 'now') : '')} aria-current={now ? 'step' : undefined}>
            {now && <Glide id="step-now" className="l-step-mark" />}
            {done ? <Check size={12} /> : now ? (error ? <CircleAlert size={12} /> : <span className={'dot ' + (phase === 'login' ? 'waiting' : 'running')} />) : <span className="dot draft l-step-todo" />}
            {stepLabels[step]}
          </li>
        </Fragment>;
      })}
    </ol> : !error && <span className="dot loading" />}
    <span className="l-foot-msg" title={message}>{message}</span>
    {error && steps.length > 0 && <button className="l-text-btn" title="从未完成的步骤继续，不重复已完成的步骤" onClick={() => act('retry-delivery')}>重试</button>}
    {phase === 'editing' && <button className="l-text-btn" onClick={() => act('dismiss-delivery')}>完成</button>}
    {delivery.canCopy && <button className="l-icon" aria-label="复制完整原文" title="复制完整原文" onClick={() => act('copy-pending')}><Copy size={14} /></button>}
    {!finished && <button className="l-icon" aria-label={error ? '关闭提示' : '取消待发送动作'} title={error ? '关闭' : '取消待发送动作'} onClick={() => act('cancel-delivery')}><X size={14} /></button>}
  </footer>;
}
