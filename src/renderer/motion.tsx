import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { LayoutGroup, motion, type Transition } from 'motion/react';

/** Shared motion presets. CSS still owns hover, press and color; these cover presence, layout and sliding highlights. */
export const ease = [0.22, 0.68, 0, 1] as const;
export const spring: Transition = { type: 'spring', stiffness: 520, damping: 38, mass: 0.8 };
export const soft: Transition = { duration: 0.18, ease };
export const rise = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.28, ease } },
  exit: { opacity: 0, y: -3, transition: { duration: 0.1, ease: 'easeIn' } }
} as const;
export const pop = {
  initial: { opacity: 0, scale: 0.94 },
  animate: { opacity: 1, scale: 1, transition: spring },
  exit: { opacity: 0, scale: 0.94, transition: { duration: 0.12 } }
} as const;
export const collapse = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1, transition: soft },
  exit: { height: 0, opacity: 0, transition: { duration: 0.14, ease: 'easeIn' } }
} as const;

const HiddenPaneContext = createContext(false);

/** A highlight that slides to whichever sibling currently renders it. */
export function Glide({ id, className }: { id: string; className: string }) {
  const hidden = useContext(HiddenPaneContext);
  if (hidden) return <span className={className} aria-hidden="true" />;
  return <motion.span layoutId={id} className={className} transition={spring} aria-hidden="true" />;
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, ReactNode])[]; onChange: (value: T) => void }) {
  const group = useId();
  return <LayoutGroup id={group}><div className="l-seg" role="radiogroup" aria-label={label}>
    {options.map(([id, text]) => <button key={id || '_'} type="button" role="radio" aria-checked={value === id} onClick={() => onChange(id)}>
      {value === id && <Glide id="seg" className="l-seg-thumb" />}<span className="l-seg-label">{text}</span></button>)}
  </div></LayoutGroup>;
}

const paneActivators = new Map<HTMLElement, (id: string) => void>();
let subPaneHooksInstalled = false;

function activateSubPaneForNode(target: EventTarget | null) {
  if (!(target instanceof Element)) return;
  const pane = target.closest('[data-sub-pane]') as HTMLElement | null;
  if (!pane || !pane.hidden) return;
  const id = pane.dataset.subPane;
  const container = pane.parentElement;
  if (!id || !container) return;
  const activate = paneActivators.get(container);
  if (activate) {
    flushSync(() => activate(id));
    container.scrollTop = 0;
  }
}

function ensureSubPaneHooks() {
  if (subPaneHooksInstalled || typeof window === 'undefined') return;
  subPaneHooksInstalled = true;
  const origScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element, ...args: Parameters<Element['scrollIntoView']>) {
    activateSubPaneForNode(this);
    return origScroll.apply(this, args);
  };
  const origClick = HTMLElement.prototype.click;
  HTMLElement.prototype.click = function (this: HTMLElement) {
    activateSubPaneForNode(this);
    return origClick.apply(this);
  };
  const origFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (this: HTMLElement, ...args: Parameters<HTMLElement['focus']>) {
    activateSubPaneForNode(this);
    return origFocus.apply(this, args);
  };
  for (const type of ['input', 'change', 'focusin'] as const) {
    document.addEventListener(type, event => activateSubPaneForNode(event.target), true);
  }
}

export function useSubNav<T extends string>(initial: T): [T, (next: T) => void, RefObject<HTMLDivElement | null>] {
  const [sub, setSub] = useState<T>(initial);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ensureSubPaneHooks();
    const el = bodyRef.current;
    if (!el) return;
    const activate = (id: string) => setSub(id as T);
    paneActivators.set(el, activate);
    return () => { paneActivators.delete(el); };
  }, []);
  const select = (next: T) => {
    setSub(next);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };
  return [sub, select, bodyRef];
}

export function SubNav<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void }) {
  return <div className="l-set-subnav" role="tablist" aria-label={label}>
    {options.map(([id, text]) => <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)}>{text}</button>)}
  </div>;
}

export function SubPane({ id, active, children }: { id: string; active: boolean; children: ReactNode }) {
  return <HiddenPaneContext.Provider value={!active}>
    <div className="l-sub-pane" data-sub-pane={id} hidden={!active}>{children}</div>
  </HiddenPaneContext.Provider>;
}
