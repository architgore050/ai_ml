import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Headphones, RotateCcw, RotateCw } from 'lucide-react-native';

import { accent, border, content, glass, radius, type as typeScale } from '../../design/tokens';
import { glow } from '../../design/shadows';
import { typography } from '../../design/typography';
import { MIN_TOUCH_TARGET, hitSlop, onAccent, touchableStyle } from '../ui/primitives';
import { formatTime } from '../../lib/formatTime';
import { SKIP_SECONDS } from '../../lib/skipSeconds';
import { skipBy, usePlayerStore, type CardStatus, type PlaybackState } from '../../store/player';

/**
 * The reel's transport: timecode, the ±10 s skip pair, and the hands-free toggle.
 *
 * ## THE STEP AND THE FORMATTER ARE BOTH IMPORTED, NOT DECLARED HERE
 * Two numbers used to live in this file and had to be pulled out because a
 * sibling control on the same reel needs the identical value or the reel
 * contradicts itself on screen:
 *  - `SKIP_SECONDS` — the ±10 s the buttons seek by, and the same step
 *    `SeekProgressBar` hands VoiceOver's increment/decrement (both go through
 *    the store's one `skipBy`). It is `lib/skipSeconds.ts`.
 *  - `formatTime` — the `m:ss` spelling of the timecode, which is also what the
 *    seek bar puts in its `accessibilityValue.text`. It is `lib/formatTime.ts`,
 *    and that file is inside `collectCoverageFrom`; a formatter declared here
 *    would be measured logic with no measurement.
 * Re-declaring either of them locally is the regression these files exist to
 * prevent, not a simplification.
 *
 * ## STATE COMES FROM THE STORE, NOT FROM PROPS
 * `SeekProgressBar` — the sibling that owns the scrubber this control sits
 * under — reads `usePlayerStore` directly (`SeekProgressBar.tsx:299-302`) rather
 * than taking `currentTime` / `duration` / `playback` as props, and that is the
 * convention this follows. It is the right one here for a reason that is not
 * about style: `cardStatus` and `playback` are written by TWO different
 * producers (`store/player.ts` §`CardStatus`), and a prop chain means every
 * caller has to thread both of them plus `playingClipId` correctly. One way of
 * getting playback state means the reel cannot hold two different answers to
 * "what is the player doing", and a control that disagrees with the bar directly
 * above it is exactly the class of bug this redesign is removing.
 *
 * `clipId` IS a prop, and `title` is, because those are facts about the CARD
 * rather than about the player — the same card identity `SeekProgressBar` takes.
 *
 * ## Provenance
 * `git show 20451d3:frontend/sample_frontend2/src/components/audio/ReelCard.tsx`
 * — the only surviving copy of that directory:
 *
 *   ReelCard.tsx:299   the skip column — `flexDirection: 'column',
 *                      alignItems: 'center', gap: 16, marginTop: 8`
 *   ReelCard.tsx:301   forward button — `width/height: 40,
 *                      borderRadius: var(--radius-full)`,
 *                      `border: 1px solid rgba(255,255,255,0.2)`,
 *                      `background: var(--surface-overlay)`, `<SkipForward size={16}/>`
 *   ReelCard.tsx:309   back button — the same box, `<SkipBack size={16}/>`
 *
 * The hands-free control is NOT in that file. The only surviving implementation
 * is in the older tree, `frontend/src/components/common/Header.tsx:87-100`:
 * a pill, `px-3 py-1.5 rounded-lg text-[11px] uppercase tracking-wider`, a
 * `Headphones` glyph at 14 px, the words "Hands-Free", and a 6 px dot that
 * appears only while the mode is on. Both are the ON/OFF visual states.
 *
 * ## THREE SOURCE DEFECTS FIXED RATHER THAN PORTED
 *
 *  1. **The icons were semantically wrong.** `SkipForward` / `SkipBack` are
 *     "go to the next/previous ITEM". These buttons move 10 SECONDS WITHIN the
 *     current clip, which is rewind/advance — `RotateCcw` / `RotateCw`. The
 *     distinction is not pedantry: a skip-to-item glyph next to a reel that
 *     pages vertically tells the reader this changes the reel, and it does not.
 *     (Verified present in the installed `lucide-react-native@1.48.0`:
 *     `dist/cjs/lucide-react-native.js:6380` and `:6392` export `RotateCcw` and
 *     `RotateCw`; the source's `SkipBack`/`SkipForward` also exist and are
 *     deliberately not used.)
 *
 *  2. **The skip buttons were 40 × 40, below both platform floors.** 40 fails
 *     44 pt (iOS) and 48 dp (Android) — `tokens.accessibility`, re-exported as
 *     `MIN_TOUCH_TARGET`. The GEOMETRY is kept at 40 (it is a tracked design
 *     value and the column is composed around it) and the TARGET is a separate,
 *     floor-sized box with the 40 px circle centred inside it — the same
 *     two-box resolution `SeekProgressBar` uses for its 4 px track, and for the
 *     same reason: the visual and the hit rect cannot be the same element when
 *     one is 8 px and the other 44. The cost is stated, not hidden — the row
 *     claims 44-48 dp of the reel's height, and that is what the floor costs.
 *
 *  3. **The `title` attribute was the only affordance name.** The source's
 *     `title="Skip forward 10s"` is a browser tooltip: it is invisible to
 *     VoiceOver and TalkBack, invisible to anyone using a keyboard or switch
 *     control, and invisible on a phone. Every control here carries a real
 *     `accessibilityRole` + `accessibilityLabel`, and the toggle carries
 *     `accessibilityState.checked`.
 *
 * ## A SOURCE BEHAVIOUR DELIBERATELY NOT PORTED
 * Both source buttons call `interactionsAPI.registerSkip(...)` on press
 * (`ReelCard.tsx:300,308`). Registering a "skip" for a +10 s ADVANCE is wrong —
 * a skip is leaving audio unheard, and the recommender reads that as a skip
 * (`pacing.completionThreshold`, plan §13). It is also telemetry wiring, which
 * belongs to the feed's analytics layer rather than to a transport. So there is
 * no `onSkip` prop here: a seam with no caller is exactly the ceremonial
 * abstraction this repo's other refactors removed. Raised in the hand-off
 * report rather than silently dropped.
 */

