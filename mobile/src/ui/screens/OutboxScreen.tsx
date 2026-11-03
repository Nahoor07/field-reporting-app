import React, { useCallback, useMemo } from 'react';
import { SectionList, StyleSheet, Text, View } from 'react-native';
import { runtime } from '../../app/runtime';
import type { LocalReport } from '../../domain/report';
import { Button } from '../components/Button';
import { ReportCard } from '../components/ReportCard';
import { StatusBanner } from '../components/StatusBanner';
import { useDraft, useEngineActivity, useNow, useOffline, useOutbox } from '../hooks';
import { summarize } from '../status';
import { colors, space, typography as t } from '../theme';

interface Props {
  onCompose: () => void;
  bottomInset: number;
}

/** "On this phone": everything the device is responsible for, and the way to add more. */
export function OutboxScreen({ onCompose, bottomInset }: Props) {
  const { reports } = useOutbox();
  const draft = useDraft();
  const activity = useEngineActivity();
  const offline = useOffline();
  const ticking = activity.state === 'waiting' || reports.some(r => r.status === 'queued' && r.nextAttemptAt);
  const now = useNow(1000, ticking);

  const summary = summarize(reports, { offline, activity, now });
  const sections = useMemo(() => {
    const failed = reports.filter(r => r.status === 'failed');
    const pending = reports
      .filter(r => r.status !== 'failed' && r.status !== 'uploaded')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // send order
    const delivered = reports.filter(r => r.status === 'uploaded');
    return [
      { key: 'failed', title: 'Needs your decision', data: failed },
      { key: 'pending', title: 'Waiting to send, in order', data: pending },
      { key: 'delivered', title: 'On the server', data: delivered },
    ].filter(section => section.data.length > 0);
  }, [reports]);

  const onRetry = useCallback((id: string) => runtime.retry(id), []);
  const onDiscard = useCallback((id: string) => runtime.outbox.discard(id), []);

  const draftCount = draft.photos.length + draft.preparing.length;
  const hasDraft = draftCount > 0 || draft.description.trim().length > 0;

  return (
    <View style={styles.flex}>
      <SectionList
        sections={sections}
        keyExtractor={(item: LocalReport) => item.id}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View style={styles.header}>
            <StatusBanner summary={summary} onRetryNow={runtime.retryAll} />
          </View>
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={t.heading}>{section.title}</Text>
            {section.key === 'delivered' && (
              <Button label="Clear" variant="ghost" compact onPress={() => runtime.outbox.clearDelivered()} />
            )}
          </View>
        )}
        renderItem={({ item }) => (
          <ReportCard report={item} offline={offline} now={now} onRetry={onRetry} onDiscard={onDiscard} />
        )}
        ItemSeparatorComponent={Separator}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No reports on this phone</Text>
            <Text style={t.small}>
              Write a short description and add 1–5 photos. It works with no signal: the report waits here and sends
              itself when it can.
            </Text>
          </View>
        }
      />
      <View style={[styles.footer, { paddingBottom: space.md + bottomInset }]}>
        <Button label={hasDraft ? `Continue draft${draftCount ? ` (${draftCount} photos)` : ''}` : 'New report'} onPress={onCompose} />
      </View>
    </View>
  );
}

const Separator = () => <View style={{ height: space.md }} />;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: space.lg, paddingBottom: space.xxl },
  header: { marginBottom: space.sm },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: space.lg,
    marginBottom: space.sm,
    minHeight: 36,
  },
  empty: { marginTop: space.xl, gap: space.sm, paddingHorizontal: space.sm },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.ink },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    backgroundColor: colors.paper,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
});
