// How work that takes time is shown: a line with a bar where its result will
// land, a button that says it is busy, and in the header what is going on,
// from every tab.

import { useEffect, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useDispatch } from "../state/store";
import { TIME_AFTER, countText, elapsedText, fraction, headline, pieces, tasks, type Task } from "../state/tasks";
import { mayLeave } from "../state/unsaved";

/** Every task that is running. */
export function useTasks(): readonly Task[] {
  return useSyncExternalStore(tasks.subscribe, tasks.get);
}

/** The task of a kind that is running, or null. */
export function useTask(key: string): Task | null {
  return useTasks().find((t) => t.key === key) ?? null;
}

/** The time, kept up to the second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

/** The bar of a task: in pieces for a few parts, one filling bar for many, and going on without an end when they cannot be counted. */
function Bar({ task }: { task: Task }) {
  const parts = pieces(task);
  const part = fraction(task);
  return (
    <div
      className="progress-bar"
      role="progressbar"
      aria-label={task.label}
      aria-valuemin={task.total === null ? undefined : 0}
      aria-valuemax={task.total ?? undefined}
      aria-valuenow={task.total === null ? undefined : Math.round((task.done + (task.part ?? 0)) * 100) / 100}
      aria-valuetext={countText(task) || undefined}
    >
      {parts ? (
        parts.map((state, i) =>
          state === "now" && task.part !== null ? (
            <span key={i}>
              <i style={{ width: `${Math.round(task.part * 100)}%` }} />
            </span>
          ) : (
            <span key={i} className={state} />
          ),
        )
      ) : part === null ? (
        <span className="now" />
      ) : (
        <span>
          <i style={{ width: `${Math.round(part * 100)}%` }} />
        </span>
      )}
    </div>
  );
}

/**
 * A task where its result will land: what is being done and how far it is, a
 * bar, and under it what is in hand, how long it has taken, and Stop when it
 * can be stopped. Nothing for the first moments of a task, unless `always`.
 */
export function ProgressLine({ task, className, always }: { task: Task | null; className?: string; always?: boolean }) {
  const now = useNow(task !== null && task.shown);
  // `always`: from its first moment, where the bar takes the place of what started it.
  if (!task || !(task.shown || always)) return null;
  const count = countText(task);
  const time = now - task.started >= TIME_AFTER ? elapsedText(task, now) : "";
  return (
    <div className={`progress-line${className ? ` ${className}` : ""}`}>
      <div className="progress-top" role="status">
        <span className="progress-label">{task.stopping ? "Stopping…" : task.label}</span>
        {count && <span className="progress-count">{count}</span>}
      </div>
      <Bar task={task} />
      {(task.stage || time || task.stoppable || task.cancellable) && (
        <div className="progress-sub">
          <span className="progress-stage">{task.stage}</span>
          {time && (
            <span className="progress-time" aria-hidden="true">
              {time}
            </span>
          )}
          {task.stoppable && (
            <button type="button" className="link" disabled={task.stopping} onClick={() => tasks.stop(task.id)} title="Stops after the one in hand. What is done stays done.">
              Stop
            </button>
          )}
          {task.cancellable && (
            <button type="button" className="link" disabled={task.stopping} onClick={() => tasks.cancel(task.id)} title="Ends it now. Nothing of it is kept, and what was worked out before has to be worked out again.">
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A button that, while its work goes on, turns, says so and cannot be pressed again. */
export function BusyButton({ busy, busyText, children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { busy: boolean; busyText?: ReactNode }) {
  return (
    <button {...rest} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy ? (
        <>
          <Spinner /> {busyText ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** Whether something has been so for a while: quick work does not flicker. */
export function useLasting(on: boolean, ms: number): boolean {
  const [lasting, setLasting] = useState(false);
  useEffect(() => {
    if (!on) return setLasting(false);
    const timer = setTimeout(() => setLasting(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return on && lasting;
}

/** In the header: what the app is busy with, whatever tab is shown. It leads to where the work shows. */
export function Activity() {
  const said = headline(useTasks());
  const dispatch = useDispatch();
  if (!said) return null;
  const view = said.task?.view ?? null;
  const part = said.task ? fraction(said.task) : null;
  const inside = (
    <>
      <Spinner /> {said.text}
    </>
  );
  return (
    <>
      {view ? (
        <button className="activity" title="Show where this is going on" onClick={() => mayLeave() && dispatch({ type: "setView", view })}>
          {inside}
        </button>
      ) : (
        <span className="activity">{inside}</span>
      )}
      <span className="activity-strip" aria-hidden="true">
        {part === null ? <i className="now" /> : <i style={{ width: `${Math.round(part * 100)}%` }} />}
      </span>
    </>
  );
}

/** Under the header: the tasks that have no place of their own on the page. */
export function TaskNotices() {
  const shown = useTasks().filter((t) => t.shown && t.place === "notice");
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((task) => (
        <div key={task.id} className="notice task-notice">
          <ProgressLine task={task} />
        </div>
      ))}
    </>
  );
}