/**
 * ReelCard.tsx:301/309 — `width: 40, height: 40`.
 *
 * The VISUAL. The touch target is `MIN_TOUCH_TARGET`; see the two-box note in
 * the module docstring.
 */
export const SKIP_BUTTON_SIZE = 40;

/** ReelCard.tsx:301/309 — `<SkipForward size={16} />`. */
export const SKIP_ICON_SIZE = 16;

/** Header.tsx:92 — `Headphones className="w-3.5 h-3.5"`. */
export const TOGGLE_ICON_SIZE = 14;

/**
 * Card states in which there is no servable media, so a skip control would be a
 * button that looks live and does nothing.
 *
 * `processing` is the motivating one from the brief: a still-encoding clip has
 * no source loaded and no duration reported, so the control would sit in a
 * fully-lit state on a clip that will never answer. `unavailable` and `gone` are
 * the two 403/404 arms (`unavailable` deliberately collapses two 403 causes —
 * see `store/player.ts` §`PlaybackStatus`), `auth-required` is a dead session,
 * and `error` is a failed mint.
 *
 * Exported so a test can iterate the SET rather than trust that five
 * hand-written cases happen to cover it.
 */
export const TERMINAL_CARD_STATUSES = [
  'processing',
  'unavailable',
  'gone',
  'auth-required',
  'error',
] as const satisfies readonly CardStatus[];

/**
 * The complement, stated rather than left to `!TERMINAL.includes(status)`, so
 * that ADDING a card status fails a test instead of silently becoming servable.
 */
export const SERVED_CARD_STATUSES = ['idle', 'minting'] as const satisfies readonly CardStatus[];

/** The store facts the skip gate reads. Named so the shape is not re-declared. */
export type SkipGateInput = {
  cardStatus: CardStatus;
  playback: PlaybackState;
  /** expo-audio SECONDS. `0` means the source has not reported a length. */
  duration: number;
  /** The clip NATIVE has loaded, which is not always the requested one. */
  playingClipId: string | null;
  /** The clip this transport belongs to. */
  clipId: string;
};

