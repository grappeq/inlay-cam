// The Tools area: the list of tools beside the sheet of the one picked, and
// the materials and profiles they refer to.

import { useEffect, useMemo, useRef, useState } from "react";
import { core } from "../core/client";
import type { Attention, Material, Tool, ToolKind } from "../core/types";
import { useFileActions } from "../state/files";
import { TOOL_KIND_LABELS, allMaterials, blankTool, currentResult, fmt, jobToolIds, projectOnlyTools, toolSize } from "../state/model";
import { message, useApp, useDispatch } from "../state/store";
import { downloadText, pickTextFile } from "../util/files";
import { MaterialsPage } from "./MaterialsView";
import { ProfilesPage } from "./ProfilesView";
import { ToolCard } from "./ToolCard";
import { ToolSheet } from "./ToolSheet";

/** What a group of tools is called when the tools name none of their own. */
const KIND_GROUPS: Record<ToolKind, string> = {
  flat_end: "End mills",
  ball_end: "Ball end mills",
  v_bit: "V-bits",
  corner_round: "Corner-rounding bits",
  drill: "Drills",
  thread_mill: "Thread mills",
};
const KIND_CHIPS: { kind: ToolKind; label: string }[] = [
  { kind: "flat_end", label: "End mills" },
  { kind: "v_bit", label: "V-bits" },
  { kind: "corner_round", label: "Corner" },
  { kind: "ball_end", label: "Ball" },
  { kind: "drill", label: "Drills" },
  { kind: "thread_mill", label: "Thread" },
];

export function ToolsArea() {
  const { settingsPage, tools, lists } = useApp();
  const dispatch = useDispatch();
  const page = settingsPage === "materials" || settingsPage === "profiles" ? settingsPage : "tools";
  const tab = (id: "tools" | "materials" | "profiles", label: string, count: number) => (
    <button aria-pressed={page === id} onClick={() => dispatch({ type: "setView", view: "settings", page: id })}>
      {label} <span className="count">{count}</span>
    </button>
  );
  return (
    <div className="tools-area">
      <div className="subnav">
        <nav className="tabs" aria-label="Tools, materials and profiles">
          {tab("tools", "Tools", tools.length)}
          {tab("materials", "Materials", allMaterials(lists).length)}
          {tab("profiles", "Profiles", (lists.profiles ?? []).length)}
        </nav>
        <span className="muted subnav-note">Kept in this browser and used by all your projects.</span>
        <span className="spacer" />
        <LibraryMenu />
      </div>
      {page === "tools" ? (
        <ToolsPage />
      ) : (
        <main className="plain-page">
          <div>{page === "materials" ? <MaterialsPage /> : <ProfilesPage />}</div>
        </main>
      )}
    </div>
  );
}

/** A button that opens a short list of actions, and closes when one is taken or the pointer goes elsewhere. */
function Menu(props: { label: string; primary?: boolean; items: { label: string; hint?: string; disabled?: boolean; run: () => void }[] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  return (
    <details className="menu" ref={ref}>
      <summary className={props.primary ? "primary" : ""}>{props.label}</summary>
      <div className="menu-items" role="menu">
        {props.items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (ref.current) ref.current.open = false;
              item.run();
            }}
          >
            {item.label}
            {item.hint && <span className="hint">{item.hint}</span>}
          </button>
        ))}
      </div>
    </details>
  );
}

