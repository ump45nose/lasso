import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, LayoutGroup, motion, type Transition } from 'motion/react';
import { Check, ChevronDown } from 'lucide-react';

/** Shared motion presets. CSS still owns hover, press and color; these cover presence, layout and sliding highlights. */
export const ease = [0.22, 0.68, 0, 1] as const;
export const spring: Transition = { type: 'spring', stiffness: 520, damping: 38, mass: 0.8 };
const soft: Transition = { duration: 0.18, ease };
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
  const [active, setActive] = useState(value);
  useEffect(() => {
    setActive(value);
  }, [value]);
  return <LayoutGroup id={group}><div className="l-seg" role="radiogroup" aria-label={label}>
    {options.map(([id, text]) => <button key={id || '_'} type="button" role="radio" aria-checked={active === id} onClick={() => {
      setActive(id);
      onChange(id);
    }}>
      {active === id && <Glide id="seg" className="l-seg-thumb" />}<span className="l-seg-label">{text}</span></button>)}
  </div></LayoutGroup>;
}

export function useSubNav<T extends string>(initial: T): [T, (next: T) => void, RefObject<HTMLDivElement | null>] {
  const [sub, setSub] = useState<T>(initial);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const select = (next: T) => {
    setSub(next);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };
  return [sub, select, bodyRef];
}

const tabId = (scope: string, id: string) => `${scope}-${id}-tab`;
const panelId = (scope: string, id: string) => `${scope}-${id}-panel`;

export function SubNav<T extends string>({ scope, label, value, options, onChange }: { scope: string; label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void }) {
  const group = useId();
  return <LayoutGroup id={group}><div className="l-set-subnav" role="tablist" aria-label={label}>
    {options.map(([id, text]) => (
      <button
        key={id}
        id={tabId(scope, id)}
        type="button"
        role="tab"
        aria-selected={value === id}
        aria-controls={panelId(scope, id)}
        onClick={() => onChange(id)}
      >
        {value === id && <Glide id={`${scope}-subnav`} className="l-sub-nav-thumb" />}
        <span className="l-sub-nav-label">{text}</span>
      </button>
    ))}
  </div></LayoutGroup>;
}

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

type SelectPos = {
  top?: number;
  bottom?: number;
  left: number;
  minWidth: number;
  maxHeight: number;
  above: boolean;
};

export function SelectBox<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  disabled,
  compact,
  placeholder
}: {
  id?: string;
  label?: string;
  value: T;
  options: readonly (SelectOption<T> | readonly [T, string])[];
  onChange: (value: T) => void;
  disabled?: boolean;
  compact?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<SelectPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const items = options.map(opt => (Array.isArray(opt) ? { value: opt[0] as T, label: opt[1] as string } : (opt as SelectOption<T>)));
  const selected = items.find(opt => opt.value === value);

  const updatePos = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 4;
    const pad = 10;
    const below = window.innerHeight - rect.bottom - gap - pad;
    const above = rect.top - gap - pad;
    const placeAbove = below < 160 && above > below;
    const maxHeight = Math.max(120, Math.min(280, placeAbove ? above : below));
    const width = Math.max(rect.width, 160);
    const left = Math.max(pad, Math.min(rect.left, window.innerWidth - width - pad));
    setPos(
      placeAbove
        ? { bottom: window.innerHeight - rect.top + gap, left, minWidth: rect.width, maxHeight, above: true }
        : { top: rect.bottom + gap, left, minWidth: rect.width, maxHeight, above: false }
    );
  };

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return;
    updatePos();
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      updatePos();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', updatePos);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        className={'l-select-btn' + (compact ? ' compact' : '') + (open ? ' open' : '')}
        onClick={() => {
          if (disabled) return;
          setOpen(prev => !prev);
        }}
      >
        <span className={'l-select-value' + (selected ? '' : ' placeholder')}>{selected?.label ?? placeholder ?? '请选择…'}</span>
        <ChevronDown size={13} className="l-select-caret" aria-hidden="true" />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={menuRef}
              role="listbox"
              aria-label={label}
              className="l-select-menu"
              style={{
                top: pos.top,
                bottom: pos.bottom,
                left: pos.left,
                minWidth: pos.minWidth,
                maxHeight: pos.maxHeight,
                transformOrigin: pos.above ? 'center bottom' : 'center top'
              }}
              initial={{ opacity: 0, scale: 0.96, y: pos.above ? 4 : -4 }}
              animate={{ opacity: 1, scale: 1, y: 0, transition: soft }}
              exit={{ opacity: 0, scale: 0.96, y: pos.above ? 4 : -4, transition: { duration: 0.1 } }}
            >
              {items.map(opt => {
                const active = opt.value === value;
                return (
                  <button
                    key={opt.value || '__empty__'}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className="l-select-opt"
                    onClick={() => {
                      setOpen(false);
                      if (opt.value !== value) onChange(opt.value);
                    }}
                  >
                    <span className="l-select-opt-label">{opt.label}</span>
                    <span className="l-select-opt-check">{active && <Check size={12} />}</span>
                  </button>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}

/** Inactive panes stay mounted but hidden; to reach a control inside one, select its tab first. */
export function SubPane({ scope, id, active, children }: { scope: string; id: string; active: boolean; children: ReactNode }) {
  return <HiddenPaneContext.Provider value={!active}>
    <div id={panelId(scope, id)} className="l-sub-pane" role="tabpanel" aria-labelledby={tabId(scope, id)} hidden={!active}>{children}</div>
  </HiddenPaneContext.Provider>;
}
