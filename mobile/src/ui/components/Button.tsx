import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { colors, HIT, radius, space } from '../theme';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface Props {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}

export function Button({ label, onPress, variant = 'primary', disabled, busy, compact, style, accessibilityHint }: Props) {
  const v = VARIANTS[variant];
  const inactive = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      android_ripple={{ color: v.ripple }}
      hitSlop={compact ? 8 : 0}
      style={({ pressed }) => [
        styles.base,
        compact && styles.compact,
        { backgroundColor: pressed && v.pressed ? v.pressed : v.bg, borderColor: v.border },
        inactive && styles.disabled,
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={v.fg} /> : <Text style={[styles.label, { color: v.fg }]}>{label}</Text>}
    </Pressable>
  );
}

const VARIANTS: Record<Variant, { bg: string; fg: string; border: string; pressed?: string; ripple: string }> = {
  primary: { bg: colors.primary, fg: colors.onPrimary, border: colors.primary, pressed: colors.primaryPressed, ripple: '#ffffff33' },
  secondary: { bg: colors.card, fg: colors.ink, border: colors.line, ripple: '#00000014' },
  danger: { bg: colors.danger, fg: colors.onPrimary, border: colors.danger, ripple: '#ffffff33' },
  ghost: { bg: 'transparent', fg: colors.primary, border: 'transparent', ripple: '#00000014' },
};

const styles = StyleSheet.create({
  base: {
    minHeight: HIT,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  compact: { minHeight: 36, paddingHorizontal: space.md, borderRadius: radius.sm },
  label: { fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.45 },
});
