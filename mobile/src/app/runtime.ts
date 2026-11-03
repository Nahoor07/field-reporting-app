import { AppState } from 'react-native';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { HttpUploadTransport } from '../api/HttpUploadTransport';
import { DraftStore } from '../compose/DraftStore';
import { clearImageCaches, processPhoto, removeSource } from '../images/nativeImages';
import { FileOutboxStore } from '../outbox/FileOutboxStore';
import { netInfoConnectivity, onReconnect } from '../platform/connectivity';
import { join } from '../platform/disk';
import { uuid } from '../platform/ids';
import { rnfsDisk, rnfsFileReader } from '../platform/rnfsDisk';
import { UploadEngine } from '../sync/UploadEngine';
import { SettingsStore } from './settings';

/**
 * Composition root. The only file that knows which concrete adapters exist.
 * Everything below it is testable with fakes; everything above it (React) only
 * reads snapshots and calls the handful of commands exposed here.
 *
 * Lives outside React on purpose: the queue must keep draining no matter which
 * screen is mounted, and must not restart because a component re-rendered.
 */
const ROOT = join(RNFS.DocumentDirectoryPath, 'field-reports');

const log = {
  info: (message: string, data?: Record<string, unknown>) => __DEV__ && console.log(`[sync] ${message}`, data ?? ''),
  warn: (message: string, data?: Record<string, unknown>) => console.warn(`[sync] ${message}`, data ?? ''),
};

export function createRuntime() {
  const settings = new SettingsStore(rnfsDisk, ROOT);
  const outbox = new FileOutboxStore(rnfsDisk, join(ROOT, 'outbox'));
  const drafts = new DraftStore(
    {
      disk: rnfsDisk,
      outbox,
      processPhoto,
      removeSource,
      newId: uuid,
      now: () => new Date(),
    },
    join(ROOT, 'draft'),
  );
  const engine = new UploadEngine({
    store: outbox,
    transport: new HttpUploadTransport(() => settings.get().serverUrl),
    files: rnfsFileReader,
    connectivity: netInfoConnectivity,
    logger: log,
  });

  let started: Promise<void> | null = null;
  const unsubscribers: (() => void)[] = [];

  /** Idempotent. Resolves once local state is loaded; the drain itself runs on. */
  function start(): Promise<void> {
    started ??= (async () => {
      await settings.load();
      await Promise.all([outbox.load(), drafts.load()]);
      engine.start(); // not awaited: loading the UI never waits on the network

      // Signal came back: don't sit out the rest of a backoff window.
      unsubscribers.push(onReconnect(() => engine.drain({ ignoreBackoff: true })));
      const sub = AppState.addEventListener('change', state => {
        if (state === 'active') engine.drain({ ignoreBackoff: true });
        else drafts.flush();
      });
      unsubscribers.push(() => sub.remove());
    })();
    return started;
  }

  return {
    settings,
    outbox,
    drafts,
    engine,
    start,

    async submitDraft() {
      const report = await drafts.submit();
      engine.drain();
      return report;
    },

    async retry(reportId: string) {
      await outbox.retry(reportId);
      engine.drain({ ignoreBackoff: true });
    },

    retryAll() {
      engine.drain({ ignoreBackoff: true });
    },

    async setServerUrl(url: string) {
      await settings.setServerUrl(url);
      engine.drain({ ignoreBackoff: true });
    },

    /**
     * Start over, on this phone. Removes: every queued, failed and delivered report, every
     * processed photo, the draft, and the picker/resizer caches. Keeps: the server address
     * (configuration, not work). Never touches the server: what landed there is the record.
     */
    async reset() {
      await engine.stop(); // aborts the in-flight request and discards its result
      await drafts.discard();
      await outbox.wipe();
      await clearImageCaches().catch(() => {});
      await engine.start();
    },
  };
}

export type Runtime = ReturnType<typeof createRuntime>;

export const runtime: Runtime = createRuntime();
