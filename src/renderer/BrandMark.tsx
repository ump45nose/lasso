const mark = new URL('../../assets/lasso-mark.svg', import.meta.url).href;

export function BrandMark({ size = 20, className = '' }: { size?: number; className?: string }) {
  return <img className={'brand-mark ' + className} src={mark} width={size} height={size} alt="Lasso" draggable={false} />;
}
