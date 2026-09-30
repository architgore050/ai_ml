import React, { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';

import { approveClipModeration, getClipStatus, uploadClip, type CancellableUpload, type UploadAsset } from '../../src/api/endpoints/clips';
import { Button, ProgressBar } from '../../src/components/ui/Button';
import { content, spacing, surface, accent, border } from '../../src/design/tokens';
import { typography } from '../../src/design/typography';
import { limitNumber } from '../../src/api/schema';
import { useSubscription } from '../../src/hooks/useSubscription';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Creator workflow: record or choose audio, validate, upload, then track processing. */
export default function StudioScreen() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recording = useAudioRecorderState(recorder);
  const subscription = useSubscription();
  const [asset, setAsset] = useState<UploadAsset | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('music');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [clipStatus, setClipStatus] = useState<string | null>(null);
  const upload = useRef<CancellableUpload | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    upload.current?.cancel();
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  const maxDurationSeconds = limitNumber(subscription.status?.limits, 'max_clip_duration_seconds');
  const maxSizeMb = limitNumber(subscription.status?.limits, 'max_upload_size_mb');

  const validate = (next: UploadAsset): boolean => {
    const maxBytes = (maxSizeMb ?? 100) * 1024 * 1024;
    if ((next.size ?? 0) > Math.min(MAX_UPLOAD_BYTES, maxBytes)) {
      Alert.alert('File is too large', `Choose audio smaller than ${maxSizeMb ?? 100} MB.`);
      return false;
    }
    if (next.durationMs != null && maxDurationSeconds != null && next.durationMs > maxDurationSeconds * 1000) {
      Alert.alert('Clip is too long', `Your current limit is ${maxDurationSeconds} seconds.`);
      return false;
    }
    return true;
  };

  const pickAudio = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true, multiple: false });
    if (result.canceled) return;
    const selected = result.assets[0];
    if (!selected) return;
    const next: UploadAsset = {
      uri: selected.uri,
      name: selected.name,
      mimeType: selected.mimeType || 'audio/mpeg',
      size: selected.size,
      // Android's system picker does not reliably return media duration. The
      // server validates the canonical file; recorded clips are checked below.
      durationMs: null,
    };
    if (validate(next)) setAsset(next);
  };

  const toggleRecording = async () => {
    if (recording.isRecording) {
      await recorder.stop();
      if (!recorder.uri) return;
      const next: UploadAsset = {
        uri: recorder.uri,
        name: `recording-${Date.now()}.m4a`,
        mimeType: 'audio/mp4',
        durationMs: Math.round(recorder.currentTime * 1000),
      };
      if (validate(next)) setAsset(next);
      return;
    }
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Microphone permission needed', 'Allow microphone access to record a clip.');
      return;
    }
    await recorder.prepareToRecordAsync();
    recorder.record();
  };

  const poll = (clipId: string) => {
    pollTimer.current = setTimeout(async () => {
      try {
        const next = await getClipStatus(clipId);
        setClipStatus(next.status);
        if (next.status === 'processing') poll(clipId);
      } catch {
        setClipStatus('processing status unavailable');
      }
    }, 5000);
  };

  const publish = () => {
    if (!asset || !title.trim() || uploading) return;
    setUploading(true);
    setProgress(0);
    setClipStatus(null);
    upload.current = uploadClip({ title, category, licenseType: 'Owned', asset }, setProgress);
    void upload.current.promise
      .then(async ({ clipId }) => {
        const approved = await approveClipModeration(clipId);
        setClipStatus(approved.status);
        poll(clipId);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        Alert.alert('Upload failed', cause instanceof Error ? cause.message : 'Try again.');
      })
      .finally(() => { setUploading(false); upload.current = null; });
  };

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Text style={styles.eyebrow}>Creator studio</Text>
      <Text style={styles.title}>Publish a clip</Text>
      <Text style={styles.body}>Record something new or choose an audio file. Uploads are processed before they can appear in the feed.</Text>
      <View style={styles.actions}>
        <Button label={recording.isRecording ? 'Stop recording' : 'Record audio'} onPress={() => void toggleRecording()} variant="ghost" />
        <Button label="Choose audio file" onPress={() => void pickAudio()} variant="ghost" disabled={recording.isRecording} />
      </View>
      {recording.isRecording ? <Text accessibilityRole="timer" style={styles.recording}>Recording {Math.round(recording.durationMillis / 1000)}s</Text> : null}
      {asset ? <Text style={styles.selected}>Selected: {asset.name}</Text> : null}
      <TextInput accessibilityLabel="Clip title" value={title} onChangeText={setTitle} placeholder="Clip title" placeholderTextColor={content.tertiary} maxLength={200} style={styles.input} />
      <TextInput accessibilityLabel="Clip category" value={category} onChangeText={setCategory} placeholder="Category" placeholderTextColor={content.tertiary} maxLength={100} style={styles.input} />
      <Text style={styles.limit}>Limit: {maxDurationSeconds ?? '…'} seconds · {maxSizeMb ?? '…'} MB</Text>
      {uploading ? <><ProgressBar progress={progress} /><Button label="Cancel upload" onPress={() => upload.current?.cancel()} variant="ghost" /></> : null}
      {clipStatus ? <Text accessibilityLiveRegion="polite" style={styles.status}>Status: {clipStatus}</Text> : null}
      <Button label="Upload and process" onPress={publish} disabled={!asset || !title.trim() || recording.isRecording || uploading} loading={uploading} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, backgroundColor: surface.base, padding: spacing.stack, gap: spacing.stack },
  eyebrow: { ...typography.microLabel, color: accent.base },
  title: { ...typography.page, color: content.primary },
  body: { ...typography.bodySecondary, color: content.tertiary },
  actions: { gap: spacing.gutter },
  recording: { ...typography.label, color: '#ffb4ab' },
  selected: { ...typography.bodySecondary, color: content.secondary },
  input: { minHeight: 48, borderWidth: 1, borderColor: border.default, borderRadius: 12, paddingHorizontal: spacing.gutter, color: content.primary },
  limit: { ...typography.microLabel, color: content.tertiary },
  status: { ...typography.bodySecondary, color: accent.base },
});
