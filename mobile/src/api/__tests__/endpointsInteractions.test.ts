import {
  isTelemetryRefusedForMinor,
  logTelemetry,
  registerSkip,
  toggleLike,
} from '../endpoints/interactions';
import { apiFetch } from '../client';

/**
 * Endpoint-shape tests for the three interaction writes.
 *
 * Most of these pin server behaviour rather than restating the implementation,
 * because two of the three have a failure mode that a 2xx hides:
 *
 *  - `registerSkip` requires `reel_id` (omitting it is a 400) and then throws
 *    it away. A caller-supplied UUID could therefore disagree with the `clipId`
 *    in the URL with no server-side way to detect it.
 *  - `logTelemetry` hardcodes `action_type: 'view'`. The server's ChoiceField
 *    also accepts `'like' | 'share' | 'skip'`, each of which is a live
 *    data-corruption primitive (see the module docstring). The exact-keys
 *    assertions below are what keep that from being "helpfully" widened.
 */

jest.mock('../client', () => ({ apiFetch: jest.fn() }));
const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

/** The real client, for the ApiError instances — `../client` is mocked above. */
const { ApiError } = jest.requireActual<typeof import('../client')>('../client');

const CLIP = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('toggleLike', () => {
  it('POSTs to the trailing-slash path with no body and no method extras', async () => {
    mockApiFetch.mockResolvedValue({ status: 'liked' });
    await toggleLike(CLIP);

    expect(mockApiFetch).toHaveBeenCalledWith(`/interactions/${CLIP}/toggle-like/`, {
      method: 'POST',
    });
    // Not `body: undefined` either: `apiFetch` keys Content-Type off
    // `body !== undefined`, and the view never reads request.data at all
    // (views/interactions.py:121-126).
    const options = mockApiFetch.mock.calls[0]?.[1];
    expect(options).not.toHaveProperty('body');
  });

  it.each([
    ['liked', 'liked'],
    ['unliked', 'unliked'],
  ])('returns the parsed server value %s', async (wire, expected) => {
    mockApiFetch.mockResolvedValue({ status: wire });
    await expect(toggleLike(CLIP)).resolves.toEqual({ status: expected });
  });

  it('REJECTS a status outside the two the server can produce', async () => {
    // The view computes the string from `interaction.is_active`
    // (views/interactions.py:125), so anything else is a backend change. It must
    // fail here rather than reaching a heart button as an unknown state.
    mockApiFetch.mockResolvedValue({ status: 'like' });
    await expect(toggleLike(CLIP)).rejects.toThrow();
  });

  it('exposes no like count, because the server sends none', async () => {
    // `likes` lives on FeedClip and is flushed to Postgres on a 5-minute Celery
    // beat. A count read off this response would disagree with `is_liked`.
    mockApiFetch.mockResolvedValue({ status: 'liked' });
    await expect(toggleLike(CLIP)).resolves.toEqual({ status: 'liked' });
  });
});

