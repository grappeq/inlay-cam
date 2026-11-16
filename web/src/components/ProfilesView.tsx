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

  const tick = (profile: Profile, label: string, title: string, checked: boolean, set: (on: boolean) => void) => (
    <label className="check" title={title}>
      <input type="checkbox" aria-label={`${profile.label}: ${label}`} checked={checked} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );

  return (
    <>
      <p className="muted lead">
        A tool's plain cutting settings are safe for any cut. A profile names one kind of toolpath, such as a finishing pass or a slot, so that a tool can keep a further row
        tuned for it. On a tool's sheet a row is given to a profile under "For"; in a project, a tool can then be told to run that row.
      </p>

      <section className="block">
        <h3>
          Profiles <span className="muted">{profiles.length === 0 ? "none: plain settings only" : profiles.length}</span>
        </h3>
        {profiles.length === 0 && <p className="block-empty">You need none to cut. Add one when a tool should cut differently for one kind of toolpath.</p>}
        {profiles.map((profile) => {
          const adaptive = isAdaptive(profile.key, profile);
          return (
            <div key={profile.key} className="profile-row">
              <div className="profile-main">
                <NameField value={profile.label} onChange={(label) => rename(profile, label)} taken={(label) => taken(label, profile.key)} />
                <input
                  className="cell-in"
                  type="text"
                  maxLength={200}
                  aria-label={`Note on ${profile.label}`}
                  placeholder="A note, shown where the profile is chosen"
                  value={profile.note ?? ""}
                  onChange={(e) => change(profile.key, { note: e.target.value === "" ? undefined : e.target.value })}
                />
              </div>
              <div className="profile-starts">
                <label>
                  <span className="muted">Suggestions start at</span>
                  <select aria-label={`${profile.label}: suggestions start at`} value={profile.level ?? ""} onChange={(e) => change(profile.key, { level: e.target.value === "" ? undefined : (e.target.value as FeedLevel) })}>
                    <option value="">Slot-safe, as a plain row</option>
                    {LEVELS.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>
                {tick(profile, "Ramped entry", "The suggested plunge is for a tool that goes down along a ramp, not straight.", profile.ramping ?? false, (on) => change(profile.key, { ramping: on || undefined }))}
                {tick(profile, "Lubricated", "The cut gets light lubrication. It changes the suggestions for titanium and for adaptive cuts in aluminium.", profile.lubricated ?? false, (on) =>
                  change(profile.key, { lubricated: on || undefined }),
                )}
                {tick(profile, "Full-width cut", "A cut as wide as the tool, such as a slot or a contour: suggested with the whole diameter as its stepover.", profile.slot ?? false, (on) =>
                  change(profile.key, { slot: on || undefined }),
                )}
                {tick(profile, "Adaptive clearing", "A light sideways cut taken deep, as other CAM programs' adaptive clearing makes.", adaptive, (on) => change(profile.key, { adaptive: on }))}
              </div>
              <div className="profile-foot">
                <span className="muted">
                  <code>{profile.key}</code>, {rows(profile.key)} cutting row{rows(profile.key) === 1 ? "" : "s"}
                  {jobs(profile.key) > 0 ? `, used by ${jobs(profile.key)} part${jobs(profile.key) === 1 ? "" : "s"} of the open project` : ""}
                </span>
                <button type="button" className="danger small" onClick={() => remove(profile)}>
                  Delete
                </button>
              </div>
              {adaptive && (
                <p className="hint warn">
                  This app has no adaptive toolpath, so it does not cut with this profile's rows: run as its pockets are, they would bury the tool at full width. The rows are kept,
                  and written for other programs.
                </p>
              )}
            </div>
          );
        })}
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
      <p className="muted lead">
        The starting stop and the four ticks only say where the suggested values on a tool's sheet begin for this profile's rows. They change no row and no file. The name in
        grey is the key files refer to a profile by; it does not change when you rename it.
      </p>
    </>
  );
}

/** A name that is kept as typed while it cannot be used, and says why. */
function NameField(props: { value: string; onChange: (value: string) => void; taken: (value: string) => boolean }) {
  const [text, setText] = useState(props.value);
  const problem = text.trim() === "" ? "A profile needs a name." : props.taken(text) ? "Another profile has this name." : null;
  return (
    <span className="profile-name">
      <input
        className="cell-in"
        type="text"
        maxLength={40}
        aria-label="Name"
        value={text}
        aria-invalid={problem !== null}
        onChange={(e) => {
          setText(e.target.value);
          props.onChange(e.target.value);
        }}
        onBlur={() => problem && setText(props.value)}
      />
      {problem && <span className="hint warn">{problem} The old name is kept.</span>}
    </span>
  );
}
