// What is said when something was done to several projects, one after the
// other: all of them, some of them when it was stopped, or none.

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * What to say after projects were moved to a folder. `done` of `total` were
 * moved; `one` is the name of the project when there was only one to move,
 * `to` what the folder is called. Null when there is nothing to say.
 */
export function movedText(done: number, total: number, one: string, to: string): string | null {
  if (total === 0) return null;
  if (done === 0) return "Stopped: nothing was moved.";
  const left = total - done;
  const what = total === 1 ? `"${one}"` : plural(done, "project");
  return `${what} moved to ${to}${left > 0 ? `; ${left} left where ${left === 1 ? "it was" : "they were"}` : ""}.`;
}

/** What to say after projects were deleted, when not all of them were: null when all were, as the list shows it. */
export function deletedText(done: number, total: number): string | null {
  if (done >= total) return null;
  if (done === 0) return "Stopped: nothing was deleted.";
  return `${plural(done, "project")} deleted; ${total - done} kept.`;
}

/** What a failure part of the way says: what was done before it, then why it stopped. */
export function partWayText(done: number, did: string, why: string): string {
  return done > 0 ? `${plural(done, "project")} ${did}, then: ${why}` : why;
}

/** What to say to something asked for while other work on what is kept is going on. */
export function waitText(label: string): string {
  return `Not done: "${label}" is still going on. Try again when it is over.`;
}
