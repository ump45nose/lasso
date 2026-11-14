import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useAnimationControls } from 'motion/react';
import {
  ArrowUpRight,
  Copy,
  CornerDownLeft,
  Ellipsis,
  Languages,
  NotebookPen,
  Pin,
  RotateCcw,
  SlidersHorizontal,
  X
} from 'lucide-react';
import {
  BAR_MENU,
  presetTargetLabels as targetLabels,
  type ActionBarAPI,
  type ActionBarItem,
  type ActionBarLayout,
  type ActionBarState,
  type FastApiCardState
} from '../shared/contracts';
import { BrandMark } from './BrandMark';
import { useFonts } from './fonts';
import { Glide, spring } from './motion';
import { Badge } from './targets';

declare global {
  interface Window {
    actionBar: ActionBarAPI;
  }
}

type Spot = { id: string; x: number; width: number };
const TIP_DELAY = 350;

function renderInlineCode(line: string) {
  const parts = line.split(/(`[^`]+`)/g);
  return parts.map((part, i) =>
    part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
      <code key={i} className="ab-inline-code mono">
        {part.slice(1, -1)}
      </code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  );
}

function FastApiCard({ card, side }: { card: FastApiCardState; side: 'above' | 'below' }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current) return;
    const report = () => {
      if (box.current) window.actionBar.cardHeight(box.current.offsetHeight);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(box.current);
    return () => {
      observer.disconnect();
      window.actionBar.cardHeight(0);
    };
  }, [card.status, card.text, card.error]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        window.actionBar.closeFastCard();
      } else if (event.key === 'Enter' && !event.shiftKey && card.text.trim()) {
        event.preventDefault();
        void window.actionBar.replaceSelection(card.text);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && !window.getSelection()?.toString() && card.text.trim()) {
        event.preventDefault();
        void window.actionBar.copyFastResult(card.text);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card.text]);

  const dotClass = card.status === 'streaming' ? 'running' : card.status === 'error' ? 'error' : 'complete';
  const paragraphs = (card.text || '').split(/\n{2,}/);

  return (
    <motion.div
      ref={box}
      className={'ab-fast-card ' + side}
      role="dialog"
      aria-label={`${card.presetName} 速查结果`}
      style={{ [side === 'above' ? 'bottom' : 'top']: 36 + 40 + BAR_MENU.gap }}
      initial={{ opacity: 0, y: side === 'above' ? 8 : -8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
      transition={spring}
      onPointerEnter={() => window.actionBar.hit(true)}
    >
      <div className="ab-fast-head">
        <span className={'dot ' + dotClass} />
        <strong className="ab-fast-title">{card.presetName}</strong>
        <span className="ab-fast-meta mono">
          {card.model || 'API'}
          {card.firstTokenMs ? ` · 首字 ${card.firstTokenMs}ms` : ''}
        </span>
        <button type="button" className="ab-fast-icon push" aria-label="关闭快答卡" onClick={() => window.actionBar.closeFastCard()}>
          <X size={14} />
        </button>
      </div>
      <div className="ab-fast-body">
        {card.status === 'error' ? (
          <div className="ab-fast-error" role="alert">
            <span>{card.error || '请求失败'}</span>
            <button type="button" className="ab-fast-btn" onClick={() => void window.actionBar.retryFastCard()}>
              <RotateCcw size={12} />
              重试
            </button>
          </div>
        ) : (
          <div className="ab-fast-prose">
            {(card.text ? paragraphs : ['正在连接模型…']).map((para, idx) => (
              <p key={idx}>
                {renderInlineCode(para)}
                {card.status === 'streaming' && idx === paragraphs.length - 1 && <span className="l-caret" />}
              </p>
            ))}
          </div>
        )}
      </div>
      <div className="ab-fast-foot">
        <button type="button" className="ab-fast-btn primary" disabled={!card.text.trim()} onClick={() => void window.actionBar.replaceSelection(card.text)}>
          <CornerDownLeft size={13} />
          替换选中文本
        </button>
        <button type="button" className="ab-fast-btn ghost" disabled={!card.text.trim()} onClick={() => void window.actionBar.copyFastResult(card.text)}>
          <Copy size={13} />
          复制<kbd>⌘C</kbd>
        </button>
        <button type="button" className="ab-fast-icon" aria-label="入便签" title="入便签" disabled={!card.text.trim()} onClick={() => void window.actionBar.noteFastResult(card.text)}>
          <NotebookPen size={14} />
        </button>
        <button
          type="button"
          className="ab-fast-icon"
          aria-label="钉为贴图"
          title="钉为贴图"
          disabled={!card.text.trim() || card.status === 'streaming'}
          onClick={() => void window.actionBar.pinFastResult(card.text)}
        >
          <Pin size={14} />
        </button>
        <button type="button" className="ab-fast-icon" aria-label="重新生成" title="重新生成" onClick={() => void window.actionBar.retryFastCard()}>
          <RotateCcw size={14} />
        </button>
        <button type="button" className="ab-fast-link push" onClick={() => void window.actionBar.continueFastInChat()}>
          继续追问
          <ArrowUpRight size={13} />
        </button>
      </div>
    </motion.div>
  );
}

export function ActionBar() {
  const [state, setState] = useState<ActionBarState | null>(null);
  const [layout, setLayout] = useState<ActionBarLayout>({ tip: 'above', menu: 'above' });
  const tipSide = layout.tip;
  const [entry, setEntry] = useState(0);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [tip, setTip] = useState<Spot | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [row, setRow] = useState<string | null>(null);
  const [sending, setSending] = useState<{ target: string; width: number } | null>(null);
  useFonts(state?.fonts);
  const capsule = useRef<HTMLDivElement>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastSpot = useRef<Spot | null>(null);
  const tipBox = useRef<HTMLDivElement>(null);
  const [tipWidth, setTipWidth] = useState(0);
  const controls = useAnimationControls();

  useEffect(() => {
    document.documentElement.classList.add('ab-html');
    document.body.classList.add('ab-body');
    const stops = [
      window.actionBar.onState(setState),
      window.actionBar.onEnter(next => {
        setLayout(next);
        setEntry(n => n + 1);
        setSpot(null);
        setTip(null);
        setPressed(null);
        setMenu(false);
        void controls.start({ opacity: [0, 1], y: [next.tip === 'above' ? 4 : -4, 0], scale: [0.96, 1], transition: spring });
      })
    ];
    void window.actionBar.getState().then(setState);
    const observer = new ResizeObserver(() => {
      if (capsule.current) window.actionBar.resize(capsule.current.offsetWidth);
    });
    if (capsule.current) observer.observe(capsule.current);
    return () => {
      stops.forEach(stop => stop());
      observer.disconnect();
      clearTimeout(tipTimer.current);
    };
  }, []);

  function enter(id: string, event: React.PointerEvent<HTMLButtonElement>) {
    const button = event.currentTarget;
    const next = { id, x: button.offsetLeft, width: button.offsetWidth };
    lastSpot.current = spot;
    setSpot(next);
    clearTimeout(tipTimer.current);
    if (tip) setTip(next);
    else tipTimer.current = setTimeout(() => setTip(next), TIP_DELAY);
  }

  function leave() {
    if (menu || state?.fastCard) return;
    lastSpot.current = null;
    setSpot(null);
    clearTimeout(tipTimer.current);
    setTip(null);
    window.actionBar.hit(false);
  }

  function triggerItem(item: ActionBarItem, button?: HTMLButtonElement) {
    const width = capsule.current?.offsetWidth || 320;
    if (button && spot?.id !== item.id) {
      lastSpot.current = null;
      setSpot({ id: item.id, x: button.offsetLeft, width: button.offsetWidth });
    }
    clearTimeout(tipTimer.current);
    setTip(null);
    setPressed(item.id);

    if (item.kind === 'translate' || item.kind === 'note' || item.target === 'api') {
      setTimeout(() => {
        setPressed(null);
        if (!button) setMenu(false);
      }, 120);
      if (item.kind === 'preset' && state?.fastCard?.presetId === item.id) {
        void window.actionBar.retryFastCard();
      } else {
        void window.actionBar.runItem(item.id);
      }
      return;
    }

    const label = item.target ? targetLabels[item.target] : 'AI';
    setTimeout(() => {
      setPressed(null);
      setSending({ target: label, width });
      if (!button) setMenu(false);
    }, 120);
    void window.actionBar.runItem(item.id).finally(() => setTimeout(() => setSending(null), 400));
  }

  function toggleMenu(open: boolean) {
    setMenu(open);
    clearTimeout(tipTimer.current);
    setTip(null);
    if (!open) setSpot(null);
    window.actionBar.menu(open);
  }

  useLayoutEffect(() => {
    if (tipBox.current) setTipWidth(tipBox.current.offsetWidth);
  }, [tip?.id]);

  const items = state?.items || [];
  const more = state?.more || [];
  const fastCard = state?.fastCard || null;
  const tipItem = tip ? items.find(i => i.id === tip.id) : undefined;
  const slide = Boolean(lastSpot.current);
  const tipX = tip ? Math.min(Math.max(tip.x + tip.width / 2, tipWidth / 2 - 12), (capsule.current?.offsetWidth || 0) + 12 - tipWidth / 2) : 0;

  return (
    <div
      className={'ab-stage menu-' + layout.menu}
      onPointerDown={event => {
        if (event.target === event.currentTarget) {
          if (menu) toggleMenu(false);
          if (fastCard) window.actionBar.closeFastCard();
          window.actionBar.hit(false);
        }
      }}
    >
      <motion.div
        ref={capsule}
        className="ab-bar"
        animate={controls}
        style={sending ? { minWidth: sending.width } : undefined}
        role={sending ? 'status' : 'toolbar'}
        aria-label="Lasso 动作条"
        onPointerEnter={() => window.actionBar.hit(true)}
        onPointerLeave={leave}
      >
        <span className="ab-mark">
          <BrandMark key={entry + (sending ? '-send' : '')} size={18} ink="var(--on-ink)" draw={sending ? 'loop' : 'once'} />
        </span>
        <AnimatePresence mode="popLayout" initial={false}>
          {sending ? (
            <motion.span key="sending" className="ab-sending" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
              正在交给 {sending.target}…
            </motion.span>
          ) : (
            <motion.span key="buttons" className="ab-buttons" exit={{ opacity: 0, y: -4, transition: { duration: 0.1 } }}>
              {spot && (
                <motion.span
                  className={'ab-pill' + (pressed ? ' pressed' : '')}
                  aria-hidden="true"
                  initial={false}
                  animate={{ x: spot.x, width: spot.width }}
                  transition={slide ? spring : { duration: 0 }}
                />
              )}
              {items.map((item, idx) => (
                <Fragment key={`${item.kind}:${item.id}`}>
                  {item.kind === 'note' && idx > 0 && <span className="ab-sep" />}
                  <button
                    type="button"
                    className={item.kind === 'preset' && fastCard?.presetId === item.id && spot?.id !== item.id ? 'act' : undefined}
                    disabled={Boolean(state?.busy || pressed)}
                    aria-label={item.name}
                    onPointerEnter={event => enter(item.id, event)}
                    onClick={event => triggerItem(item, event.currentTarget)}
                  >
                    {item.kind === 'translate' && <Languages size={15} />}
                    {item.kind === 'note' && <NotebookPen size={15} />}
                    {item.name}
                  </button>
                </Fragment>
              ))}
              <button
                type="button"
                className={menu && spot?.id !== 'more' ? 'act icon-only' : 'icon-only'}
                aria-label="更多动作与设置"
                aria-haspopup="menu"
                aria-expanded={menu}
                onPointerEnter={event => enter('more', event)}
                onClick={() => toggleMenu(!menu)}
              >
                <Ellipsis size={16} />
              </button>
            </motion.span>
          )}
        </AnimatePresence>
        {sending && <motion.span className="ab-progress" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.42, ease: 'easeOut' }} />}
      </motion.div>

      <AnimatePresence>
        {fastCard && !sending && <FastApiCard key="fast-card" card={fastCard} side={layout.menu} />}
        {menu && !fastCard && !sending && (
          <motion.div
            key="menu"
            className={'ab-menu ' + layout.menu}
            role="menu"
            aria-label="更多动作"
            style={{
              width: BAR_MENU.width,
              padding: BAR_MENU.pad,
              left: 16 + Math.max(0, (capsule.current?.offsetWidth || 0) - BAR_MENU.width),
              [layout.menu === 'above' ? 'bottom' : 'top']: 36 + 40 + BAR_MENU.gap
            }}
            initial={{ opacity: 0, y: layout.menu === 'above' ? 6 : -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
            transition={spring}
            onPointerLeave={() => setRow(null)}
          >
            {more.map(item => (
              <button
                key={`${item.kind}:${item.id}`}
                type="button"
                role="menuitem"
                style={{ height: BAR_MENU.row }}
                disabled={Boolean(state?.busy || pressed)}
                onPointerEnter={() => setRow(item.id)}
                onClick={() => triggerItem(item)}
              >
                {row === item.id && <Glide id="ab-menu-row" className={'ab-menu-on' + (pressed === item.id ? ' pressed' : '')} />}
                {item.kind === 'translate' ? (
                  <Languages size={15} className="ab-menu-icon" />
                ) : item.kind === 'note' ? (
                  <NotebookPen size={15} className="ab-menu-icon" />
                ) : (
                  <Badge target={item.target || 'api'} dark />
                )}
                <span className="ab-menu-name">{item.name}</span>
                <span className="ab-menu-dim mono">{item.target ? targetLabels[item.target] : ''}</span>
              </button>
            ))}
            {more.length > 0 && <span className="ab-menu-sep" style={{ height: BAR_MENU.sep }} />}
            <button type="button" role="menuitem" style={{ height: BAR_MENU.row }} onPointerEnter={() => setRow('settings')} onClick={() => window.actionBar.settings()}>
              {row === 'settings' && <Glide id="ab-menu-row" className="ab-menu-on" />}
              <SlidersHorizontal size={15} className="ab-menu-icon" />
              <span className="ab-menu-name">配置动作条…</span>
              <span className="ab-menu-dim mono">⌘,</span>
            </button>
          </motion.div>
        )}
        {tip && !menu && !fastCard && !sending && (
          <motion.div
            key="tip"
            ref={tipBox}
            className={'ab-tip ' + tipSide}
            role="tooltip"
            initial={{ opacity: 0, y: tipSide === 'above' ? 3 : -3, x: tipX }}
            animate={{ opacity: 1, y: 0, x: tipX }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={spring}
          >
            {tipItem?.kind === 'translate' ? (
              <>
                打开翻译窗<span className="ab-tip-dim">· 可改词或替换选区</span>
              </>
            ) : tipItem?.kind === 'note' ? (
              <>
                入便签<span className="ab-tip-dim">· 追加到 Scratchpad</span>
              </>
            ) : tipItem?.target ? (
              <>
                <Badge target={tipItem.target} dark />
                {targetLabels[tipItem.target]}
                <span className="ab-tip-dim">· {tipItem.target === 'api' ? '原地快答' : tipItem.mode === 'edit' ? '先编辑' : '直接发送'}</span>
              </>
            ) : (
              <>更多动作与设置</>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