/**
 * Whether the skip pair may seek. Exported so the rule can be tested over the
 * whole state space rather than through a handful of renders, and so the
 * component has exactly ONE place that decides it.
 *
 * Four independent reasons to refuse:
 *
 *  - **The card is terminal.** `processing`, `unavailable`, `gone`,
 *    `auth-required`, `error` — see `TERMINAL_CARD_STATUSES`. A skip control on
 *    a still-encoding clip is a button that looks live and does nothing, which
 *    is worse than no button.
 *  - **Nothing is loaded.** `duration > 0` is `clampSeekTime`'s OWN predicate
 *    for "there is something to seek within", deliberately re-used rather than
 *    re-derived. If this and the store's refusal used two different notions of
 *    "loaded" they would drift, and the drift is a seek on an idle player —
 *    which on Android is STORED by ExoPlayer and applied to the NEXT clip
 *    (`Playable.kt:31`). Not padding: the same reason `clampSeekTime` returns
 *    `null` rather than 0.
 *  - **A different clip is loaded.** A reel under momentum scroll can have a
 *    neighbour mounted, and a transport that seeks on behalf of the clip the
 *    player is NOT playing is a live bug. This is the identity half of what
 *    `SeekProgressBar.stillCurrent` checks at gesture commit, checked at render
 *    instead because a button press has no "start" to capture it at.
 *  - **The native player errored.** A media failure leaves nothing to seek
 *    within, and `ReelCard.CardStatusView` already renders it as a failure.
 *
 * `playback === 'ended'` is deliberately NOT a refusal. `ended` is LATCHED for
 * as long as the clip is loaded (`store/player.ts` §`endedForClipId`), so a veto
 * keyed on it would leave the transport permanently dead on every clip that ran
 * to the end — which is exactly when a user most wants to hear the last ten
 * seconds again. `SeekProgressBar` refuses an `ended` veto for the same reason
 * (`SeekProgressBar.tsx:376-381`).
 */
export function canSkipClip(input: SkipGateInput): boolean {
  const servable = (SERVED_CARD_STATUSES as readonly CardStatus[]).includes(input.cardStatus);
  const loaded = input.duration > 0;
  const mine = input.playingClipId === input.clipId;
  return servable && loaded && mine && input.playback !== 'error';
}

export type ClipTransportProps = {
  /**
   * The clip this transport belongs to. Used for the accessibility labels and,
   * more importantly, to check that the store's loaded clip is the SAME clip —
   * a reel under momentum scroll can have a neighbour mounted, and a transport
   * that seeks on behalf of a clip the player is not playing is a live bug.
   */
  clipId: string;
  /** Clip title, for the skip buttons' labels. */
  title?: string;
};

