import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { Spinner } from '../ui/Button';
import { AmbientOrbs } from './AmbientOrbs';
import { ClipTransport } from './ClipTransport';
import { OVERLAY_Z, PlayOverlay } from './PlayOverlay';
import { SeekProgressBar } from './SeekProgressBar';
import { WaveformBars } from './WaveformBars';
import { categoryColor, categoryLabel } from '../../design/categories';
import { gradients, spacing } from '../../design/tokens';
import { typography } from '../../design/typography';
import { msToSeconds, type CardStatus, type PlaybackState } from '../../store/player';
import type { WaveformState } from '../../lib/waveform';
import type { FeedClip } from '../../api/schema';

/**
 * One full-bleed reel.
 *
 * ## THE LAYER STACK IS THE POINT OF THIS FILE
 *
 * Everything a reel draws is a sibling, and every sibling carries an explicit
 * `zIndex` from `LAYER` below. That is not decoration: five of the six layers
 * are absolutely positioned or transparent, so nothing but the `zIndex`
 * decides what covers what, and "the progress bar is under the transport" or
 * "the orbs are over the title" are exactly the failures a unit test on a
 * component in isolation cannot see — each of those components passes its own
 * suite while the assembled card is wrong on screen.
 *
 * The order is reconstructed from the design source, the only surviving copy
 * being `git show 20451d3:frontend/sample_frontend2/src/components/audio/ReelCard.tsx`
 * (that directory is gitignored; see `AmbientOrbs.tsx`'s header). Back to front
 * the source paints: the reel's own `linear-gradient(135deg, …)` background
 * (`:102-105`), the two blurred orbs and the dot grid (`:121-133`, the `else`
 * branch of the `cover_image` ternary), the play/pause overlay at `zIndex: 10`
 * (`:139`), the 40-bar decorative waveform at `bottom: 120, opacity: .15`
 * (`:170-186`), the glass metadata panel (`:196`), the seek bar at `bottom: 60`
 * (`:249-251`) and finally the right-hand action cluster (`:255-262`), which is
 * the card's last child and therefore on top of everything inside the visual
 * header.
 *
 * Two places where this file deliberately does NOT copy the source:
 *
 *  1. **The seek bar and the transport are ABOVE the overlay, not below it.**
 *     `PlayOverlay` is a full-bleed `Pressable` (`StyleSheet.absoluteFill`),
 *     so anything under it loses hit-testing to it. The source has the same
 *     shape and the same latent bug — its overlay is `zIndex: 10` and its seek
 *     bar has no `zIndex`, so in the browser the overlay's `<div>` sits over the
 *     scrubber. `PlayOverlay.tsx:86-90` states the constraint explicitly ("the
 *     action cluster and the seek bar must render above it, or this full-reel
 *     target will swallow their taps") and this file is the caller it means.
 *  2. **The waveform is BELOW the card's copy.** The brief's sketch listed it
 *     the other way round; the source paints the glass metadata panel after the
 *     0.15-opacity row, and letting decorative bars sit over the title is the
 *     part of that arrangement that is visible.
 *
 * `design/tokens.ts` HAS a `zIndex` group (`nav: 200, sheet: 800, toast: 5000,
 * onboarding: 7000, networkBanner: 8000`) and none of it is usable here: every
 * entry is app chrome, and card internals must not be able to climb into that
 * range. So the card-internal scale is declared here and exported, exactly as
 * `PlayOverlay` exports its own `OVERLAY_Z` for the same reason.
 */

/** Back to front. See the module docstring for the source each line is read from. */
export const LAYER = {
  /** The reel's own gradient, plus the orbs when there is no cover art. */
  backdrop: 0,
  /** The decorative 40-bar row. Under the copy, over the backdrop. */
  waveform: 1,
  /** Creator, title, category, duration, tags, and the terminal-state copy. */
  content: 2,
  /** `PlayOverlay`'s own `OVERLAY_Z` (10) — the source's `zIndex: 10`. */
  overlay: OVERLAY_Z,
  /** The bottom cluster. Above the overlay, or the controls are unreachable. */
  footer: 20,
  /** Timecode, ±10 s, hands-free. */
  transport: 21,
  /** The scrubber. Above the transport, per the brief's "not under" rule. */
  progress: 22,
  /** Reserved for the status layer; nothing is drawn above the footer today. */
  status: 30,
} as const;

/**
 * The clip's cover art, or `null` — and it is `null` in this MVP.
 *
 * OWNER DECISION (2026-09-30), for two independent reasons that are both still
 * true today:
 *
 *  - `feedClipSchema` (`src/api/schema.ts:99`) declares no `cover_image`, and a
 *    zod object strips the keys it does not declare — so the parsed `FeedClip`
 *    cannot carry one even though `FeedClipSerializer` does emit the key
 *    (`backend/app/serializers.py:655`).
 *  - that key is `None` on every row, and when it is populated it presigns
 *    against the container-internal MinIO endpoint
 *    (`serializers.py::_cover_image_url`, DEFECT B) — a Docker-network DNS name
 *    a device cannot resolve.
 *
 * THE CONDITIONAL IS KEPT. The source's whole layer order is built on the
 * `cover_image` ternary — the gradient, the orbs AND the dot grid all live in
 * its `else` branch (`:102-192`) — and a cover image is a later drop-in. The
 * condition is stated in exactly one place so that adding the field is a
 * one-line change here rather than a restructure of the card.
 *
 * Typed `string | null` rather than inferred, so the ternary keeps both
 * branches: a bare `const x = null` is narrowed to `null` at every use and the
 * cover-art branch would stop being type-checked.
 */
