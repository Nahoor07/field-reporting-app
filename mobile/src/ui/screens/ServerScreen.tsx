import React, { useState } from 'react';
import { ActivityIndicator, FlatList, Image, Modal, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { ServerReport } from '../../api/serverReports';
import { Button } from '../components/Button';
import { useOnForeground, useServerReports, useSettings } from '../hooks';
import { clock, formatBytes } from '../status';
import { colors, radius, space, tones, typography as t } from '../theme';

/** "On the server": fetched from the server every time. Never built from local state. */
export function ServerScreen({ topInset }: { topInset: number }) {
  const { state, refresh } = useServerReports();
  const { serverUrl } = useSettings();
  const [viewing, setViewing] = useState<string | null>(null);
  useOnForeground(refresh);

  if (state.phase === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
        <Text style={t.small}>Asking the server what it holds…</Text>
      </View>
    );
  }

  if (state.phase === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>{state.message}</Text>
        <Text style={[t.small, styles.centerText]}>
          This list comes straight from the server, so it needs a connection. Reports on this phone are unaffected and
          keep sending on their own.
        </Text>
        <Text style={[t.tiny, styles.centerText]}>{serverUrl}</Text>
        <Button label="Try again" variant="secondary" onPress={refresh} />
      </View>
    );
  }

  return (
    <>
      <FlatList
        data={state.reports}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={refresh} colors={[colors.primary]} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={t.small}>
              {state.reports.length} {state.reports.length === 1 ? 'report' : 'reports'} on the server · checked{' '}
              {clock(new Date(state.fetchedAt).toISOString())}. Pull down to check again.
            </Text>
            {state.staleError && (
              <View style={[styles.stale, { backgroundColor: tones.waiting.bg }]}>
                <Text style={[t.small, { color: tones.waiting.fg }]}>
                  {state.staleError} Showing the list from {clock(new Date(state.fetchedAt).toISOString())}.
                </Text>
              </View>
            )}
          </View>
        }
        ItemSeparatorComponent={Separator}
        renderItem={({ item }) => <ServerReportCard report={item} onOpen={setViewing} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.errorTitle}>The server has no reports yet</Text>
            <Text style={t.small}>Reports appear here once the server has confirmed every photo.</Text>
          </View>
        }
      />
      <Modal visible={viewing !== null} transparent animationType="fade" onRequestClose={() => setViewing(null)} statusBarTranslucent>
        <Pressable style={styles.viewer} onPress={() => setViewing(null)} accessibilityLabel="Close photo">
          {viewing && <Image source={{ uri: viewing }} style={styles.full} resizeMode="contain" />}
          <Text style={[styles.close, { top: topInset + space.md }]}>Close ✕</Text>
        </Pressable>
      </Modal>
    </>
  );
}

function ServerReportCard({ report, onOpen }: { report: ServerReport; onOpen: (url: string) => void }) {
  const images = [...report.images].sort((a, b) => a.position - b.position);
  const total = images.reduce((sum, image) => sum + image.size, 0);
  return (
    <View style={styles.card}>
      <Text style={t.body}>{report.description}</Text>
      <View style={styles.thumbs}>
        {images.map(image => (
          <Pressable
            key={image.id}
            onPress={() => onOpen(image.url)}
            accessibilityRole="imagebutton"
            accessibilityLabel={`Photo ${image.position + 1}, ${formatBytes(image.size)}`}
          >
            <Image source={{ uri: image.url }} style={styles.thumb} resizeMethod="resize" />
          </Pressable>
        ))}
      </View>
      <Text style={t.tiny}>
        Received {clock(report.receivedAt)} · {images.length} {images.length === 1 ? 'photo' : 'photos'},{' '}
        {formatBytes(total)} · id {report.id.slice(0, 8)}
      </Text>
    </View>
  );
}

const Separator = () => <View style={{ height: space.md }} />;

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  centerText: { textAlign: 'center' },
  errorTitle: { fontSize: 18, fontWeight: '700', color: colors.ink, textAlign: 'center' },
  content: { padding: space.lg, paddingBottom: space.xxl },
  header: { gap: space.sm, marginBottom: space.md },
  stale: { borderRadius: radius.md, padding: space.md },
  empty: { marginTop: space.xl, gap: space.sm, alignItems: 'center' },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.md, gap: space.sm },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  thumb: { width: 64, height: 64, borderRadius: radius.sm, backgroundColor: colors.lineSoft },
  viewer: { flex: 1, backgroundColor: '#000000F0', alignItems: 'center', justifyContent: 'center' },
  full: { width: '100%', height: '85%' },
  close: { position: 'absolute', right: space.lg, color: '#fff', fontSize: 16, fontWeight: '600', padding: space.sm },
});