function LibraryMenu() {
  const { tools, lists } = useApp();
  const dispatch = useDispatch();
  const actions = useFileActions();
  const save = async (name: string, call: "libraryToFile" | "libraryToToolsYaml", mime?: string) => {
    try {
      downloadText(name, await core.call(call, { ...lists, tools }), mime);
    } catch (e) {
      dispatch({ type: "notice", notice: { kind: "error", text: message(e) } });
    }
  };
  return (
    <Menu
      label="Import and export"
      items={[
        { label: "Import a tool file…", hint: "A file this app exported.", run: async () => actions.importToolLibrary(await pickTextFile(".json,application/json")) },
        { label: "Import a tools.yaml…", hint: "From the tooling library.", run: async () => actions.importToolsYaml(await pickTextFile(".yaml,.yml")) },
        { label: "Export a tool file", hint: "Everything here, to keep or move.", disabled: tools.length === 0, run: () => save("tools.inlay-tools.json", "libraryToFile") },
        { label: "Export a tools.yaml", hint: "For the tooling library. No comments.", disabled: tools.length === 0, run: () => save("tools.yaml", "libraryToToolsYaml", "text/yaml") },
      ]}
    />
  );
}

type Mode = { kind: "read" } | { kind: "edit" } | { kind: "new"; tool: Tool };

