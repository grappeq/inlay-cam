import { useEffect } from "react";
// Saving text to a file and reading a file the user picks.

export function downloadText(fileName: string, text: string, mime = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Hands a file that is not text to the browser to save. */
export function downloadBytes(fileName: string, bytes: Uint8Array, mime = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Opens the file picker for a file that is not text. Resolves to null when the user cancels. */
export function pickBinaryFile(accept: string): Promise<{ name: string; bytes: Uint8Array } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        resolve({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      } catch (e) {
        reject(e);
      }
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** A file brought into the app. `bytes` are there for the kinds that may not be text: a DXF, which may be binary, and a Makera library. */
export interface InFile {
  name: string;
  text: string;
  bytes?: Uint8Array;
}

const BINARY = /\.(dxf|tlslibrary)$/i;

/** Reads a picked or dropped file, as text, and as bytes for the kinds that may not be text. */
export async function readFile(file: File): Promise<InFile> {
  if (!BINARY.test(file.name)) return { name: file.name, text: await file.text() };
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { name: file.name, text: new TextDecoder().decode(bytes), bytes };
}

/** Opens the file picker. Resolves to null when the user cancels. */
export function pickTextFile(accept: string): Promise<InFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        resolve(await readFile(file));
      } catch (e) {
        reject(e);
      }
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Opens the file picker for any number of files. Resolves to an empty list when the user cancels. */
export function pickTextFiles(accept: string): Promise<InFile[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = true;
    input.onchange = async () => {
      try {
        resolve(await Promise.all([...(input.files ?? [])].map(readFile)));
      } catch (e) {
        reject(e);
      }
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** A safe file name stem from a user-entered name. */
export function fileStem(name: string): string {
  const stem = name.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ");
  return stem === "" ? "untitled" : stem;
}

/** Calls `onEscape` when the Escape key is pressed, for as long as the component is shown. */
export function useEscape(onEscape: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscape]);
}
