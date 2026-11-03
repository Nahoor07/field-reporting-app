import { Platform, type ViewStyle } from 'react-native';
import type { Tone } from './status';

export const colors = {
  ink: '#0F172A',
  inkSoft: '#475569',
  inkFaint: '#94A3B8',
  paper: '#F4F6FA',
  card: '#FFFFFF',
  line: '#E2E8F0',
  lineSoft: '#EEF2F7',
  field: '#F1F4F9',
  primary: '#2563EB',
  primaryPressed: '#1D4ED8',
  primarySoft: '#EAF1FF',
  primarySoftPressed: '#DCE7FF',
  danger: '#DC2626',
  dangerSoft: '#FEECEC',
  onPrimary: '#FFFFFF',
} as const;

/** One color pair per fact about a report. Used consistently in banner, card and dot. */
export const tones: Record<Tone, { fg: string; bg: string; label: string; glyph: string }> = {
  safe: { fg: '#4F6B8F', bg: '#EDF2F8', label: 'Saved on this phone', glyph: '✓' },
  moving: { fg: '#2563EB', bg: '#EAF1FF', label: 'Sending', glyph: '↑' },
  waiting: { fg: '#B45309', bg: '#FFF4E5', label: 'Waiting to retry', glyph: '…' },
  problem: { fg: '#DC2626', bg: '#FEECEC', label: 'Needs your decision', glyph: '!' },
  done: { fg: '#15803D', bg: '#E8F7EE', label: 'On the server', glyph: '✓' },
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 10, md: 14, lg: 20, xl: 28 } as const;

/** Android's recommended minimum touch target. */
export const HIT = 48;

/** Soft elevation instead of borders: cards float on the page rather than being boxed in. */
export const shadow: { card: ViewStyle; raised: ViewStyle; bar: ViewStyle } = {
  card: Platform.select({
    ios: { shadowColor: '#0F172A', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
    default: { elevation: 2, shadowColor: '#0F172A' },
  }) as ViewStyle,
  raised: Platform.select({
    ios: { shadowColor: '#0F172A', shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
    default: { elevation: 3, shadowColor: '#0F172A' },
  }) as ViewStyle,
  bar: Platform.select({
    ios: { shadowColor: '#0F172A', shadowOpacity: 0.08, shadowRadius: 16, shadowOffset: { width: 0, height: -4 } },
    default: { elevation: 12, shadowColor: '#0F172A' },
  }) as ViewStyle,
};

export const typography = {
  title: { fontSize: 24, fontWeight: '800' as const, color: colors.ink, letterSpacing: -0.4 },
  heading: { fontSize: 14, fontWeight: '700' as const, color: colors.ink, letterSpacing: -0.1 },
  body: { fontSize: 15, color: colors.ink, lineHeight: 21 },
  small: { fontSize: 13, color: colors.inkSoft, lineHeight: 18 },
  tiny: { fontSize: 11, color: colors.inkFaint, lineHeight: 15 },
};
