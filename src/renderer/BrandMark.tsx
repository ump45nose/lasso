import { motion } from 'motion/react';
import { ease } from './motion';

/** Inline so the stroke can follow the surface: ink on paper, ivory on the dark action bar. Same paths as assets/lasso-mark.svg.
 *  `draw` traces the strokes in once (entrance) or back and forth (handing off). */
export function BrandMark({ size = 20, ink = 'var(--ink)', draw }: { size?: number; ink?: string; draw?: 'once' | 'loop' }) {
  const stroke = (delay: number) => draw ? {
    initial: { pathLength: 0 }, animate: { pathLength: 1 },
    transition: { duration: 0.34, delay, ease, ...(draw === 'loop' ? { repeat: Infinity, repeatType: 'reverse' as const, repeatDelay: 0.12 } : {}) }
  } : {};
  return <svg width={size} height={size} viewBox="0 0 64 64" fill="none" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Lasso">
    <motion.path stroke="var(--clay)" strokeWidth="15" d="M10 35C22 33 32 32.4 41 31.4" {...stroke(0)} />
    <motion.path stroke={ink} strokeWidth="5" d="M8 35.2C20 34 31 33.4 40 32.4M50 31.4L58 30.6M48 23.5L54 18.6M49.5 39L56 43.5" {...stroke(0.1)} />
  </svg>;
}
