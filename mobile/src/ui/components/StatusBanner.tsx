import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Summary } from '../status';
import { colors, radius, space, tones } from '../theme';
import { Button } from './Button';
import { ProgressBar } from './ProgressBar';

/** The one-glance answer: is my work safe, moving, or in trouble? */
export function StatusBanner({ summary, onRetryNow }: { summary: Summary; onRetryNow: () => void }) {
  const tone = tones[summary.tone];
  return (
    <View
      style={[styles.box, { backgroundColor: tone.bg, borderColor: tone.fg + '33' }]}
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${summary.title}. ${summary.detail}`}
    >
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: tone.fg }]} />
        <View style={styles.text}>
          <Text style={[styles.title, { color: tone.fg }]}>{summary.title}</Text>
          <Text style={styles.detail}>{summary.detail}</Text>
        </View>
        {summary.canRetryNow && <Button label="Try now" variant="secondary" compact onPress={onRetryNow} />}
      </View>
      {summary.progress !== undefined && <ProgressBar value={summary.progress} color={tone.fg} />}
      {summary.pending > 0 && summary.failed > 0 && (
        <Text style={[styles.extra, { color: tones.problem.fg }]}>
          Also: {summary.failed} not sent, needs your decision below.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: radius.lg, borderWidth: 1, padding: space.lg, gap: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  dot: { width: 10, height: 10, borderRadius: 5 },
  text: { flex: 1 },
  title: { fontSize: 17, fontWeight: '700' },
  detail: { fontSize: 14, color: colors.inkSoft, marginTop: 2, lineHeight: 19 },
  extra: { fontSize: 14, fontWeight: '600' },
});
