import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useAnimationControls } from 'motion/react';
import { Ellipsis } from 'lucide-react';
import { targetLabels, type ActionBarAPI, type ActionBarState, type ActionBarTip } from '../shared/contracts';
import { BrandMark } from './BrandMark';
import { useFonts } from './fonts';
import { spring } from './motion';
import { Badge } from './targets';
declare global { interface Window { actionBar: ActionBarAPI } }

type Preset = ActionBarState['presets'][number];
type Spot = { id: string; x: number; width: number };
const TIP_DELAY = 350;

/** The transparent window holds the capsule between two tip bands. Hover moves one highlight between buttons;
 *  a press turns it clay, then the capsule shows "handing off" until main's fade-out hides the window. */
export function ActionBar() {
  const [state, setState] = useState<ActionBarState | null>(null);
  const [tipSide, setTipSide] = useState<ActionBarTip>('above');
  const [entry, setEntry] = useState(0);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [tip, setTip] = useState<Spot | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
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
      window.actionBar.onEnter(side => {
        setTipSide(side); setEntry(n => n + 1); setSpot(null); setTip(null); setPressed(null); setMenu(false);
        void controls.start({ opacity: [0, 1], y: [side === 'above' ? 4 : -4, 0], scale: [0.96, 1], transition: spring });
      }),
      window.actionBar.onMenuClosed(() => { setMenu(false); setSpot(null); })
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
    if (menu) return;
    lastSpot.current = null; setSpot(null); clearTimeout(tipTimer.current); setTip(null); window.actionBar.hit(false);
  }
  function run(preset: Preset, button: HTMLButtonElement) {
    const width = capsule.current!.offsetWidth;
    // Keyboard presses never hovered: put the highlight under the pressed button so it can turn clay.
    if (spot?.id !== preset.id) { lastSpot.current = null; setSpot({ id: preset.id, x: button.offsetLeft, width: button.offsetWidth }); }
    clearTimeout(tipTimer.current); setTip(null); setPressed(preset.id);
    setTimeout(() => { setPressed(null); setSending({ target: targetLabels[preset.target], width }); }, 120);
    // The bar hides as the run starts; clear the label once it has faded so the next selection starts fresh.
    void window.actionBar.runPreset(preset.id).finally(() => setTimeout(() => setSending(null), 400));
  }
  function more() { setMenu(true); clearTimeout(tipTimer.current); setTip(null); window.actionBar.more(); }
  useLayoutEffect(() => { if (tipBox.current) setTipWidth(tipBox.current.offsetWidth); }, [tip?.id]);
  const presets = state?.presets || [];
  const tipPreset = tip && presets.find(p => p.id === tip.id);
  const slide = Boolean(lastSpot.current);
  // Centre the tip on its button but keep it 4px inside the window (the stage has 16px side padding).
  const tipX = tip ? Math.min(Math.max(tip.x + tip.width / 2, tipWidth / 2 - 12), (capsule.current?.offsetWidth || 0) + 12 - tipWidth / 2) : 0;
  return <div className="ab-stage">
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
            <button aria-label="更多预设与设置" aria-expanded={menu} onPointerEnter={event => enter('more', event)} onClick={more}><Ellipsis size={16} /></button>
          </motion.span>}
      </AnimatePresence>
      {sending && <motion.span className="ab-progress" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.42, ease: 'easeOut' }} />}
    </motion.div>
    <AnimatePresence>
      {tip && !sending && <motion.div key="tip" ref={tipBox} className={'ab-tip ' + tipSide} role="tooltip"
        initial={{ opacity: 0, y: tipSide === 'above' ? 3 : -3, x: tipX }} animate={{ opacity: 1, y: 0, x: tipX }}
        exit={{ opacity: 0, transition: { duration: 0.1 } }} transition={spring}>
        {tipPreset ? <><Badge target={tipPreset.target} />{targetLabels[tipPreset.target]}<span className="ab-tip-dim">· {tipPreset.mode === 'edit' ? '先编辑' : '直接发送'}</span></> : <>更多预设与设置</>}
      </motion.div>}
    </AnimatePresence>
  </div>;
}
