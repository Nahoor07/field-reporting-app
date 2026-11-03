import React, { memo, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { LocalReport } from '../../domain/report';
import { reportStatus } from '../status';
import { colors, radius, space, tones, typography as t } from '../theme';
import { Button } from './Button';
import { ProgressBar } from './ProgressBar';

interface Props {
  report: LocalReport;
  offline: boolean;
  now: number;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
}

export const fileUri = (path: string) => (path.startsWith('file://') ? path : `file://${path}`);

export const ReportCard = memo(function ReportCardView({ report, offline, now, onRetry, onDiscard }: Props) {
  const status = reportStatus(report, { offline, now });
  const tone = tones[status.tone];
  const [confirming, setConfirming] = useState(false);
  const hasLocalPhotos = report.status !== 'uploaded';

  return (
    <View style={[styles.card, status.tone === 'problem' && { borderColor: tone.fg }]}>
      <View style={styles.top}>
        {hasLocalPhotos ? (
          <View style={styles.thumbs}>
            {report.images.slice(0, 3).map(image => (
              <Image key={image.id} source={{ uri: fileUri(image.uri) }} style={styles.thumb} resizeMethod="resize" />
            ))}
          </View>
        ) : null}
        <View style={[styles.body, hasLocalPhotos && styles.bodyAfterThumbs]}>
          <Text style={t.body} numberOfLines={2}>
            {report.description}
          </Text>
          <Text style={t.tiny}>
            {report.images.length} {report.images.length === 1 ? 'photo' : 'photos'} · created{' '}
            {new Date(report.createdAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      </View>

      <View style={[styles.status, { backgroundColor: tone.bg }]}>
        <Text style={[styles.statusTitle, { color: tone.fg }]}>{status.title}</Text>
        <Text style={styles.statusDetail}>{status.detail}</Text>
        {status.progress !== undefined && <ProgressBar value={status.progress} color={tone.fg} />}
      </View>

      {report.status === 'failed' && !confirming && (
        <View style={styles.actions}>
          <Button label="Try again" onPress={() => onRetry(report.id)} style={styles.flex} />
          <Button label="Delete…" variant="secondary" onPress={() => setConfirming(true)} style={styles.flex} />
        </View>
      )}
      {confirming && (
        <View style={styles.confirm}>
          <Text style={t.small}>
            Delete this report and its photos from this phone? The server never accepted it, so there is no other copy.
          </Text>
          <View style={styles.actions}>
            <Button label="Delete for good" variant="danger" onPress={() => onDiscard(report.id)} style={styles.flex} />
            <Button label="Keep" variant="secondary" onPress={() => setConfirming(false)} style={styles.flex} />
          </View>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.md,
    gap: space.md,
  },
  top: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  thumbs: { flexDirection: 'row' },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: radius.sm,
    marginRight: -16,
    borderWidth: 2,
    borderColor: colors.card,
    backgroundColor: colors.lineSoft,
  },
  body: { flex: 1, gap: 2 },
  bodyAfterThumbs: { marginLeft: 16 },
  status: { borderRadius: radius.md, padding: space.md, gap: 6 },
  statusTitle: { fontSize: 15, fontWeight: '700' },
  statusDetail: { fontSize: 14, color: colors.inkSoft, lineHeight: 19 },
  actions: { flexDirection: 'row', gap: space.sm },
  confirm: { gap: space.sm },
  flex: { flex: 1 },
});
