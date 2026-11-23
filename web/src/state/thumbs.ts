// The small pictures of the drawings in the list of projects. The core
// draws them (thumbnail.rs): on a server it does so as it lists the
// projects, in a browser as each is kept.

import { core } from "../core/client";
import type { Design } from "../core/types";
import * as db from "../storage/home";
import { tasks } from "./tasks";

/** The picture of a drawing; null for none. */
export function thumbOf(design: Design | null): Promise<db.Thumb | null> {
  return design ? core.call("designThumbnail", design) : Promise.resolve(null);
}

// Projects whose picture was tried for already: one that cannot be read is not read again and again.
const tried = new Set<string>();

/**
 * Works out the pictures of the projects kept in this browser before there
 * were pictures, one after the other. Gives whether any was kept.
 */
export async function fillThumbs(projects: readonly db.ProjectSummary[]): Promise<boolean> {
  if ((await db.findHome()) === "server") return false;
  let any = false;
  for (const p of projects) {
    if (p.thumb !== undefined || tried.has(p.id)) continue;
    // The core does one thing at a time: long work the user waits for goes first, and the rest is drawn another time.
    if (tasks.get().some((t) => t.heavy)) break;
    tried.add(p.id);
    try {
      const stored = await db.getProject(p.id);
      if (!stored) continue;
      const { design } = await core.call("projectFromFile", stored.text);
      await db.fillThumb(p.id, await thumbOf(design), stored.modified);
      any = true;
    } catch {
      // It stays without a picture.
    }
  }
  return any;
}
