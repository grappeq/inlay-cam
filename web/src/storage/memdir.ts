// A folder in memory that answers as a browser's directory handle does, as
// far as fs.ts asks: for the tests.

import type { Dir, FileNode } from "./fs";

function refusal(name: string): Error {
  return Object.assign(new Error(name), { name });
}

let clock = 1000;

export class MemFile implements FileNode {
  kind = "file" as const;
  text = "";
  lastModified = 0;
  /** How often the text was read. */
  reads = 0;
  /** Being written: a browser lets one writer at a file at a time. */
  open = false;
  /** Set to have the next write fail. */
  failing: Error | null = null;
  constructor(public name: string) {}
  async getFile() {
    const { text, lastModified } = this;
    return {
      text: async () => {
        this.reads++;
        return text;
      },
      lastModified,
      size: text.length,
    };
  }
  async createWritable() {
    if (this.open) throw refusal("NoModificationAllowedError");
    this.open = true;
    let next = "";
    return {
      write: async (text: string) => {
        // As a disk does: not at once.
        await Promise.resolve();
        if (this.failing) {
          const e = this.failing;
          this.failing = null;
          throw e;
        }
        next += text;
      },
      close: async () => {
        this.text = next;
        this.lastModified = clock += 10;
        this.open = false;
      },
      abort: async () => {
        this.open = false;
      },
    };
  }
}

export class MemDir implements Dir {
  kind = "directory" as const;
  children = new Map<string, MemFile | MemDir>();
  /** Names are one whatever their case, as on a Windows disk. */
  constructor(
    public name = "root",
    private caseless = false,
  ) {}

  private key(name: string): string | undefined {
    if (this.children.has(name)) return name;
    return this.caseless ? [...this.children.keys()].find((other) => other.toLowerCase() === name.toLowerCase()) : undefined;
  }
  async *entries(): AsyncGenerator<[string, MemFile | MemDir]> {
    yield* [...this.children.entries()];
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemDir> {
    const at = this.key(name);
    const node = at === undefined ? undefined : this.children.get(at);
    if (node instanceof MemDir) return node;
    if (node) throw refusal("TypeMismatchError");
    if (!options?.create) throw refusal("NotFoundError");
    const made = new MemDir(name, this.caseless);
    this.children.set(name, made);
    return made;
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemFile> {
    const at = this.key(name);
    const node = at === undefined ? undefined : this.children.get(at);
    if (node instanceof MemFile) return node;
    if (node) throw refusal("TypeMismatchError");
    if (!options?.create) throw refusal("NotFoundError");
    const made = new MemFile(name);
    this.children.set(name, made);
    return made;
  }
  async removeEntry(name: string): Promise<void> {
    const at = this.key(name);
    const node = at === undefined ? undefined : this.children.get(at);
    if (!node) throw refusal("NotFoundError");
    if (node instanceof MemDir && node.children.size > 0) throw refusal("InvalidModificationError");
    this.children.delete(at!);
  }

  /** Puts a file where a path says, as a hand would: `projects/Gifts/a.json`. */
  put(path: string, text: string): MemFile {
    const names = path.split("/");
    let dir: MemDir = this;
    for (const name of names.slice(0, -1)) {
      let next = dir.children.get(name);
      if (!(next instanceof MemDir)) dir.children.set(name, (next = new MemDir(name, this.caseless)));
      dir = next;
    }
    const file = new MemFile(names[names.length - 1]);
    file.text = text;
    file.lastModified = clock += 10;
    dir.children.set(file.name, file);
    return file;
  }
  /** The text of the file a path names; undefined when there is none. */
  read(path: string): string | undefined {
    let node: MemFile | MemDir | undefined = this;
    for (const name of path.split("/")) node = node instanceof MemDir ? node.children.get(name) : undefined;
    return node instanceof MemFile ? node.text : undefined;
  }
  /** Every file under here, by its path. */
  paths(prefix = ""): string[] {
    return [...this.children.entries()].flatMap(([name, node]) => (node instanceof MemDir ? node.paths(`${prefix}${name}/`) : [`${prefix}${name}`])).sort();
  }
}
