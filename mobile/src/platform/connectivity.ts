import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import type { Connectivity } from '../sync/ports';

/**
 * Only `isConnected === false` counts as offline. "Connected but no internet reachability"
 * is exactly what one bar of 2G looks like to the OS, and we still want to try.
 */
export const isOfflineState = (state: Pick<NetInfoState, 'isConnected'>) => state.isConnected === false;

export const netInfoConnectivity: Connectivity = {
  async isOffline() {
    return isOfflineState(await NetInfo.fetch());
  },
};

/** Calls `onOnline` on every offline → online transition. */
export function onReconnect(onOnline: () => void): () => void {
  let offline: boolean | null = null;
  return NetInfo.addEventListener(state => {
    const now = isOfflineState(state);
    if (offline === true && !now) onOnline();
    offline = now;
  });
}