export function ClipTransport({ clipId, title }: ClipTransportProps) {
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const playback = usePlayerStore((s) => s.playback);
  const cardStatus = usePlayerStore((s) => s.cardStatus);
  const handsFree = usePlayerStore((s) => s.handsFree);
  const playingClipId = usePlayerStore((s) => s.playingClipId);
  const toggleHandsFree = usePlayerStore((s) => s.toggleHandsFree);

  /**
   * Whether there is a servable clip to move within — one call to
   * `canSkipClip`, whose docstring is the argument for each of the four reasons
   * it can refuse. Read fresh from the store on every tick.
   */
  const loaded = duration > 0;
  const canSkip = canSkipClip({ cardStatus, playback, duration, playingClipId, clipId });

  /**
   * The timecode.
   *
   * ## `ended` is LATCHED, and the timecode must not care
   * `playback === 'ended'` is latched by the store in `endedForClipId` for as
   * long as the clip stays loaded (`store/player.ts` §`endedForClipId`),
   * because `didJustFinish` is a ONE-TICK pulse on both native platforms and an
   * un-latched store would report `ended` for 500 ms and then fall back to
   * `paused`.
   *
   * So any rule keyed on `ended` here would be a rule with a LIFETIME: it would
   * hold until the user swipes. The only robust answer is the one that needs no
   * state at all — render the store's `currentTime` — which is why there is no
   * `ended` branch here. At completion the native player reports
   * `currentTime ≈ duration`, so a finished clip reads `duration / duration`,
   * and that is both true and what the generic rule already produces.
   *
   * The two rules that WERE available and are rejected:
   *  - `ended ? ZERO : currentTime` is the old app's spelling
   *    (`frontend/src/components/feed/ReelCard.tsx:263-264`,
   *    `isThisPlaying ? formatTime(progress) : '0:00'`). It shows a clip that
   *    played all the way through as never started, and it is wrong on a clip
   *    that ends while PAUSED too.
   *  - `ended ? duration : currentTime` is a lie in the other direction: it
   *    reports the end position for a clip that was abandoned near the start
   *    and then latched.
   *
   * The TOTAL is omitted until the source reports a duration, rather than
   * rendered as `0:00` — `3.4 / 0:00` is a worse sentence than `0:03`, and
   * `duration === 0` is the normal pre-load state on both platforms
   * (`store/player.ts` §UNITS, and `SeekProgressBar`'s fact 1).
   */
  const position = formatTime(currentTime);
  const total = formatTime(duration);
  const timecode = loaded ? `${position} / ${total}` : position;
  // The spoken form matches `SeekProgressBar`'s `accessibilityValue.text`
  // ("0:12 of 1:00") so the timecode and the scrubber are read the same way.
  // It cannot drift, because that bar builds its string from this SAME
  // `formatTime` — one rule, two consumers, rather than two copies that agree
  // until someone edits one of them.
  const timecodeSpoken = loaded ? `${position} of ${total}` : position;

  /**
   * Both skips go through `skipBy`, never `seekToSeconds`.
   *
   * `skipBy` reads the store live, clamps through `clampSeekTime` — the ONE
   * place the seek bounds live — and returns `null` rather than seeking to 0
   * when there is nothing loaded. This component adds no bounds of its own and
   * re-derives no clamping; it supplies a signed delta and gets a refusal back.
   *
   * It also does NOT write `currentTime` optimistically. A seek emits a status
   * update on all three platforms (`ios/AudioPlayer.swift:189-194`,
   * `BaseAudioPlayer.kt:119-121`), so the store corrects itself within one
   * `updateInterval`. An optimistic write would be a second source of truth
   * that can disagree with native — and the disagreement would be visible as the
   * timecode jumping back to the pre-skip value.
   *
   * The `canSkip` guard in the handlers is NOT a second definition of the same
   * predicate — it is the SAME value, read from the SAME call. `disabled` on a
   * `Pressable` is enforced at the responder boundary; the guard is what makes
   * the refusal hold if a press ever reaches the handler anyway. Because both
   * come from one `canSkipClip(...)` result, they cannot drift, and the test
   * asserts that agreement over the whole `cardStatus` × `playback` matrix
   * rather than trusting it.
   */
  const onRewind = useCallback(() => {
    if (!canSkip) return;
    skipBy(-SKIP_SECONDS);
  }, [canSkip]);

  const onAdvance = useCallback(() => {
    if (!canSkip) return;
    skipBy(SKIP_SECONDS);
  }, [canSkip]);

  /**
   * Hands-free is a MODE, not a control on this clip, so it is never disabled.
   *
   * The argument for the other side: consistency with the skip pair, which is
   * disabled whenever the clip is unservable. Against it, and decisively: hands-
   * free ON is the mechanism that moves the user OFF the unservable clip, and
   * the state most likely to be unservable is `processing` — a reel full of
   * clips still encoding is exactly the case where a user reaches for the
   * toggle. Disabling it there removes the only control that helps.
   *
   * It is also a preference for the whole feed, not an affordance for the audio
   * on screen, so there is nothing about the current clip it could be wrong
   * about.
   *
   * AUTO-ADVANCE IS NOT IMPLEMENTED HERE, and that is deliberate rather than an
   * omission. The contract, for whoever wires it (plan §13 PACING, and
   * `tokens.pacing`): advance when `progress >= 0.99`, wait
   * `pacing.interReelPause` (1000 ms), then move on. That needs to observe the
   * `ended` latch and drive the momentum scroll's next index, which is app
   * wiring above this component, not a control. This file is the CONTROL only.
   */
  const onToggleHandsFree = useCallback(() => {
    toggleHandsFree();
  }, [toggleHandsFree]);

  // Header.tsx:96 `title="Toggle Hands-Free Continuous Playback"`. The checked
  // state is NOT folded into the label: `accessibilityState.checked` is announced
  // by the platform, and a label that repeated it would be read twice.
  const inClip = title ? ` in ${title}` : '';

  return (
    // `box-none` on THIS view, and it has to be here rather than on a wrapper.
    //
    // THE BOX THIS FIXES. `column` has no width, and every ancestor of it is a
    // plain column flex container — `reel-layer-transport` is
    // `footerSlot: {alignSelf: 'stretch'}` (`ReelCard.tsx:401`) inside
    // `reel-layer-footer` (`gap`, also a column) inside `reel-card` — so the
    // default `alignItems: 'stretch'` makes this column FULL BLEED. It is not
    // sized to its contents: the three controls are `alignItems: 'center'`ed
    // inside a box that spans the whole reel. Its height is `marginTop: 8` +
    // the timecode line + two 16 px gaps + two 44 px targets, so roughly 140 px
    // of full-width band across the bottom of the reel.
    //
    // And it mounts ABOVE the play/pause target: `ReelCard`'s `LAYER` puts this
    // at `transport: 21` and `PlayOverlay`'s full-bleed `Pressable` at
    // `overlay: OVERLAY_Z` = 10 (`ReelCard.tsx:66-83`). With no `pointerEvents`
    // prop the container is `AUTO`, i.e. it IS the hit test wherever the point
    // lands, so the 16 px gaps, the margins, and the whole width beside the
    // centred controls swallowed taps meant for play/pause and produced NOTHING.
    // Nothing could rescue them: `PlayOverlay` is a SIBLING of this column's
    // wrapper, so the platform's walk from the hit view to the nearest JS
    // responder never reaches it.
    //
    // WHY A WRAPPER CANNOT DO IT. A parent's `pointerEvents` removes only the
    // PARENT from the hit test; both implementations still descend into this
    // view and accept it as the hit view. iOS `betterHitTest` walks
    // `currentContainerView.subviews` in `reverseObjectEnumerator`
    // (`RCTViewComponentView.mm:762` — zIndex order) and returns the first hit,
    // so the footer's own `box-none` (`ReelCard.tsx:275`) is consulted, returns
    // this view, and passes it up. Android's DFS does the same, preferring CHILD
    // and iterating children topmost-first (`TouchTargetHelper.kt`). So the
    // component has to make ITSELF transparent; the caller cannot.
    //
    // WHAT `box-none` IS, from the installed source rather than from memory.
    // iOS, `RCTViewComponentView.mm:772-785`:
    //   `case PointerEventsMode::BoxNone:` runs `betterHitTest` and then
    //   `return view != self ? view : nil` — the deepest descendant wins, and if
    //   the only thing that would have hit is the container itself the answer is
    //   `nil`, which lets the search continue to whatever is behind. Android
    //   agrees: `TouchTargetHelper.kt:363-365`, `PointerEvents.BOX_NONE ->
    //   findTouchTargetView(eventCoords, view, EnumSet.of(CHILD))` — SELF is not
    //   even offered, and a null result returns to the parent's search.
    //
    // The other three values would each be a different bug:
    //  - `none` returns `nil` for the whole subtree (`RCTViewComponentView.mm:777`
    //    / `TouchTargetHelper.kt:347-349`, "This view and its children can't be
    //    the target"), which would kill the three controls this file exists for.
    //  - `box-only` offers SELF and never descends (`:779-780` /
    //    `EnumSet.of(SELF)`), so the container becomes the target and the
    //    controls below it become unreachable.
    //  - `auto` (i.e. no prop) is the dead zone above.
    // Exactly one of the four values keeps the children live while letting the
    // empty space through, which is why this is asserted rather than assumed.
    <View testID="clip-transport" style={styles.column} pointerEvents="box-none">
      {/*
        WaveformBar.tsx:57-60 — `fontSize: 11`, `color: var(--outline)`,
        `fontVariantNumeric: 'tabular-nums'`, `letterSpacing: '0.03em'`, and the
        text is `${formatTime(duration * progress)} / ${formatTime(duration)}`.
        The tabbed figures are load-bearing, not a nicety: a proportional-digit
        timecode changes width every time the seconds digit changes, so the two
        halves of the string jitter apart twice a second. RN spells
        `fontVariantNumeric` as `fontVariant`.
      */}
      <Text
        testID="clip-transport-timecode"
        accessible
        accessibilityRole="text"
        accessibilityLabel={timecodeSpoken}
        style={styles.timecode}
      >
        {timecode}
      </Text>

      {/* ReelCard.tsx:299 — the column, `gap: 16`, advance above rewind. */}
      <View style={styles.skipRow}>
        <SkipButton
          testID="clip-transport-advance"
          label={`Advance ${SKIP_SECONDS} seconds${inClip}`}
          disabled={!canSkip}
          onPress={onAdvance}
        >
          {/* No `testID` here: `react-native-svg` does not forward it to the
              native view (`Icon.mjs` puts it on `Svg`, and the host element that
              renders is `RNSVGSvgView` with no testID), so it would be a prop
              that looks addressable and is not. The glyph is asserted by its
              path data instead — which is a stronger claim anyway, since it is
              the actual shape rather than the name of the component. */}
          <RotateCw size={SKIP_ICON_SIZE} color={content.primary} />
        </SkipButton>

        <SkipButton
          testID="clip-transport-rewind"
          label={`Rewind ${SKIP_SECONDS} seconds${inClip}`}
          disabled={!canSkip}
          onPress={onRewind}
        >
          <RotateCcw size={SKIP_ICON_SIZE} color={content.primary} />
        </SkipButton>
      </View>

      {/*
        Header.tsx:87-100. The pill is the visual; the floor-sized box around it
        is the target, for the same two-box reason as the skip buttons — a 28 px
        pill (11 px text + `py-1.5`) fails 44 pt and 48 dp outright.
      */}
      <Pressable
        testID="clip-transport-hands-free"
        accessibilityRole="switch"
        accessibilityLabel="Hands-free auto-advance"
        accessibilityHint="Clips move on by themselves once they finish"
        accessibilityState={{ checked: handsFree }}
        onPress={onToggleHandsFree}
        hitSlop={hitSlop}
        style={({ pressed }) => [
          touchableStyle(styles.toggleTarget),
          pressed && styles.togglePressed,
        ]}
      >
        <View
          testID="clip-transport-hands-free-pill"
          style={[styles.togglePill, handsFree ? styles.togglePillOn : styles.togglePillOff]}
        >
          <Headphones size={TOGGLE_ICON_SIZE} color={handsFree ? onAccent : content.tertiary} />
          <Text style={[styles.toggleLabel, { color: handsFree ? onAccent : content.tertiary }]}>
            Hands-Free
          </Text>
          {/* Header.tsx:100 — the 6 px dot, present only while the mode is on.
              On it, `onAccent` (`primitives.ts:56`), because the source's
              `bg-black` was the foreground token for the pill's own orange and
              the pill here is `accent.base`. */}
          {handsFree ? <View testID="clip-transport-hands-free-dot" style={styles.toggleDot} /> : null}
        </View>
      </Pressable>
    </View>
  );
}

