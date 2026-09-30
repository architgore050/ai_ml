import type { CardStatus, PlaybackState } from '../store/player';

/**
 * When the play/pause overlay is on screen, as a pure state machine.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT IN THE COMPONENT
 * ---------------------------------------------------------------------------
 * The overlay is a *status* affordance with a timer attached, and the timer is
 * where the bugs live:
 *
 *  - The design source (`ReelCard.tsx:135-163`, the only surviving copy — see
 *    `git show 20451d3:frontend/sample_frontend2/src/components/audio/ReelCard.tsx`)
 *    sets a `showPlayIcon` flag and clears it with a bare
 *    `setTimeout(() => setShowPlayIcon(false), 600)`. That timer is NEVER
 *    cleared: swipe the reel away inside the window and the timeout still fires,
 *    writing state into a card that is gone. On a fast scroll that is one
 *    setState per abandoned tap, and React 18 no longer warns about it, so it
 *    fails silently and forever.
 *  - A second tap inside the window does not restart that timer (the source
 *    sets a NEW one and drops the handle to the old one, so the FIRST deadline
 *    is what actually hides the overlay — the 600 ms the user sees after the
 *    second tap is however much was left of the first one). That is a race with
 *    no owner.
 *
 * Both are properties of a *decision over time*, not of React, so they live
 * here as a reducer plus one pure selector, and the component does nothing but
 * schedule a `setTimeout` whose deadline the machine hands it. Every timing rule
 * below is testable with injected `now` values — no fake timers, no renderer.
 *
 * The component still needs a real timer, and that timer is the one thing the
 * machine cannot own, so the contract is explicit: the machine NEVER holds a
 * handle, and `autoHideAt` is an ABSOLUTE deadline rather than a remaining
 * count. A remaining count recomputed on every render would re-arm the effect
 * that schedules it, and the overlay would never hide at all — the timer would
 * be restarted by its own deadline approaching. See `autoHideDelayMs`.
 */

/** The source's 600 ms (`ReelCard.tsx:140`). */
export const OVERLAY_AUTO_HIDE_MS = 600;

/**
 * The `CardStatus` values that mean "this clip cannot be played, and retrying
 * will not change that".
 *
 * `idle` and `minting` are deliberately NOT here: both are settling states
 * (`decidePlaybackAction` maps a minting token to `show: 'idle'`, which the feed
 * screen turns back into `'minting'`), and a tap during one is a legitimate
 * "play this" intent.
 *
 * The membership is the same set `lib/playbackDecision.ts` reports through its
 * `show` arm. It is restated here rather than imported because that module
 * exposes a DECISION (given a token, what should the player do), not a set of
 * states, and it is reached from here over a different question (given the
 * states, may a tap act). See the note on `playbackDecision` in
 * `PlayOverlay.tsx` for why reusing it is not a fit.
 */
export const TERMINAL_CARD_STATUSES: ReadonlySet<CardStatus> = new Set<CardStatus>([
  'processing',
  'unavailable',
  'gone',
  'auth-required',
  'error',
]);

/** Which glyph the circle draws. Derived from the REAL player state, never latched. */
export type OverlayIcon = 'bars' | 'triangle';

/**
 * The machine. Clip-scoped BY CONSTRUCTION.
 *
 * Every field is about ONE clip, and `{ type: 'clip' }` is the only way to
 * leave it — and that event clears both fields. So a pending hide cannot outlive
 * the reel that armed it, which is the "a tap must not hide the NEXT clip's
 * overlay" rule without any cross-clip bookkeeping.
 */
export type PlayOverlayState = {
  /** The clip this state describes. A tap never changes it. */
  clipId: string;
  /**
   * Absolute `now` at which the interaction window closes, or null.
   *
   * Only set by a tap that left the clip PLAYING — see the `tap` reducer.
   */
  hideAt: number | null;
  /**
   * True when the last tap left this clip PAUSED, and it is still paused.
   *
   * NOT "the user paused at some point": `playOverlayVisibility` conjoins it
   * with the live `playback` before it will show anything, so a clip that starts
   * playing again for any other reason (a reload, a native resume) cannot be
   * left wearing a paused affordance.
   */
  pausedLatched: boolean;
};

