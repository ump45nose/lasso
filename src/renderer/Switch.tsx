// Keep this free of app-module imports: the capture editor, a helper surface, imports it too (see main.tsx).
export function Switch({ label, value, change, disabled }: { label: string; value: boolean; change: () => void; disabled?: boolean }) {
  return <button className="l-switch" role="switch" aria-label={label} aria-checked={value} disabled={disabled} onClick={change}><span /></button>;
}
