import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Spinner } from '../ui/Button';
import { categoryColor, categoryLabel } from '../../design/categories';
import { spacing } from '../../design/tokens';
import { typography } from '../../design/typography';
import { msToSeconds, type CardStatus, type PlaybackState } from '../../store/player';
import type { FeedClip } from '../../api/schema';

/**
 * One full-bleed reel.
 *
 * Visual design (cover art, ambient orbs, the 40-bar waveform, the action
 * cluster) is plan §13 and arrives with the Phase 2 polish pass. This card
 * carries what playback actually needs: identity, duration, category, and the
 * four terminal states, because those are what make the transport legible when
 * it fails.
 */
export function ReelCard({
  clip,
  active,
  cardStatus,
  playback,
  durationMs,
  height,
}: {
  clip: FeedClip;
  active: boolean;
  /** Token-lifecycle state. Terminal states outrank `playback`. */
  cardStatus: CardStatus;
  /** Native player state. Drives the play/pause affordance, not the copy. */
  playback: PlaybackState;
  durationMs?: number;
  /** Measured viewport height. `flex: 1` alone resolves to zero here. */
  height: number;
}) {
  const tint = categoryColor(clip.category);
  const seconds = durationMs ? Math.round(msToSeconds(durationMs)) : null;

  return (
    <View style={[styles.reel, { height }]}>
      <View style={[styles.reelTint, { backgroundColor: tint, opacity: 0.08 }]} />

      <View style={styles.reelBody}>
        <Text style={typography.microLabel}>
          {active && playback === 'playing' ? 'Now playing' : clip.creator_name}
        </Text>
        <Text style={[typography.page, styles.reelTitle]} numberOfLines={2}>
          {clip.title}
        </Text>

        <View style={styles.metaRow}>
          {clip.category ? (
            <View style={[styles.chip, { borderColor: tint }]}>
              <Text style={[typography.microLabel, { color: tint }]}>
                {categoryLabel(clip.category)}
              </Text>
            </View>
          ) : null}
          {seconds ? <Text style={typography.count}>{seconds}s</Text> : null}
        </View>

        {/* tags come from KeyBERT over the Whisper transcript, so they are a
            real content signal rather than the uploader's chosen category. */}
        {clip.tags && clip.tags.length > 0 ? (
          <Text style={[typography.bodySecondary, styles.tags]} numberOfLines={2}>
            {clip.tags.join(' · ')}
          </Text>
        ) : null}

        {active ? <CardStatusView cardStatus={cardStatus} playback={playback} /> : null}
      </View>
    </View>
  );
}

/**
 * The card's own overlay.
 *
 * A terminal `cardStatus` wins over `playback`: a clip that is unavailable must
 * not also be reporting a spinner, and an errored clip must not keep claiming to
 * play. `playback` is what fills the gap the token lifecycle cannot — a native
 * media failure on a clip whose token minted fine, which was previously
 * reported as "Now playing" indefinitely because `replace()` does not throw.
 */
function CardStatusView({
  cardStatus,
  playback,
}: {
  cardStatus: CardStatus;
  playback: PlaybackState;
}) {
  if (cardStatus === 'minting' || playback === 'loading' || playback === 'buffering') {
    return (
      <View style={styles.statusBox}>
        <Spinner />
      </View>
    );
  }
  if (cardStatus === 'processing') {
    return (
      <View style={styles.statusBox}>
        <Text style={typography.label}>Still processing — this clip is being encoded</Text>
      </View>
    );
  }
  if (cardStatus === 'unavailable') {
    return (
      <View style={styles.statusBox}>
        {/* SECURITY: one message for BOTH 403 causes (unmoderated and
            licence-restricted). Distinguishing them tells a caller holding
            only a UUID something about moderation or licensing state. */}
        <Text style={typography.label}>This clip is no longer available</Text>
      </View>
    );
  }
  if (cardStatus === 'gone') {
    // Same copy as `unavailable` on purpose: a 404 versus a 403 is a different
    // fact about the clip, and saying so tells a caller holding only a UUID
    // whether the row was deleted versus gated. The states stay distinct in the
    // store for retry logic; the copy does not distinguish them.
    return (
      <View style={styles.statusBox}>
        <Text style={typography.label}>This clip is no longer available</Text>
      </View>
    );
  }
  if (cardStatus === 'auth-required') {
    return (
      <View style={styles.statusBox}>
        <Text style={typography.label}>Sign in again to keep listening</Text>
      </View>
    );
  }
  if (cardStatus === 'error' || playback === 'error') {
    return (
      <View style={styles.statusBox}>
        <Text style={typography.label}>Could not play this clip</Text>
      </View>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  // `flex: 1` is kept only as a fallback for a zero-height prop; the explicit
  // `height` from the measured viewport is what actually sizes the cell. See
  // the `viewport` docstring for why this cannot be left to the layout engine.
  reel: { flex: 1, justifyContent: 'flex-end' },
  // RN 0.86 exposes `absoluteFill` only; `absoluteFillObject` is gone.
  reelTint: { ...StyleSheet.absoluteFill, opacity: 0.08 },
  reelBody: { padding: spacing.stack, paddingBottom: spacing.stack * 2, gap: spacing.gutter },
  reelTitle: { marginTop: spacing.marginMobile },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.gutter },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.gutter,
    paddingVertical: spacing.marginMobile / 3,
  },
  tags: { opacity: 0.7 },
  statusBox: { marginTop: spacing.marginMobile },
});
