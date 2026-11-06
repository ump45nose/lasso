import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useAnimationControls } from 'motion/react';
import { Copy, CornerDownLeft, Ellipsis, Pin, RotateCcw, Settings2, X, Zap } from 'lucide-react';
import { BAR_MENU, presetTargetLabels as targetLabels, type ActionBarAPI, type ActionBarLayout, type ActionBarState, type FastApiCardState } from '../shared/contracts';
import { BrandMark } from './BrandMark';
import { useFonts } from './fonts';
import { Glide, spring } from './motion';
import { Badge } from './targets';
declare global { interface Window { actionBar: ActionBarAPI } }

type Preset = ActionBarState['presets'][number];
type Spot = { id: string; x: number; width: number };
const TIP_DELAY = 350;

function FastApiCard({ card, side }: { card: FastApiCardState; side: 'above' | 'below' }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current) return;
    const report = () => { if (box.current) window.actionBar.cardHeight(box.current.offsetHeight); };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(box.current);
    return () => { observer.disconnect(); window.actionBar.cardHeight(0); };
  }, [card.status, card.text, card.error]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); window.actionBar.closeFastCard(); }
      else if (event.key === 'Enter' && !event.shiftKey && card.text.trim()) { event.preventDefault(); void window.actionBar.replaceSelection(card.text); }
      else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && !window.getSelection()?.toString() && card.text.trim()) {
        event.preventDefault();
        void window.actionBar.copyFastResult(card.text);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card.text]);

  const dotClass = card.status === 'streaming' ? 'running' : card.status === 'error' ? 'error' : 'complete';
  return <motion.div ref={box} className={'ab-fast-card ' + side} role="dialog" aria-label={`${card.presetName} 速查结果`}
    style={{ [side === 'above' ? 'bottom' : 'top']: 36 + 40 + BAR_MENU.gap }}
    initial={{ opacity: 0, y: side === 'above' ? 8 : -8, scale: 0.97 }}
    animate={{ opacity: 1, y: 0, scale: 1 }}
    exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
    transition={spring}
    onPointerEnter={() => window.actionBar.hit(true)}>
    <div className="ab-fast-head">
      <span className={'dot ' + dotClass} />
      <strong className="ab-fast-title">{card.presetName}</strong>
      <span className="ab-fast-meta mono"><Zap size={11} />{card.model}{card.firstTokenMs ? ` · ${card.firstTokenMs}ms` : ''}</span>
      {card.isTranslation && <div className="ab-fast-langs" role="group" aria-label="目标语言">
        {([['auto', '自动'], ['zh', '中'], ['en', 'EN']] as const).map(([id, label]) => (
          <button key={id} type="button" aria-pressed={card.targetLang === id} onClick={() => void window.actionBar.retryFastCard(id)}>{label}</button>
        ))}
      </div>}
      <button type="button" className="ab-fast-icon" aria-label="关闭速查卡片" onClick={() => window.actionBar.closeFastCard()}><X size={14} /></button>
    </div>
    <div className="ab-fast-body">
      {card.status === 'error'
        ? <div className="ab-fast-error" role="alert"><span>{card.error || '请求失败'}</span><button type="button" className="ab-fast-btn" onClick={() => void window.actionBar.retryFastCard(card.targetLang)}><RotateCcw size={12} />重试</button></div>
        : <p className="ab-fast-text">{card.text || '正在连接 New API 流式输出…'}{card.status === 'streaming' && <span className="l-caret" />}</p>}
    </div>
    <div className="ab-fast-foot">
      <button type="button" className="ab-fast-btn primary" disabled={!card.text.trim()} onClick={() => void window.actionBar.replaceSelection(card.text)}>
        <CornerDownLeft size={13} />替换选中文本<kbd>↵</kbd>
      </button>
      <button type="button" className="ab-fast-btn" disabled={!card.text.trim()} onClick={() => void window.actionBar.copyFastResult(card.text)}>
        <Copy size={13} />复制<kbd>⌘C</kbd>
      </button>
      <button type="button" className="ab-fast-btn" disabled={!card.text.trim() || card.status === 'streaming'} onClick={() => void window.actionBar.pinFastResult(card.text)}>
        <Pin size={13} />贴图
      </button>
      <button type="button" className="ab-fast-icon push" aria-label="重新生成" title="重新生成" onClick={() => void window.actionBar.retryFastCard(card.targetLang)}>
        <RotateCcw size={13} />
      </button>
    </div>
  </motion.div>;
}

