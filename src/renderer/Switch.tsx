// Keep this free of app-module imports: the capture editor, a helper surface, imports it too (see main.tsx).
import { useEffect, useState } from 'react';

export function Switch({ label, value, change, disabled }: { label: string; value: boolean; change: () => void; disabled?: boolean }) {
  const [checked, setChecked] = useState(value);
  useEffect(() => {
    setChecked(value);
  }, [value]);

  return (
    <button
      type="button"
      className="l-switch"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        setChecked(prev => !prev);
        change();
      }}
    >
      <span />
    </button>
  );
}
