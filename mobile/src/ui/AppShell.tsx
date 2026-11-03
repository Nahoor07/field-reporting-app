import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { runtime } from '../app/runtime';
import { useOutbox } from './hooks';
import { ComposeScreen } from './screens/ComposeScreen';
import { OutboxScreen } from './screens/OutboxScreen';
import { ServerScreen } from './screens/ServerScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { colors, HIT, space, tones } from './theme';

type Tab = 'phone' | 'server' | 'settings';

const TABS: { key: Tab; label: string }[] = [
  { key: 'phone', label: 'On this phone' },
  { key: 'server', label: 'On the server' },
  { key: 'settings', label: 'Settings' },
];

/**
 * Three tabs and one full-screen compose route. Deliberately no navigation library:
 * four screens don't need a navigator, and every native dependency is one more thing
 * to keep building on a new React Native release.
 */
export function AppShell() {
  const insets = useSafeAreaInsets();
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('phone');
  const [composing, setComposing] = useState(false);
  const toast = useToast();

  useEffect(() => {
    runtime
      .start()
      .then(() => setReady(true))
      .catch(error => setBootError(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (composing) {
        setComposing(false); // the draft is kept
        return true;
      }
      if (tab !== 'phone') {
        setTab('phone');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [composing, tab]);

  if (bootError) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.bootTitle}>Couldn't open this phone's report storage</Text>
        <Text style={styles.bootDetail}>{bootError}</Text>
      </View>
    );
  }
  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (composing) {
    return (
      <ComposeScreen
        topInset={insets.top}
        bottomInset={insets.bottom}
        onClose={() => setComposing(false)}
        onSubmitted={() => {
          setComposing(false);
          setTab('phone');
          toast.show('Report saved on this phone. It sends by itself.');
        }}
      />
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.titleBar}>
        <Text style={styles.appTitle}>Field Reports</Text>
      </View>
      <TabBar tab={tab} onChange={setTab} />
      <View style={styles.flex}>
        {tab === 'phone' && <OutboxScreen onCompose={() => setComposing(true)} bottomInset={insets.bottom} />}
        {tab === 'server' && <ServerScreen topInset={insets.top} />}
        {tab === 'settings' && (
          <SettingsScreen
            onResetDone={() => {
              setTab('phone');
              toast.show('This phone has been cleared.');
            }}
          />
        )}
      </View>
      {tab !== 'phone' && <View style={{ height: insets.bottom }} />}
      {toast.element(insets.bottom + 88)}
    </View>
  );
}

function TabBar({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  const { reports } = useOutbox();
  const attention = reports.filter(r => r.status === 'failed').length;
  const waiting = reports.filter(r => r.status !== 'failed' && r.status !== 'uploaded').length;
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      {TABS.map(({ key, label }) => {
        const selected = key === tab;
        const count = key === 'phone' ? waiting + attention : 0;
        return (
          <Pressable
            key={key}
            onPress={() => onChange(key)}
            style={[styles.tab, selected && styles.tabSelected]}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            android_ripple={{ color: '#00000010' }}
          >
            <Text style={[styles.tabLabel, selected && styles.tabLabelSelected]} numberOfLines={1}>
              {label}
            </Text>
            {count > 0 && (
              <View style={[styles.pill, { backgroundColor: attention ? tones.problem.fg : tones.safe.fg }]}>
                <Text style={styles.pillText}>{count}</Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

function useToast() {
  const [message, setMessage] = useState<string | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(
    (text: string) => {
      if (timer.current) clearTimeout(timer.current);
      setMessage(text);
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
      timer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: true }).start(() => setMessage(null));
      }, 3500);
    },
    [opacity],
  );

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const element = (bottom: number) =>
    message ? (
      <Animated.View pointerEvents="none" style={[styles.toast, { bottom, opacity }]} accessibilityLiveRegion="polite">
        <Text style={styles.toastText}>{message}</Text>
      </Animated.View>
    ) : null;

  return { show, element };
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md, backgroundColor: colors.paper },
  bootTitle: { fontSize: 18, fontWeight: '700', color: colors.ink, textAlign: 'center' },
  bootDetail: { fontSize: 14, color: colors.inkSoft, textAlign: 'center' },
  titleBar: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm },
  appTitle: { fontSize: 24, fontWeight: '800', color: colors.ink, letterSpacing: -0.3 },
  tabs: {
    flexDirection: 'row',
    paddingHorizontal: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  tab: {
    flex: 1,
    minHeight: HIT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
  },
  tabSelected: { borderBottomColor: colors.primary },
  tabLabel: { fontSize: 14, fontWeight: '600', color: colors.inkFaint },
  tabLabelSelected: { color: colors.ink },
  pill: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  pillText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  toast: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    backgroundColor: colors.ink,
    borderRadius: 12,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  toastText: { color: '#fff', fontSize: 15, fontWeight: '500', textAlign: 'center' },
});
