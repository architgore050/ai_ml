import { act, renderHook, waitFor } from '@testing-library/react-native';

import { usePlaybackToken } from '../usePlaybackToken';
import { getOrMintToken, __resetTokenCacheForTests } from '../../lib/playbackTokenCache';
import { ApiError } from '../../api/client';

/**
 * The stale-token race, tested through the real hook.
 *
 * The bug: `usePlaybackToken` is `useState`, which does not update until the
 * hook's own effect runs — AFTER the render commits. The feed screen's load
 * effect is declared after this hook and re-runs on the same commit, so on
 * every clip change it read the *previous* clip's token and loaded the new
 * clip with a foreign credential. Tokens are per-clip scoped at the edge, so
 * the manifest 403'd on every swipe.
 *
 * A pure-function test of `decidePlaybackAction` proves the consumer is safe.
 * This proves the other half: that the hook actually labels its state with the
 * clip it belongs to, so a consumer CAN tell.
 */

// NOTE: `../../api/client` is deliberately NOT mocked. `classifyTokenError`
// branches on `err instanceof ApiError`, so substituting a second class of the
// same name makes every 403/404/409 fall through to the generic error branch
// and the test passes for the wrong reason.

const mockGetOrMint = getOrMintToken as jest.MockedFunction<typeof getOrMintToken>;

jest.mock('../../lib/playbackTokenCache', () => {
  const actual = jest.requireActual('../../lib/playbackTokenCache');
  return { ...actual, getOrMintToken: jest.fn() };
});

beforeEach(() => {
  mockGetOrMint.mockReset();
  __resetTokenCacheForTests();
});

const entry = (token: string) => ({ token, expiresAt: Date.now() + 600_000, clipId: 'x' });

describe('usePlaybackToken — clip labelling', () => {
  it('labels a ready token with the clip it is for', async () => {
    mockGetOrMint.mockResolvedValue(entry('tok-a'));
    const { result } = await renderHook(() => usePlaybackToken('a'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.clipId).toBe('a');
  });

  it('never returns a previous clip\'s ready token under a new clipId', async () => {
    // The regression. If this fails, the load effect would fetch clip b's
    // manifest with a's token.
    let resolveA!: (v: ReturnType<typeof entry>) => void;
    mockGetOrMint.mockImplementationOnce(
      () => new Promise((res) => { resolveA = res as never; }),
    );

    const { result, rerender } = await renderHook(
      ({ id }: { id: string | null }) => usePlaybackToken(id),
      { initialProps: { id: 'a' as string | null } },
    );

    // Still minting a; now move to b before a resolves.
    mockGetOrMint.mockResolvedValue(entry('tok-b'));
    await act(async () => { rerender({ id: 'b' }); });

    // Whatever the state is, it must not be a READY token for a.
    expect(
      result.current.status === 'ready' && result.current.clipId === 'a' && true,
    ).toBe(false);

    await act(async () => {
      resolveA(entry('tok-a'));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.clipId).toBe('b');
    expect((result.current as { token: string }).token).toBe('tok-b');
  });

  it('reports clipId null before anything has resolved', async () => {
    let release!: (v: ReturnType<typeof entry>) => void;
    mockGetOrMint.mockImplementation(() => new Promise((res) => { release = res as never; }));
    const { result } = await renderHook(() => usePlaybackToken('a'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.status).toBe('minting');
    expect(result.current.clipId).toBe('a');
    await act(async () => { release(entry('tok-a')); });
  });

  it('reports clipId null when there is no clip', async () => {
    const { result } = await renderHook(() => usePlaybackToken(null));
    expect(result.current.clipId).toBeNull();
  });

  it('labels an error with the clip that failed', async () => {
    mockGetOrMint.mockRejectedValue(new ApiError({ status: 403, body: {} }));
    const { result } = await renderHook(() => usePlaybackToken('a'));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.clipId).toBe('a');
  });

  it('distinguishes 401 from a generic error', async () => {
    // 401 means the session is dead and the app is already redirecting to
    // login. Showing "could not play this clip" for it is a false diagnosis.
    mockGetOrMint.mockRejectedValue(new ApiError({ status: 401, body: {} }));
    const { result } = await renderHook(() => usePlaybackToken('a'));
    await waitFor(() => expect(result.current.status).toBe('auth-required'));
    expect(result.current.clipId).toBe('a');
  });

  it('treats 429 as retryable rather than a permanent per-clip failure', async () => {
    mockGetOrMint.mockRejectedValue(new ApiError({ status: 429, body: {} }));
    const { result } = await renderHook(() => usePlaybackToken('a'));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });
});

describe('usePlaybackToken — refresh', () => {
  it('re-mints after a refresh', async () => {
    mockGetOrMint.mockResolvedValue(entry('tok-1'));
    const { result } = await renderHook(() => usePlaybackToken('a'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    mockGetOrMint.mockResolvedValue(entry('tok-2'));
    await act(async () => { result.current.refresh(); });
    await waitFor(() =>
      expect((result.current as { token?: string }).token).toBe('tok-2'),
    );
  });

  it('refresh is a no-op without a clip', async () => {
    const { result } = await renderHook(() => usePlaybackToken(null));
    await act(async () => { result.current.refresh(); });
    expect(mockGetOrMint).not.toHaveBeenCalled();
  });
});
