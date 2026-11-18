// What is kept in this browser and shared by all projects. The header's
// Tools tab shows the tools; its Settings tab the materials and profiles they
// refer to, the machine, and what a new inlay starts with: a list of the four
// on the left, the one picked on the right, as the tools are shown.

import { useState, type ReactNode } from "react";
import type { Machine, Setup } from "../core/types";
import { DEFAULT_SETUP, FEED_MATERIALS, MACHINE_PRESETS, MAX_TOOL_CHANGE_SECONDS, SETUP_LIMITS, allMaterials, fmt, sameSetup } from "../state/model";
import { useApp, useDispatch, type SettingsPage } from "../state/store";
import { Num, PageHead } from "./Cells";
import { HELP } from "./help";
import { MaterialsPage } from "./MaterialsView";
import { ProfilesPage } from "./ProfilesView";
import { ToolsArea } from "./ToolsView";

export function SettingsView() {
  const { settingsPage, lists, machine, defaults, home } = useApp();
  const dispatch = useDispatch();
  if (settingsPage === "tools") return <ToolsArea />;

  const materials = allMaterials(lists);
  const unknown = materials.filter((m) => !FEED_MATERIALS.some((f) => f.value === m.value) && !lists.materials?.find((i) => i.key === m.value)?.feedsAs).length;
  const profiles = lists.profiles ?? [];
  const changed = (Object.keys(SETUP_LIMITS) as (keyof Setup)[]).filter((key) => defaults[key] !== DEFAULT_SETUP[key]).length;
  const pages: { id: SettingsPage; label: string; summary: string }[] = [
    { id: "materials", label: "Materials", summary: `${materials.length} materials${unknown > 0 ? `, ${unknown} without suggestions` : ""}` },
    { id: "profiles", label: "Profiles", summary: profiles.length === 0 ? "none: plain settings only" : profiles.map((p) => p.label).join(", ") },
    { id: "machine", label: "Machine", summary: `${machine.name}, ${fmt(machine.travel[0])} × ${fmt(machine.travel[1])} mm` },
    { id: "defaults", label: "New inlays", summary: changed === 0 ? "the app's values" : `${changed} of your own` },
  ];
  return (
    <div className="settings-split">
      <nav className="set-nav" aria-label="Settings">
        {pages.map((page) => (
          <button key={page.id} aria-current={settingsPage === page.id ? "page" : undefined} onClick={() => dispatch({ type: "setView", view: "settings", page: page.id })}>
            <b>{page.label}</b>
            <span>{page.summary}</span>
          </button>
        ))}
        <p className="set-nav-foot">
          {home === "server" ? "Kept on this server, for everyone who opens it." : "Kept in this browser, for all your projects."}
        </p>
      </nav>
      <main className="tool-pane">
        <div className="card set-card">{settingsPage === "materials" ? <MaterialsPage /> : settingsPage === "profiles" ? <ProfilesPage /> : settingsPage === "machine" ? <MachinePage /> : <DefaultsPage />}</div>
      </main>
    </div>
  );
}

/** One setting on one line: its name, its field, and what it does. */
function Row(props: { label: string; what: ReactNode; children: ReactNode; own?: ReactNode }) {
  return (
    <tr>
      <th scope="row">{props.label}</th>
      <td className="set-val">{props.children}</td>
      <td className="set-what">
        {props.what}
        {props.own}
      </td>
    </tr>
  );
}

function Rows(props: { title: string; children: ReactNode }) {
  return (
    <section className="block">
      <h3>{props.title}</h3>
      <table className="set-table">
        <tbody>{props.children}</tbody>
      </table>
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
  const isPreset = (preset: Machine) => preset.name === machine.name && preset.maxRpm === machine.maxRpm && preset.travel[0] === machine.travel[0] && preset.travel[1] === machine.travel[1];

  return (
    <>
      <PageHead title="Machine">Every file is checked against these limits before you get it. Files are written for the Carvera Community Firmware.</PageHead>
      <Rows title="Which machine">
        <Row
          label="Name"
          what={
            <span className="presets">
              Fill in for
              {MACHINE_PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  className="chip"
                  aria-pressed={isPreset(preset)}
                  title={`${fmt(preset.travel[0])} × ${fmt(preset.travel[1])} mm, ${preset.maxRpm} rpm`}
                  onClick={() => {
                    set({ name: preset.name, maxRpm: preset.maxRpm, travel: preset.travel });
                    setName(preset.name);
                  }}
                >
                  {preset.name}
                </button>
              ))}
            </span>
          }
        >
          <input
            id="machine-name"
            className="cell-in"
            type="text"
            aria-label="Machine name"
            value={name}
            aria-invalid={name.trim() === ""}
            onChange={(e) => {
              setName(e.target.value);
              if (e.target.value.trim() !== "") set({ name: e.target.value });
            }}
            onBlur={() => setName(machine.name)}
          />
        </Row>
      </Rows>
      <Rows title="Limits">
        <Row label="Travel" what="How far the tool can move. A file whose moves span more is refused.">
          <span className="pair">
            <Num label="Travel in X" unit="mm X" min={1} value={machine.travel[0]} onChange={(v) => v !== undefined && set({ travel: [v, machine.travel[1]] })} />
            <Num label="Travel in Y" unit="mm Y" min={1} value={machine.travel[1]} onChange={(v) => v !== undefined && set({ travel: [machine.travel[0], v] })} />
          </span>
        </Row>
        <Row label="Spindle speed" what="Lowest and top. A tool set to turn faster than the top is refused. Suggested cutting settings keep within the two, and run wood at the top.">
          <span className="pair">
            <Num
              label="Lowest spindle speed"
              unit="to"
              min={1}
              max={machine.maxRpm}
              whole
              value={machine.minRpm}
              onChange={(v) => v !== undefined && set({ minRpm: v })}
            />
            <Num
              label="Top spindle speed"
              unit="rpm"
              min={1}
              whole
              value={machine.maxRpm}
              onChange={(v) => v !== undefined && set({ maxRpm: v, minRpm: Math.min(machine.minRpm, v) })}
            />
          </span>
        </Row>
      </Rows>
      <Rows title="Time estimates">
        <Row label="Rapid speed" what="How fast the tool travels between cuts.">
          <Num label="Rapid speed" unit="mm/min" min={1} value={machine.rapidRate} onChange={(v) => v !== undefined && set({ rapidRate: v })} />
        </Row>
        <Row label="A tool change takes" what="Added to a file's time for each tool it loads. At 0, the time is given without tool changes.">
          <Num
            label="A tool change takes"
            unit="s"
            min={0}
            max={MAX_TOOL_CHANGE_SECONDS}
            value={machine.toolChangeSeconds ?? 0}
            onChange={(v) => v !== undefined && set({ toolChangeSeconds: v })}
          />
        </Row>
      </Rows>
      <Rows title="Tool numbers">
        <Row label="First tool number" what="A file's tools are numbered from here, in the order they are used. With a tool rack, T1 to T6 are loaded by themselves; start at 7 to be asked for each tool by hand.">
          <Num label="First tool number" min={1} max={99} whole value={machine.firstTool} onChange={(v) => v !== undefined && set({ firstTool: v })} />
        </Row>
      </Rows>
    </>
  );
}