export type PlayOverlayEvent =
  /**
   * A tap that WAS acted on. `outcome` is the state the tap produced, not the
   * state it found — the component decides it from the store before dispatching,
   * so the machine never has to know the store's rules.
   */
  | { type: 'tap'; now: number; outcome: 'playing' | 'paused' }
  /** The deadline in `hideAt` has passed. */
  | { type: 'window-elapsed' }
  /** This machine now describes a different clip. Clears everything. */
  | { type: 'clip'; clipId: string };

/** A machine for `clipId`, with nothing pending and nothing latched. */
export function initialPlayOverlay(clipId: string): PlayOverlayState {
  return { clipId, hideAt: null, pausedLatched: false };
}

/**
 * Advance the machine. Pure; the same (state, event) always gives the same
 * state, and `state` is never mutated.
 */
export function playOverlayReducer(
  state: PlayOverlayState,
  event: PlayOverlayEvent,
): PlayOverlayState {
  switch (event.type) {
    case 'tap':
      // The two arms are MUTUALLY EXCLUSIVE by construction, and that is the
      // whole point of putting the decision here rather than in a boolean.
      //
      //  - ended PLAYING: the bars are an acknowledgement, not a control. A
      //    100 px blurred disc sitting over the artwork of every playing reel
      //    would be a permanent tax, so it says "yes, that started" and gets out
      //    of the way.
      //  - ended PAUSED: the triangle is the ONLY "how do I get this back"
      //    affordance on a reel — there is no transport bar in the centre of the
      //    card — so it stays until the next tap resumes it or the clip changes.
      //
      // Because a pause tap arms no deadline, `autoHideAt` is never a timer that
      // provably cannot change the output. (See the module docstring on why a
      // ceremonial timer is worse than none.)
      return event.outcome === 'paused'
        ? { ...state, hideAt: null, pausedLatched: true }
        : { ...state, hideAt: event.now + OVERLAY_AUTO_HIDE_MS, pausedLatched: false };

    case 'window-elapsed':
      // The latch is NOT cleared here: a latched machine has no deadline, so
      // this event cannot reach one. Spelling that out beats relying on it.
      return state.hideAt === null ? state : { ...state, hideAt: null };

    case 'clip':
      return state.clipId === event.clipId ? state : initialPlayOverlay(event.clipId);

    default:
      return state;
  }
}

/**
 * May a tap on this reel act on playback at all?
 *
 * Three independent refusals, each for a different reason:
 *
 *  1. **A terminal card state.** The backend has already refused (403), 404'd,
 *     asked for a login, or said the clip is still encoding. There is nothing
 *     loaded to pause and nothing to resume, so a tap must be a no-op rather
 *     than an optimistic claim. This is the rule the store's own docstring asks
 *     for: do not write `playing` for a clip that is not going to play.
 *  2. **A native `playback: 'error'`.** Same shape, different producer — the
 *     player failed rather than the token, which is why it is a separate test
 *     rather than being folded into the card-status set.
 *  3. **This clip is not the loaded one.** `playingClipId` is "the id actually
 *     playing, not the requested one" (`store/player.ts`). A mounted-but-passed
 *     reel would otherwise be able to `resume()` a player pointing at a
 *     different clip, which writes `playback: 'playing'` about a clip that is
 *     not the one on screen. The feed loads clips; this overlay only toggles one
 *     that is already loaded.
 */
export function canTogglePlayback(input: {
  cardStatus: CardStatus;
  playback: PlaybackState;
  playingClipId: string | null;
  clipId: string;
}): boolean {
  if (TERMINAL_CARD_STATUSES.has(input.cardStatus)) return false;
  if (input.playback === 'error') return false;
  return input.playingClipId === input.clipId;
}

/**
 * What a permitted tap should DO. `'pause'` only for `playing`.
 *
 * Keyed on the same predicate the ICON uses, so what the user taps and what
 * happens are the same fact: a buffering or freshly-loaded reel draws the
 * triangle, and tapping the triangle resumes. The cost is that
 * `resume()`'s optimistic `playback: 'playing'` is corrected by the next
 * `syncFromPlayer` tick (500 ms, `updateInterval`) if the clip was not actually
 * ready — a bounded, self-correcting claim on a clip that IS loaded, which is a
 * different thing from claiming it for a clip that is not.
 */