describe('registerSkip', () => {
  const ok = { status: 'skip/view registered' };

  it('POSTs all three required body fields', async () => {
    mockApiFetch.mockResolvedValue(ok);
    await registerSkip(CLIP, { listenDurationMs: 4_200, reelPositionMs: 9_000 });

    expect(mockApiFetch).toHaveBeenCalledWith(`/interactions/${CLIP}/register-skip/`, {
      method: 'POST',
      body: {
        listen_duration_ms: 4_200,
        reel_position_ms: 9_000,
        reel_id: CLIP,
      },
    });
  });

  it('derives reel_id from the clipId in the path', async () => {
    mockApiFetch.mockResolvedValue(ok);
    await registerSkip(CLIP, { listenDurationMs: 1, reelPositionMs: 1 });

    const body = mockApiFetch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    // The server discards this field, so a disagreement with the URL is
    // undetectable server-side. Deriving it makes it unrepresentable.
    expect(body.reel_id).toBe(CLIP);
    expect((mockApiFetch.mock.calls[0]?.[0] as string)).toContain(CLIP);
  });

  it('cannot be made to send a reel_id that disagrees with the path', async () => {
    mockApiFetch.mockResolvedValue(ok);
    const foreign = '99999999-9999-9999-9999-999999999999';

    // The only lever a caller has is extra properties on `input`, since
    // `reel_id` is not in `RegisterSkipInput`. TypeScript rejects them; this
    // proves the RUNTIME ignores them too, because a stray `reel_id` that
    // reached the wire would be exactly the bug the derivation prevents.
    await registerSkip(CLIP, {
      listenDurationMs: 1,
      reelPositionMs: 1,
      reel_id: foreign,
    } as unknown as Parameters<typeof registerSkip>[1]);

    const body = mockApiFetch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(body.reel_id).toBe(CLIP);
    expect(body.reel_id).not.toBe(foreign);
    expect(Object.keys(body).sort()).toEqual([
      'listen_duration_ms',
      'reel_id',
      'reel_position_ms',
    ]);
  });

  it('sends listen_duration_ms verbatim — it is the only field the server reads', async () => {
    mockApiFetch.mockResolvedValue(ok);
    // Accumulated watch time, deliberately NOT equal to the media position:
    // seeking to 9s of a 10s clip after one second of listening must report 1s.
    await registerSkip(CLIP, { listenDurationMs: 1_000, reelPositionMs: 9_000 });

    const body = mockApiFetch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(body.listen_duration_ms).toBe(1_000);
    expect(body.reel_position_ms).toBe(9_000);
  });

  it('accepts zero, which is the server minimum', async () => {
    mockApiFetch.mockResolvedValue(ok);
    await registerSkip(CLIP, { listenDurationMs: 0, reelPositionMs: 0 });
    const body = mockApiFetch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(body.listen_duration_ms).toBe(0);
  });

  it('REJECTS a status the server cannot produce', async () => {
    // views/interactions.py:140 — the literal space is part of the contract, so
    // a trimmed variant must not be accepted as if it were the real thing.
    mockApiFetch.mockResolvedValue({ status: 'skip/view registered'.replace(' ', '') });
    await expect(registerSkip(CLIP, { listenDurationMs: 1, reelPositionMs: 1 })).rejects.toThrow();
  });
});

