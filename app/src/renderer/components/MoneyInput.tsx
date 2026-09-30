import type { InputHTMLAttributes } from "react";

/**
 * A dollar amount field (UI-controls pass, 2026-09-29). The monthly budget was typed into a bare
 * `inputMode="decimal"` box three times over — the budget prompt, Settings → Usage and the advanced
 * limits — each with its own `Number(text)`: no "$", "5" stayed "5", "1,234.50" was rejected as
 * not a number and "abc" reached the save as NaN. This is the one field for money:
 *
 *   - a "$" drawn inside the field, so the unit is never a label's job;
 *   - the decimal keypad (`inputMode="decimal"`);
 *   - on blur, a valid amount is rewritten as the app writes money everywhere else: two decimals and
 *     thousands separators ("1234.5" → "1,234.50"); anything else is left as typed so it can be fixed;
 *   - `parseMoney` is the only reader, so "$1,234.50", "1234.5" and " 12 " all mean what they say.
 */

/** The amount a money field holds, or null when it is empty or is not a finite, non-negative number. */
export function parseMoney(text: string): number | null {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (!t || !/^\d*\.?\d*$/.test(t) || t === ".") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** How a money field shows an amount: "1,234.50". No "$" — the field draws that itself. */
export function formatMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type Native = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "inputMode">;

export function MoneyInput({ value, onChange, invalid = false, className, onBlur, ...rest }: Native & {
  value: string;
  onChange(text: string): void;
  /** Marks the field invalid (aria-invalid); pair it with `aria-describedby` naming the error line. */
  invalid?: boolean;
}) {
  return (
    <span className={`money-input${className ? ` ${className}` : ""}`}>
      <span className="money-prefix" aria-hidden="true">$</span>
      <input {...rest} type="text" inputMode="decimal" autoComplete="off" spellCheck={false} className="text-input"
        aria-invalid={invalid || undefined} value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          const n = parseMoney(value);
          if (n !== null) onChange(formatMoney(n));
          onBlur?.(e);
        }} />
    </span>
  );
}
