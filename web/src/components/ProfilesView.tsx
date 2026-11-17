import { useState } from "react";
import type { FeedLevel, Profile } from "../core/types";
import { isAdaptive, profileKey } from "../state/model";
import { useApp, useDispatch } from "../state/store";
import { NameField, PageHead } from "./Cells";

const LEVELS: { value: FeedLevel; label: string }[] = [
  { value: "gentle", label: "Gentle" },
  { value: "slot_safe", label: "Slot-safe" },
  { value: "standard", label: "Standard" },
  { value: "firm", label: "Firm" },
  { value: "aggressive", label: "Aggressive" },
];

/** The kinds of toolpath a tool can keep a further cutting row for. */
export function ProfilesPage() {
  const { tools, lists, project } = useApp();
  const dispatch = useDispatch();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const profiles = lists.profiles ?? [];
  const setProfiles = (next: Profile[], nextTools = tools) => dispatch({ type: "setTools", tools: nextTools, lists: { ...lists, profiles: next } });
  const change = (key: string, update: Partial<Profile>) => setProfiles(profiles.map((p) => (p.key === key ? { ...p, ...update } : p)));

  const rows = (key: string) => tools.reduce((n, t) => n + t.cutting.filter((c) => c.profile === key).length, 0);
  const steps = (key: string) => project.steps.filter((j) => Object.values(j.rowProfiles ?? {}).includes(key)).length;
  const taken = (label: string, but?: string) => profiles.some((p) => p.key !== but && p.label.trim().toLowerCase() === label.trim().toLowerCase());

  const add = () => {
    const label = name.trim();
    if (label === "") return setError("Give the profile a name.");
    if (label.length > 40) return setError("A profile's name is at most 40 characters.");
    if (taken(label)) return setError("There is already a profile with this name.");
    setProfiles([...profiles, { key: profileKey(label, profiles.map((p) => p.key)), label }]);
    setName("");
    setError(null);
  };

  const rename = (profile: Profile, label: string) => {
    // An empty or taken name would not save: keep the old one until the new one is usable.
    if (label.trim() === "" || label.length > 40 || taken(label, profile.key)) return;
    change(profile.key, { label });
  };

  const remove = (profile: Profile) => {
    const n = rows(profile.key);
    const used = steps(profile.key);
    const warning =
      (n > 0 ? ` Its ${n} cutting row${n === 1 ? "" : "s"} will be deleted from your tools.` : "") +
      (used > 0 ? ` ${used} part${used === 1 ? "" : "s"} of the open project use${used === 1 ? "s" : ""} it and will need another row chosen.` : "");
    if (!confirm(`Delete the profile "${profile.label}"?${warning}`)) return;
    setProfiles(
      profiles.filter((p) => p.key !== profile.key),
      tools.map((t) => (t.cutting.some((c) => c.profile === profile.key) ? { ...t, cutting: t.cutting.filter((c) => c.profile !== profile.key) } : t)),
    );
  };

  const way = (profile: Profile, label: string, title: string, on: boolean, set: (on: boolean) => void) => (
    <button type="button" className="chip" aria-pressed={on} aria-label={`${profile.label}: ${label}`} title={title} onClick={() => set(!on)}>
      {label}
    </button>
  );

  return (
    <>
      <PageHead title="Profiles">
        A tool's plain cutting settings are safe for any cut. A profile names one kind of toolpath, such as a finishing pass or a slot, so that a tool can keep a further row tuned for
        it.
      </PageHead>

      <section className="block">
        {profiles.length === 0 ? (
          <p className="block-empty">None, and you need none to cut. Add one when a tool should cut differently for one kind of toolpath.</p>
        ) : (
          <div className="cut-wrap">
            <table className="cut-table set-list profiles">
              <thead>
                <tr>
                  <th>Name</th>
                  <th title="Shown where the profile is chosen">Note</th>
                  <th title="The stop the suggestion on a tool's sheet begins at for this profile's rows. It changes no row and no file.">Suggestions start at</th>
                  <th title="How this profile's rows are cut, which shapes what is suggested for them. It changes no row and no file.">Cut</th>
                  <th className="num" title="How many cutting rows your tools keep for it">Rows</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => {
                  const adaptive = isAdaptive(profile.key, profile);
                  const parts = steps(profile.key);
                  return (
                    <tr key={profile.key}>
                      <td>
                        <NameField label={`Name of ${profile.label}`} what="profile" maxLength={40} value={profile.label} onChange={(label) => rename(profile, label)} taken={(label) => taken(label, profile.key)} />
                        <code className="muted set-key" title="What files call the profile. It never changes, also when the profile is renamed.">
                          {profile.key}
                        </code>
                      </td>
                      <td>
                        <input
                          className="cell-in"
                          type="text"
                          maxLength={200}
                          aria-label={`Note on ${profile.label}`}
                          placeholder="None"
                          value={profile.note ?? ""}
                          title={profile.note}
                          onChange={(e) => change(profile.key, { note: e.target.value === "" ? undefined : e.target.value })}
                        />
                      </td>
                      <td>
                        <select className="cell-in" aria-label={`${profile.label}: suggestions start at`} value={profile.level ?? ""} onChange={(e) => change(profile.key, { level: e.target.value === "" ? undefined : (e.target.value as FeedLevel) })}>
                          <option value="">As a plain row</option>
                          {LEVELS.map((l) => (
                            <option key={l.value} value={l.value}>
                              {l.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <span className="ways">
                          {way(profile, "Ramped", "The tool goes down along a ramp, not straight: the suggested plunge is for that.", profile.ramping ?? false, (on) => change(profile.key, { ramping: on || undefined }))}
                          {way(profile, "Lubricated", "The cut gets light lubrication. It changes the suggestions for titanium, and for adaptive cuts in aluminium.", profile.lubricated ?? false, (on) =>
                            change(profile.key, { lubricated: on || undefined }),
                          )}
                          {way(profile, "Full width", "A cut as wide as the tool, such as a slot or a contour: suggested with the whole diameter as its stepover.", profile.slot ?? false, (on) =>
                            change(profile.key, { slot: on || undefined }),
                          )}
                          {way(profile, "Adaptive", "A light sideways cut taken deep, as other programs' adaptive clearing makes.", adaptive, (on) => change(profile.key, { adaptive: on }))}
                        </span>
                        {adaptive && (
                          <span className="hint warn" title="This app has no adaptive toolpath. Run as its pockets are, these rows would bury the tool at full width, so it does not cut with them. They are kept, and written for other programs.">
                            ▲ not cut by this app
                          </span>
                        )}
                      </td>
                      <td className="num" title={parts > 0 ? `Used by ${parts} part${parts === 1 ? "" : "s"} of the open project` : undefined}>
                        {rows(profile.key) || <span className="muted">0</span>}
                        {parts > 0 && <span className="muted"> · in use</span>}
                      </td>
                      <td className="row-actions">
                        <button type="button" className="row-x" aria-label={`Delete the profile ${profile.label}`} title="Delete this profile, and its rows" onClick={() => remove(profile)}>
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <form
          className="block-add"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input className="cell-in" type="text" aria-label="New profile" value={name} maxLength={40} placeholder="A new profile, such as Finishing or Slot" onChange={(e) => setName(e.target.value)} />
          <button type="submit">Add profile</button>
          {error && (
            <span className="form-error" role="alert">
              {error}
            </span>
          )}
        </form>
      </section>
      <p className="hint set-foot">On a tool's sheet a row is given to a profile under "For". In a project, a tool can then be told to run that row.</p>
    </>
  );
}
