// Whether a tool's sheet holds changes that are not saved, so that whatever
// would take the user away from it can ask first.

let unsaved = false;

export function setUnsaved(value: boolean) {
  unsaved = value;
}

export const hasUnsaved = () => unsaved;

/** True when there is nothing to lose, or the user agrees to lose it. */
export function mayLeave(): boolean {
  return !unsaved || confirm("Leave this tool without saving your changes to it?");
}
