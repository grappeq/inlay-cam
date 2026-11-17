// Fields that sit in a cell of a sheet or a table: no label of their own
// beside them, sized by the cell.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { round6 } from "../state/feedsView";

/** A line of text in a cell; empty means none. */
export function Text(p: { label: string; value: string | undefined; onChange: (value: string | undefined) => void; placeholder?: string }) {
  return <input className="cell-in" type="text" aria-label={p.label} placeholder={p.placeholder} value={p.value ?? ""} onChange={(e) => p.onChange(e.target.value.trim() === "" ? undefined : e.target.value)} />;
}

/**
 * A number in a cell. It reports only complete, in-range numbers; while the
 * text is not one, the field is marked and the last good value stays, and
 * comes back when the field is left.
 */
export function Num(p: { label: string; value: number | undefined; onChange: (value: number | undefined) => void; unit?: string; min?: number; max?: number; whole?: boolean; optional?: boolean; hint?: string; onBlur?: () => void }) {
  const shown = (v: number | undefined) => (v === undefined ? "" : String(round6(v)));
  const [text, setText] = useState(shown(p.value));
  const [bad, setBad] = useState(false);
  const focused = useRef(false);
  // Plain decimal numbers only: no exponents, no hexadecimal, no "Infinity".
  const parse = (t: string) => (t.trim() === "" ? undefined : /^\d+([.,]\d*)?$|^[.,]\d+$/.test(t.trim()) ? Number(t.trim().replace(",", ".")) : NaN);
  // Follow changes from elsewhere (a suggestion taken, the diameter changed) unless the text already says the same.
  useEffect(() => {
    // Not while it is typed in: a value rounded on its way round must not rewrite the text under the cursor.
    if (parse(text) !== p.value && !(focused.current && !bad && Math.abs((parse(text) ?? NaN) - (p.value ?? NaN)) < 1e-3)) {
      setText(shown(p.value));
      setBad(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.value]);
  const range = [p.min !== undefined && p.min > 0 ? (p.min <= 0.001 ? "a number above 0" : `at least ${p.min}`) : null, p.max !== undefined && p.max !== Infinity ? `at most ${round6(p.max)}` : null, p.whole ? "a whole number" : null].filter(Boolean).join(", ");
  // In range when typed, out of it since: a stepover wider than a diameter made smaller, say.
  const outside = !bad && p.value !== undefined && ((p.max !== undefined && p.value > p.max * (1 + 1e-9)) || (p.min !== undefined && p.value < p.min));
  return (
    <span className="num-in">
      <input
        className="cell-in"
        type="text"
        inputMode="decimal"
        aria-label={p.label}
        aria-invalid={bad || outside}
        placeholder={p.hint}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = parse(e.target.value);
          const usable = n === undefined ? p.optional === true : Number.isFinite(n) && n >= (p.min ?? 0) && n <= (p.max ?? Infinity) && (!p.whole || Number.isInteger(n));
          setBad(!usable);
          if (usable) p.onChange(n);
        }}
        onFocus={() => (focused.current = true)}
        onKeyDown={(e) => {
          // Enter must not save a sheet whose field shows something that was not kept.
          if (e.key === "Enter" && bad) e.preventDefault();
        }}
        onBlur={() => {
          focused.current = false;
          p.onBlur?.();
          if (bad) {
            setText(shown(p.value));
            setBad(false);
          }
        }}
      />
      {p.unit && <span className="unit">{p.unit}</span>}
      {(bad || outside) && (
        <span className="num-why" role="alert">
          {bad ? "Not kept: " : "Now "}
          {bad ? range || "a number is needed" : p.max !== undefined && p.value !== undefined && p.value > p.max ? `over the most it can be, ${round6(p.max)}` : `under the least it can be, ${p.min}`}
        </span>
      )}
    </span>
  );
}

/** The head of a settings page: what it is, in a line, and what can be done to all of it. */
export function PageHead(props: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <header className="card-head">
      <div className="card-title">
        <h2>{props.title}</h2>
        {props.action}
      </div>
      <p className="card-note muted">{props.children}</p>
    </header>
  );
}

/** A name in a cell, kept as typed while it cannot be used, with why; the old name comes back when the field is left. */
export function NameField(props: { label: string; what: string; value: string; onChange: (value: string) => void; taken: (value: string) => boolean; maxLength?: number }) {
  const [text, setText] = useState(props.value);
  const problem = text.trim() === "" ? `A ${props.what} needs a name.` : props.taken(text) ? `Another ${props.what} has this name.` : null;
  return (
    <span className="profile-name">
      <input
        className="cell-in"
        type="text"
        maxLength={props.maxLength}
        aria-label={props.label}
        value={text}
        aria-invalid={problem !== null}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() !== "" && !props.taken(e.target.value)) props.onChange(e.target.value);
        }}
        onBlur={() => problem && setText(props.value)}
      />
      {problem && <span className="hint warn">{problem} The old name is kept.</span>}
    </span>
  );
}
