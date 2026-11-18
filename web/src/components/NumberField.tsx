import { useEffect, useId, useState } from "react";
import { fmt } from "../state/model";
import { HelpTip } from "./HelpTip";
import type { HelpTopic } from "./help";

interface Props {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  unit?: string;
  min?: number;
  max?: number;
  /** Take whole numbers only. */
  whole?: boolean;
  /** Allow the field to be left empty (the value is then undefined). */
  optional?: boolean;
  hint?: string;
  /** What the number is, for a "?" beside the label. For what explains; `hint` is for what the number gives. */
  help?: HelpTopic;
  /**
   * Report the number only when the user is done with it (Enter, or leaving
   * the field) instead of at every keystroke. Escape puts the old value back.
   */
  deferred?: boolean;
  /** Shown, and not to be typed in: there is nothing for the number to be of. */
  disabled?: boolean;
}

/**
 * A number input that only reports complete, in-range numbers. While the text
 * is not a usable number the field is marked invalid and the last good value stays.
 */
export function NumberField({ label, value, onChange, unit, min = 0, max = Infinity, whole, optional, hint, help, deferred, disabled }: Props) {
  const id = useId();
  const unusable = (n: number) => Number.isNaN(n) || n < min || n > max || (whole === true && !Number.isInteger(n));
  const [text, setText] = useState(value === undefined ? "" : fmt(value));
  const [invalid, setInvalid] = useState(false);

  // Follow outside changes (another project opened, a reset) unless the user is mid-edit.
  useEffect(() => {
    const parsed = parse(text);
    if (parsed !== value) {
      setText(value === undefined ? "" : fmt(value));
      setInvalid(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function parse(raw: string): number | undefined {
    const trimmed = raw.trim().replace(",", ".");
    if (trimmed === "") return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
  }

  function change(raw: string) {
    setText(raw);
    const parsed = parse(raw);
    if (parsed === undefined) {
      setInvalid(!optional);
      if (optional) onChange(undefined);
    } else if (unusable(parsed)) {
      setInvalid(true);
    } else {
      setInvalid(false);
      if (!deferred) onChange(parsed);
    }
  }

  function revert() {
    setText(value === undefined ? "" : fmt(value));
    setInvalid(false);
  }

  /** Deferred fields: hands over what was typed, if it is a usable number and a new one. */
  function commit() {
    const parsed = parse(text);
    if (parsed === undefined || unusable(parsed)) return revert();
    if (parsed !== value && fmt(parsed) !== (value === undefined ? "" : fmt(value))) onChange(parsed);
    else revert();
  }

  return (
    <div className="field">
      <span className="field-label">
        <label htmlFor={id}>{label}</label>
        {help && <HelpTip topic={help} />}
      </span>
      <span className="field-input">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          value={text}
          aria-invalid={invalid}
          disabled={disabled}
          onChange={(e) => change(e.target.value)}
          onBlur={() => {
            if (deferred) commit();
            else if (invalid) revert();
          }}
          onKeyDown={
            deferred
              ? (e) => {
                  if (e.key === "Enter") commit();
                  else if (e.key === "Escape") {
                    revert();
                    e.stopPropagation();
                  } else if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "y" || e.key === "Z")) {
                    // With something typed and not yet handed over, undo takes that back. Otherwise it belongs to the drawing.
                    e.preventDefault();
                    if (text !== (value === undefined ? "" : fmt(value))) e.stopPropagation();
                    revert();
                  }
                }
              : undefined
          }
        />
        {unit && <span className="unit">{unit}</span>}
      </span>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
