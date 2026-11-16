import { useState } from "react";
import type { MaterialInfo } from "../core/types";
import { allMaterials, isBuiltInMaterial, materialKey } from "../state/model";
import { useApp, useDispatch } from "../state/store";

/** The materials cutting settings can be given for: a page of the settings view. */
export function MaterialsPage() {
  const { tools, lists, project } = useApp();
  const dispatch = useDispatch();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const materials = allMaterials(lists);
  const own = lists.materials ?? [];
  const setMaterials = (next: MaterialInfo[]) => dispatch({ type: "setTools", tools, lists: { ...lists, materials: next } });

  const rows = (key: string) => tools.reduce((n, t) => n + t.cutting.filter((c) => c.material === key).length, 0);
  // What still refers to a material, and so keeps it from being deleted.
  const uses = (key: string): string[] => {
    const out: string[] = [];
    const n = rows(key);
    if (n > 0) out.push(`${n} cutting row${n === 1 ? "" : "s"}`);
    const listed = tools.filter(
      (t) => t.recommendedFor?.includes(key) || t.inventory?.log?.some((entry) => entry.material === key),
    ).length;
    if (listed > 0) out.push(`${listed} tool${listed === 1 ? "" : "s"} that list${listed === 1 ? "s" : ""} it`);
    const jobs = project.jobs.filter((j) => j.material === key).length;
    if (jobs > 0) out.push(`${jobs} part${jobs === 1 ? "" : "s"} of the open project`);
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

  const rename = (key: string, label: string) =>
    setMaterials(own.map((m) => (m.key === key ? { ...m, label: label.trim() === "" ? undefined : label } : m)));

  const remove = (key: string, label: string) => {
    if (!confirm(`Delete the material "${label}"?`)) return;
    setMaterials(own.filter((m) => m.key !== key));
  };

  return (
    <>
      <div className="toolbar">
        <h2>Materials</h2>
      </div>
      <p className="muted lead">
        What you cut. Each tool has its own cutting settings per material, and a part of a project is cut with the settings for its material. Hardwood and
        softwood are always here. The app's toolpaths have only been proven in wood: treat any other material as untested.
      </p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Name in Makera CAM</th>
              <th className="num">Cutting rows</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {materials.map(({ value: key, label }) => {
              const info = own.find((m) => m.key === key);
              const fixed = isBuiltInMaterial(key);
              const used = uses(key);
              return (
                <tr key={key}>
                  <td>
                    {fixed ? (
                      label
                    ) : (
                      <input type="text" className="material-name" style={{ width: "100%", minWidth: "12rem" }} aria-label={`Name of ${label}`} value={info?.label ?? label} onChange={(e) => rename(key, e.target.value)} />
                    )}
                  </td>
                  <td>
                    <code>{key}</code>
                  </td>
                  <td>{info?.cam?.name ?? <span className="muted">none</span>}</td>
                  <td className="num">{rows(key)}</td>
                  <td className="row-actions">
                    {fixed ? (
                      <span className="muted">Always here</span>
                    ) : (
                      <button
                        className="danger"
                        disabled={used.length > 0}
                        title={used.length > 0 ? `Still used by ${used.join(", ")}.` : undefined}
                        onClick={() => remove(key, label)}
                      >
                        Delete
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
        className="materials-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <label className="field">
          <span className="field-label">New material</span>
          <input type="text" value={name} placeholder="Such as Oak or Acrylic" onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit">Add material</button>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="muted">
        The key is how files refer to a material; it does not change when you rename it. A material can be deleted once no cutting row, tool or part of the
        open project uses it. A material you add here has no record in the Makera apps, so libraries written for them leave its rows out.
      </p>
    </>
  );
}
