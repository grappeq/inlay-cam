// The Tools tab: the list of tools beside the sheet of the one picked. The
// list is found in as in the tooling library's workbench: a search that
// reads sizes, chips that show only or hide, and four orders.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { core } from "../core/client";
import type { Attention, MakeraImportPlan, Tool, ToolKind } from "../core/types";
import { useFileActions } from "../state/files";
import { allMaterials, blankTool, currentResult, stepToolIds, materialLabel, projectOnlyTools } from "../state/model";
import { hasUnsaved, mayLeave, setUnsaved } from "../state/unsaved";
import { message, useApp, useDispatch } from "../state/store";
import {
  FLUTES,
  NO_STYLE,
  SHANKS,
  SORTS,
  anyChips,
  chipCounts,
  chipState,
  chipsMatch,
  chipsText,
  cleanChips,
  comparator,
  cycleChip,
  matchesQuery,
  noChips,
  noMatchText,
  parseQuery,
  searchWords,
  shownName,
  sizeOf,
  styleLayout,
  type Chips,
  type Row,
  type SortKey,
} from "../state/toolFind";
import { downloadBytes, downloadText, pickBinaryFile, pickTextFile } from "../util/files";
import { ExportReportDialog, MakeraImportDialog, type ExportReport } from "./LibraryDialogs";
import { ToolCard } from "./ToolCard";
import { recall, remember } from "../storage/view";

/** What a group of tools is called when the tools name none of their own. */
const KIND_GROUPS: Record<ToolKind, string> = {
  flat_end: "End mills",
  ball_end: "Ball end mills",
  v_bit: "V-bits",
  corner_round: "Corner-rounding bits",
  drill: "Drills",
  thread_mill: "Thread mills",
};

/** What wants looking at, by kind, in the order the worst comes first. */
const ATTENTION: { kind: Attention["kind"]; label: string }[] = [
  { kind: "failed", label: "Failed rows" },
  { kind: "provisional", label: "Rows to confirm" },
  { kind: "verify", label: "To check" },
  { kind: "no_cutting", label: "No cutting settings" },
  { kind: "flute_length", label: "Flute length unknown" },
];

const STATE_WORD = { only: "only", hide: "hidden" };
const NEXT_STEP = { off: "click to show only, again to hide", only: "click to hide", hide: "click to clear" };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;


/** Something that opens under a button and closes when the pointer goes elsewhere. */
function Popover(props: { label: ReactNode; title?: string; className?: string; disabled?: boolean; up?: boolean; children: (close: () => void) => ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && ref.current?.open) ref.current.open = false;
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  const close = () => {
    if (ref.current) ref.current.open = false;
  };
  return (
    <details className={props.up ? "menu up" : "menu"} ref={ref}>
      <summary className={props.className} title={props.title} aria-disabled={props.disabled} onClick={(e) => props.disabled && e.preventDefault()}>
        {props.label}
      </summary>
      {props.children(close)}
    </details>
  );
}