/** The transparent window holds the capsule between two tip bands. Hover moves one highlight between buttons;
 *  a press turns it clay, then the capsule shows "handing off" until main's fade-out hides the window.
 *  The ··· menu or inline Fast API card opens in the band on the menu side, which main grows while it is open. */
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
        setLayout(next); setEntry(n => n + 1); setSpot(null); setTip(null); setPressed(null); setMenu(false);
        void controls.start({ opacity: [0, 1], y: [next.tip === 'above' ? 4 : -4, 0], scale: [0.96, 1], transition: spring });
      })
    ];
    void window.actionBar.getState().then(setState);
    const observer = new ResizeObserver(() => window.actionBar.resize(capsule.current!.offsetWidth));
    observer.observe(capsule.current!);
    return () => { stops.forEach(stop => stop()); observer.disconnect(); clearTimeout(tipTimer.current); };
  }, []);
  function enter(id: string, event: React.PointerEvent<HTMLButtonElement>) {
    const button = event.currentTarget, next = { id, x: button.offsetLeft, width: button.offsetWidth };
    lastSpot.current = spot; setSpot(next);
    clearTimeout(tipTimer.current);
    // The first tip waits; once one is showing, moving to a neighbour updates it at once.
    if (tip) setTip(next); else tipTimer.current = setTimeout(() => setTip(next), TIP_DELAY);
  }
  function leave() {
    if (menu || state?.fastCard) return;
    lastSpot.current = null; setSpot(null); clearTimeout(tipTimer.current); setTip(null); window.actionBar.hit(false);
  }
  function run(preset: Preset, button?: HTMLButtonElement) {
    const width = capsule.current!.offsetWidth;
    // Keyboard presses never hovered: put the highlight under the pressed button so it can turn clay.
    if (button && spot?.id !== preset.id) { lastSpot.current = null; setSpot({ id: preset.id, x: button.offsetLeft, width: button.offsetWidth }); }
    clearTimeout(tipTimer.current); setTip(null); setPressed(preset.id);
    if (preset.target === 'api') {
      setTimeout(() => { setPressed(null); if (!button) setMenu(false); }, 120);
      void window.actionBar.runPreset(preset.id);
      return;
    }
    setTimeout(() => { setPressed(null); setSending({ target: targetLabels[preset.target], width }); if (!button) setMenu(false); }, 120);
    // The bar hides as the run starts; clear the label once it has faded so the next selection starts fresh.
    void window.actionBar.runPreset(preset.id).finally(() => setTimeout(() => setSending(null), 400));
  }
  function toggleMenu(open: boolean) {
    setMenu(open); clearTimeout(tipTimer.current); setTip(null);
    if (!open) setSpot(null);
    window.actionBar.menu(open);
  }
  useLayoutEffect(() => { if (tipBox.current) setTipWidth(tipBox.current.offsetWidth); }, [tip?.id]);
  const presets = state?.presets || [], more = state?.more || [], fastCard = state?.fastCard || null;
  const tipPreset = tip && presets.find(p => p.id === tip.id);
  const slide = Boolean(lastSpot.current);
  // Centre the tip on its button but keep it 4px inside the window (the stage has 16px side padding).
  const tipX = tip ? Math.min(Math.max(tip.x + tip.width / 2, tipWidth / 2 - 12), (capsule.current?.offsetWidth || 0) + 12 - tipWidth / 2) : 0;
  return <div className={'ab-stage menu-' + layout.menu} onPointerDown={event => {
    if (event.target === event.currentTarget) {
      if (menu) toggleMenu(false);
      if (fastCard) window.actionBar.closeFastCard();
      window.actionBar.hit(false);
    }
  }}>
    <motion.div ref={capsule} className="ab-bar" animate={controls} style={sending ? { minWidth: sending.width } : undefined}
      role={sending ? 'status' : 'toolbar'} aria-label="Lasso 动作条" onPointerEnter={() => window.actionBar.hit(true)} onPointerLeave={leave}>
      <span className="ab-mark"><BrandMark key={entry + (sending ? '-send' : '')} size={16} ink="var(--on-ink)" draw={sending ? 'loop' : 'once'} /></span>
      <AnimatePresence mode="popLayout" initial={false}>
        {sending ? <motion.span key="sending" className="ab-sending" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={spring}>正在交给 {sending.target}…</motion.span>
          : <motion.span key="buttons" className="ab-buttons" exit={{ opacity: 0, y: -4, transition: { duration: 0.1 } }}>
            {spot && <motion.span className={'ab-pill' + (pressed ? ' pressed' : '')} aria-hidden="true"
              initial={false} animate={{ x: spot.x, width: spot.width }} transition={slide ? spring : { duration: 0 }} />}
            {presets.map(preset => <button key={preset.id} disabled={state!.busy || Boolean(pressed)} aria-label={`${preset.name} · ${targetLabels[preset.target]} · ${preset.mode === 'edit' ? '先编辑' : '直接发送'}`}
              onPointerEnter={event => enter(preset.id, event)} onClick={event => run(preset, event.currentTarget)}>{preset.name}</button>)}
            <span className="ab-sep" />
            <button aria-label="更多预设与设置" aria-haspopup="menu" aria-expanded={menu} onPointerEnter={event => enter('more', event)} onClick={() => toggleMenu(!menu)}><Ellipsis size={16} /></button>
          </motion.span>}
      </AnimatePresence>
      {sending && <motion.span className="ab-progress" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.42, ease: 'easeOut' }} />}
    </motion.div>
    <AnimatePresence>
      {fastCard && !sending && <FastApiCard key="fast-card" card={fastCard} side={layout.menu} />}
      {menu && !fastCard && !sending && <motion.div key="menu" className={'ab-menu ' + layout.menu} role="menu" aria-label="更多预设"
        style={{ width: BAR_MENU.width, padding: BAR_MENU.pad, left: 16 + Math.max(0, (capsule.current?.offsetWidth || 0) - BAR_MENU.width), [layout.menu === 'above' ? 'bottom' : 'top']: 36 + 40 + BAR_MENU.gap }}
        initial={{ opacity: 0, y: layout.menu === 'above' ? 6 : -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }} transition={spring} onPointerLeave={() => setRow(null)}>
        {more.map(preset => <button key={preset.id} role="menuitem" style={{ height: BAR_MENU.row }} disabled={state!.busy || Boolean(pressed)}
          onPointerEnter={() => setRow(preset.id)} onClick={() => run(preset)}>
          {row === preset.id && <Glide id="ab-menu-row" className={'ab-menu-on' + (pressed === preset.id ? ' pressed' : '')} />}
          <Badge target={preset.target} /><span className="ab-menu-name">{preset.name}</span><span className="ab-menu-dim">{preset.mode === 'edit' ? '先编辑' : '直接发送'}</span></button>)}
        {more.length > 0 && <span className="ab-menu-sep" style={{ height: BAR_MENU.sep }} />}
        <button role="menuitem" style={{ height: BAR_MENU.row }} onPointerEnter={() => setRow('settings')} onClick={() => window.actionBar.settings()}>
          {row === 'settings' && <Glide id="ab-menu-row" className="ab-menu-on" />}<Settings2 size={15} className="ab-menu-icon" /><span className="ab-menu-name">预设设置…</span></button>
      </motion.div>}
      {tip && !menu && !fastCard && !sending && <motion.div key="tip" ref={tipBox} className={'ab-tip ' + tipSide} role="tooltip"
        initial={{ opacity: 0, y: tipSide === 'above' ? 3 : -3, x: tipX }} animate={{ opacity: 1, y: 0, x: tipX }}
        exit={{ opacity: 0, transition: { duration: 0.1 } }} transition={spring}>
        {tipPreset ? <><Badge target={tipPreset.target} />{targetLabels[tipPreset.target]}<span className="ab-tip-dim">· {tipPreset.mode === 'edit' ? '先编辑' : '直接发送'}</span></> : <>更多预设与设置</>}
      </motion.div>}
    </AnimatePresence>
  </div>;
}