const MVP_COVER_ART: string | null = null;

/**
 * One full-bleed reel.
 *
 * The card root is a plain `View`. It must never become a `Pressable`: a
 * touch-capturing ancestor inside a `pagingEnabled` `FlatList` is the
 * "swallow the feed's scroll" defect, and the tap-to-toggle target is the
 * separate `PlayOverlay` layer below (which is what the design source did too —
 * `onClick` on the card's visual div, a click, not a touch-down claim).
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

  /**
   * ONE rule, read by both the identity line and the status layer.
   *
   * This is the precedence the card is built on — a terminal `cardStatus` wins
   * over `playback` — and it is consulted twice on purpose: the micro-label
   * falls back to the creator's name whenever there is something to report, so
   * the card never says "Now playing" above a copy that says it is not.
   */
  const report = cardStatusReport(cardStatus, playback);
  const isPlayingThisCard = active && playback === 'playing';

  /**
   * The waveform's pose, and the whole reason `WaveformBars` defaults
   * `state` to `'paused'`.
   *
   * A feed keeps several cards mounted (`initialNumToRender: 2`, `windowSize:
   * 3`), so a row that animated on every mounted cell would burn the UI thread
   * behind every offscreen reel. `state` gates the LOOP; `isActive` gates only
   * the per-bar opacity (the source's `isActive ? 0.6 : 0.3`, `:180`), which is
   * why the two are passed separately rather than folded into one flag.
   */
  const waveformState: WaveformState = isPlayingThisCard ? 'playing' : 'paused';

  return (
    <View testID="reel-card" style={[styles.reel, { height }]}>
      {/* LAYER 0 — the backdrop. `pointerEvents="none"`: it is decoration
          behind every tap target, and a plain full-bleed View is a hit target
          by default. `AmbientOrbs` sets the same prop on itself. */}
      <View
        testID="reel-layer-backdrop"
        style={[styles.layer, { zIndex: LAYER.backdrop }]}
        pointerEvents="none"
      >
        {MVP_COVER_ART ? (
          <Image
            testID="reel-cover-art"
            source={{ uri: MVP_COVER_ART }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
        ) : (
          <>
            {/* ReelCard.tsx:102-105 — the reel's own background when the clip has
                no cover art. `AmbientOrbs` deliberately does not draw this; its
                docstring hands the decision (and this gradient) to the caller. */}
            <LinearGradient
              testID="reel-backdrop"
              {...gradients.reelBackdrop(tint)}
              style={StyleSheet.absoluteFill}
            />
            <AmbientOrbs category={clip.category} />
          </>
        )}
      </View>

      {/* LAYER 1 — the decorative waveform. `WaveformBars` positions itself
          (`position: absolute`, `bottom: 120`) but carries no `zIndex`, so the
          wrapper is what puts it at layer 1; `pointerEvents="none"` says the
          same thing the component's own docstring does, that it is not a seek
          bar and must not answer a tap. */}
      <View
        testID="reel-layer-waveform"
        style={[styles.layer, { zIndex: LAYER.waveform }]}
        pointerEvents="none"
      >
        <WaveformBars
          clipId={clip.id}
          category={clip.category}
          isActive={active}
          state={waveformState}
        />
      </View>

      {/* LAYER 2 — the card's identity, and the terminal-state copy.
          Deliberately BELOW the overlay: the overlay is the tap target for the
          whole reel, and anything above it here would take taps away from
          play/pause. Nothing paints over this layer except the controls. */}
      <View testID="reel-layer-content" style={[styles.reelBody, { zIndex: LAYER.content }]}>
        <Text testID="reel-identity" style={typography.microLabel}>
          {isPlayingThisCard && report === null ? 'Now playing' : clip.creator_name}
        </Text>
        <Text testID="reel-title" style={[typography.page, styles.reelTitle]} numberOfLines={2}>
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

        {active && report ? <StatusView report={report} /> : null}
      </View>

      {/* LAYER 3 — the full-bleed play/pause target, at the source's own
          `zIndex: 10` (`PlayOverlay` sets it on the Pressable itself, so this
          layer needs no wrapper).

          ACTIVE REELS ONLY. Not a rendering economy: `canTogglePlayback`
          requires `playingClipId === clipId`, so a mounted neighbour could never
          act, and a `Pressable` that can never do anything is still a
          full-bleed hit target over the reel the user is actually on. */}
      {active ? <PlayOverlay clipId={clip.id} title={clip.title} /> : null}

      {/* LAYERS 4-6 — the bottom cluster: transport, then the scrubber last so
          it is the bottom row and the topmost of the three.

          ACTIVE REELS ONLY, and this one is a correctness fix rather than an
          economy. `SeekProgressBar` and `ClipTransport` read `currentTime`,
          `duration` and `playback` straight off the app-wide store
          (`SeekProgressBar.tsx:285-288`, `ClipTransport.tsx:210-216`), so a
          mounted neighbour would draw the LOADED clip's progress and timecode —
          two extra scrubbers showing a position that is not theirs. */}
      {active ? (
        <View
          testID="reel-layer-footer"
          style={[styles.footer, { zIndex: LAYER.footer }]}
          // `box-none`, not `auto`: the footer is a full-width column, and as a
          // plain target its empty space would eat the overlay's tap across the
          // whole band. Its interactive children stay live.
          pointerEvents="box-none"
        >
          <View
            testID="reel-layer-transport"
            style={[styles.footerSlot, { zIndex: LAYER.transport }]}
            pointerEvents="box-none"
          >
            <ClipTransport clipId={clip.id} title={clip.title} />
          </View>

          <View
            testID="reel-layer-progress"
            style={[styles.footerSlot, { zIndex: LAYER.progress }]}
            pointerEvents="box-none"
          >
            <SeekProgressBar clipId={clip.id} category={clip.category} title={clip.title} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * What the card's own status layer has to say, if anything.
 *
 * `{kind: 'spinner'}` is the settling case — a token being minted, or the native
 * player loading or buffering — which has chrome and no words, exactly as the
 * card always drew it.
 */
export type CardStatusReport = { kind: 'spinner' } | { kind: 'copy'; text: string };

/**
 * The ONE precedence rule for the card's own state.
 *
 * A terminal `cardStatus` wins over `playback`: a clip that is unavailable must
 * not also be reporting a spinner, and an errored clip must not keep claiming to
 * play. `playback` is what fills the gap the token lifecycle cannot — a native
 * media failure on a clip whose token minted fine, which was previously
 * reported as "Now playing" indefinitely because `replace()` does not throw.
 *
 * Exported so the precedence is assertable over the whole
 * `CardStatus` × `PlaybackState` matrix instead of through a handful of renders,
 * and so the identity line and the status layer cannot hold two different
 * opinions about whether something is being reported.
 */
export function cardStatusReport(
  cardStatus: CardStatus,
  playback: PlaybackState,
): CardStatusReport | null {
  if (cardStatus === 'minting' || playback === 'loading' || playback === 'buffering') {
    return { kind: 'spinner' };
  }
  if (cardStatus === 'processing') {
    return { kind: 'copy', text: 'Still processing — this clip is being encoded' };
  }
  if (cardStatus === 'unavailable') {
    // SECURITY: one message for BOTH 403 causes (unmoderated and
    // licence-restricted). Distinguishing them tells a caller holding only a
    // UUID something about moderation or licensing state.
    return { kind: 'copy', text: UNAVAILABLE_COPY };
  }
  if (cardStatus === 'gone') {
    // Same copy as `unavailable` on purpose: a 404 versus a 403 is a different
    // fact about the clip, and saying so tells a caller holding only a UUID
    // whether the row was deleted versus gated. The states stay distinct in the
    // store for retry logic; the copy does not distinguish them.
    return { kind: 'copy', text: UNAVAILABLE_COPY };
  }
  if (cardStatus === 'auth-required') {
    return { kind: 'copy', text: 'Sign in again to keep listening' };
  }
  if (cardStatus === 'error' || playback === 'error') {
    return { kind: 'copy', text: 'Could not play this clip' };
  }
  return null;
}

/** One string, because `unavailable` and `gone` must not be distinguishable. */
const UNAVAILABLE_COPY = 'This clip is no longer available';

function StatusView({ report }: { report: CardStatusReport }) {
  if (report.kind === 'spinner') {
    return (
      <View testID="reel-status" style={styles.statusBox}>
        <Spinner />
      </View>
    );
  }
  return (
    <View testID="reel-status" style={styles.statusBox}>
      <Text style={typography.label}>{report.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // `flex: 1` is kept only as a fallback for a zero-height prop; the explicit
  // `height` from the measured viewport is what actually sizes the cell. See
  // the `viewport` docstring for why this cannot be left to the layout engine.
  reel: { flex: 1, justifyContent: 'flex-end' },
  // RN 0.86 exposes `absoluteFill` only; `absoluteFillObject` is gone.
  layer: { ...StyleSheet.absoluteFill },
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
  // In flow, not absolute: the footer's height is whatever `ClipTransport` and
  // `SeekProgressBar` actually measure (a 44 px bar inside a 4 px track, a
  // column whose height comes from three children and two gaps), and a
  // hard-coded bottom offset would have to be re-tuned whenever either changes.
  footer: { gap: spacing.gutter },
  /**
   * Full width, stated rather than inherited. A column flex container stretches
   * its children by default, so this is the default — but the scrubber being a
   * full-width target is a design value (the source's
   * `position:absolute; left:0; right:0; padding: 0 14px`, `:249-251`), and a
   * later `alignItems` on the footer must not be able to narrow it.
   */
  footerSlot: { alignSelf: 'stretch' },
});
