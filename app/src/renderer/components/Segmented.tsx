import { useRef, type KeyboardEvent } from "react";

/**
 * A segmented control (the macOS one): a radio group drawn as one track with the chosen segment raised.
 * Keyboard: Tab reaches the checked segment only (roving tabindex); the arrow keys move the choice and
 * focus together, Home and End jump to the ends — the ARIA radio-group pattern.
 */
export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  /** null: nothing chosen yet (the saved value hasn't been read) — no segment is raised. */
  value: T | null;
  options: readonly { value: T; label: string }[];
  onChange(v: T): void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = Math.max(0, options.findIndex((o) => o.value === value));
  const move = (i: number) => {
    const n = (i + options.length) % options.length;
    onChange(options[n]!.value);
    refs.current[n]?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step) { e.preventDefault(); move(at + step); }
    else if (e.key === "Home") { e.preventDefault(); move(0); }
    else if (e.key === "End") { e.preventDefault(); move(options.length - 1); }
  };
  return (
    <div role="radiogroup" aria-label={label} className="segmented" onKeyDown={onKey}>
      {options.map((o, i) => (
        <button key={o.value} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={o.value === value}
          tabIndex={i === at ? 0 : -1} className="segment" onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
