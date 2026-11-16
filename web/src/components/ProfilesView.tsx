import { useState } from "react";
import type { FeedLevel, Profile } from "../core/types";
import { isAdaptive, profileKey } from "../state/model";
import { useApp, useDispatch } from "../state/store";

const LEVELS: { value: FeedLevel; label: string }[] = [
  { value: "gentle", label: "Gentle" },
  { value: "slot_safe", label: "Slot-safe" },
  { value: "standard", label: "Standard" },
  { value: "firm", label: "Firm" },
  { value: "aggressive", label: "Aggressive" },
];

/** The kinds of toolpath a tool can keep a further cutting row for: a page of the settings view. */
export function ProfilesPage() {
  const { tools, lists, project } = useApp();
  const dispatch = useDispatch();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const profiles = lists.profiles ?? [];
  const setProfiles = (next: Profile[], nextTools = tools) => dispatch({ type: "setTools", tools: nextTools, lists: { ...lists, profiles: next } });
  const change = (key: string, update: Partial<Profile>) => setProfiles(profiles.map((p) => (p.key === key ? { ...p, ...update } : p)));

  const rows = (key: string) => tools.reduce((n, t) => n + t.cutting.filter((c) => c.profile === key).length, 0);
  const jobs = (key: string) => project.jobs.filter((j) => Object.values(j.rowProfiles ?? {}).includes(key)).length;
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
    const used = jobs(profile.key);
    const warning =
      (n > 0 ? ` Its ${n} cutting row${n === 1 ? "" : "s"} will be deleted from your tools.` : "") +
      (used > 0 ? ` ${used} part${used === 1 ? "" : "s"} of the open project use${used === 1 ? "s" : ""} it and will need another row chosen.` : "");
    if (!confirm(`Delete the profile "${profile.label}"?${warning}`)) return;
    setProfiles(
      profiles.filter((p) => p.key !== profile.key),
      tools.map((t) => (t.cutting.some((c) => c.profile === profile.key) ? { ...t, cutting: t.cutting.filter((c) => c.profile !== profile.key) } : t)),
    );
  };

  return (
    <>
      <div className="toolbar">
        <h2>Profiles</h2>
      </div>
      <p className="muted lead">
        A tool's plain cutting settings are safe for any cut. A profile names one kind of toolpath, such as a finishing pass or a slot, so that a tool can keep
        a further row tuned for it. On a tool's sheet a row is given to a profile under "For"; in a project, a tool can then be told to run that row.
      </p>

      {profiles.length === 0 && (
        <div className="empty-card">
          <p>No profiles yet.</p>
          <p className="muted">You need none to cut: every tool has its plain settings. Add one when a tool should cut differently for one kind of toolpath.</p>
        </div>
      )}

      {profiles.map((profile) => {
        const adaptive = isAdaptive(profile.key, profile);
        return (
          <section key={profile.key} className="sheet-section">
            <div className="row">
              <label className="field grow">
                <span className="field-label">Name</span>
                <NameField value={profile.label} onChange={(label) => rename(profile, label)} taken={(label) => taken(label, profile.key)} />
              </label>
              <label className="field">
                <span className="field-label">Suggestions start at</span>
                <select value={profile.level ?? ""} onChange={(e) => change(profile.key, { level: e.target.value === "" ? undefined : (e.target.value as FeedLevel) })}>
                  <option value="">Slot-safe, as a plain row</option>
                  {LEVELS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field wide">
              <span className="field-label">Note</span>
              <input
                type="text"
                maxLength={200}
                value={profile.note ?? ""}
                onChange={(e) => change(profile.key, { note: e.target.value === "" ? undefined : e.target.value })}
              />
              <span className="hint">Shown where the profile is chosen.</span>
            </label>
            <div className="check-list">
              <label className="check" title="The suggested plunge is for a tool that goes down along a ramp, not straight.">
                <input type="checkbox" checked={profile.ramping ?? false} onChange={(e) => change(profile.key, { ramping: e.target.checked || undefined })} />
                Ramped entry
              </label>
              <label className="check" title="The cut gets light lubrication. It changes the suggestions for titanium and for adaptive cuts in aluminium.">
                <input type="checkbox" checked={profile.lubricated ?? false} onChange={(e) => change(profile.key, { lubricated: e.target.checked || undefined })} />
                Lubricated
              </label>
              <label className="check" title="A cut as wide as the tool, such as a slot or a contour: suggested with the whole diameter as its stepover.">
                <input type="checkbox" checked={profile.slot ?? false} onChange={(e) => change(profile.key, { slot: e.target.checked || undefined })} />
                Full-width cut
              </label>
              <label className="check" title="A light sideways cut taken deep, as other CAM programs' adaptive clearing makes.">
                <input type="checkbox" checked={adaptive} onChange={(e) => change(profile.key, { adaptive: e.target.checked })} />
                Adaptive clearing
              </label>
            </div>
            {adaptive && (
              <p className="hint warn">
                This app has no adaptive toolpath, so it does not cut with this profile's rows: run as its pockets are, they would bury the tool at full width.
                The rows are kept, and written for other programs.
              </p>
            )}
            <div className="row">
              <span className="muted">
                Key <code>{profile.key}</code> · {rows(profile.key)} cutting row{rows(profile.key) === 1 ? "" : "s"}
                {jobs(profile.key) > 0 ? ` · used by ${jobs(profile.key)} part${jobs(profile.key) === 1 ? "" : "s"} of the open project` : ""}
              </span>
              <span className="spacer" />
              <button type="button" className="danger" onClick={() => remove(profile)}>
                Delete
              </button>
            </div>
          </section>
        );
      })}

      <form
        className="materials-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <label className="field">
          <span className="field-label">New profile</span>
          <input type="text" value={name} maxLength={40} placeholder="Such as Finishing or Slot" onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit">Add profile</button>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="muted">
        The four ticks and the starting stop only say where the suggested values on a tool's sheet begin for this profile's rows. They change no row and no
        file. The key is how files refer to a profile; it does not change when you rename it.
      </p>
    </>
  );
}

/** A name that is kept as typed while it cannot be used, and says why. */
function NameField(props: { value: string; onChange: (value: string) => void; taken: (value: string) => boolean }) {
  const [text, setText] = useState(props.value);
  const problem = text.trim() === "" ? "A profile needs a name." : props.taken(text) ? "Another profile has this name." : null;
  return (
    <>
      <input
        type="text"
        maxLength={40}
        value={text}
        aria-invalid={problem !== null}
        onChange={(e) => {
          setText(e.target.value);
          props.onChange(e.target.value);
        }}
        onBlur={() => problem && setText(props.value)}
      />
      {problem && <span className="hint warn">{problem} The old name is kept.</span>}
    </>
  );
}
