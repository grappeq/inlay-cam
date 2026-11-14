import { useEffect, useState } from "react";
import { fmt } from "../state/model";

interface Props {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  unit?: string;
  min?: number;
  /** Allow the field to be left empty (the value is then undefined). */
  optional?: boolean;
  hint?: string;
}

/**
 * A number input that only reports complete, in-range numbers. While the text
 * is not a usable number the field is marked invalid and the last good value stays.
 */
export function NumberField({ label, value, onChange, unit, min = 0, optional, hint }: Props) {
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
    } else if (Number.isNaN(parsed) || parsed < min) {
      setInvalid(true);
    } else {
      setInvalid(false);
      onChange(parsed);
    }
  }

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input">
        <input
          type="text"
          inputMode="decimal"
          value={text}
          aria-invalid={invalid}
          onChange={(e) => change(e.target.value)}
          onBlur={() => {
            if (invalid) {
              setText(value === undefined ? "" : fmt(value));
              setInvalid(false);
            }
          }}
        />
        {unit && <span className="unit">{unit}</span>}
      </span>
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}
