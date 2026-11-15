// Browser storage (IndexedDB). Projects and the tool list are stored as the
// same file text that export writes, so data kept in the browser goes through
// the same version migration as an imported file when it is loaded.

const DB_NAME = "wooden-inlays";
const DB_VERSION = 1;
const PROJECTS = "projects";
const SETTINGS = "settings";

export interface StoredProject {
  id: string;
  name: string;
  /** Milliseconds since 1970. */
  modified: number;
  /** Project file text. */
  text: string;
}

export type ProjectSummary = Omit<StoredProject, "text">;

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Browser storage is not available"));
  });
  return opening;
}

async function run<T>(store: string, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = work(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error ?? new Error("Browser storage failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Browser storage failed"));
  });
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const all = await run<StoredProject[]>(PROJECTS, "readonly", (s) => s.getAll());
  return all.map(({ id, name, modified }) => ({ id, name, modified })).sort((a, b) => b.modified - a.modified);
}

export function getProject(id: string): Promise<StoredProject | undefined> {
  return run<StoredProject | undefined>(PROJECTS, "readonly", (s) => s.get(id));
}

export async function putProject(project: StoredProject): Promise<void> {
  await run(PROJECTS, "readwrite", (s) => s.put(project));
}

export async function deleteProject(id: string): Promise<void> {
  await run(PROJECTS, "readwrite", (s) => s.delete(id));
}

export type SettingKey = "tools" | "lastProjectId" | "machine";

export function getSetting(key: SettingKey): Promise<string | undefined> {
  return run<string | undefined>(SETTINGS, "readonly", (s) => s.get(key));
}

export async function putSetting(key: SettingKey, value: string): Promise<void> {
  await run(SETTINGS, "readwrite", (s) => s.put(value, key));
}