describe('logTelemetry', () => {
  const ok = { status: 'telemetry logged' };

  it('POSTs to the trailing-slash path', async () => {
    mockApiFetch.mockResolvedValue(ok);
    await logTelemetry(CLIP, { watchTimeMs: 2_500 });

    expect(mockApiFetch).toHaveBeenCalledWith(`/interactions/${CLIP}/log-telemetry/`, {
      method: 'POST',
      body: { action_type: 'view', watch_time_ms: 2_500 },
    });
  });

  it('sends EXACTLY two keys — action_type and watch_time_ms, nothing else', async () => {
    mockApiFetch.mockResolvedValue(ok);
    await logTelemetry(CLIP, { watchTimeMs: 2_500 });

    const body = mockApiFetch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    // Object.keys, not toEqual: DRF silently DROPS unknown fields, so a
    // typo'd or smuggled key is invisible server-side and the only place it can
    // be caught is here.
    expect(Object.keys(body).sort()).toEqual(['action_type', 'watch_time_ms']);
  });

  it('hardcodes action_type to view and cannot be widened from the call site', async () => {
    mockApiFetch.mockResolvedValue(ok);

    // TypeScript forbids these; this proves the runtime does too. Each of
    // 'like'/'share'/'skip' is accepted by the server's ChoiceField and is a
    // live corruption primitive (see the module docstring), so a caller that
    // COULD reach it would be the vulnerability rather than the feature.
    for (const smuggled of ['like', 'share', 'skip', 'view_x']) {
      mockApiFetch.mockClear();
      await logTelemetry(CLIP, {
        watchTimeMs: 1_000,
        action_type: smuggled,
      } as unknown as Parameters<typeof logTelemetry>[1]);

      const body = mockApiFetch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
      expect(body.action_type).toBe('view');
      expect(Object.keys(body).sort()).toEqual(['action_type', 'watch_time_ms']);
    }
  });

  it('sends watch_time_ms verbatim and never derives it from a position', async () => {
    mockApiFetch.mockResolvedValue(ok);
    await logTelemetry(CLIP, { watchTimeMs: 1_000 });

    const body = mockApiFetch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(body.watch_time_ms).toBe(1_000);
    // A body with no position field at all IS the guarantee — there is nothing
    // for a caller to accidentally feed currentTime * 1000 into.
    expect(Object.keys(body)).not.toContain('reel_position_ms');
  });

  it('accepts the server maximum, 10 hours', async () => {
    mockApiFetch.mockResolvedValue(ok);
    await logTelemetry(CLIP, { watchTimeMs: 36_000_000 });
    const body = mockApiFetch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(body.watch_time_ms).toBe(36_000_000);
  });

  it('REJECTS a 202 body whose status is not the one the server sends', async () => {
    mockApiFetch.mockResolvedValue({ status: 'telemetry logged successfully' });
    await expect(logTelemetry(CLIP, { watchTimeMs: 1 })).rejects.toThrow();
  });

  it('REJECTS an empty body rather than accepting a 202 as a success', async () => {
    // 202 is not 200: the write is accepted for async processing. An empty
    // body means the contract changed and the caller must not be told the
    // heartbeat landed.
    mockApiFetch.mockResolvedValue({});
    await expect(logTelemetry(CLIP, { watchTimeMs: 1 })).rejects.toThrow();
  });

  it('propagates a rejected write instead of swallowing it', async () => {
    // 403 (minor), 404 (out of scope), 429 (60/min) all arrive here as throws
    // from apiFetch and must reach the caller — the heartbeat loop branches on
    // them, and silently swallowing one would spin forever at 60 req/min.
    mockApiFetch.mockRejectedValue(new ApiError({ status: 403, body: { detail: 'nope' } }));
    await expect(logTelemetry(CLIP, { watchTimeMs: 1 })).rejects.toThrow();
  });
});

describe('isTelemetryRefusedForMinor', () => {
  it('is true for a 403', () => {
    expect(isTelemetryRefusedForMinor(new ApiError({ status: 403, body: null }))).toBe(true);
  });

  it('is true for a plain object carrying status 403', () => {
    // Structural by design: the predicate must not depend on there being one
    // ApiError class instance in the process.
    expect(isTelemetryRefusedForMinor({ status: 403 })).toBe(true);
  });

  it('is false for the other statuses this endpoint can produce', () => {
    // 401 not signed in · 404 out of interaction scope · 429 over 60/min ·
    // 400 a body the serializer rejected.
    for (const status of [400, 401, 404, 429, 500, 0]) {
      expect(isTelemetryRefusedForMinor({ status })).toBe(false);
    }
  });

  it('is false for a non-object', () => {
    expect(isTelemetryRefusedForMinor(null)).toBe(false);
    expect(isTelemetryRefusedForMinor(undefined)).toBe(false);
    expect(isTelemetryRefusedForMinor('403')).toBe(false);
    expect(isTelemetryRefusedForMinor(403)).toBe(false);
  });

  it('does not throw on an object with no status', () => {
    expect(isTelemetryRefusedForMinor({})).toBe(false);
    expect(isTelemetryRefusedForMinor({ status: '403' })).toBe(false);
  });

  it('identifies the refusal from a live logTelemetry call', async () => {
    // End-to-end through the endpoint, so the helper is pinned to the error the
    // endpoint actually rejects with rather than to a hand-built shape.
    mockApiFetch.mockRejectedValue(
      new ApiError({
        status: 403,
        body: { detail: 'Telemetry is not collected for accounts of users under 18.' },
      }),
    );

    const outcome = await logTelemetry(CLIP, { watchTimeMs: 1 }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(outcome).toBeInstanceOf(ApiError);
    expect(isTelemetryRefusedForMinor(outcome)).toBe(true);
  });
});