/**
 * One skip button: the floor-sized TARGET wrapping the source's 40 px circle.
 *
 * The direction lives in the CALLER's handler, not in a prop here, so the two
 * buttons cannot disagree about which glyph means which direction: the source's
 * bug is exactly that kind of disagreement (`SkipForward` and `SkipBack` are
 * item-navigation glyphs being used for intra-clip seeks), and passing `delta`
 * down as data would leave the same two facts to keep in step as passing it
 * through a closure.
 */
function SkipButton({
  testID,
  label,
  disabled,
  onPress,
  children,
}: {
  testID: string;
  label: string;
  disabled: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      // `touchableStyle` is the floor (minWidth/minHeight MIN_TOUCH_TARGET,
      // centred); the circle is a CHILD, so the layout box is the target and
      // the 40 px visual sits inside it.
      style={({ pressed }) => [
        touchableStyle(styles.skipTarget),
        pressed && styles.skipPressed,
        disabled && styles.skipDisabled,
      ]}
    >
      {/*
        `pointerEvents: none` — the parent is the only hit target. A child that
        answered touches would compete for the responder on a control that is
        exactly the floor size, so the 40 px circle would be a second, smaller
        hit rect in the middle of the target it is supposed to be sitting in.
      */}
      <View pointerEvents="none" style={styles.skipCircle}>
        {children}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /** ReelCard.tsx:299 — `gap: 16`, `marginTop: 8`. */
  column: { alignItems: 'center', gap: 16, marginTop: 8 },
  /**
   * WaveformBar.tsx:57-60. `--outline` is `content.tertiary`; `11px` is
   * `type.label`; the `0.03em` and the tabbed figures are quoted above and are
   * the reason this does not use `typography.count` (10 px, 600, no
   * `fontVariant`).
   */
  timecode: {
    ...typography.microLabel,
    fontSize: typeScale.label,
    color: content.tertiary,
    letterSpacing: 0.03,
    fontVariant: ['tabular-nums'],
  },
  skipRow: { alignItems: 'center', gap: 16 },
  /**
   * The TARGET. `touchableStyle` supplies the floor (minWidth/minHeight
   * MIN_TOUCH_TARGET, centred); this adds the flex direction so the circle and
   * the pill contents sit on one line. Nothing is painted here.
   */
  skipTarget: { flexDirection: 'row' },
  /**
   * ReelCard.tsx:301-305 — `width/height: 40`, `borderRadius: var(--radius-full)`,
   * `background: var(--surface-overlay)` (= `glass.background`, globals.css:60),
   * `border: 1px solid rgba(255,255,255,0.2)`.
   *
   * THE BORDER COLOUR IS THE ONE PLACE THIS DEPARTS FROM THE LITERAL. The
   * source's `rgba(255,255,255,0.2)` is a raw white alpha; the token for a
   * hairline on a glass surface is `border.default` (`--outline-variant`,
   * globals.css:73), which is what `uiStyles.glass` uses for the same kind of
   * panel. Tokens are the contract (plan §16), so the token wins.
   */
  skipCircle: {
    width: SKIP_BUTTON_SIZE,
    height: SKIP_BUTTON_SIZE,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: border.default,
    backgroundColor: glass.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** plan §13 "active:scale-0.96 press states". */
  skipPressed: { opacity: 0.7, transform: [{ scale: 0.96 }] },
  /** `uiStyles.buttonDisabled` — the house 0.4 for an unavailable control. */
  skipDisabled: { opacity: 0.4 },
  /** The floor for a 28 px pill. Centred, so the pill is the visual inside it. */
  toggleTarget: { flexDirection: 'row' },
  togglePressed: { opacity: 0.7, transform: [{ scale: 0.96 }] },
  /** Header.tsx:88-95 — `px-3 py-1.5 rounded-lg`. */
  togglePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  /**
   * ON: `bg-[#FF6321] text-black border-[#FF6321] shadow-[0 0 15px …]`.
   * `#FF6321` is the OLD app's orange, which `tokens.ts` explicitly rejects as
   * not part of this design system; the equivalent token is `accent.base`
   * (`--terracotta`, globals.css:63), and the foreground that reads on it is
   * `onAccent` (`primitives.ts:56`, the `--on-primary` role).
   *
   * The glow's 15 px is not in plan §13's `0 0 {6,8,12,16,20,24,32}px` scale, so
   * it lands on the adjacent tracked step, 16. `glow()` returns `{}` on Android
   * — that module's documented degradation — so the ON state is legible on both
   * platforms from the fill and the dot, not from the shadow.
   */
  togglePillOn: { backgroundColor: accent.base, borderColor: accent.base, ...glow(16) },
  /** OFF: `bg-white/5 text-white/60 border-white/10`. */
  togglePillOff: { backgroundColor: 'rgba(255,255,255,0.05)', borderColor: border.default },
  /** Header.tsx:90 — `text-[11px] font-mono font-bold uppercase tracking-wider`. */
  toggleLabel: {
    ...typography.microLabel,
    fontSize: typeScale.label,
  },
  /** Header.tsx:100 — `w-1.5 h-1.5 rounded-full bg-black`. */
  toggleDot: {
    width: 6,
    height: 6,
    borderRadius: radius.full,
    backgroundColor: onAccent,
  },
});
