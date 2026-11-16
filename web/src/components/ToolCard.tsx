// One tool, to read: drawn to scale, with what is known about it and every
// cutting row on one line. Logging a result happens here; changing the tool
// itself is the editor's job.

import { useState, type ReactNode } from "react";
import type { Attention, CuttingSettings, FeedLevel, Tool, ToolLists } from "../core/types";
import { CUTTING_KINDS, TOOL_KIND_LABELS, allMaterials, fmt, jobToolIds, materialLabel, rowLabel } from "../state/model";
import { useApp } from "../state/store";
import { LogList, LogResult, ResultMark, RowFacts, Ruler, Suggestions, percentOf, placeOf, profileFlags, useInsight, valuesOf, type Flags } from "./RowInsight";
import { ToolDrawing } from "./ToolDrawing";
import { LogWear } from "./ToolSheet";

export function ToolCard(props: { tool: Tool; attention: Attention[]; onEdit: () => void; onDelete: () => void; onSave: (tool: Tool) => void; onBack: () => void }) {
  const { lists, project } = useApp();
  const { tool } = props;
  const [open, setOpen] = useState<number | null>(null);
  const materials = allMaterials(lists);
  const usedBy = project.jobs.filter((job) => jobToolIds(job).includes(tool.id));
  const cuts = CUTTING_KINDS.includes(tool.kind);
  const inventory = tool.inventory;
  const source = tool.source;
  const kept = [
    tool.ids && "its ids in the Makera apps",
    tool.apps && "which Makera libraries it goes into",
    tool.fusionType && "its Fusion 360 type",
    tool.cutting.some((c) => c.ids || c.camFlag !== undefined || c.modified) && "what the Makera apps store with its rows",
  ].filter((item): item is string => typeof item === "string");
  const saveRow = (index: number, row: CuttingSettings) => props.onSave({ ...tool, cutting: tool.cutting.map((c, i) => (i === index ? row : c)) });
  const unknown = <span className="warn">unknown</span>;

  return (
    <article className="card" aria-label={tool.name}>
      <header className="card-head">
        <button type="button" className="link back" onClick={props.onBack}>
          All tools
        </button>
        <p className="card-path">
          {[tool.group, TOOL_KIND_LABELS[tool.kind], tool.number !== undefined ? `tool no. ${tool.number}` : null].filter(Boolean).join(" / ")}
        </p>
        <div className="card-title">
          <h2>
            {tool.name}
            {tool.coating && !tool.name.endsWith(tool.coating) && <span className="coating"> {tool.coating}</span>}
          </h2>
          <button type="button" onClick={props.onEdit}>
            Edit
          </button>
          <button type="button" className="danger" onClick={props.onDelete}>
            Delete
          </button>
        </div>
        {!cuts && <p className="muted">Kept here and written for other programs. No operation of this app cuts with a {TOOL_KIND_LABELS[tool.kind].toLowerCase()}.</p>}
        {tool.note && <p className="card-note">{tool.note}</p>}
        {props.attention.length > 0 && (
          <ul className="card-attention">
            {props.attention.map((a, i) => (
              <li key={i}>
                {a.kind === "failed" && a.material && `${rowLabel({ material: a.material, profile: a.profile ?? undefined }, lists)} failed on ${a.date}: ${a.text}`}
                {a.kind === "provisional" && a.material && `${rowLabel({ material: a.material, profile: a.profile ?? undefined }, lists)} worked on ${a.date} and is still to confirm: ${a.text}`}
                {a.kind === "verify" && `To check: ${a.text}`}
                {a.kind === "no_cutting" && "No cutting settings yet, so it cannot be used."}
                {a.kind === "flute_length" && "Flute length unknown, so no depth can be checked against it."}
              </li>
            ))}
          </ul>
        )}
      </header>

      <Block title="Shape">
        <div className="paper">
          <ToolDrawing tool={tool} />
        </div>
        <dl className="facts">
          <Fact label={tool.kind === "v_bit" || tool.kind === "corner_round" ? "Body diameter" : "Diameter"} value={`${fmt(tool.diameter)} mm`} />
          <Fact label="Shank" value={`${fmt(tool.shankDiameter)} mm`} />
          <Fact label="Flute length" value={tool.fluteLength !== undefined ? `${fmt(tool.fluteLength)} mm` : unknown} />
          <Fact label="Overall length" value={tool.length !== undefined ? `${fmt(tool.length)} mm` : <span className="muted">unknown</span>} />
          {tool.shoulderLength !== undefined && <Fact label="Shoulder" value={`${fmt(tool.shoulderLength)} mm`} />}
          <Fact label="Flutes" value={tool.flutes ?? <span className="muted">unknown</span>} />
          {(tool.kind === "v_bit" || tool.kind === "drill") && <Fact label={tool.kind === "drill" ? "Point angle" : "Angle"} value={tool.tipAngle !== undefined ? `${fmt(tool.tipAngle)}°` : unknown} />}
          {tool.kind === "v_bit" && <Fact label="Tip flat" value={`${fmt(tool.tipDiameter ?? 0)} mm`} />}
          {tool.kind === "corner_round" && (
            <>
              <Fact label="Corner radius" value={`${fmt(tool.cornerRadius ?? 0)} mm`} />
              <Fact label="Tip" value={`${fmt(tool.tipDiameter ?? 0)} mm`} />
            </>
          )}
          {tool.kind === "thread_mill" && tool.threadDiameter !== undefined && <Fact label="Thread" value={`M${fmt(tool.threadDiameter)}${tool.pitch !== undefined ? ` × ${fmt(tool.pitch)}` : ""}`} />}
          {tool.style && <Fact label="Style" value={tool.style} />}
          {tool.coating && <Fact label="Coating" value={tool.coating} />}
        </dl>
        {(tool.recommendedFor?.length ?? 0) > 0 && (
          <p className="suits">
            <span className="muted">Suits</span>
            {materials.map((m) => (
              <span key={m.value} className={tool.recommendedFor?.includes(m.value) ? "chip on" : "chip"}>
                {m.label}
              </span>
            ))}
          </p>
        )}
      </Block>

      <Block title="Cutting settings" count={tool.cutting.length === 0 ? undefined : `${tool.cutting.length} ${tool.cutting.length === 1 ? "row" : "rows"}`}>
        {tool.cutting.length === 0 ? (
          <p className="block-empty">
            None yet. A tool cannot be used on a material it has no settings for.{" "}
            <button type="button" className="link" onClick={props.onEdit}>
              Add cutting settings
            </button>
          </p>
        ) : (
          <div className="cut-wrap">
            <table className="cut-table">
              <thead>
                <tr>
                  <th>For</th>
                  <th className="num">
                    Speed <small>rpm</small>
                  </th>
                  <th className="num">
                    Feed <small>mm/min</small>
                  </th>
                  <th className="num">
                    Plunge <small>mm/min</small>
                  </th>
                  <th className="num">Stepover</th>
                  <th className="num">
                    Depth <small>mm</small>
                  </th>
                  <th>How hard</th>
                </tr>
              </thead>
              <tbody>
                {tool.cutting.map((row, index) => (
                  <CutLine key={index} tool={tool} row={row} lists={lists} open={open === index} onToggle={() => setOpen(open === index ? null : index)} onSave={(next) => saveRow(index, next)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      {usedBy.length > 0 && (
        <Block title="In the open project">
          <p className="block-line">
            Used by {usedBy.map((job) => job.name).join(", ")} in {project.name || "the open project"}.
          </p>
        </Block>
      )}

      <Block title="Stock and source">
        <dl className="facts">
          <Fact label="On hand" value={inventory?.quantity !== undefined ? <span className={inventory.quantity === 0 ? "warn" : ""}>{inventory.quantity}</span> : <span className="muted">not counted</span>} />
          <Fact label="Price each" value={inventory?.price !== undefined ? `${fmt(inventory.price)} ${inventory.currency ?? ""}` : <span className="muted">not noted</span>} />
          {inventory?.purchased && <Fact label="Last bought" value={<span className="num">{inventory.purchased}</span>} />}
          {source?.invoice && <Fact label="Invoice" value={source.invoice} />}
          {source?.sizeNote && <Fact label="Size as sold" value={source.sizeNote} />}
          {source?.url && (
            <Fact
              label="Product page"
              value={
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.url.replace(/^https?:\/\//, "").slice(0, 48)}
                </a>
              }
            />
          )}
        </dl>
        {(inventory?.log?.length ?? 0) > 0 && (
          <ul className="log-list">
            {inventory?.log?.map((entry, i) => (
              <li key={i}>
                <span className="num">{entry.date}</span>
                <span className="mark danger">{entry.kind}</span>
                <span>
                  {entry.material ? `In ${materialLabel(entry.material, lists).toLowerCase()}. ` : ""}
                  {entry.note}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="block-line">
          <LogWear
            materials={materials}
            canTakeOne={(inventory?.quantity ?? 0) > 0}
            onAdd={(entry, takeOne) =>
              props.onSave({
                ...tool,
                inventory: {
                  ...inventory,
                  log: [...(inventory?.log ?? []), entry],
                  quantity: takeOne && inventory?.quantity !== undefined ? Math.max(0, inventory.quantity - 1) : inventory?.quantity,
                },
              })
            }
          />
        </div>
        {kept.length > 0 && <p className="block-line muted">Also kept, for other programs: {kept.join("; ")}.</p>}
      </Block>
    </article>
  );
}

function Block(props: { title: string; count?: string; children: ReactNode }) {
  return (
    <section className="block">
      <h3>
        {props.title}
        {props.count && <span className="muted"> {props.count}</span>}
      </h3>
      {props.children}
    </section>
  );
}

function Fact(props: { label: string; value: ReactNode }) {
  return (
    <div className="fact">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

/** One cutting row on one line; opened, what the model makes of it, its log, and a way to log a result. */
function CutLine(props: { tool: Tool; row: CuttingSettings; lists: ToolLists; open: boolean; onToggle: () => void; onSave: (row: CuttingSettings) => void }) {
  const { tool, row, lists } = props;
  const start = profileFlags(row, lists);
  const [flags, setFlags] = useState<Flags>({ ramping: start.ramping, lubricated: start.lubricated });
  const [level, setLevel] = useState<FeedLevel>(start.level);
  const insight = useInsight(tool, row, lists, flags);
  const place = placeOf(row, insight.stops);
  const profile = lists.profiles?.find((p) => p.key === row.profile);
  const warned = (insight.check?.warnings.length ?? 0) > 0;
  const percent = row.stepoverUnit === "percent";

  return (
    <>
      <tr className={props.open ? "cut-line open" : "cut-line"} onClick={props.onToggle}>
        <th scope="row">
          <button type="button" className="cut-toggle" aria-expanded={props.open} onClick={(e) => (e.stopPropagation(), props.onToggle())}>
            <span className="caret" aria-hidden="true" />
            {materialLabel(row.material, lists)}
          </button>
          {row.profile !== undefined && <span className="tag">{profile?.label ?? row.profile}</span>} <ResultMark row={row} short />
          {warned && (
            <span className="mark warn" title={insight.check?.warnings.join(" ")}>
              {" "}
              !
            </span>
          )}
        </th>
        <td className="num">{row.rpm}</td>
        <td className="num">{fmt(row.feed)}</td>
        <td className="num">{fmt(row.plunge)}</td>
        <td className="num">
          {percent ? `${fmt(percentOf(row, tool.diameter))} %` : `${fmt(row.stepover)} mm`}
          <small> {percent ? `${fmt(row.stepover)} mm` : `${fmt(percentOf(row, tool.diameter))} %`}</small>
        </td>
        <td className="num">{fmt(row.stepdown)}</td>
        <td>{insight.check && !insight.check.covered ? <span className="muted">no model</span> : <Ruler place={place} />}</td>
      </tr>
      {props.open && (
        <tr className="cut-detail">
          <td colSpan={7}>
            <p className="readouts">
              <ResultMark row={row} />
            </p>
            <RowFacts insight={insight} />
            <LogList row={row} />
            <LogResult saves="now" onAdd={(entry) => props.onSave({ ...row, log: [...(row.log ?? []), { ...entry, at: valuesOf(row) }] })} />
            <details className="fold">
              <summary>What the feeds model would start from</summary>
              <Suggestions tool={tool} row={row} lists={lists} insight={insight} flags={flags} setFlags={setFlags} level={level} setLevel={setLevel} onUse={(change) => props.onSave({ ...row, ...change })} />
            </details>
          </td>
        </tr>
      )}
    </>
  );
}