export function toggleDirection(playback: PlaybackState): 'pause' | 'resume' {
  return playback === 'playing' ? 'pause' : 'resume';
}

/** What the component should draw and schedule. */
export type PlayOverlayEffect = {
  /** Draw the circle. The TAP TARGET is a separate, always-mounted thing. */
  visible: boolean;
  /** Real player state → glyph. Never a latched value. */
  icon: OverlayIcon;
  /**
   * Absolute `now` at which to hide, or null when no timer is needed.
   *
   * ABSOLUTE, deliberately: the component's effect must key on this value, and a
   * remaining-milliseconds count changes on every render, which would restart
   * the timer that produced it. Absolute deadlines are stable between taps.
   */
  autoHideAt: number | null;
};

/**
 * The visibility rule, in one place.
 *
 *     visible = paused-latch OR open-window      (and neither when blocked)
 *
 * ## The decision, stated rather than implied
 *
 * **The overlay is NOT persistently visible while playing.** The brief for this
 * pass allowed either, so: the bars are an acknowledgement, and the source
 * agrees — it nests its `isPlaying ? bars : triangle` ternary INSIDE the
 * `showPlayIcon &&` guard, so the bars have only ever existed inside the 600 ms
 * window. A persistent pause affordance would put a 100 px, 40 %-opaque,
 * blurred disc over the middle of every playing reel, permanently covering the
 * art. Transient while playing, persistent while paused, and the rule is in the
 * API (`visible`) rather than in a comment beside a boolean.
 *
 * **A paused reel keeps the triangle.** Once the user has paused it, the reel
 * has to say how to resume; the card's own copy ("Now playing"/creator name) is
 * not an affordance and the transport controls are not in the centre. That is
 * the same argument the source's own `showPlayIcon` makes for the 600 ms case,
 * extended to the state where hiding would strand the user.
 *
 * **`ended` is neither.** It is NOT latched, because the store LATCHES `ended`
 * itself for as long as the clip is loaded (`endedForClipId`, `store/player.ts`):
 * a finished clip reads `'ended'`, not `'paused'`, for ever. A latch keyed on
 * "not playing" would therefore be permanent, and a finished clip would sit
 * under a play triangle inviting a replay while the plan's auto-advance consumes
 * `ended` and moves on. So `ended` gets the transient window and the triangle
 * glyph — an honest "nothing is playing right now" — and a replay control is out
 * of scope for this pass (the plan has none; auto-advance owns `ended`).
 *
 * ## The two refusals
 * A terminal card state or a native `playback: 'error'` hides the circle even if
 * a window is open or a latch is set, because a control drawn over the card's
 * own terminal copy is a second, contradicting answer to the same question.
 */
export function playOverlayVisibility(input: {
  state: PlayOverlayState;
  now: number;
  cardStatus: CardStatus;
  playback: PlaybackState;
}): PlayOverlayEffect {
  const icon: OverlayIcon = input.playback === 'playing' ? 'bars' : 'triangle';
  const blocked = TERMINAL_CARD_STATUSES.has(input.cardStatus) || input.playback === 'error';

  if (blocked) return { visible: false, icon, autoHideAt: null };

  // The latch is conjoined with the LIVE state, so "the user paused this" cannot
  // outlive the pause. See `pausedLatched`.
  if (input.state.pausedLatched && input.playback === 'paused') {
    return { visible: true, icon, autoHideAt: input.state.hideAt };
  }

  const open = input.state.hideAt !== null && input.now < input.state.hideAt;
  return {
    visible: open,
    icon,
    autoHideAt: open ? input.state.hideAt : null,
  };
}

/**
 * How long to wait before firing the auto-hide, from an absolute deadline.
 *
 * Clamped at 0, never negative: `setTimeout` treats a negative delay as 0, so a
 * late render would otherwise schedule an immediate hide and burn a frame
 * flashing the overlay. Separated out so the component holds no arithmetic of
 * its own and this clamp is testable.
 */
export function autoHideDelayMs(autoHideAt: number | null, now: number): number | null {
  if (autoHideAt === null) return null;
  return Math.max(0, autoHideAt - now);
}
