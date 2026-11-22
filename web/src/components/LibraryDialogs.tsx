// What is shown when a tool list goes out to another program, or values
// come in from one: what was written and what to know about it, and the
// differences an export of Makera CAM or Makera Studio has, to tick.

import { useState } from "react";
import { core } from "../core/client";
import type { MakeraImportChange, MakeraImportPlan } from "../core/types";
import { fmt } from "../state/model";
import { message, useApp, useDispatch } from "../state/store";
import { useEscape } from "../util/files";
import { BusyButton } from "./Progress";

/** What a library written for another program holds, and its warnings. */
export interface ExportReport {
  /** "Makera CAM library". */
  what: string;
  files: string[];
  /** "9 tools, 14 settings, 4 materials". */
  counts: string;
  warnings: string[];
  /** What to do with the file in the other program. */
  next: string;
}

export function ExportReportDialog({
  report,
  onClose,
}: {
  report: ExportReport;
  onClose: () => void;
}) {
  useEscape(onClose);
  return (
    <div className="backdrop" onClick={onClose}>
      <div
        className="dialog wide"
        role="dialog"
        aria-modal="true"
        aria-label={`${report.what} written`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{report.what} written</h2>
        <p>
          {report.files.length === 1 ? (
            <code>{report.files[0]}</code>
          ) : (
            `${report.files.length} files`
          )}
          : {report.counts}.
        </p>
        {report.files.length > 1 && (
          <ul className="plain">
            {report.files.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        )}
        <p className="muted">{report.next}</p>
        {report.warnings.length > 0 && (
          <>
            <h3>
              To know <span className="muted">{report.warnings.length}</span>
            </h3>
            <ul className="report-list">
              {report.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          </>
        )}
        <div className="dialog-foot">
          <button className="primary" autoFocus onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** One difference, as a line to tick. */
function changeText(change: MakeraImportChange): string {
  const unit = change.unit
    ? change.unit === "°"
      ? "°"
      : ` ${change.unit}`
    : "";
  const head = change.materialLabel ? `${change.materialLabel} · ` : "";
  if (change.kind === "new") return `${head}new setting: ${change.values}`;
  return `${head}${change.label} ${change.from === null ? "" : fmt(change.from)} → ${change.to === null ? "" : fmt(change.to)}${unit}`;
}

/**
 * An export of Makera CAM or Makera Studio held against the tool list. Only
 * numbers can be taken from it: sizes, cutting values and settings for
 * materials a tool has none for. Nothing is changed until it is applied.
 */
export function MakeraImportDialog({
  plan,
  fileName,
  onClose,
}: {
  plan: MakeraImportPlan;
  fileName: string;
  onClose: () => void;
}) {
  const { tools, lists } = useApp();
  const dispatch = useDispatch();
  useEscape(onClose);
  const all = plan.tools.flatMap((t) => t.changes);
  const [ticked, setTicked] = useState<string[]>(
    all.filter((c) => c.selected).map((c) => c.id),
  );
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const toggle = (id: string) =>
    setTicked(
      ticked.includes(id) ? ticked.filter((t) => t !== id) : [...ticked, id],
    );
  const skipped = plan.notImported.length + plan.notImportedMore;

  const apply = async () => {
    setApplying(true);
    try {
      const next = await core.call(
        "applyMakeraImport",
        { ...lists, tools },
        plan,
        ticked,
      );
      dispatch({ type: "setTools", tools: next.tools, lists });
      dispatch({
        type: "notice",
        notice: {
          kind: "info",
          text: `${fileName}: ${ticked.length} value${ticked.length === 1 ? "" : "s"} taken into ${new Set(all.filter((c) => ticked.includes(c.id)).map((c) => plan.tools.find((t) => t.changes.includes(c))?.toolId)).size} of your tools.`,
        },
      });
      onClose();
    } catch (e) {
      setError(message(e));
      setApplying(false);
    }
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div
        className="dialog wide import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Values from a ${plan.label}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Values from a {plan.label}</h2>
        <p className="muted">
          <code>{fileName}</code> has {plan.exportTools} tool
          {plan.exportTools === 1 ? "" : "s"}; {plan.matched}{" "}
          {plan.matched === 1 ? "is" : "are"} yours
          {plan.matchedByName > 0
            ? ` (${plan.matchedByName} matched by name and group, not by id)`
            : ""}
          . Only numbers are taken: names, groups and materials stay as you have
          them.
        </p>

        {all.length === 0 ? (
          <p className="block-empty">
            {skipped > 0
              ? "Nothing that can be taken differs. What differs and cannot be taken is listed below, with why."
              : "Nothing differs: the export has the same sizes and cutting values as your list."}
          </p>
        ) : (
          <>
            <p className="import-pick">
              <b>
                {all.length} difference{all.length === 1 ? "" : "s"}
              </b>{" "}
              in {plan.tools.length} tool{plan.tools.length === 1 ? "" : "s"}
              <span className="spacer" />
              <button
                type="button"
                className="link"
                onClick={() => setTicked(all.map((c) => c.id))}
              >
                Tick all
              </button>
              <button
                type="button"
                className="link"
                onClick={() => setTicked([])}
              >
                Tick none
              </button>
            </p>
            <div className="import-tools">
              {plan.tools.map((tool) => (
                <section key={tool.toolId} className="block">
                  <h3>
                    {tool.name} <span className="muted">{tool.group}</span>
                    {tool.byName && (
                      <span
                        className="tag plain"
                        title="Matched by its name and group, not by its id: check it is the same tool. Its values are not ticked to begin with."
                      >
                        by name
                      </span>
                    )}
                  </h3>
                  {tool.notes.map((note) => (
                    <p key={note} className="block-line muted">
                      {note}
                    </p>
                  ))}
                  <ul className="import-changes">
                    {tool.changes.map((change) => (
                      <li key={change.id}>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={ticked.includes(change.id)}
                            onChange={() => toggle(change.id)}
                          />
                          <span>
                            {changeText(change)}
                            {change.kind === "geometry" && (
                              <span className="muted">
                                {" "}
                                (a size of the tool)
                              </span>
                            )}
                            {change.note && (
                              <span className="muted"> {change.note}</span>
                            )}
                          </span>
                        </label>
                      </li>
                    ))}
                    {tool.kept.map((kept) => (
                      <li key={kept} className="muted kept">
                        Kept: {kept}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}

        {plan.unchanged.length > 0 && (
          <details className="fold">
            <summary>
              {plan.unchanged.length} tool
              {plan.unchanged.length === 1 ? "" : "s"} the same in both
            </summary>
            <ul className="report-list">
              {plan.unchanged.map((tool) => (
                <li key={tool.name}>
                  {tool.name} <span className="muted">{tool.group}</span>
                  {tool.kept.map((kept) => (
                    <span key={kept} className="muted">
                      {" "}
                      Kept: {kept}.
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </details>
        )}
        {skipped > 0 && (
          <details className="fold" open={all.length === 0}>
            <summary>{skipped} not taken, with why</summary>
            <ul className="report-list">
              {plan.notImported.map((item, i) => (
                <li key={i}>
                  <b>{item.record}</b>: {item.reason}
                </li>
              ))}
              {plan.notImportedMore > 0 && (
                <li className="muted">And {plan.notImportedMore} more.</li>
              )}
            </ul>
          </details>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-foot">
          <button onClick={onClose}>
            {all.length === 0 ? "Close" : "Cancel"}
          </button>
          {all.length > 0 && (
            <BusyButton
              className="primary"
              busy={applying}
              disabled={ticked.length === 0}
              onClick={apply}
            >
              Take {ticked.length} value{ticked.length === 1 ? "" : "s"}
            </BusyButton>
          )}
        </div>
      </div>
    </div>
  );
}
