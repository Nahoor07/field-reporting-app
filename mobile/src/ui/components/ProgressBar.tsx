import React from 'react';
import { StyleSheet, View } from 'react-native';
import { colors } from '../theme';

export function ProgressBar({ value, color }: { value: number; color: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <View
      style={styles.track}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}
    >
      <View style={[styles.fill, { width: `${pct}%`, backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 6, borderRadius: 3, backgroundColor: colors.lineSoft, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
});
