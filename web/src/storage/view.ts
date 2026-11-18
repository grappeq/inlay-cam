// What the screens remember from one visit to the next: the tool list's sort
// order and chips, and where a row's suggestion was left. Small choices,
// read while a screen is drawn, so they are held here and written behind.
//
// In a browser they are in its local storage. On a server they are one
// setting, `view`, read once at start (`loadView`), so that they follow to
// every browser like everything else kept there.

import { home, getSetting, putSetting } from "./home";

let kept: Record<string, unknown> = {};
/** The choices made on this page, which go over what the server has. */
let own: Record<string, unknown> = {};
let writing: Promise<void> = Promise.resolve();

async function read(): Promise<Record<string, unknown>> {
  const text = await getSetting("view");
  try {
    const value = JSON.parse(text ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // Not something this app wrote: nothing remembered, then.
  }
  return {};
}

/** On a server: reads what was remembered. Called once, before the screens are drawn. */
export async function loadView(): Promise<void> {
  if (home() !== "server") return;
  try {
    kept = await read();
  } catch {
    // Out of reach: the screens start as new, and nothing is written over.
  }
}

export function recall<T>(key: string, fallback: T): T {
  if (home() === "server") return key in kept ? (kept[key] as T) : fallback;
  try {
    const text = localStorage.getItem(key);
    return text === null ? fallback : (JSON.parse(text) as T);
  } catch {
    return fallback;
  }
}

export function remember(key: string, value: unknown): void {
  if (home() === "server") {
    kept = { ...kept, [key]: value };
    own = { ...own, [key]: value };
    // Written over what the server has now, not what it had at start, so
    // that another browser's choices stay and a failed read loses nothing.
    // Without the server the choice lasts as long as the page.
    writing = writing
      .then(async () => putSetting("view", JSON.stringify({ ...(await read()), ...own })))
      .catch(() => {});
    return;
  }
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Without storage the choice lasts as long as the page.
  }
}
