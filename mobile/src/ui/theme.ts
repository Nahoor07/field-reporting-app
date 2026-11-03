import type { Tone } from './status';

export const colors = {
  ink: '#16212C',
  inkSoft: '#46545F',
  inkFaint: '#7A8894',
  paper: '#F2F4F3',
  card: '#FFFFFF',
  line: '#D9E0DD',
  lineSoft: '#E8ECEA',
  primary: '#1F5FAD',
  primaryPressed: '#184C8C',
  danger: '#B93A33',
  onPrimary: '#FFFFFF',
} as const;

/** One color pair per fact about a report. Used consistently in banner, card and dot. */
export const tones: Record<Tone, { fg: string; bg: string; label: string }> = {
  safe: { fg: '#3A5674', bg: '#E8EEF5', label: 'Saved on this phone' },
  moving: { fg: '#2369C0', bg: '#E5EFFB', label: 'Sending' },
  waiting: { fg: '#A35F12', bg: '#FBEFDD', label: 'Waiting to retry' },
  problem: { fg: '#B93A33', bg: '#FAE7E5', label: 'Needs your decision' },
  done: { fg: '#24804F', bg: '#E2F2E9', label: 'On the server' },
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16 } as const;

/** Android's recommended minimum touch target. */
export const HIT = 48;

export const typography = {
  title: { fontSize: 22, fontWeight: '700' as const, color: colors.ink, letterSpacing: -0.2 },
  heading: { fontSize: 13, fontWeight: '700' as const, color: colors.inkFaint, letterSpacing: 0.8, textTransform: 'uppercase' as const },
  body: { fontSize: 16, color: colors.ink, lineHeight: 22 },
  small: { fontSize: 14, color: colors.inkSoft, lineHeight: 19 },
  tiny: { fontSize: 12, color: colors.inkFaint },
};