function Menu(props: { label: string; primary?: boolean; up?: boolean; items: { label: string; hint?: string; disabled?: boolean; run: () => void }[] }) {
  return (
    <Popover label={props.label} className={props.primary ? "primary" : ""} up={props.up}>
      {(close) => (
        <div className="menu-items" role="menu">
          {props.items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                close();
                item.run();
              }}
            >
              {item.label}
              {item.hint && <span className="hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

function LibraryMenu() {
  const { tools, lists } = useApp();
  const dispatch = useDispatch();
  const actions = useFileActions();
  const [report, setReport] = useState<ExportReport | null>(null);
  const [incoming, setIncoming] = useState<{ plan: MakeraImportPlan; fileName: string } | null>(null);
  const library = { ...lists, tools };
  const guard = (action: () => Promise<void>) => async () => {
    try {
      await action();
    } catch (e) {
      dispatch({ type: "notice", notice: { kind: "error", text: message(e) } });
    }
  };
  const save = (name: string, call: "libraryToFile" | "libraryToToolsYaml", mime?: string) => guard(async () => downloadText(name, await core.call(call, library), mime));
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

  const makera = (app: "cam" | "studio") =>
    guard(async () => {
      const out = await core.call("exportMakera", library, app, new Date().toISOString().replace(/\.\d+Z$/, "Z"));
      const file = app === "cam" ? "tools-makera-cam.tlslibrary" : "tools-makera-studio.tlslibrary";
      downloadBytes(file, new Uint8Array(out.bytes));
      const name = app === "cam" ? "Makera CAM" : "Makera Studio";
      setReport({
        what: `${name} library`,
        files: [file],
        counts: `${count(out.tools, "tool")}, ${count(out.settings, "cutting setting")}, ${count(out.materials, "material")}`,
        warnings: out.warnings,
        next: `In ${name}, select the group the tools should go under and import the file. It adds them as new tools, also when they are there already: delete the old ones first.`,
      });
    });
  const fusion = (split: boolean) =>
    guard(async () => {
      const out = await core.call("exportFusion", library);
      const files = split ? out.sections.map((s) => ({ name: s.name, text: s.text })) : [{ name: "tools-fusion-360.json", text: out.library }];
      for (const file of files) downloadText(file.name, file.text);
      setReport({
        what: "Fusion 360 library",
        files: files.map((f) => f.name),
        counts: `${count(out.tools, "tool")}, ${count(out.presets, "preset")}`,
        warnings: out.warnings,
        next: split
          ? "In Fusion 360's tool library, import each file: a library is named after its file, and libraries are the only folders it has."
          : "In Fusion 360's tool library, import the file. Every cutting row is a preset of its tool.",
      });
    });
  const takeValues = guard(async () => {
    const file = await pickBinaryFile(".tlslibrary");
    if (!file) return;
    setIncoming({ plan: await core.call("planMakeraImport", library, file.bytes), fileName: file.name });
  });
  const none = tools.length === 0;
  const groups = new Set(tools.map((t) => (t.group ?? KIND_GROUPS[t.kind]).split("/")[0].trim())).size;

  return (
    <>
      <Menu
        label="Import and export"
        up
        items={[
          { label: "Add the starter set", hint: "50 bits with cutting settings. Tools you have are left alone.", run: actions.addStarterSet },
          { label: "Import a tool file…", hint: "A file this app exported.", run: async () => actions.importToolLibrary(await pickTextFile(".json,application/json")) },
          { label: "Import a tools.yaml…", hint: "From the tooling library.", run: async () => actions.importToolsYaml(await pickTextFile(".yaml,.yml")) },
          { label: "Take values from a Makera export…", hint: "Sizes and cutting values changed in Makera CAM or Studio.", disabled: none, run: takeValues },
          { label: "Export a tool file", hint: "Everything here, to keep or move.", disabled: none, run: save("tools.task-tools.json", "libraryToFile") },
          { label: "Export a tools.yaml", hint: "For the tooling library.", disabled: none, run: save("tools.yaml", "libraryToToolsYaml", "text/yaml") },
          { label: "Export for Makera CAM", hint: "A .tlslibrary to import there.", disabled: none, run: makera("cam") },
          { label: "Export for Makera Studio", hint: "A .tlslibrary to import there.", disabled: none, run: makera("studio") },
          { label: "Export for Fusion 360", hint: "One .json library with every tool.", disabled: none, run: fusion(false) },
          ...(groups > 1 ? [{ label: "Export for Fusion 360, by group", hint: `${groups} libraries, one per top group.`, disabled: none, run: fusion(true) }] : []),
        ]}
      />
      {report && <ExportReportDialog report={report} onClose={() => setReport(null)} />}
      {incoming && <MakeraImportDialog plan={incoming.plan} fileName={incoming.fileName} onClose={() => setIncoming(null)} />}
    </>
  );
}

type Mode = { kind: "read" } | { kind: "new"; tool: Tool };

/** What the list was narrowed to and showed when it was last on screen, for as long as the page is open. */
const left: { query: string; selected: string | null; closed: string[]; onlyAttention: boolean; category: Attention["kind"] | null } = { query: "", selected: null, closed: [], onlyAttention: false, category: null };

/** Has the tool list show one tool when it is next opened, whatever it was narrowed to. */
export function showInToolList(id: string): void {
  Object.assign(left, { selected: id, query: "", onlyAttention: false, category: null });
}

export function ToolsArea() {
  const { tools, lists, project, home } = useApp();
  const dispatch = useDispatch();
  const actions = useFileActions();
  const [selected, setSelected] = useState<string | null>(left.selected);
  const [mode, setMode] = useState<Mode>({ kind: "read" });
  const [query, setQuery] = useState(left.query);
  const [sort, setSortState] = useState<SortKey>(() => {
    const kept = recall<string>("tools.sort", "group");
    return SORTS.some((s) => s.key === kept) ? (kept as SortKey) : "group";
  });
  const [chips, setChipsState] = useState<Chips>(() => cleanChips(recall<unknown>("tools.chips", null)));
  const [onlyAttention, setOnlyAttention] = useState(left.onlyAttention);
  const [category, setCategory] = useState<Attention["kind"] | null>(left.category);
  const [closed, setClosed] = useState<string[]>(left.closed);
  Object.assign(left, { query, selected, closed, onlyAttention, category });
  const setSort = (key: SortKey) => (setSortState(key), remember("tools.sort", key));
  const setChips = (next: Chips) => (setChipsState(next), remember("tools.chips", next));

  // Whether the sheet holds changes that are not saved, so that leaving it can ask first.
  const onDirty = useCallback((value: boolean) => setUnsaved(value), []);
  useEffect(() => {
    // Closing or reloading the page would lose them too.
    const ask = (e: BeforeUnloadEvent) => hasUnsaved() && e.preventDefault();
    window.addEventListener("beforeunload", ask);
    return () => {
      window.removeEventListener("beforeunload", ask);
      setUnsaved(false);
    };
  }, []);

  // What wants looking at, worked out by the core whenever the tools change.
  const [attention, setAttention] = useState<Attention[] | null>(null);
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
    for (const item of attention ?? []) map.set(item.toolId, [...(map.get(item.toolId) ?? []), item]);
    return map;
  }, [attention]);

  const label = useCallback((key: string) => materialLabel(key, lists), [lists]);
  const wordsOf = useMemo(() => new Map(tools.map((t) => [t.id, searchWords(t, label)])), [tools, label]);
  const index = useMemo(() => new Map(tools.map((t, i) => [t.id, i])), [tools]);
  const tool = tools.find((t) => t.id === selected);
  const extra = projectOnlyTools(project, tools);
  const usedIds = new Set(project.steps.flatMap(stepToolIds));

  const tokens = parseQuery(query);
  const searched = tools.filter((t) => matchesQuery(wordsOf.get(t.id) ?? new Set(), tokens));
  const styles = useMemo(() => styleLayout(tools), [tools]);
  const recommended = new Set(tools.flatMap((t) => t.recommendedFor ?? []));
  const materialKeys = allMaterials(lists)
    .map((m) => m.value)
    .filter((k) => recommended.has(k) || chipState(chips, "material", k));
  const styleKeys = [...styles.chips, ...styles.more];
  const counts = chipCounts(searched, chips, { style: styleKeys, material: materialKeys });
  const chipLabel = (row: Row, key: string) => (row === "material" ? label(key) : row === "style" ? (key === NO_STYLE ? "No style set" : (styles.labels.get(key) ?? key)) : key);

  const shown = onlyAttention ? searched.filter((t) => (attentionOf.get(t.id) ?? []).some((a) => category === null || a.kind === category)) : searched.filter((t) => chipsMatch(t, chips));
  const compare = comparator(sort, (t) => index.get(t.id) ?? 0);
  // By group, the groups stay in the order the list first names them; the other orders are one flat list.
  const groups: { name: string | null; tools: Tool[] }[] = [];
  if (sort === "group") {
    for (const t of shown) {
      const name = t.group ?? KIND_GROUPS[t.kind];
      let group = groups.find((g) => g.name === name);
      if (!group) groups.push((group = { name, tools: [] }));
      group.tools.push(t);
    }
    const order = [...new Set(tools.map((t) => t.group ?? KIND_GROUPS[t.kind]))];
    groups.sort((a, b) => order.indexOf(a.name as string) - order.indexOf(b.name as string));
    for (const group of groups) group.tools.sort(compare);
  } else if (shown.length > 0) {
    groups.push({ name: null, tools: [...shown].sort(compare) });
  }
  const filtering = tokens.length > 0 || (!onlyAttention && anyChips(chips));
  const reset = () => {
    setQuery("");
    setChips(noChips());
    setCategory(null);
    setOnlyAttention(false);
  };
  // Nothing left to look at, or none of the kind picked: back to what there is.
  useEffect(() => {
    if (attention === null) return;
    if (onlyAttention && attention.length === 0) setOnlyAttention(false);
    if (category !== null && !attention.some((a) => a.kind === category)) setCategory(null);
  }, [attention, onlyAttention, category]);

  const save = (next: Tool) => {
    const exists = tools.some((t) => t.id === next.id);
    dispatch({ type: "setTools", tools: exists ? tools.map((t) => (t.id === next.id ? next : t)) : [...tools, next] });
    setSelected(next.id);
    setMode({ kind: "read" });
    // A tool just added is shown in the list, whatever the list was narrowed to.
    if (!exists) reset();
  };
  const remove = (t: Tool) => {
    const used = usedIds.has(t.id) ? " The open project uses it and will keep its own copy." : "";
    if (!confirm(`Delete "${t.name}" from your tools?${used}`)) return;
    dispatch({ type: "setTools", tools: tools.filter((other) => other.id !== t.id) });
    setSelected(null);
  };
  const add = (kind: ToolKind) => mayLeave() && setMode({ kind: "new", tool: blankTool(kind) });
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

  /** One option of a row: a press steps it off, only, hide, off. */
  const chip = (row: Row, key: string, unit = "") => {
    const state = chipState(chips, row, key);
    const n = counts[row][key] ?? 0;
    const name = chipLabel(row, key);
    const now = state ? `${STATE_WORD[state]}, ` : "";
    return (
      <button
        key={key}
        type="button"
        className={state === "hide" ? "hid" : undefined}
        aria-pressed={state === "only" ? "true" : state === "hide" ? "mixed" : "false"}
        disabled={n === 0 && !state}
        title={`${name}${unit}: ${now}${plural(n, "tool")}. ${NEXT_STEP[state ?? "off"]}`}
        aria-label={`${row} ${name}${unit}, ${now}${plural(n, "tool")}`}
        onClick={() => setChips(cycleChip(chips, row, key))}
      >
        {name}
      </button>
    );
  };
  /** A row's options under a button, each a three-state tick with its count. */
  const dropdown = (row: Row, name: string, heading: string, keys: string[]) => {
    const on = keys.filter((k) => chipState(chips, row, k));
    const anyOnly = on.some((k) => chipState(chips, row, k) === "only");
    const text = on.length === 0 ? name : on.length === 1 ? anyOnly ? chipLabel(row, on[0]) : <s>{chipLabel(row, on[0])}</s> : `${name}, ${on.length}`;
    return (
      <Popover label={text} title={heading} className={`sm${anyOnly ? " on" : on.length ? " xon" : ""}`} disabled={keys.length === 0}>
        {() => (
          <div className="menu-items pop" role="group" aria-label={heading}>
            <span className="pop-head">{heading}</span>
            {keys.map((k) => {
              const state = chipState(chips, row, k);
              const n = counts[row][k] ?? 0;
              const off = n === 0 && !state;
              return (
                <label key={k} className={off ? "off" : state === "hide" ? "hid" : undefined} title={off ? undefined : NEXT_STEP[state ?? "off"]}>
                  <input
                    type="checkbox"
                    checked={state === "only"}
                    ref={(el) => {
                      if (el) el.indeterminate = state === "hide";
                    }}
                    disabled={off}
                    aria-label={`${chipLabel(row, k)}, ${state ? `${STATE_WORD[state]}, ` : ""}${plural(n, "tool")}`}
                    onChange={() => setChips(cycleChip(chips, row, k))}
                  />
                  <span className="t">{chipLabel(row, k)}</span>
                  <span className="n">{n}</span>
                </label>
              );
            })}
          </div>
        )}
      </Popover>
    );
  };

  const kinds = ATTENTION.map((a) => ({ ...a, count: new Set((attention ?? []).filter((x) => x.kind === a.kind).map((x) => x.toolId)).size })).filter((a) => a.count > 0);
  const showing = mode.kind === "new" || tool !== undefined;
  return (
    <div className={showing ? "tools-split showing" : "tools-split"}>
      <section className="tool-list" aria-label="Your tools">
        <div className="tl-head">
          <div className="tl-search">
            <input type="search" aria-label="Find a tool" placeholder="Filter, e.g. 1/8 2F alu" value={query} onChange={(e) => setQuery(e.target.value)} />
            {addMenu(false)}
          </div>
          <div className="tl-mode">
            <span className="seg" role="group" aria-label="Which tools">
              <button type="button" aria-pressed={!onlyAttention} onClick={() => setOnlyAttention(false)}>
                All <span className="count">{tools.length}</span>
              </button>
              <button type="button" aria-pressed={onlyAttention} disabled={attentionOf.size === 0} onClick={() => setOnlyAttention(true)}>
                <span className="mark warn">▲</span> Needs attention <span className="count">{attentionOf.size}</span>
              </button>
            </span>
            <label className="tl-sort">
              Sort
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {onlyAttention ? (
          <div className="facets">
            <div className="fr">
              <span className="seg wrap" role="group" aria-label="What needs attention">
                <button type="button" aria-pressed={category === null} onClick={() => setCategory(null)}>
                  Everything
                </button>
                {kinds.map((k) => (
                  <button key={k.kind} type="button" aria-pressed={category === k.kind} onClick={() => setCategory(k.kind)}>
                    {k.label} <span className="count">{k.count}</span>
                  </button>
                ))}
              </span>
            </div>
          </div>
        ) : (
          tools.length > 0 && (
            <div className="facets">
              <div className="fr">
                <span className="grp">
                  <span className="fl">Shank</span>
                  <span className="seg" role="group" aria-label="Shank">
                    {SHANKS.map((k) => chip("shank", k, " mm"))}
                  </span>
                </span>
                <span className="grp">
                  <span className="fl">Flutes</span>
                  <span className="seg" role="group" aria-label="Flutes">
                    {FLUTES.map((k) => chip("flutes", k))}
                  </span>
                </span>
                <span className="spacer" />
                {dropdown("material", "Material", "Recommended for", materialKeys)}
              </div>
              <div className="fr">
                {styles.chips.length > 0 && (
                  <span className="grp">
                    <span className="fl">Style</span>
                    <span className="seg" role="group" aria-label="Style">
                      {styles.chips.map((k) => chip("style", k))}
                    </span>
                    {styles.more.length > 0 && dropdown("style", "More", "More styles", styles.more)}
                  </span>
                )}
                <span className="spacer" />
                <span className="res">{filtering ? `${shown.length} of ${tools.length}` : plural(tools.length, "tool")}</span>
                {filtering && (
                  <button type="button" className="link" title="Clear the search and every filter" onClick={reset}>
                    Reset
                  </button>
                )}
              </div>
            </div>
          )
        )}

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
              S
            </span>
            <span className="num" title="Flutes">
              Z
            </span>
            <span className="num" title="Cutting rows">
              Set
            </span>
          </div>
          {groups.map((group) => {
            const isClosed = group.name !== null && closed.includes(group.name) && !filtering;
            return (
              <div key={group.name ?? ""} className="tl-group">
                {group.name !== null && (
                  <button className="tl-group-head" aria-expanded={!isClosed} aria-disabled={filtering} title={filtering ? "Every group is open while the list is narrowed" : undefined} onClick={() => !filtering && setClosed(isClosed ? closed.filter((g) => g !== group.name) : [...closed, group.name as string])}>
                    <span className="caret" aria-hidden="true" />
                    {group.name.split("/").join(" / ")}
                    <span className="count">{group.tools.length}</span>
                  </button>
                )}
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
                          if (t.id === selected && mode.kind === "read") return;
                          if (!mayLeave()) return;
                          setSelected(t.id);
                          setMode({ kind: "read" });
                        }}
                      >
                        <span className="tl-name" title={shownName(t)}>
                          <span className="tl-text">{shownName(t)}</span>
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
                        <span className="tl-size">{sizeOf(t).text}</span>
                        <span className="num">{t.shankDiameter}</span>
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
              {noMatchText(query.trim(), onlyAttention ? [] : chipsText(chips, chipLabel), onlyAttention && category ? (ATTENTION.find((a) => a.kind === category)?.label ?? null) : null)}{" "}
              <button className="link" onClick={reset}>
                Reset
              </button>
            </p>
          )}
          {tools.length === 0 && <p className="tl-none">No tools yet.</p>}
        </div>
        <div className="tl-foot">
          <LibraryMenu />
          <span className="muted">{home === "server" ? "Kept on this server, for everyone who opens it." : "Kept in this browser, for all your projects."}</span>
        </div>
      </section>

      <main className="tool-pane">
        {mode.kind === "new" ? (
          <ToolCard
            key={mode.tool.id}
            tool={mode.tool}
            isNew
            taken={tools}
            attention={[]}
            onSave={save}
            onDirty={onDirty}
            onDiscard={() => setMode({ kind: "read" })}
            onDelete={() => setMode({ kind: "read" })}
            onBack={() => setMode({ kind: "read" })}
          />
        ) : tool ? (
          <ToolCard
            key={tool.id}
            tool={tool}
            isNew={false}
            taken={tools}
            attention={attentionOf.get(tool.id) ?? []}
            onSave={save}
            onDirty={onDirty}
            onDiscard={() => setMode({ kind: "read" })}
            onDelete={() => remove(tool)}
            onBack={() => mayLeave() && setSelected(null)}
          />
        ) : tools.length === 0 ? (
          <div className="pane-empty">
            <h2>Start with the tools you own</h2>
            <p>
              Every cut is made with one of your tools, at the speeds you give it for the material. A flat inlay needs an end mill; a V-carve inlay needs a V-bit, and an end
              mill saves it time. The starter set is 50 bits for a 1/8" collet, with cutting settings to start from: keep the ones you own.
            </p>
            <div className="row center">
              {addMenu(true)}
              <button onClick={actions.addStarterSet}>Add the starter set</button>
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
                  <span className="mark warn">▲</span> Show the {attentionOf.size} to check
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
