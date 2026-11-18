// What the screens remember from one visit to the next: the tool list's sort
// order and chips, and where a row's suggestion was left. Small choices,
// read while a screen is drawn, so they are held here and written behind.
//
// In a browser they are in its local storage. On a server they are one
// setting, `view`, read once at start (`loadView`), so that they follow to
// every browser like everything else kept there.

import { home, getSetting, putSetting } from "./home";

let kept: Record<string, unknown> = {};

/** On a server: reads what was remembered. Called once, before the screens are drawn. */
export async function loadView(): Promise<void> {
  if (home() !== "server") return;
  try {
    const read = JSON.parse((await getSetting("view")) ?? "{}");
    if (read && typeof read === "object" && !Array.isArray(read)) kept = read;
  } catch {
    // Nothing remembered, then.
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
    // Without the server the choice lasts as long as the page.
    putSetting("view", JSON.stringify(kept)).catch(() => {});
    return;
  }
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Without storage the choice lasts as long as the page.
  }
}