const SETUP_ROWS: { title: string; rows: { key: keyof Setup; label: string; unit: string; what: string }[] }[] = [
  // What a field is, is said once: here as it is beside the field in an inlay's panel.
  {
    title: "Heights",
    rows: [
      { key: "safeHeight", label: "Travel height", unit: "mm", what: HELP.safeHeight.text },
      { key: "plungeClearance", label: "Plunge from", unit: "mm", what: HELP.plungeClearance.text },
    ],
  },
  {
    title: "Entry and finishing",
    rows: [
      { key: "rampAngle", label: "Ramp angle", unit: "°", what: HELP.rampAngle.text },
      { key: "finishAllowance", label: "Left for a finishing pass", unit: "mm", what: HELP.finishAllowance.text },
    ],
  },
  {
    title: "Tabs",
    rows: [
      { key: "tabWidth", label: "Tab width", unit: "mm", what: "Tabs hold a part to its board until you cut it free, where an inlay has them switched on." },
      { key: "tabSpacing", label: "Tab spacing", unit: "mm", what: "An outline gets a tab about this often, and at least three where it is long enough." },
      { key: "tabThickness", label: "Tab thickness", unit: "mm", what: "Never more than half the board." },
    ],
  },
  {
    title: "Cutting parts out",
    rows: [
      { key: "throughCut", label: "Cut past the bottom", unit: "mm", what: HELP.throughCut.text },
      { key: "cutOutBorder", label: "Board around a cut-out plug", unit: "mm", what: HELP.cutOutBorder.text },
    ],
  },
];

/** The clearances and tabs a new inlay starts with. */
function DefaultsPage() {
  const { defaults } = useApp();
  const dispatch = useDispatch();
  const set = (change: Partial<Setup>) => dispatch({ type: "setDefaults", defaults: { ...defaults, ...change } });
  const own = !sameSetup(defaults, DEFAULT_SETUP);
  const change = (key: keyof Setup, v: number) => set({ [key]: v });
  // The plunge can never start above the height the tool travels at: brought down once the travel height is typed, not at each digit of it.
  const settle = () => defaults.plungeClearance > defaults.safeHeight && set({ plungeClearance: defaults.safeHeight });

  return (
    <>
      <PageHead
        title="New inlays"
        action={
          <button type="button" disabled={!own} onClick={() => dispatch({ type: "setDefaults", defaults: DEFAULT_SETUP })}>
            Back to the app's values
          </button>
        }
      >
        The clearances and tabs a new inlay starts with. Each inlay keeps its own, so changing these does not alter inlays you have already made.
      </PageHead>
      {SETUP_ROWS.map((group) => (
        <Rows key={group.title} title={group.title}>
          {group.rows.map((row) => (
            <Row
              key={row.key}
              label={row.label}
              what={row.what}
              own={
                defaults[row.key] !== DEFAULT_SETUP[row.key] && (
                  <button type="button" className="link set-own" title="Put the app's value back" onClick={() => change(row.key, DEFAULT_SETUP[row.key])}>
                    Your own. Put back the app's {fmt(DEFAULT_SETUP[row.key])}
                  </button>
                )
              }
            >
              <Num
                label={row.label}
                unit={row.unit}
                min={SETUP_LIMITS[row.key][0]}
                max={row.key === "plungeClearance" ? Math.min(SETUP_LIMITS.plungeClearance[1], defaults.safeHeight) : SETUP_LIMITS[row.key][1]}
                value={defaults[row.key]}
                onChange={(v) => v !== undefined && change(row.key, v)}
                onBlur={row.key === "safeHeight" ? settle : undefined}
              />
            </Row>
          ))}
        </Rows>
      ))}
    </>
  );
}
