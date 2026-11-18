import { useEffect, useId, useState } from "react";
import type { CutOverride, CuttingSettings, Material, Step, Tool } from "../core/types";
import { CUT_FIELDS, changedCount, cutRow, findProfile, fmt, isAdaptive, isInlay, materialLabel, stepMaterial, stepMaterials } from "../state/model";
import { useApp, useDispatch } from "../state/store";

/**
 * How one bit cuts in the open step: the profile whose cutting row it runs,
 * the row's numbers on one line, and, on Edit, a field for each number the
 * step is to change. A number left empty stays the row's own, so it follows
 * the row when that is tuned in the tool list.
 */
export function BitCut({ tool }: { tool: Tool }) {
  const { lists, project, activeStepId } = useApp();
  const dispatch = useDispatch();
  const [open, setOpen] = useState(false);
  const step = project.steps.find((j) => j.id === activeStepId);
  if (!step) return null;

  const profile = step.rowProfiles?.[tool.id];
  const change = step.cutOverrides?.[tool.id];
  const changed = changedCount(change);
  const materials = stepMaterials(step, project);
  const inlay = isInlay(step.task);
  const label = (key: string) => findProfile(key, lists, project)?.label ?? key;
  const adaptive = (key: string) => isAdaptive(key, findProfile(key, lists, project));
  // Every profile the bit has a row on, for any of what the step cuts.
  const keys = [...new Set(tool.cutting.filter((c) => materials.includes(c.material) && c.profile !== undefined && c.profile !== null).map((c) => c.profile as string))];

  const setStep = (update: (step: Step) => Step) => dispatch({ type: "updateStep", id: step.id, update });
  const setProfile = (key: string) =>
    setStep((j) => {
      const next = { ...(j.rowProfiles ?? {}) };
      if (key === "") delete next[tool.id];
      else next[tool.id] = key;
      return { ...j, rowProfiles: Object.keys(next).length > 0 ? next : undefined };
    });
  const setChange = (next: CutOverride) =>
    setStep((j) => {
      const all = { ...(j.cutOverrides ?? {}) };
      if (changedCount(next) === 0) delete all[tool.id];
      else all[tool.id] = next;
      return { ...j, cutOverrides: Object.keys(all).length > 0 ? all : undefined };
    });
  const setValue = (key: keyof CutOverride, value: number | undefined) => {
    const next = { ...(change ?? {}) };
    if (value === undefined) delete next[key];
    else next[key] = value;
    setChange(next);
  };

  const rows = materials.map((material) => ({ material, row: cutRow(tool, material, profile) }));
  const first = rows.find((r) => r.row !== undefined)?.row;
  /** A number of the rows as they are: one value, or one for each wood when they differ. */
  const own = (key: keyof CutOverride) => [...new Set(rows.filter((r) => r.row !== undefined).map((r) => fmt((r.row as CuttingSettings)[key])))].join(" / ");

  return (
    <div className="bit-cut">
      {rows.map(({ material, row }) => (
        <div className="bit-line" key={material}>
          {material === rows[0].material &&
            (keys.length === 0 && profile === undefined ? (
              <span className="bit-profile plain" title="The only row this bit has: safe for any cut">
                Plain
              </span>
            ) : (
              <span className="bit-profile">
                <select value={profile ?? ""} aria-label={`Profile of ${tool.name}`} title="The profile whose cutting row the bit runs" onChange={(e) => setProfile(e.target.value)}>
                  <option value="">Plain</option>
                  {keys.map((key) => (
                    <option key={key} value={key} disabled={adaptive(key)}>
                      {label(key)}
                      {adaptive(key) ? " (adaptive: not cut by this app)" : ""}
                    </option>
                  ))}
                  {profile !== undefined && !keys.includes(profile) && <option value={profile}>{label(profile)}</option>}
                </select>
                <span aria-hidden="true">▾</span>
              </span>
            ))}
          {rows.length > 1 && <span className="bit-part">{material === step.material && material !== stepMaterial(step, project) ? "Plug" : "Pocket"}</span>}
          {row ? (
            <span className="bit-numbers">
              {CUT_FIELDS.map((f, i) => (
                <span key={f.key} className={change?.[f.key] !== undefined ? "changed" : undefined} title={`${f.label}, ${f.unit}`}>
                  {i > 0 && <span className="sep"> · </span>}
                  {fmt(change?.[f.key] ?? row[f.key])} {f.short}
                </span>
              ))}
            </span>
          ) : (
            <span className="bit-numbers warn">{missing(profile === undefined ? null : label(profile), material, materialLabel(material, lists))}</span>
          )}
          {material === rows[0].material && (
            <button type="button" className="link bit-edit" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Done" : changed > 0 ? `Edit (${changed})` : "Edit"}
            </button>
          )}
        </div>
      ))}
      {open && (
        <div className="bit-fields">
          {CUT_FIELDS.map((f) => (
            <ChangeField
              key={f.key}
              label={f.label}
              unit={f.unit}
              tool={tool.name}
              whole={f.key === "rpm"}
              max={f.key === "rpm" ? project.machine.maxRpm : f.key === "stepover" ? tool.diameter : undefined}
              value={change?.[f.key]}
              own={own(f.key)}
              onChange={(value) => setValue(f.key, value)}
            />
          ))}
          <div className="bit-foot">
            <span className="muted">{first ? `Empty: as the ${profile === undefined ? "plain" : label(profile)} row` : ""}</span>
            {changed > 0 && (
              <button type="button" className="link" onClick={() => setChange({})}>
                Reset all
              </button>
            )}
          </div>
          {inlay && <span className="hint">The cut-out runs the plain row, unchanged.</span>}
        </div>
      )}
    </div>
  );
}

