import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { runtime } from '../../app/runtime';
import { composeProblems, remainingSlots, type ComposeProblem } from '../../domain/compose';
import { MAX_DESCRIPTION_LENGTH, MAX_IMAGES } from '../../domain/limits';
import { checkCameraAccess, choosePhotos, takePhoto, type CameraAccess } from '../../platform/photoSources';
import { Button } from '../components/Button';
import { fileUri } from '../components/ReportCard';
import { useDraft, useKeyboardHeight, useOnForeground } from '../hooks';
import { formatBytes } from '../status';
import { colors, HIT, radius, space, tones, typography as t } from '../theme';

interface Props {
  onClose: () => void;
  onSubmitted: () => void;
  topInset: number;
  bottomInset: number;
}

export function ComposeScreen({ onClose, onSubmitted, topInset, bottomInset }: Props) {
  const draft = useDraft();
  const keyboard = useKeyboardHeight();
  const { width } = useWindowDimensions();
  const [camera, setCamera] = useState<CameraAccess>('unknown');
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const refreshCamera = useCallback(() => {
    checkCameraAccess(cameraRef.current).then(setCamera);
  }, []);
  useEffect(refreshCamera, [refreshCamera]);
  // Back from the Settings app: pick up a newly granted permission without a restart.
  useOnForeground(refreshCamera);

  const preparing = draft.preparing.length;
  const room = remainingSlots(draft.photos.length, preparing);
  const problems = composeProblems({ description: draft.description, photos: draft.photos, preparing });
  const tile = Math.floor((width - space.lg * 2 - space.sm * 2) / 3);

  const add = async (source: 'camera' | 'gallery') => {
    if (room === 0 || picking) return;
    setNotice(null);
    setPicking(true);
    try {
      let result;
      if (source === 'camera') {
        const taken = await takePhoto();
        if (taken.access) setCamera(taken.access);
        result = taken;
      } else {
        result = await choosePhotos(room);
      }
      switch (result.kind) {
        case 'picked': {
          const accepted = runtime.drafts.addPhotos(result.uris);
          if (accepted < result.uris.length)
            setNotice(`A report holds ${MAX_IMAGES} photos. Kept the first ${accepted}, left out ${result.uris.length - accepted}.`);
          break;
        }
        case 'blocked':
          setCamera('blocked');
          break;
        case 'denied':
          setCamera('denied');
          break;
        case 'unavailable':
          setNotice('This device has no camera available. Choose from the gallery instead.');
          break;
        case 'error':
          setNotice(`Couldn't open the ${source}: ${result.message}`);
          break;
        case 'cancelled':
          break;
      }
    } finally {
      setPicking(false);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      await runtime.submitDraft();
      onSubmitted();
    } catch (error) {
      setNotice(`Couldn't save the report on this phone: ${error instanceof Error ? error.message : String(error)}`);
      setSubmitting(false);
    }
  };

  const discard = async () => {
    await runtime.drafts.discard();
    onClose();
  };

  const hasContent = draft.photos.length > 0 || preparing > 0 || draft.description.length > 0;

  return (
    <View style={[styles.screen, { paddingTop: topInset }]}>
      <View style={styles.header}>
        <Button label="‹ Back" variant="ghost" compact onPress={onClose} accessibilityHint="Keeps this draft" />
        <Text style={styles.headerTitle}>New report</Text>
        {hasContent ? (
          <Button label="Discard" variant="ghost" compact onPress={() => setConfirmDiscard(true)} />
        ) : (
          <View style={styles.headerSpacer} />
        )}
      </View>

      {confirmDiscard && (
        <View style={[styles.notice, styles.noticeProblem, styles.discard]}>
          <Text style={t.small}>Throw away this draft and its photos? This can't be undone.</Text>
          <View style={styles.row}>
            <Button label="Discard draft" variant="danger" onPress={discard} style={styles.flex} />
            <Button label="Keep editing" variant="secondary" onPress={() => setConfirmDiscard(false)} style={styles.flex} />
          </View>
        </View>
      )}

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={t.heading}>What did you find?</Text>
        <TextInput
          value={draft.description}
          onChangeText={text => runtime.drafts.setDescription(text)}
          placeholder="Describe the issue and exactly where it is"
          placeholderTextColor={colors.inkFaint}
          multiline
          maxLength={MAX_DESCRIPTION_LENGTH}
          textAlignVertical="top"
          style={styles.input}
          accessibilityLabel="Description"
        />
        <Text style={[t.tiny, styles.counter]}>
          {draft.description.length}/{MAX_DESCRIPTION_LENGTH} · draft is kept on this phone as you type
        </Text>

        <View style={styles.photosHeader}>
          <Text style={t.heading}>Photos</Text>
          <Text style={t.small}>
            {draft.photos.length + preparing} of {MAX_IMAGES}
          </Text>
        </View>

        <View style={styles.grid}>
          {draft.photos.map((photo, index) => (
            <View key={photo.id} style={[styles.tile, { width: tile, height: tile }]}>
              <Image source={{ uri: fileUri(photo.path) }} style={styles.tileImage} resizeMethod="resize" />
              <View style={styles.badge}>
                <Text style={styles.badgeText}>
                  {index + 1} · {formatBytes(photo.size)}
                </Text>
              </View>
              <Pressable
                onPress={() => runtime.drafts.removePhoto(photo.id)}
                style={styles.remove}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Remove photo ${index + 1}`}
              >
                <Text style={styles.removeText}>✕</Text>
              </Pressable>
            </View>
          ))}
          {draft.preparing.map(slot => (
            <View key={slot.id} style={[styles.tile, { width: tile, height: tile }]}>
              <Image source={{ uri: slot.previewUri }} style={[styles.tileImage, styles.dim]} resizeMethod="resize" />
              <View style={styles.preparing}>
                <ActivityIndicator color={colors.onPrimary} />
                <Text style={styles.preparingText}>Preparing</Text>
              </View>
            </View>
          ))}
        </View>

        {room > 0 ? (
          <View style={styles.row}>
            <Button
              label="Take photo"
              variant="secondary"
              onPress={() => add('camera')}
              disabled={picking || camera === 'blocked'}
              style={styles.flex}
            />
            <Button
              label={room < MAX_IMAGES ? `Gallery (up to ${room})` : 'Choose from gallery'}
              variant="secondary"
              onPress={() => add('gallery')}
              disabled={picking}
              style={styles.flex}
            />
          </View>
        ) : (
          <Text style={t.small}>
            {preparing > 0 ? 'All 5 slots are used.' : 'That’s the maximum of 5 photos.'} Remove one to add another.
          </Text>
        )}

        {camera === 'blocked' && (
          <View style={[styles.notice, styles.noticeWaiting]}>
            <Text style={t.small}>
              Camera access is turned off for this app. Turn it on in Settings, then come back here; nothing you've
              written will be lost. You can still choose photos from the gallery.
            </Text>
            <Button label="Open Settings" variant="secondary" compact onPress={() => Linking.openSettings()} />
          </View>
        )}
        {camera === 'denied' && (
          <View style={[styles.notice, styles.noticeWaiting]}>
            <Text style={t.small}>Camera permission wasn't given. Tap “Take photo” to be asked again.</Text>
          </View>
        )}
        {(notice || draft.lastError) && (
          <View style={[styles.notice, styles.noticeProblem]}>
            <Text style={t.small}>{notice ?? draft.lastError}</Text>
          </View>
        )}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: space.md + (keyboard > 0 ? keyboard : bottomInset) }]}>
        {problems.length > 0 && <Text style={[t.small, styles.problems]}>{problems.map(describe).join(' · ')}</Text>}
        <Button
          label="Save & send"
          onPress={submit}
          disabled={problems.length > 0}
          busy={submitting}
          accessibilityHint="Saves the report on this phone. It sends by itself when there is signal."
        />
        <Text style={[t.tiny, styles.footnote]}>Saves on this phone first. Sending needs no signal from you.</Text>
      </View>
    </View>
  );
}

function describe(problem: ComposeProblem): string {
  switch (problem.kind) {
    case 'no_description':
      return 'Add a description';
    case 'description_too_long':
      return `Keep the description under ${problem.max} characters`;
    case 'no_photos':
      return 'Add at least 1 photo';
    case 'too_many_photos':
      return `Remove photos until there are ${problem.max}`;
    case 'photo_too_large':
      return `Photo ${problem.index + 1} is too large`;
    case 'still_preparing':
      return `Preparing ${problem.count} ${problem.count === 1 ? 'photo' : 'photos'}…`;
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.sm,
    minHeight: HIT + 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  headerTitle: { fontSize: 17, fontWeight: '700', color: colors.ink },
  headerSpacer: { width: 80 },
  content: { padding: space.lg, gap: space.md, paddingBottom: space.xxl },
  input: {
    minHeight: 120,
    maxHeight: 220,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: space.md,
    fontSize: 16,
    color: colors.ink,
  },
  counter: { marginTop: -space.sm, textAlign: 'right' },
  photosHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: space.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: { borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.lineSoft },
  tileImage: { width: '100%', height: '100%' },
  dim: { opacity: 0.5 },
  badge: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    backgroundColor: '#000000AA',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  remove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#000000AA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  preparing: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: 4 },
  preparingText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  row: { flexDirection: 'row', gap: space.sm },
  flex: { flex: 1 },
  notice: { borderRadius: radius.md, padding: space.md, gap: space.sm, alignItems: 'flex-start' },
  noticeWaiting: { backgroundColor: tones.waiting.bg },
  noticeProblem: { backgroundColor: tones.problem.bg },
  discard: { margin: space.lg, marginBottom: 0, alignItems: 'stretch' },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.sm,
    backgroundColor: colors.paper,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  problems: { textAlign: 'center' },
  footnote: { textAlign: 'center' },
});
