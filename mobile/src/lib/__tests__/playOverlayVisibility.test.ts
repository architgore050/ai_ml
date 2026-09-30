/**
 * The play/pause overlay's visibility machine.
 *
 * ## No renderer, no fake timers, by construction
 * Every timing rule is expressed as a pure `(state, event)` / `(state, now)`
 * question with `now` INJECTED, so this file asserts them with plain numbers
 * and `jest.getTimerCount() === 0` never enters into it. The two properties
 * that genuinely need a real timer — that the component CLEARS its timer on
 * unmount (the design source leaks it) and that a repeat tap RESTARTS it — are
 * about the component's `useEffect`, not about the machine, so they are tested
 * in `components/reel/__tests__/PlayOverlay.test.tsx` against real fake timers.
 * Splitting them this way is the whole reason the module was extracted.
 *
 * ## `outcome` means "the state the tap PRODUCED", and the tests are named for it
 * This is the single most misreadable thing in the file, so the reducer's two
 * arms are pinned from BOTH directions. A tap on a PLAYING clip pauses it, so
 * `outcome: 'paused'` — the triangle, latched, because the triangle is the only
 * "how do I get this back" affordance on a reel. A tap on a PAUSED clip resumes
 * it, so `outcome: 'playing'` — the bars, a 600 ms acknowledgement, because a
 * persistent 100 px disc over the artwork of every playing reel is a permanent
 * tax and the source's own `showPlayIcon &&` guard proves the author never
 * wanted one. Reading `outcome` as "the state the tap FOUND" inverts both arms,
 * and that inversion is exactly what a careless reader would assume.
 */

import {
  autoHideDelayMs,
  canTogglePlayback,
  initialPlayOverlay,
  OVERLAY_AUTO_HIDE_MS,
  playOverlayReducer,
  playOverlayVisibility,
  TERMINAL_CARD_STATUSES,
  toggleDirection,
  type PlayOverlayEffect,
  type PlayOverlayState,
} from '../playOverlayVisibility';
import { decidePlaybackAction } from '../playbackDecision';
import type { TokenStatus } from '../playbackTokenCache';
import type { CardStatus, PlaybackState } from '../../store/player';

const CLIP = 'clip-a';
const NEXT_CLIP = 'clip-b';

/** A `CardStatus` that is not terminal and not `error` — the "playable" case. */
const SETTLED: CardStatus = 'idle';

/** `now` is injected everywhere, so one fixed origin keeps the arithmetic legible. */
const T0 = 1_000_000;

/** The selector's input, minus the parts every test fixes for itself. */
type VisibilityInput = Parameters<typeof playOverlayVisibility>[0];

const shown = (over: Partial<Omit<VisibilityInput, 'now'>> = {}): PlayOverlayEffect =>
  playOverlayVisibility({
    state: initialPlayOverlay(CLIP),
    now: T0,
    cardStatus: SETTLED,
    playback: 'paused',
    ...over,
  });

/** Dispatch a `tap` that ended the clip in `outcome`. */
const tapped = (
  state: PlayOverlayState,
  now: number,
  outcome: 'playing' | 'paused',
): PlayOverlayState => playOverlayReducer(state, { type: 'tap', now, outcome });

