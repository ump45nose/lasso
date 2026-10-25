/** Inline so the stroke can follow the surface: ink on paper, ivory on the dark action bar. Same paths as assets/lasso-mark.svg. */
export function BrandMark({ size = 20, ink = 'var(--ink)' }: { size?: number; ink?: string }) {
  return <svg width={size} height={size} viewBox="0 0 64 64" fill="none" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Lasso">
    <path stroke="var(--clay)" strokeWidth="15" d="M10 35C22 33 32 32.4 41 31.4" />
    <path stroke={ink} strokeWidth="5" d="M8 35.2C20 34 31 33.4 40 32.4M50 31.4L58 30.6M48 23.5L54 18.6M49.5 39L56 43.5" />
  </svg>;
}
