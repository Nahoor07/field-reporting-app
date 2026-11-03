import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Summary } from '../status';
import { colors, radius, shadow, space, tones } from '../theme';
import { Button } from './Button';
import { ProgressBar } from './ProgressBar';

/** The one-glance answer: is my work safe, moving, or in trouble? */
export function StatusBanner({ summary, onRetryNow }: { summary: Summary; onRetryNow: () => void }) {
  const tone = tones[summary.tone];
  return (
    <View
      style={styles.box}
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${summary.title}. ${summary.detail}`}
    >
      <View style={styles.row}>
        <View style={[styles.badge, { backgroundColor: tone.bg }]}>
          <Text style={[styles.glyph, { color: tone.fg }]}>{tone.glyph}</Text>
        </View>
        <View style={styles.text}>
          <Text style={styles.title}>{summary.title}</Text>
          <Text style={styles.detail}>{summary.detail}</Text>
        </View>
        {summary.canRetryNow && <Button label="Try now" variant="secondary" compact onPress={onRetryNow} />}
      </View>
      {summary.progress !== undefined && <ProgressBar value={summary.progress} color={tone.fg} />}
      {summary.pending > 0 && summary.failed > 0 && (
        <View style={[styles.extra, { backgroundColor: tones.problem.bg }]}>
          <Text style={[styles.extraText, { color: tones.problem.fg }]}>
            Also: {summary.failed} not sent, needs your decision below.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.card, borderRadius: radius.lg, padding: space.md, gap: space.md, ...shadow.card },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  badge: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 17, fontWeight: '800' },
  text: { flex: 1 },
  title: { fontSize: 15, fontWeight: '700', color: colors.ink, letterSpacing: -0.2 },
  detail: { fontSize: 13, color: colors.inkSoft, marginTop: 1, lineHeight: 18 },
  extra: { borderRadius: radius.sm, paddingVertical: space.sm, paddingHorizontal: space.md },
  extraText: { fontSize: 13, fontWeight: '600' },
});
