import { useId, type ReactNode } from 'react';
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

/** A highlight that slides to whichever sibling currently renders it. */
export function Glide({ id, className }: { id: string; className: string }) {
  return <motion.span layoutId={id} className={className} transition={spring} aria-hidden="true" />;
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, ReactNode])[]; onChange: (value: T) => void }) {
  const group = useId();
  return <LayoutGroup id={group}><div className="l-seg" role="radiogroup" aria-label={label}>
    {options.map(([id, text]) => <button key={id || '_'} type="button" role="radio" aria-checked={value === id} onClick={() => onChange(id)}>
      {value === id && <Glide id="seg" className="l-seg-thumb" />}<span>{text}</span></button>)}
  </div></LayoutGroup>;
}
