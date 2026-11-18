import { useState } from "react";
import type { MaterialInfo } from "../core/types";
import { FEED_MATERIALS, allMaterials, isBuiltInMaterial, materialKey } from "../state/model";
import { useApp, useDispatch } from "../state/store";
import { NameField, PageHead } from "./Cells";
import { HelpTip } from "./HelpTip";

/** The materials cutting settings can be given for: a page of the settings view. */
export function MaterialsPage() {
  const { tools, lists, project } = useApp();
  const dispatch = useDispatch();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const materials = allMaterials(lists);
  const own = lists.materials ?? [];
  const setMaterials = (next: MaterialInfo[]) => dispatch({ type: "setTools", tools, lists: { ...lists, materials: next } });
  // The Makera apps' own materials are only known from an imported tools.yaml.
  const makera = own.some((m) => m.cam !== undefined || (m.studio?.length ?? 0) > 0);

  const rows = (key: string) => tools.reduce((n, t) => n + t.cutting.filter((c) => c.material === key).length, 0);
  // What still refers to a material, and so keeps it from being deleted.
  const uses = (key: string): string[] => {
    const out: string[] = [];
    const n = rows(key);
    if (n > 0) out.push(`${n} cutting row${n === 1 ? "" : "s"}`);
    const listed = tools.filter((t) => t.recommendedFor?.includes(key) || t.inventory?.log?.some((entry) => entry.material === key)).length;
    if (listed > 0) out.push(`${listed} tool${listed === 1 ? "" : "s"} that list${listed === 1 ? "s" : ""} it`);
    const steps = project.steps.filter((j) => j.material === key).length;
    if (steps > 0) out.push(`${steps} part${steps === 1 ? "" : "s"} of the open project`);
    return out;
  };

  const add = () => {
    const label = name.trim();
    if (label === "") return setError("Give the material a name.");
    if (materials.some((m) => m.label.toLowerCase() === label.toLowerCase())) return setError("There is already a material with this name.");
    const key = materialKey(label, materials.map((m) => m.value));
    setMaterials([...own, { key, label }]);
    setName("");
    setError(null);
  };

  const rename = (key: string, label: string) => setMaterials(own.map((m) => (m.key === key ? { ...m, label: label.trim() === "" ? undefined : label } : m)));

  const remove = (key: string, label: string) => {
    if (!confirm(`Delete the material "${label}"?`)) return;
    setMaterials(own.filter((m) => m.key !== key));
  };

  return (
    <>
      <PageHead title="Materials">What you cut. A tool keeps its own cutting settings for each material, and a part of a project is cut with those for its material.</PageHead>

      <section className="block">
        <div className="cut-wrap">
          <table className="cut-table set-list">
            <thead>
              <tr>
                <th>Name</th>
                <th>
                  Key <HelpTip topic="materialKey" />
                </th>
                <th>
                  Suggestions as <HelpTip topic="materialFeedsAs" />
                </th>
                {makera && <th>Makera CAM</th>}
                {makera && <th>Makera Studio</th>}
                <th className="num">Rows</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {materials.map(({ value: key, label }) => {
                const info = own.find((m) => m.key === key);
                const fixed = isBuiltInMaterial(key);
                const used = uses(key);
                const known = FEED_MATERIALS.some((m) => m.value === key);
                return (
                  <tr key={key}>
                    <td>{fixed ? <b>{label}</b> : <NameField label={`Name of ${label}`} what="material" value={label} onChange={(next) => rename(key, next)} taken={(next) => materials.some((o) => o.value !== key && o.label.trim().toLowerCase() === next.trim().toLowerCase())} />}</td>
                    <td>
                      <code className="muted">{key}</code>
                    </td>
                    <td>
                      {known ? (
                        <span className="muted">itself</span>
                      ) : (
                        <select
                          className={info?.feedsAs ? "cell-in" : "cell-in unset"}
                          aria-label={`${label} is suggested as`}
                          value={info?.feedsAs ?? ""}
                          onChange={(e) => setMaterials(own.map((m) => (m.key === key ? { ...m, feedsAs: e.target.value === "" ? undefined : e.target.value } : m)))}
                        >
                          <option value="">nothing: no suggestions</option>
                          {FEED_MATERIALS.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    {makera && <td>{info?.cam?.name ?? <span className="muted">—</span>}</td>}
                    {makera && <td>{info?.studio?.length ? info.studio.map((s) => s.name).join(", ") : <span className="muted">—</span>}</td>}
                    <td className="num">{rows(key) || <span className="muted">0</span>}</td>
                    <td className="row-actions">
                      {fixed ? (
                        <span className="muted" title="The app's own materials are always here">
                          built in
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="row-x"
                          aria-label={`Delete the material ${label}`}
                          disabled={used.length > 0}
                          title={used.length > 0 ? `Cannot be deleted: still used by ${used.join(", ")}.` : "Delete this material"}
                          onClick={() => remove(key, label)}
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <form
          className="block-add"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input className="cell-in" type="text" aria-label="New material" value={name} placeholder="A new material, such as Oak or Acrylic" onChange={(e) => (setName(e.target.value), setError(null))} />
          <button type="submit">Add material</button>
          {error && (
            <span className="form-error" role="alert">
              {error}
            </span>
          )}
        </form>
      </section>
      <p className="hint warn set-foot">▲ The app's toolpaths have only been proven in wood: treat any other material as untested.</p>
      {makera && <p className="hint set-foot">A material with no Makera material beside it is left out of the libraries written for those apps.</p>}
    </>
  );
}