function missing(profile: string | null, key: Material, name: string): string {
  const wood = name.toLowerCase() || key;
  return profile === null ? `No cutting settings for ${wood}` : `No ${profile} row for ${wood}`;
}

/**
 * One number of a row that the step may change. Empty leaves the row's own,
 * which is shown in grey. Only a usable number is handed over.
 */
function ChangeField(props: { label: string; unit: string; tool: string; whole: boolean; max?: number; value: number | undefined; own: string; onChange: (value: number | undefined) => void }) {
  const id = useId();
  const { value } = props;
  const shown = value === undefined ? "" : fmt(value);
  const [text, setText] = useState(shown);
  const [invalid, setInvalid] = useState(false);
  const parse = (raw: string): number | undefined => {
    const trimmed = raw.trim().replace(",", ".");
    if (trimmed === "") return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
  };
  // Follow a reset or another step, unless the user is mid-edit.
  useEffect(() => {
    if (parse(text) !== value) {
      setText(shown);
      setInvalid(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const change = (raw: string) => {
    setText(raw);
    const n = parse(raw);
    if (n === undefined) {
      setInvalid(false);
      props.onChange(undefined);
    } else if (Number.isNaN(n) || n <= 0 || (props.max !== undefined && n > props.max) || (props.whole && !Number.isInteger(n))) {
      setInvalid(true);
    } else {
      setInvalid(false);
      props.onChange(n);
    }
  };

  return (
    <>
      <label htmlFor={id} className={value !== undefined ? "changed" : undefined}>
        {props.label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={text}
        placeholder={props.own}
        aria-invalid={invalid}
        aria-label={`${props.label} of ${props.tool} in this step`}
        className={value !== undefined ? "changed" : undefined}
        onChange={(e) => change(e.target.value)}
        onBlur={() => {
          if (invalid) {
            setText(shown);
            setInvalid(false);
          }
        }}
      />
      <span className="unit">{props.unit}</span>
      {value !== undefined ? (
        <button type="button" className="small bit-reset" title={`Back to ${props.own}`} aria-label={`${props.label}: back to ${props.own}`} onClick={() => props.onChange(undefined)}>
          ↺
        </button>
      ) : (
        <span />
      )}
    </>
  );
}
