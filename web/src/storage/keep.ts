// What this browser remembers about the places things can be kept in: the
// folder that was picked (its handle can only be kept in IndexedDB), what
// was read of the files in it, and how two places stood when they were last
// synced. A storage of its own, beside the one that is itself a place (db.ts).

const DB_NAME = "wooden-inlays-places";
const STORE = "kept";

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Browser storage is not available"));
  });
  // One that failed is tried again the next time.
  opening.catch(() => (opening = null));
  return opening;
}

async function run<T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = work(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error ?? new Error("Browser storage failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Browser storage failed"));
  });
}

export function recall<T>(key: string): Promise<T | undefined> {
  return run<T | undefined>("readonly", (s) => s.get(key));
}

export async function keep(key: string, value: unknown): Promise<void> {
  await run("readwrite", (s) => s.put(value, key));
}

export async function forget(key: string): Promise<void> {
  await run("readwrite", (s) => s.delete(key));
}
