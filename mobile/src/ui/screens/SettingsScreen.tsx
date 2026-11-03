import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { runtime } from '../../app/runtime';
import { Button } from '../components/Button';
import { useDraft, useOutbox, useSettings } from '../hooks';
import { plural } from '../status';
import { colors, radius, shadow, space, tones, typography as t } from '../theme';

export function SettingsScreen({ onResetDone }: { onResetDone: () => void }) {
  const { serverUrl } = useSettings();
  const { reports } = useOutbox();
  const draft = useDraft();
  const [url, setUrl] = useState(serverUrl);
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);

  const unsent = reports.filter(r => r.status !== 'uploaded').length;
  const delivered = reports.length - unsent;
  const draftPhotos = draft.photos.length + draft.preparing.length;
  const hasDraft = draftPhotos > 0 || draft.description.trim().length > 0;

  const reset = async () => {
    setResetting(true);
    try {
      await runtime.reset();
      setUrl(runtime.settings.get().serverUrl);
      onResetDone();
    } finally {
      setResetting(false);
      setConfirming(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={t.heading}>Server</Text>
      <View style={styles.card}>
        <TextInput
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={styles.input}
          accessibilityLabel="Server address"
        />
        <Text style={t.tiny}>With a USB cable: run “adb reverse tcp:4000 tcp:4000” and keep http://localhost:4000.</Text>
        <Button
          label="Save address"
          variant="secondary"
          disabled={url.trim() === serverUrl}
          onPress={() => runtime.setServerUrl(url)}
        />
      </View>

      <Text style={[t.heading, styles.gap]}>Start over</Text>
      <View style={styles.card}>
        <Text style={t.small}>
          Clears this phone: every report here (sent or not), their photos, the draft, and temporary image files. The
          server address is kept. Nothing on the server is deleted: once a report has landed there, it's the record.
        </Text>
        {!confirming ? (
          <Button label="Start over…" variant="secondary" onPress={() => setConfirming(true)} />
        ) : (
          <View style={[styles.confirm, { backgroundColor: tones.problem.bg }]}>
            <Text style={[styles.confirmTitle, { color: tones.problem.fg }]}>This will delete from this phone:</Text>
            {unsent > 0 && (
              <Text style={[t.small, styles.strong]}>
                • {plural(unsent, 'report')} the server doesn't have. These are lost for good.
              </Text>
            )}
            {delivered > 0 && <Text style={t.small}>• {plural(delivered, 'delivery receipt')} (the server keeps the reports)</Text>}
            {hasDraft && <Text style={t.small}>• Your draft{draftPhotos ? ` and its ${plural(draftPhotos, 'photo')}` : ''}</Text>}
            {unsent === 0 && delivered === 0 && !hasDraft && <Text style={t.small}>• Nothing but temporary files</Text>}
            <View style={styles.row}>
              <Button label="Delete everything" variant="danger" busy={resetting} onPress={reset} style={styles.flex} />
              <Button label="Cancel" variant="secondary" onPress={() => setConfirming(false)} style={styles.flex} />
            </View>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm, paddingBottom: space.xxl },
  gap: { marginTop: space.lg },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: space.lg, gap: space.md, ...shadow.card },
  input: {
    backgroundColor: colors.field,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    minHeight: 46,
    fontSize: 15,
    color: colors.ink,
  },
  confirm: { borderRadius: radius.md, padding: space.md, gap: space.sm },
  confirmTitle: { fontSize: 14, fontWeight: '700' },
  strong: { fontWeight: '700', color: colors.ink },
  row: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  flex: { flex: 1 },
});