function ToolsPage() {
  const { tools, lists, project } = useApp();
  const dispatch = useDispatch();
  const actions = useFileActions();
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "read" });
  const [query, setQuery] = useState("");
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [kinds, setKinds] = useState<ToolKind[]>([]);
  const [material, setMaterial] = useState<Material | "">("");
  const [closed, setClosed] = useState<string[]>([]);

  // What wants looking at, worked out by the core whenever the tools change.
  const [attention, setAttention] = useState<Attention[]>([]);
  useEffect(() => {
    let stale = false;
    core
      .call("needsAttention", tools)
      .then((list) => !stale && setAttention(list))
      .catch(() => !stale && setAttention([]));
    return () => {
      stale = true;
    };
  }, [tools]);
  const attentionOf = useMemo(() => {
    const map = new Map<string, Attention[]>();
    for (const item of attention) map.set(item.toolId, [...(map.get(item.toolId) ?? []), item]);
    return map;
  }, [attention]);

  const tool = tools.find((t) => t.id === selected);
  const extra = projectOnlyTools(project, tools);
  const usedIds = new Set(project.jobs.flatMap(jobToolIds));
  const presentKinds = KIND_CHIPS.filter((chip) => tools.some((t) => t.kind === chip.kind));
  const presentMaterials = allMaterials(lists).filter((m) => tools.some((t) => t.cutting.some((c) => c.material === m.value)));

  // Every word typed must be somewhere in what the tool is called, filed under or made of.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = tools.filter((t) => {
    if (onlyAttention && !attentionOf.has(t.id)) return false;
    if (kinds.length > 0 && !kinds.includes(t.kind)) return false;
    if (material !== "" && !t.cutting.some((c) => c.material === material)) return false;
    const text = [t.name, t.group, t.coating, t.style, TOOL_KIND_LABELS[t.kind], toolSize(t)].filter(Boolean).join(" ").toLowerCase().replace(/[×x]/g, "x");
    return words.every((word) => text.includes(word.replace(/×/g, "x")));
  });
  // Groups in the order the list first names them; tools by size within a group.
  const groups: { name: string; tools: Tool[] }[] = [];
  for (const t of shown) {
    const name = t.group ?? KIND_GROUPS[t.kind];
    let group = groups.find((g) => g.name === name);
    if (!group) groups.push((group = { name, tools: [] }));
    group.tools.push(t);
  }
  for (const group of groups) group.tools.sort((a, b) => a.diameter - b.diameter || (a.fluteLength ?? 0) - (b.fluteLength ?? 0) || a.name.localeCompare(b.name));
  const filtered = words.length > 0 || onlyAttention || kinds.length > 0 || material !== "";
  const clear = () => {
    setQuery("");
    setOnlyAttention(false);
    setKinds([]);
    setMaterial("");
  };

  const save = (next: Tool) => {
    const exists = tools.some((t) => t.id === next.id);
    dispatch({ type: "setTools", tools: exists ? tools.map((t) => (t.id === next.id ? next : t)) : [...tools, next] });
    setSelected(next.id);
    setMode({ kind: "read" });
  };
  const remove = (t: Tool) => {
    const used = usedIds.has(t.id) ? " The open project uses it and will keep its own copy." : "";
    if (!confirm(`Delete "${t.name}" from your tools?${used}`)) return;
    dispatch({ type: "setTools", tools: tools.filter((other) => other.id !== t.id) });
    setSelected(null);
  };
  const add = (kind: ToolKind) => setMode({ kind: "new", tool: blankTool(kind) });
  const addMenu = (primary: boolean) => (
    <Menu
      label="Add a tool"
      primary={primary}
      items={[
        { label: "End mill", run: () => add("flat_end") },
        { label: "V-bit", run: () => add("v_bit") },
        { label: "Corner-rounding bit", run: () => add("corner_round") },
        { label: "Ball end mill", hint: "Kept, not cut with here.", run: () => add("ball_end") },
        { label: "Drill", hint: "Kept, not cut with here.", run: () => add("drill") },
        { label: "Thread mill", hint: "Kept, not cut with here.", run: () => add("thread_mill") },
      ]}
    />
  );

  const showing = mode.kind === "new" || tool !== undefined;
  return (
    <div className={showing ? "tools-split showing" : "tools-split"}>
      <section className="tool-list" aria-label="Your tools">
        <div className="tl-head">
          <div className="tl-search">
            <input type="search" aria-label="Find a tool" placeholder="Find a tool: 1/8 2F, 60° v, upcut" value={query} onChange={(e) => setQuery(e.target.value)} />
            {addMenu(false)}
          </div>
          <div className="tl-filters">
            <span className="tabs" role="group" aria-label="Which tools">
              <button aria-pressed={!onlyAttention} onClick={() => setOnlyAttention(false)}>
                All <span className="count">{tools.length}</span>
              </button>
              <button aria-pressed={onlyAttention} disabled={attentionOf.size === 0} onClick={() => setOnlyAttention(true)}>
                <span className="mark warn">▲</span> Needs attention <span className="count">{attentionOf.size}</span>
              </button>
            </span>
            {presentMaterials.length > 1 && (
              <select aria-label="With cutting settings for" value={material} onChange={(e) => setMaterial(e.target.value)}>
                <option value="">Any material</option>
                {presentMaterials.map((m) => (
                  <option key={m.value} value={m.value}>
                    Cuts {m.label.toLowerCase()}
                  </option>
                ))}
              </select>
            )}
          </div>
          {presentKinds.length > 1 && (
            <div className="tl-chips" role="group" aria-label="Kinds of tool">
              {presentKinds.map((chip) => (
                <button
                  key={chip.kind}
                  className="chip"
                  aria-pressed={kinds.includes(chip.kind)}
                  onClick={() => setKinds(kinds.includes(chip.kind) ? kinds.filter((k) => k !== chip.kind) : [...kinds, chip.kind])}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {extra.length > 0 && (
          <p className="tl-banner">
            The open project uses {extra.length === 1 ? "a tool that is" : `${extra.length} tools that are`} not in your list: {extra.map((t) => t.name).join(", ")}.{" "}
            <button className="link" onClick={() => dispatch({ type: "setTools", tools: [...tools, ...extra] })}>
              Add to my tools
            </button>
          </p>
        )}

        <div className="tl-scroll">
          <div className="tl-cols" aria-hidden="true">
            <span>Name</span>
            <span>Size</span>
            <span className="num" title="Shank diameter, mm">
              Shank
            </span>
            <span className="num" title="Flutes">
              Fl.
            </span>
            <span className="num" title="Cutting rows">
              Rows
            </span>
          </div>
          {groups.map((group) => {
            const isClosed = closed.includes(group.name) && !filtered;
            return (
              <div key={group.name} className="tl-group">
                <button
                  className="tl-group-head"
                  aria-expanded={!isClosed}
                  onClick={() => setClosed(isClosed ? closed.filter((g) => g !== group.name) : [...closed, group.name])}
                >
                  <span className="caret" aria-hidden="true" />
                  {group.name}
                  <span className="count">{group.tools.length}</span>
                </button>
                {!isClosed &&
                  group.tools.map((t) => {
                    const flags = attentionOf.get(t.id) ?? [];
                    const failed = t.cutting.some((c) => currentResult(c)?.outcome === "failed");
                    return (
                      <button
                        key={t.id}
                        className="tl-row"
                        aria-current={t.id === selected && mode.kind !== "new" ? "true" : undefined}
                        onClick={() => {
                          setSelected(t.id);
                          setMode({ kind: "read" });
                        }}
                      >
                        <span className="tl-name">
                          {t.name}
                          {flags.length > 0 && (
                            <span className={failed ? "mark danger" : "mark warn"} title={`${flags.length} ${flags.length === 1 ? "thing" : "things"} to look at`}>
                              {" "}
                              ▲{flags.length}
                            </span>
                          )}
                          {usedIds.has(t.id) && (
                            <span className="tl-used" title="Used by the open project">
                              {" "}
                              in use
                            </span>
                          )}
                        </span>
                        <span className="tl-size">{toolSize(t)}</span>
                        <span className="num">{fmt(t.shankDiameter)}</span>
                        <span className="num">{t.flutes ?? ""}</span>
                        <span className={t.cutting.length === 0 ? "num warn" : "num"}>{t.cutting.length}</span>
                      </button>
                    );
                  })}
              </div>
            );
          })}
          {tools.length > 0 && shown.length === 0 && (
            <p className="tl-none">
              No tool matches.{" "}
              <button className="link" onClick={clear}>
                Show all {tools.length}
              </button>
            </p>
          )}
          {tools.length === 0 && <p className="tl-none">No tools yet.</p>}
        </div>
        {filtered && shown.length > 0 && (
          <p className="tl-foot">
            {shown.length} of {tools.length} shown.{" "}
            <button className="link" onClick={clear}>
              Show all
            </button>
          </p>
        )}
      </section>

      <main className="tool-pane">
        {mode.kind === "new" ? (
          <ToolSheet key={mode.tool.id} initial={mode.tool} isNew taken={tools} onSave={save} onCancel={() => setMode({ kind: "read" })} />
        ) : tool && mode.kind === "edit" ? (
          <ToolSheet key={tool.id} initial={tool} isNew={false} taken={tools} onSave={save} onCancel={() => setMode({ kind: "read" })} />
        ) : tool ? (
          <ToolCard
            key={tool.id}
            tool={tool}
            attention={attentionOf.get(tool.id) ?? []}
            onEdit={() => setMode({ kind: "edit" })}
            onDelete={() => remove(tool)}
            onSave={(next) => dispatch({ type: "setTools", tools: tools.map((t) => (t.id === next.id ? next : t)) })}
            onBack={() => setSelected(null)}
          />
        ) : tools.length === 0 ? (
          <div className="pane-empty">
            <h2>Start with the tools you own</h2>
            <p>
              Every cut is made with one of your tools, at the speeds you give it for the material. A flat inlay needs an end mill; a V-carve inlay needs a V-bit, and an end
              mill saves it time.
            </p>
            <div className="row center">
              {addMenu(true)}
              <button onClick={async () => actions.importToolsYaml(await pickTextFile(".yaml,.yml"))}>Import a tools.yaml…</button>
              <button onClick={async () => actions.importToolLibrary(await pickTextFile(".json,application/json"))}>Import a tool file…</button>
            </div>
          </div>
        ) : (
          <div className="pane-empty">
            <p>Pick a tool to see it drawn to scale, with its cutting settings and what was logged about them.</p>
            {attentionOf.size > 0 && (
              <div className="row center">
                <button onClick={() => setOnlyAttention(true)}>
                  <span className="mark warn">▲</span> Show the {attentionOf.size} that {attentionOf.size === 1 ? "needs" : "need"} attention
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
