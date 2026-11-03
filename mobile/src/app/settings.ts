import { join, type Disk } from '../platform/disk';

/**
 * Default assumes `adb reverse tcp:4000 tcp:4000` (works on emulators and USB devices).
 * Changeable in-app so a reviewer on Wi-Fi can point at a LAN address without rebuilding.
 */
export const DEFAULT_SERVER_URL = 'http://localhost:4000';

export interface Settings {
  serverUrl: string;
}

export class SettingsStore {
  private value: Settings = { serverUrl: DEFAULT_SERVER_URL };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly disk: Disk, private readonly dir: string) {}

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await this.disk.readText(join(this.dir, 'settings.json'))) as Partial<Settings>;
      this.value = { ...this.value, ...saved };
    } catch {
      // first run
    }
  }

  get = (): Settings => this.value;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async setServerUrl(url: string): Promise<void> {
    this.value = { ...this.value, serverUrl: normalizeUrl(url) };
    for (const listener of this.listeners) listener();
    await this.disk.mkdir(this.dir);
    await this.disk.writeTextAtomic(join(this.dir, 'settings.json'), JSON.stringify(this.value));
  }
}

export function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}
