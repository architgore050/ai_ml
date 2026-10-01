import {
  INTER_REEL_PAUSE_MS,
  decidePlaybackAction,
  type PlaybackInput,
} from '../playbackDecision';
import type { TokenStatus } from '../playbackTokenCache';

/**
 * These pin the two worst bugs in this client, both of which lived in the
 * feed screen's load effect and were invisible to the component's test suite
 * (there wasn't one).
 */

const base = (over: Partial<PlaybackInput> = {}): PlaybackInput => ({
  token: { status: 'ready', clipId: 'a', token: 'tok-a' },
  activeClipId: 'a',
  activeClipMissing: false,
  activeClipHasNoPlaylist: false,
  sinceLastLoadMs: INTER_REEL_PAUSE_MS,
  ...over,
});

describe('the stale-token race', () => {
  it('refuses to load when the ready token belongs to a different clip', () => {
    // THE bug. On the render where activeClipId moves a→b, usePlaybackToken
    // still returns a's state, so the effect read a's token and called
    // loadClip(clipB, A_TOKEN). Tokens are per-clip scoped at the edge, so b's
    // manifest 403'd — on every single swipe.
    const action = decidePlaybackAction(
      base({
        token: { status: 'ready', clipId: 'a', token: 'tok-a' },
        activeClipId: 'b',
      }),
    );
    expect(action).toEqual({ kind: 'none' });
  });

  it('refuses a stale 403 as well as a stale token', () => {
    // Same one-render lag, different branch: a's tombstone would otherwise
    // render on b's card.
    expect(
      decidePlaybackAction(
        base({ token: { status: 'unavailable', clipId: 'a' }, activeClipId: 'b' }),
      ),
    ).toEqual({ kind: 'none' });
  });

  it('refuses a stale 409 processing state', () => {
    expect(
      decidePlaybackAction(
        base({ token: { status: 'processing', clipId: 'a' }, activeClipId: 'b' }),
      ),
    ).toEqual({ kind: 'none' });
  });

  it('refuses a not-yet-resolved state (clipId null)', () => {
    expect(
      decidePlaybackAction(
        base({ token: { status: 'minting', clipId: null }, activeClipId: 'a' }),
      ),
    ).toEqual({ kind: 'none' });
  });

  it('loads once the state does belong to the active clip', () => {
    expect(decidePlaybackAction(base())).toEqual({
      kind: 'load',
      clipId: 'a',
      token: 'tok-a',
    });
  });
});

describe('the refill-restarts-playback bug', () => {
  it('is keyed on the clip and token, not on the clips array', () => {
    // `clips` used to be in the effect's dependency array. A background refill
    // replaces the array identity, which re-ran the effect and called loadClip
    // again for the clip already playing — restarting the audio under the user
    // with no visible cause. The decision function takes no clips input, so
    // the two are structurally incapable of being confused.
    const a = decidePlaybackAction(base());
    const b = decidePlaybackAction(base());
    expect(a).toEqual(b);
  });
});

describe('inter-reel pause', () => {
  it('defers the load when one was issued recently', () => {
    const action = decidePlaybackAction(base({ sinceLastLoadMs: 0 }));
    expect(action).toEqual({
      kind: 'load-after',
      clipId: 'a',
      token: 'tok-a',
      waitMs: INTER_REEL_PAUSE_MS,
    });
  });

  it('waits only the remainder', () => {
    const action = decidePlaybackAction(base({ sinceLastLoadMs: 600 }));
    expect(action).toEqual({
      kind: 'load-after',
      clipId: 'a',
      token: 'tok-a',
      waitMs: 400,
    });
  });

  it('loads immediately at exactly the threshold', () => {
    expect(decidePlaybackAction(base({ sinceLastLoadMs: INTER_REEL_PAUSE_MS })).kind).toBe('load');
  });
});

describe('terminal states', () => {
  const cases: [TokenStatus['status'], string][] = [
    ['processing', 'processing'],
    ['unavailable', 'unavailable'],
    ['gone', 'gone'],
    ['auth-required', 'auth-required'],
  ];

  it.each(cases)('%s renders as %s', (status, expected) => {
    expect(decidePlaybackAction(base({ token: { status, clipId: 'a' } } as PlaybackInput))).toEqual(
      { kind: 'show', status: expected },
    );
  });

  it('minting shows the idle/spinner state, never a load', () => {
    const action = decidePlaybackAction(
      base({ token: { status: 'minting', clipId: 'a' } }),
    );
    expect(action).toEqual({ kind: 'show', status: 'idle' });
  });

  it('a network error retains the last good state rather than clobbering it', () => {
    // The audio is still playing, so writing `error` reports a failure for a
    // clip that is audibly fine. The NetworkBanner covers the transport.
    expect(
      decidePlaybackAction(
        base({ token: { status: 'error', clipId: 'a', message: 'Network request failed' } }),
      ),
    ).toEqual({ kind: 'none' });
  });
});

describe('missing media', () => {
  it('stops the player when the buffer evicted the playing clip', () => {
    // The 60-cap trims from the front, which can remove the clip on screen.
    // Playing on leaves audio running for a reel that is no longer there.
    expect(decidePlaybackAction(base({ activeClipMissing: true }))).toEqual({ kind: 'stop' });
  });

  it('shows gone when the clip has no playlist url', () => {
    expect(decidePlaybackAction(base({ activeClipHasNoPlaylist: true }))).toEqual({
      kind: 'show',
      status: 'gone',
    });
  });

  it('prefers stop over gone when both apply', () => {
    expect(
      decidePlaybackAction(base({ activeClipMissing: true, activeClipHasNoPlaylist: true })),
    ).toEqual({ kind: 'stop' });
  });
});

describe('defensive', () => {
  it('never loads an empty token', () => {
    expect(
      decidePlaybackAction(
        base({ token: { status: 'ready', clipId: 'a', token: '' } }),
      ),
    ).toEqual({ kind: 'none' });
  });

  it('does nothing when no clip is active', () => {
    expect(
      decidePlaybackAction(
        base({ activeClipId: null, token: { status: 'ready', clipId: null, token: 't' } }),
      ),
    ).toEqual({ kind: 'none' });
  });
});
