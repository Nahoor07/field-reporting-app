import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Keyboard, Platform } from 'react-native';
import { useNetInfo } from '@react-native-community/netinfo';
import { fetchServerReports, type ServerReport } from '../api/serverReports';
import { runtime } from '../app/runtime';
import { isOfflineState } from '../platform/connectivity';
import type { EngineActivity } from '../sync/UploadEngine';

export const useOutbox = () => useSyncExternalStore(runtime.outbox.subscribe, runtime.outbox.getSnapshot);

export const useDraft = () => useSyncExternalStore(runtime.drafts.subscribe, runtime.drafts.getSnapshot);

export const useSettings = () => useSyncExternalStore(runtime.settings.subscribe, runtime.settings.get);

export function useEngineActivity(): EngineActivity {
  const subscribe = useCallback((cb: () => void) => runtime.engine.subscribe(cb), []);
  return useSyncExternalStore(subscribe, () => runtime.engine.getActivity());
}

export function useOffline(): boolean {
  const state = useNetInfo();
  return isOfflineState(state);
}

/** Re-renders every `ms` while `active`, for countdowns. */
export function useNow(ms: number, active = true): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms, active]);
  return now;
}

/** Keyboard height, so footers can lift above it (adjustResize no longer applies edge-to-edge). */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', e =>
      setHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setHeight(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}

/** Fires when the app returns to the foreground (e.g. back from Settings). */
export function useOnForeground(callback: () => void): void {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') ref.current();
    });
    return () => sub.remove();
  }, []);
}

export type ServerList =
  | { phase: 'loading' }
  | { phase: 'ready'; reports: ServerReport[]; fetchedAt: number; refreshing: boolean; staleError: string | null }
  | { phase: 'error'; message: string };

const SERVER_LIST_TIMEOUT_MS = 20_000;

/**
 * The server's list, fetched from the server. A failed refresh keeps the last good list on
 * screen and says it's stale, rather than replacing what the user can see with an error.
 */
export function useServerReports(): { state: ServerList; refresh: () => void } {
  const { serverUrl } = useSettings();
  const [state, setState] = useState<ServerList>({ phase: 'loading' });
  const inflight = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    const timer = setTimeout(() => controller.abort(), SERVER_LIST_TIMEOUT_MS);
    setState(prev => (prev.phase === 'ready' ? { ...prev, refreshing: true } : { phase: 'loading' }));

    fetchServerReports(serverUrl, controller.signal)
      .then(reports => {
        if (inflight.current !== controller) return;
        setState({ phase: 'ready', reports, fetchedAt: Date.now(), refreshing: false, staleError: null });
      })
      .catch(error => {
        if (inflight.current !== controller) return;
        const message = describeFetchError(error, controller.signal.aborted);
        setState(prev =>
          prev.phase === 'ready' ? { ...prev, refreshing: false, staleError: message } : { phase: 'error', message },
        );
      })
      .finally(() => clearTimeout(timer));
  }, [serverUrl]);

  useEffect(() => {
    refresh();
    return () => inflight.current?.abort();
  }, [refresh]);

  return { state, refresh };
}

function describeFetchError(error: unknown, timedOut: boolean): string {
  if (timedOut) return 'The server took too long to answer.';
  const status = (error as { status?: number })?.status;
  if (status) return `The server answered with an error (${status}).`;
  return "Couldn't reach the server.";
}
