/**
 * The smallest file-system surface the outbox needs. Production wraps react-native-fs;
 * tests use MemoryDisk. Keeping it this small is what lets the store be tested in Jest.
 */
export interface Disk {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readText(path: string): Promise<string>;
  /** Write-to-temp then rename: a reader sees the old file or the new one, never half of either. */
  writeTextAtomic(path: string, text: string): Promise<void>;
  /** Rename. Directory renames within one volume are atomic. */
  move(from: string, to: string): Promise<void>;
  /** Recursive; missing paths are fine. */
  remove(path: string): Promise<void>;
  /** Names (not paths) of the entries directly inside `path`; [] if it doesn't exist. */
  list(path: string): Promise<string[]>;
}

export const join = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/');
