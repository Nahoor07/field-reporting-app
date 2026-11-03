import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radius, space } from '../theme';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface Props {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  compact?: boolean;
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}

export function Button({ label, onPress, variant = 'primary', disabled, busy, compact, icon, style, accessibilityHint }: Props) {
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
        { backgroundColor: pressed && v.pressed ? v.pressed : v.bg },
        inactive && (variant === 'primary' ? styles.primaryDisabled : styles.disabled),
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={v.fg} />
      ) : (
        <View style={styles.inner}>
          {icon}
          <Text style={[styles.label, compact && styles.labelCompact, { color: inactive && variant === 'primary' ? colors.inkFaint : v.fg }]} numberOfLines={1}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const VARIANTS: Record<Variant, { bg: string; fg: string; pressed?: string; ripple: string }> = {
  primary: { bg: colors.primary, fg: colors.onPrimary, pressed: colors.primaryPressed, ripple: '#ffffff33' },
  secondary: { bg: colors.primarySoft, fg: colors.primary, pressed: colors.primarySoftPressed, ripple: '#2563EB1A' },
  danger: { bg: colors.danger, fg: colors.onPrimary, ripple: '#ffffff33' },
  ghost: { bg: 'transparent', fg: colors.primary, ripple: '#2563EB14' },
};

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  compact: { minHeight: 34, paddingHorizontal: space.md, borderRadius: radius.sm },
  inner: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  label: { fontSize: 15, fontWeight: '700', letterSpacing: 0.1 },
  labelCompact: { fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.45 },
  primaryDisabled: { backgroundColor: colors.lineSoft },
});
