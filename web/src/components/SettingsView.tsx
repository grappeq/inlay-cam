// What is kept in this browser and shared by all projects: the tools, the
// machine, and what a new inlay starts with. One page each, with a list of
// the pages beside them.

import { useState, type ReactNode } from "react";
import type { Machine, Setup } from "../core/types";
import { DEFAULT_SETUP, MACHINE_PRESETS, fmt, sameSetup } from "../state/model";
import { useApp, useDispatch, type SettingsPage } from "../state/store";
import { NumberField } from "./NumberField";
import { CutOutFields, HeightFields, TabFields } from "./SetupFields";
import { ToolsPage } from "./ToolsView";

export function SettingsView() {
  const { settingsPage, tools, machine, defaults } = useApp();
  const dispatch = useDispatch();

  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const endMills = tools.filter((t) => t.kind === "flat_end").length;
  const pages: { id: SettingsPage; title: string; note: string }[] = [
    {
      id: "tools",
      title: "Tools",
      note: tools.length === 0 ? "None yet" : `${count(endMills, "end mill", "end mills")}, ${count(tools.length - endMills, "V-bit", "V-bits")}`,
    },
    { id: "machine", title: "Machine", note: `${machine.name}, ${fmt(machine.travel[0])} × ${fmt(machine.travel[1])} mm` },
    {
      id: "defaults",
      title: "New inlays",
      note: sameSetup(defaults, DEFAULT_SETUP) ? "The app's clearances and tabs" : "Your own clearances and tabs",
    },
  ];

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Tools and settings">
        {pages.map((page) => (
          <button
            key={page.id}
            aria-current={settingsPage === page.id ? "page" : undefined}
            onClick={() => dispatch({ type: "setView", view: "settings", page: page.id })}
          >
            <span className="settings-nav-title">{page.title}</span>
            <span className="settings-nav-note">{page.note}</span>
          </button>
        ))}
        <p className="settings-nav-foot">Kept in this browser and used by all your projects.</p>
      </nav>
      <main className="settings-page">
        {settingsPage === "tools" ? <ToolsPage /> : settingsPage === "machine" ? <MachinePage /> : <DefaultsPage />}
      </main>
    </div>
  );
}

/** One topic of a settings page: what it is about on the left, its fields on the right. */
function Group(props: { title: string; note: ReactNode; children: ReactNode }) {
  return (
    <section className="setting-group">
      <div className="setting-about">
        <h3>{props.title}</h3>
        <p>{props.note}</p>
      </div>
      <div className="setting-fields">{props.children}</div>
    </section>
  );
}

/** The limits of the machine the files are checked against. */
function MachinePage() {
  const { machine } = useApp();
  const dispatch = useDispatch();
  const set = (change: Partial<Machine>) => dispatch({ type: "setMachine", machine: { ...machine, ...change } });
  // The name is typed freely, but an empty one is never kept.
  const [name, setName] = useState(machine.name);
  if (name.trim() !== "" && name !== machine.name && document.activeElement?.id !== "machine-name") setName(machine.name);

  return (
    <>
      <div className="toolbar">
        <h2>Your machine</h2>
      </div>
      <p className="muted lead">
        Every file is checked against these limits before you get it. The files themselves are always written for the Carvera Community Firmware.
      </p>
      <div className="setting-card">
        <Group title="Which machine" note="The name is used in messages. A preset fills in the travel and the top spindle speed.">
          <div className="row setup-row">
            <label className="field">
              <span className="field-label">Name</span>
              <span className="field-input">
                <input
                  id="machine-name"
                  type="text"
                  value={name}
                  aria-invalid={name.trim() === ""}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (e.target.value.trim() !== "") set({ name: e.target.value });
                  }}
                  onBlur={() => setName(machine.name)}
                />
              </span>
            </label>
          </div>
          <div className="presets">
            <span className="muted">Fill in for</span>
            {MACHINE_PRESETS.map((preset) => (
              <button
                key={preset.name}
                className="small"
                onClick={() => {
                  set({ name: preset.name, maxRpm: preset.maxRpm, travel: preset.travel });
                  setName(preset.name);
                }}
              >
                {preset.name}
              </button>
            ))}
          </div>
        </Group>
        <Group title="Travel" note="How far the tool can move. A file whose moves span more is refused.">
          <div className="row setup-row">
            <NumberField label="In X" unit="mm" min={1} value={machine.travel[0]} onChange={(v) => v !== undefined && set({ travel: [v, machine.travel[1]] })} />
            <NumberField label="In Y" unit="mm" min={1} value={machine.travel[1]} onChange={(v) => v !== undefined && set({ travel: [machine.travel[0], v] })} />
          </div>
        </Group>
        <Group title="Speeds" note="A tool set to run faster than the spindle can is refused. The rapid speed is only used for the time estimates.">
          <div className="row setup-row">
            <NumberField label="Top spindle speed" unit="rpm" min={1} whole value={machine.maxRpm} onChange={(v) => v !== undefined && set({ maxRpm: v })} />
            <NumberField label="Rapid speed" unit="mm/min" min={1} value={machine.rapidRate} onChange={(v) => v !== undefined && set({ rapidRate: v })} />
          </div>
        </Group>
        <Group
          title="Tool numbers"
          note="The tools of a file are numbered from here, in the order they are used. On a Carvera with a tool rack, T1 to T6 are the rack's slots and are loaded automatically; start at 7 to be asked for each tool by hand."
        >
          <div className="row setup-row">
            <NumberField label="First tool number" min={1} max={99} whole value={machine.firstTool} onChange={(v) => v !== undefined && set({ firstTool: v })} />
          </div>
        </Group>
      </div>
    </>
  );
}

/** The clearances and tabs a new inlay starts with. */
function DefaultsPage() {
  const { defaults } = useApp();
  const dispatch = useDispatch();
  const set = (change: Partial<Setup>) => dispatch({ type: "setDefaults", defaults: { ...defaults, ...change } });
  const own = !sameSetup(defaults, DEFAULT_SETUP);

  return (
    <>
      <div className="toolbar">
        <h2>Defaults for new inlays</h2>
        <span className="spacer" />
        <button disabled={!own} onClick={() => dispatch({ type: "setDefaults", defaults: DEFAULT_SETUP })}>
          Back to the app's values
        </button>
      </div>
      <p className="muted lead">
        The clearances and tabs a new inlay starts with. Each inlay keeps its own, which you can change in the inlay under "Clearances and tabs".
        Changing a value here does not alter inlays you have already made.
      </p>
      <div className="setting-card">
        <Group title="Heights" note="Where the tool travels between cuts, and where it slows down on the way into the wood.">
          <HeightFields setup={defaults} onChange={set} />
        </Group>
        <Group title="Tabs" note="Small bridges of wood that hold a part to its board until you cut it free. Used where an inlay has tabs switched on.">
          <TabFields setup={defaults} onChange={set} />
        </Group>
        <Group title="Cutting parts out" note="For loose inserts, and for a plug that is cut out of a larger board.">
          <CutOutFields setup={defaults} onChange={set} />
        </Group>
      </div>
    </>
  );
}