describe('playOverlayVisibility', () => {
  describe('the source constants', () => {
    it('auto-hides after 600 ms, the source value', () => {
      // ReelCard.tsx:140 — `setTimeout(() => setShowPlayIcon(false), 600)`.
      // Restated as a literal rather than imported, so a change to the constant
      // fails here instead of silently redefining "the source's 600 ms".
      expect(OVERLAY_AUTO_HIDE_MS).toBe(600);
    });
  });

  describe('a tap that left the clip PLAYING — transient, 600 ms', () => {
    // Found paused, resumed, so `outcome: 'playing'` and the glyph is the bars.

    it('shows the bars immediately', () => {
      const state = tapped(initialPlayOverlay(CLIP), T0, 'playing');
      const effect = playOverlayVisibility({
        state,
        now: T0,
        cardStatus: SETTLED,
        playback: 'playing',
      });

      expect(effect.visible).toBe(true);
      expect(effect.icon).toBe('bars');
    });

    it('arms an ABSOLUTE deadline exactly 600 ms out', () => {
      // Absolute, not a remaining count: the component keys its effect on this
      // value, and a recomputed remainder would restart the timer that produced
      // it, so the overlay would never hide at all.
      const state = tapped(initialPlayOverlay(CLIP), T0, 'playing');
      expect(state.hideAt).toBe(T0 + OVERLAY_AUTO_HIDE_MS);
      expect(autoHideDelayMs(state.hideAt, T0)).toBe(600);
    });

    it('is still visible one millisecond before the deadline and not one after', () => {
      const state = tapped(initialPlayOverlay(CLIP), T0, 'playing');
      const at = (now: number) =>
        playOverlayVisibility({ state, now, cardStatus: SETTLED, playback: 'playing' });

      // The boundary is `<`, so the window is half-open: [now, hideAt).
      expect(at(T0 + OVERLAY_AUTO_HIDE_MS - 1).visible).toBe(true);
      expect(at(T0 + OVERLAY_AUTO_HIDE_MS).visible).toBe(false);
    });

    it('stops asking for a timer once the window has closed', () => {
      // `autoHideAt: null` is the effect's "unschedule" signal. Returning the
      // stale deadline instead would keep re-arming a timer for a window that
      // has already gone — an infinite re-arm loop.
      const state = tapped(initialPlayOverlay(CLIP), T0, 'playing');
      const late = playOverlayVisibility({
        state,
        now: T0 + OVERLAY_AUTO_HIDE_MS,
        cardStatus: SETTLED,
        playback: 'playing',
      });

      expect(late.visible).toBe(false);
      expect(late.autoHideAt).toBeNull();
    });

    it('closes the window on `window-elapsed`', () => {
      const open = tapped(initialPlayOverlay(CLIP), T0, 'playing');
      const elapsed = playOverlayReducer(open, { type: 'window-elapsed' });

      expect(elapsed.hideAt).toBeNull();
      expect(
        playOverlayVisibility({ state: elapsed, now: T0, cardStatus: SETTLED, playback: 'playing' })
          .visible,
      ).toBe(false);
    });

    it('does not latch a paused affordance it never earned', () => {
      // The guard against a "the user paused this" flag outliving the pause: a
      // clip that resumes later for any other reason must not come back wearing
      // a triangle it never asked for.
      expect(tapped(initialPlayOverlay(CLIP), T0, 'playing').pausedLatched).toBe(false);
    });
  });

  describe('a tap that left the clip PAUSED — persistent, no timer', () => {
    // Found playing, paused it, so `outcome: 'paused'` and the glyph is the triangle.

    it('shows the triangle', () => {
      const state = tapped(initialPlayOverlay(CLIP), T0, 'paused');
      const effect = playOverlayVisibility({
        state,
        now: T0,
        cardStatus: SETTLED,
        playback: 'paused',
      });

      expect(effect.visible).toBe(true);
      expect(effect.icon).toBe('triangle');
    });

    it('stays visible far past 600 ms, and asks for no timer', () => {
      const state = tapped(initialPlayOverlay(CLIP), T0, 'paused');
      // A long way past the window the playing case would have closed at: the
      // paused case is deliberately NOT bounded by the source's 600 ms.
      const effect = playOverlayVisibility({
        state,
        now: T0 + 60_000,
        cardStatus: SETTLED,
        playback: 'paused',
      });

      expect(effect.visible).toBe(true);
      // No deadline means no `setTimeout` at all. A ceremonial timer here would
      // be worse than none: it could not change the output, because a latched
      // machine is visible by the latch alone.
      expect(effect.autoHideAt).toBeNull();
      expect(autoHideDelayMs(effect.autoHideAt, T0)).toBeNull();
    });

    it('survives a state it did not measure — the window is not what holds it', () => {
      const state = tapped(initialPlayOverlay(CLIP), T0, 'paused');
      // `window-elapsed` cannot clear a latch, so this is a no-op. Spelled out
      // rather than relied upon: a latched machine has no deadline, so the
      // component never schedules the event that would dispatch it.
      const elapsed = playOverlayReducer(state, { type: 'window-elapsed' });
      expect(elapsed.pausedLatched).toBe(true);
      expect(
        playOverlayVisibility({ state: elapsed, now: T0, cardStatus: SETTLED, playback: 'paused' })
          .visible,
      ).toBe(true);
    });

    it('drops the latch the moment the clip is playing again', () => {
      // The latch is conjoined with the LIVE state, not trusted on its own. A
      // native resume, a reload — anything — must clear the affordance, or a
      // playing reel sits under a play triangle that lies about its state.
      const state = tapped(initialPlayOverlay(CLIP), T0, 'paused');
      const resumed = playOverlayVisibility({
        state,
        now: T0,
        cardStatus: SETTLED,
        playback: 'playing',
      });

      expect(resumed.visible).toBe(false);
      expect(resumed.icon).toBe('bars');
    });

    it('is suppressed by `ended`, which the store latches for the whole clip', () => {
      const state = tapped(initialPlayOverlay(CLIP), T0, 'paused');
      const finished = playOverlayVisibility({
        state,
        now: T0,
        cardStatus: SETTLED,
        playback: 'ended',
      });

      expect(finished.visible).toBe(false);
    });
  });

  describe('repeat taps', () => {
    it('move the deadline forward, so the window restarts rather than ending early', () => {
      // THE restart property. A second tap 300 ms in must produce a NEW absolute
      // deadline 600 ms from ITS OWN moment. Keeping the first (600) is the
      // design source's actual behaviour and it is a race with no owner: the
      // user sees 300 ms of overlay, not 600.
      const first = tapped(initialPlayOverlay(CLIP), T0, 'playing');
      const second = tapped(first, T0 + 300, 'playing');

      expect(first.hideAt).toBe(T0 + 600);
      expect(second.hideAt).toBe(T0 + 900);
      expect(second.hideAt).not.toBe(first.hideAt);
    });

    it('give a full 600 ms from the second tap, not the remainder of the first', () => {
      const first = tapped(initialPlayOverlay(CLIP), T0, 'playing');
      const second = tapped(first, T0 + 300, 'playing');

      // 900 - 300 = 600. The stale-timer reading would give 300.
      expect(autoHideDelayMs(second.hideAt, T0 + 300)).toBe(OVERLAY_AUTO_HIDE_MS);
      expect(autoHideDelayMs(second.hideAt, T0 + 300)).not.toBe(300);
    });

    it('hold the window open past the FIRST tap deadline', () => {
      // The observable consequence: at T0+600 the first window has closed, but
      // the second is 300 ms from closing, so the overlay must still be up.
      const state = tapped(tapped(initialPlayOverlay(CLIP), T0, 'playing'), T0 + 300, 'playing');
      const effect = playOverlayVisibility({
        state,
        now: T0 + 600,
        cardStatus: SETTLED,
        playback: 'playing',
      });

      expect(effect.visible).toBe(true);
    });

    it('clear a paused latch when a second tap resumes, so it does not stick', () => {
      // Alternating taps are the normal interaction, and the latch is
      // single-valued: resuming must give the 600 ms window back, not collide
      // with a latch that is still set.
      const paused = tapped(initialPlayOverlay(CLIP), T0, 'paused');
      const playing = tapped(paused, T0 + 50, 'playing');

      expect(playing.pausedLatched).toBe(false);
      expect(playing.hideAt).toBe(T0 + 650);
      expect(
        playOverlayVisibility({ state: playing, now: T0 + 50, cardStatus: SETTLED, playback: 'playing' })
          .visible,
      ).toBe(true);
    });
  });

  describe('clip scoping', () => {
    it('discards a pending window when the clip changes, so the NEW clip starts hidden', () => {
      // A tap on the previous reel must not leave its 600 ms window to hide the
      // next reel's overlay, and must not leave its latch to SHOW one either.
      const armed = tapped(initialPlayOverlay(CLIP), T0, 'paused');
      expect(armed.pausedLatched).toBe(true);

      const onNext = playOverlayReducer(armed, { type: 'clip', clipId: NEXT_CLIP });

      expect(onNext).toEqual(initialPlayOverlay(NEXT_CLIP));
      expect(
        playOverlayVisibility({
          state: onNext,
          now: T0,
          cardStatus: SETTLED,
          playback: 'paused',
        }).visible,
      ).toBe(false);
    });

    it('drops an armed 600 ms window on a clip change too, not only a latch', () => {
      const armed = tapped(initialPlayOverlay(CLIP), T0, 'playing');
      const onNext = playOverlayReducer(armed, { type: 'clip', clipId: NEXT_CLIP });

      expect(onNext.hideAt).toBeNull();
      // And `autoHideAt: null` is what makes the component's effect cleanup fire
      // `clearTimeout` — the stale timer is cancelled by the deadline changing.
      expect(
        playOverlayVisibility({
          state: onNext,
          now: T0 + 10,
          cardStatus: SETTLED,
          playback: 'playing',
        }).autoHideAt,
      ).toBeNull();
    });

    it('is a no-op for a re-base onto the clip it already describes', () => {
      const armed = tapped(initialPlayOverlay(CLIP), T0, 'playing');
      // Matters for `dispatch`, which re-bases before every event: an
      // unconditional reset here would discard the pending window on the very
      // tap that armed it.
      expect(playOverlayReducer(armed, { type: 'clip', clipId: CLIP })).toBe(armed);
    });
  });

  describe('purity', () => {
    it('never mutates the state it is given', () => {
      const before = tapped(initialPlayOverlay(CLIP), T0, 'paused');
      const snapshot = { ...before };

      playOverlayReducer(before, { type: 'window-elapsed' });
      playOverlayReducer(before, { type: 'clip', clipId: NEXT_CLIP });
      playOverlayVisibility({ state: before, now: T0 + 5, cardStatus: SETTLED, playback: 'playing' });

      expect(before).toEqual(snapshot);
    });

    it('returns a distinct object from every event that actually changes state', () => {
      // Guards against a future `return state` shortcut silently keeping a stale
      // latch alive; `toBe` identity is the check that catches it. Started from a
      // state with an OPEN WINDOW, because `window-elapsed` on a state with no
      // deadline is a documented no-op that deliberately preserves identity.
      const open = tapped(initialPlayOverlay(CLIP), T0, 'playing');
      expect(playOverlayReducer(open, { type: 'window-elapsed' })).not.toBe(open);
      expect(playOverlayReducer(open, { type: 'clip', clipId: NEXT_CLIP })).not.toBe(open);
      expect(playOverlayReducer(open, { type: 'tap', now: T0, outcome: 'paused' })).not.toBe(open);
    });

    it('preserves identity for a no-op, so a re-arm does not churn state', () => {
      // `dispatch` re-bases before every event, and `clip` no-ops on a matching
      // id, so a chain of no-ops must not allocate. Identity here is what keeps
      // `useMemo`/`useState` bailouts working.
      const before = initialPlayOverlay(CLIP);
      expect(playOverlayReducer(before, { type: 'window-elapsed' })).toBe(before);
      expect(playOverlayReducer(before, { type: 'clip', clipId: CLIP })).toBe(before);
    });
  });

  describe('autoHideDelayMs', () => {
    it('is null when there is no deadline, so the effect schedules nothing', () => {
      expect(autoHideDelayMs(null, T0)).toBeNull();
    });

    it('clamps a past deadline to 0 rather than going negative', () => {
      // `setTimeout` treats a negative delay as 0, so without the clamp a late
      // render schedules an immediate hide and burns a frame flashing the
      // overlay. Asserted as exactly 0 so a negative value fails here.
      expect(autoHideDelayMs(T0 - 1, T0)).toBe(0);
      expect(autoHideDelayMs(T0 - 10_000, T0)).toBe(0);
    });
  });

  describe('the two refusals', () => {
    // `Partial` because each case overrides exactly ONE of the two, and building
    // the input field by field rather than by spreading — a spread of a
    // known-keyed object over the defaults is TS2783.
    const blocked: Array<[string, Partial<Pick<VisibilityInput, 'cardStatus' | 'playback'>>]> = [
      ['processing', { cardStatus: 'processing' }],
      ['unavailable', { cardStatus: 'unavailable' }],
      ['gone', { cardStatus: 'gone' }],
      ['auth-required', { cardStatus: 'auth-required' }],
      ['card error', { cardStatus: 'error' }],
      ['native playback error', { playback: 'error' }],
    ];

    it.each(blocked)('hides the circle for %s, even with the window open', (_name, over) => {
      const state = tapped(initialPlayOverlay(CLIP), T0, 'playing');
      const effect = playOverlayVisibility({
        state,
        now: T0,
        cardStatus: over.cardStatus ?? SETTLED,
        playback: over.playback ?? 'playing',
      });

      expect(effect.visible).toBe(false);
      // And it stops asking for a timer, so a blocked card does not keep a
      // deadline alive that will re-show the circle the instant it unblocks.
      expect(effect.autoHideAt).toBeNull();
    });

    it('hides a latched triangle behind a refusal as well', () => {
      const state = tapped(initialPlayOverlay(CLIP), T0, 'paused');
      expect(
        playOverlayVisibility({
          state,
          now: T0,
          cardStatus: 'gone',
          playback: 'paused',
        }).visible,
      ).toBe(false);
    });

    it('leaves `idle` and `minting` alone — both are settling, so a tap is a real intent', () => {
      // `decidePlaybackAction` maps a minting token to `show: 'idle'` and the
      // feed turns it straight back into `'minting'`, so neither means "this
      // will never play". Refusing there would swallow a legitimate first play.
      for (const cardStatus of ['idle', 'minting'] as const) {
        expect(
          playOverlayVisibility({
            state: tapped(initialPlayOverlay(CLIP), T0, 'paused'),
            now: T0,
            cardStatus,
            playback: 'paused',
          }).visible,
        ).toBe(true);
        expect(canTogglePlayback({ cardStatus, playback: 'paused', playingClipId: CLIP, clipId: CLIP })).toBe(
          true,
        );
      }
    });
  });

  describe('the icon follows the LIVE state, never the machine', () => {
    it.each<[PlaybackState, 'bars' | 'triangle']>([
      ['playing', 'bars'],
      ['paused', 'triangle'],
      ['ended', 'triangle'],
      ['idle', 'triangle'],
      ['loading', 'triangle'],
      ['buffering', 'triangle'],
      ['error', 'triangle'],
    ])('%s draws the %s', (playback, icon) => {
      // The machine records what a tap DID; the icon reports what is TRUE now.
      // If the icon were read off the latch it would be a lie for the whole
      // 600 ms after any state change the machine did not cause.
      expect(shown({ playback, state: initialPlayOverlay(CLIP) }).icon).toBe(icon);
    });

    it('says `bars` only for `playing` — never for `cardStatus`', () => {
      // `cardStatus: 'idle'` is what a SETTLED, PLAYABLE card reads, so keying
      // "now playing" on it would put the bars on every loaded, paused reel.
      expect(shown({ playback: 'playing', cardStatus: SETTLED }).icon).toBe('bars');
      expect(shown({ playback: 'paused', cardStatus: SETTLED }).icon).toBe('triangle');
    });
  });

  describe('`ended` — latched by the store, so the overlay must not latch it too', () => {
    it('is transient, and invites nothing once the window closes', () => {
      // `store/player.ts` LATCHES `ended` in `endedForClipId` for as long as the
      // clip is loaded, because `didJustFinish` is a one-tick native pulse. A
      // finished clip therefore reads `ended` indefinitely, so ANY overlay rule
      // keyed on "not playing" would be permanent — a play triangle inviting a
      // replay, sitting there while auto-advance consumes `ended` and moves on.
      const state = tapped(initialPlayOverlay(CLIP), T0, 'playing');
      const at = (now: number) =>
        playOverlayVisibility({ state, now, cardStatus: SETTLED, playback: 'ended' });

      // Honest "nothing is playing right now" for the length of the window...
      expect(at(T0).visible).toBe(true);
      expect(at(T0).icon).toBe('triangle');
      // ...and then it goes away rather than parking a replay button on screen.
      expect(at(T0 + OVERLAY_AUTO_HIDE_MS).visible).toBe(false);
    });

    it('is a legitimate thing to tap — it is the replay affordance', () => {
      expect(
        canTogglePlayback({
          cardStatus: SETTLED,
          playback: 'ended',
          playingClipId: CLIP,
          clipId: CLIP,
        }),
      ).toBe(true);
      expect(toggleDirection('ended')).toBe('resume');
    });

    it('does not leave a paused latch behind, which would outlive the clip', () => {
      // `pausedLatched` is only honoured when `playback === 'paused'`, and
      // `ended` never is — so the latch cannot survive into the next clip.
      const latched = tapped(initialPlayOverlay(CLIP), T0, 'paused');
      expect(
        playOverlayVisibility({ state: latched, now: T0, cardStatus: SETTLED, playback: 'ended' })
          .visible,
      ).toBe(false);
    });
  });

  describe('canTogglePlayback', () => {
    const ok = {
      cardStatus: SETTLED,
      playback: 'paused' as PlaybackState,
      playingClipId: CLIP,
      clipId: CLIP,
    };

    it('permits a tap on the clip that is actually loaded', () => {
      expect(canTogglePlayback(ok)).toBe(true);
    });

    it('refuses every terminal card status, for every playback state', () => {
      for (const cardStatus of TERMINAL_CARD_STATUSES) {
        for (const playback of ['idle', 'loading', 'playing', 'paused', 'ended'] as const) {
          expect(canTogglePlayback({ ...ok, cardStatus, playback })).toBe(false);
        }
      }
    });

    it('refuses a native playback error even when the card status is perfectly fine', () => {
      // A SEPARATE test from the card-status set, and this is what makes it one:
      // the card here is `idle`, which is NOT in the terminal set, so the refusal
      // can only have come from `playback === 'error'`. Same consequence,
      // different producer — the PLAYER failed, not the token — and
      // `cardStatus` cannot express it.
      const fine: CardStatus = 'idle';
      expect(TERMINAL_CARD_STATUSES.has(fine)).toBe(false);
      expect(canTogglePlayback({ ...ok, cardStatus: fine, playback: 'error' })).toBe(false);
    });

    it('refuses a clip that is not the loaded one', () => {
      // A mounted-but-passed reel. `playingClipId` is "the id actually playing,
      // not the requested one", so this is the whole point of the check: without
      // it, a neighbour reel could `resume()` a player pointing at another clip
      // and write `playback: 'playing'` about a clip that is not on screen.
      expect(canTogglePlayback({ ...ok, playingClipId: NEXT_CLIP })).toBe(false);
      expect(canTogglePlayback({ ...ok, playingClipId: null })).toBe(false);
    });

    it('refuses while nothing is loaded at all', () => {
      expect(canTogglePlayback({ ...ok, playingClipId: null })).toBe(false);
    });
  });

  describe('toggleDirection', () => {
    it.each<[PlaybackState, 'pause' | 'resume']>([
      ['playing', 'pause'],
      ['paused', 'resume'],
      ['ended', 'resume'],
      ['idle', 'resume'],
      ['loading', 'resume'],
      ['buffering', 'resume'],
    ])('%s toggles to %s', (playback, expected) => {
      expect(toggleDirection(playback)).toBe(expected);
    });

    it('uses the same predicate as the icon, so the tap and the glyph agree', () => {
      // A buffering or freshly-loaded reel draws the TRIANGLE and tapping that
      // triangle resumes. If these ever diverged, the user would be shown a
      // pause glyph whose tap resumed the clip.
      for (const playback of ['playing', 'paused', 'ended', 'idle', 'loading', 'buffering'] as const) {
        const icon = playOverlayVisibility({
          state: initialPlayOverlay(CLIP),
          now: T0,
          cardStatus: SETTLED,
          playback,
        }).icon;
        const pauses = toggleDirection(playback) === 'pause';

        expect(pauses).toBe(icon === 'bars');
      }
    });
  });

  describe('correspondence with playbackDecision.ts', () => {
    // The two modules answer DIFFERENT questions and the set is restated rather
    // than derived, because `playbackDecision` exposes a DECISION (given a token,
    // what should the player do) and takes no `playback` at all. A restated
    // constant is only as trustworthy as the tests below, so the two are driven
    // against each other here rather than left to a comment.

    /**
     * One `TokenStatus` VALUE per name, spelled out rather than built from a
     * parameter.
     *
     * `TokenStatus` is a union of OBJECT types, not of status strings
     * (`playbackTokenCache.ts:52-77`), and `'error'` is the one arm carrying a
     * `message`. So a `tokenFor(status: TokenStatus['status'])` helper cannot
     * build one without a cast — and the cast would erase exactly the
     * correspondence this block exists to check. Listing the values keeps the
     * union membership visible and the types honest.
     */
    const TOKEN = {
      ready: { status: 'ready', token: 'tok', clipId: CLIP },
      minting: { status: 'minting', clipId: CLIP },
      processing: { status: 'processing', clipId: CLIP },
      unavailable: { status: 'unavailable', clipId: CLIP },
      gone: { status: 'gone', clipId: CLIP },
      'auth-required': { status: 'auth-required', clipId: CLIP },
    } satisfies Record<string, TokenStatus>;
    const TOKEN_ERROR: TokenStatus = { status: 'error', message: 'boom', clipId: CLIP };

    const decisionFor = (token: TokenStatus) =>
      decidePlaybackAction({
        token,
        activeClipId: CLIP,
        activeClipMissing: false,
        activeClipHasNoPlaylist: false,
        sinceLastLoadMs: 5_000,
      });

    const AGREEING = [
      ['processing', 'processing'],
      ['unavailable', 'unavailable'],
      ['gone', 'gone'],
      ['auth-required', 'auth-required'],
    ] as const;

    it.each(AGREEING)(
      'agrees with playbackDecision that %s is terminal',
      (cardStatus, tokenName) => {
        // Same membership, reached by two independent questions.
        expect(TERMINAL_CARD_STATUSES.has(cardStatus)).toBe(true);
        expect(decisionFor(TOKEN[tokenName])).toEqual({ kind: 'show', status: cardStatus });
      },
    );

    it('is the ONE documented divergence: `error`', () => {
      // `decidePlaybackAction` returns `{kind:'none'}` for `error` on purpose —
      // "the audio is still playing, keep the last good state" — whereas a tap on
      // an errored card MUST refuse, or it optimistically claims playback for a
      // clip that will not play. Opposite requirements, so `error` is in this
      // module's terminal set and not in that module's `show` arm.
      expect(TERMINAL_CARD_STATUSES.has('error')).toBe(true);
      expect(decisionFor(TOKEN_ERROR)).toEqual({ kind: 'none' });
    });

    it('maps `minting` to the `show: idle` output without making either one terminal', () => {
      // The trap this guards: `playbackDecision`'s `show` arm includes the
      // literal `'idle'`, so a naive "derive the terminal set from the show arm"
      // would make a settled, PLAYABLE card untappable. `'idle'` is a
      // `CardStatus` the feed displays; it is PRODUCED by `decidePlaybackAction`
      // from a `minting` token and is not itself a `TokenStatus` at all — which
      // is why `TOKEN` above has no `idle` key to pass in.
      expect(decisionFor(TOKEN.minting)).toEqual({ kind: 'show', status: 'idle' });
      expect(TERMINAL_CARD_STATUSES.has('minting')).toBe(false);
      expect(TERMINAL_CARD_STATUSES.has('idle')).toBe(false);
      // And a tap on either is still permitted, which is the whole point.
      for (const cardStatus of ['idle', 'minting'] as const) {
        expect(
          canTogglePlayback({
            cardStatus,
            playback: 'paused',
            playingClipId: CLIP,
            clipId: CLIP,
          }),
        ).toBe(true);
      }
    });

    it('is not deriverable from the `show` arm without breaking a playable card', () => {
      // Stated as a fact rather than left implicit: the two sets differ in BOTH
      // directions — `error` is terminal here but a `none` there, and `idle` is a
      // `show` status there but a playable, non-terminal card here. So
      // "import the set" is not an available refactor, and the membership is
      // pinned by the three tests above instead of derived from either module.
      const showArm: ReadonlySet<string> = new Set(['idle', 'processing', 'unavailable', 'gone', 'auth-required']);
      const here: ReadonlySet<string> = TERMINAL_CARD_STATUSES;

      // `error`: terminal here, absent from the show arm.
      expect(here.has('error')).toBe(true);
      expect(showArm.has('error')).toBe(false);
      // `idle`: in the show arm, but NOT terminal here.
      expect(showArm.has('idle')).toBe(true);
      expect(here.has('idle')).toBe(false);
    });
  });

  describe('the machine holds no timer', () => {
    it('has no handle, deadline provider, or side effect in its state', () => {
      // The contract that makes the component's timer the ONLY timer. If a
      // handle ever crept into this state, the two would have to be kept in sync
      // and the "cleared on unmount" guarantee would stop being provable here.
      const state = tapped(initialPlayOverlay(CLIP), T0, 'playing');
      expect(Object.keys(state).sort()).toEqual(['clipId', 'hideAt', 'pausedLatched']);
      for (const value of Object.values(state)) {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    });
  });
});
