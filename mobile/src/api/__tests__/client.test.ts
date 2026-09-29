import {
  ApiError,
  __resetRefreshMutexForTests,
  apiFetch,
  onSessionExpired,
  setTokenStore,
} from '../client';

/**
 * Client tests. Plan §16 names these three explicitly: "api.ts refresh rotation,
 * 401 replay, 429 backoff". The refresh mutex is the one algorithm salvaged from
 * the old app, and rotation is why it is subtle — so it gets the most attention
 * here.
 */

const BASE = 'https://localhost:18443';

type Pair = { access: string; refresh: string };

let tokens: Pair | null = null;
let expiresFired = 0;

const memoryStore = {
  async getAccess() {
    return tokens?.access ?? null;
  },
  async getRefresh() {
    return tokens?.refresh ?? null;
  },
  async set(pair: Pair) {
    tokens = pair;
  },
  async clear() {
    tokens = null;
  },
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) =>
        headers[k.toLowerCase()] ?? (k.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/plain' : null) },
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

const noContent = () =>
  ({
    ok: true,
    status: 204,
    headers: { get: () => null },
    json: async () => {
      throw new Error('204 has no body');
    },
    text: async () => {
      throw new Error('204 has no body');
    },
  }) as unknown as Response;

beforeEach(() => {
  tokens = { access: 'access-1', refresh: 'refresh-1' };
  expiresFired = 0;
  __resetRefreshMutexForTests();
  setTokenStore(memoryStore);
  onSessionExpired(() => {
    expiresFired += 1;
  });
  global.fetch = jest.fn() as unknown as typeof fetch;
});

afterEach(() => {
  jest.resetAllMocks();
});

const mockFetch = () => global.fetch as unknown as jest.Mock;

/**
 * `apiFetch<T = unknown>` returns `Promise<unknown>`, so `await x.catch(e => e)`
 * widens to `unknown` and every property access on it is a type error. Typing
 * the success branch as `never` makes the catch branch the only possible value,
 * which is what these assertions are actually about.
 */
async function expectApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the request to reject with an ApiError');
}

describe('request shape', () => {
  it('sends the bearer token, and a Content-Type only when there is a body', async () => {
    mockFetch().mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch('/profile/me/');

    const [url, init] = mockFetch().mock.calls[0];
    expect(url).toBe(`${BASE}/profile/me/`);
    expect(init.headers.Authorization).toBe('Bearer access-1');
    // No body on a GET, so no Content-Type. Asserting one would encode the
    // opposite (wrong) behaviour.
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('sets Content-Type: application/json when a body is sent', async () => {
    mockFetch().mockResolvedValue(jsonResponse({ id: 'c1' }));

    await apiFetch('/comments/', { method: 'POST', body: { text: 'hi' } });

    expect(mockFetch().mock.calls[0][1].headers['Content-Type']).toBe('application/json');
  });

  it('omits Authorization when skipAuth is set', async () => {
    mockFetch().mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch('/legal/compliance/', { skipAuth: true });

    expect(mockFetch().mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('does not set Content-Type for FormData, so the boundary survives', async () => {
    mockFetch().mockResolvedValue(jsonResponse({ id: 'x' }));
    const form = new FormData();
    form.append('title', 'hello');

    await apiFetch('/clips/', { method: 'POST', body: form });

    expect(mockFetch().mock.calls[0][1].headers['Content-Type']).toBeUndefined();
  });

  it('returns null for 204 instead of parsing a body that is not there', async () => {
    mockFetch().mockResolvedValue(noContent());

    await expect(apiFetch('/interactions/1/toggle-like/')).resolves.toBeNull();
  });

  it('returns raw text when the response is not JSON', async () => {
    mockFetch().mockResolvedValue(textResponse('pong'));

    await expect(apiFetch('/ping/')).resolves.toBe('pong');
  });
});

describe('refresh rotation', () => {
  it('persists the rotated refresh token rather than keeping the old one', async () => {
    // Rotation is ON (settings.py:776), so the response ALWAYS carries a new
    // refresh and the previous one is blacklisted. The old client's
    // `data.refresh || tokens.refresh` fallback would keep a dead token here.
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ detail: 'expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ access: 'access-2', refresh: 'refresh-2' }))
      .mockResolvedValueOnce(jsonResponse({ id: 1, username: 'dev' }));

    await apiFetch('/profile/me/');

    expect(tokens).toEqual({ access: 'access-2', refresh: 'refresh-2' });
  });

  it('fails closed when the rotation response omits `refresh`', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ detail: 'expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ access: 'access-2' })) // no refresh!
      .mockResolvedValueOnce(jsonResponse({ id: 1, username: 'dev' }));

    await expect(apiFetch('/profile/me/')).rejects.toBeInstanceOf(ApiError);

    // A half-pair must not be stored: the old refresh is blacklisted server-side
    // by that point, so keeping it would loop forever.
    expect(tokens).toBeNull();
  });
});

describe('the single-flight mutex', () => {
  it('collapses concurrent 401s into ONE refresh', async () => {
    // With rotation on, a second concurrent refresh would present the refresh
    // token the first one just blacklisted — logging the user out. This is the
    // exact failure the mutex exists to prevent.
    let refreshCalls = 0;
    // Each slow path 401s on its FIRST call and succeeds on the replay, so the
    // test measures the mutex rather than measuring a repeated 401.
    const seen = new Map<string, number>();

    mockFetch().mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/token/refresh/')) {
        refreshCalls += 1;
        // Yield so all three callers are inside the mutex before the first
        // resolves — otherwise the test would pass even without a mutex.
        await new Promise((r) => setTimeout(r, 5));
        return jsonResponse({ access: 'access-2', refresh: 'refresh-2' });
      }
      const n = (seen.get(url) ?? 0) + 1;
      seen.set(url, n);
      await new Promise((r) => setTimeout(r, 1));
      if (url.includes('/slow') && n === 1) {
        return jsonResponse({ detail: 'expired' }, 401);
      }
      return jsonResponse({ ok: true, url });
    });

    const results = await Promise.all([
      apiFetch<{ url: string }>('/slow-a/'),
      apiFetch<{ url: string }>('/slow-b/'),
      apiFetch<{ url: string }>('/slow-c/'),
    ]);

    expect(refreshCalls).toBe(1);
    expect(tokens?.access).toBe('access-2');
    // All three replayed with the new token rather than failing. (fetch sees
    // the absolute URL, since rawFetch joins the base before calling it.)
    expect(results.map((r) => r.url).sort()).toEqual([
      `${BASE}/slow-a/`,
      `${BASE}/slow-b/`,
      `${BASE}/slow-c/`,
    ]);
  });
});

describe('401 handling', () => {
  it('replays the original request exactly once after a successful refresh', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ detail: 'expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ access: 'access-2', refresh: 'refresh-2' }))
      .mockResolvedValueOnce(jsonResponse({ id: 1, username: 'dev' }));

    await expect(apiFetch('/profile/me/')).resolves.toEqual({ id: 1, username: 'dev' });
    expect(mockFetch()).toHaveBeenCalledTimes(3);
    expect(mockFetch().mock.calls[2][1].headers.Authorization).toBe('Bearer access-2');
  });

  it('does NOT loop when the replay 401s again', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ detail: 'expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ access: 'access-2', refresh: 'refresh-2' }))
      .mockResolvedValueOnce(jsonResponse({ detail: 'expired' }, 401));

    await expect(apiFetch('/profile/me/')).rejects.toMatchObject({ status: 401 });
    // 3 calls, not 4: initial + refresh + one replay.
    expect(mockFetch()).toHaveBeenCalledTimes(3);
  });

  it('emits session-expired and clears tokens when the refresh itself fails', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ detail: 'expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ detail: 'token is blacklisted' }, 401));

    await expect(apiFetch('/profile/me/')).rejects.toBeInstanceOf(ApiError);
    expect(tokens).toBeNull();
    expect(expiresFired).toBeGreaterThanOrEqual(1);
  });

  it('does NOT sign out on a network failure during refresh', async () => {
    // Losing connectivity mid-session is not the same as being logged out.
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ detail: 'expired' }, 401))
      .mockRejectedValueOnce(new TypeError('Network request failed'));

    await expect(apiFetch('/profile/me/')).rejects.toBeInstanceOf(ApiError);
    expect(tokens).not.toBeNull();
    expect(expiresFired).toBe(0);
  });
});

describe('errors', () => {
  it('surfaces DRF field errors for form-level display', async () => {
    mockFetch().mockResolvedValue(
      jsonResponse({ terms_version: ['Invalid terms version. Allowed: [\'v1.0\']'] }, 400),
    );

    const err = await expectApiError(
      apiFetch('/auth/register/', { method: 'POST', body: {}, skipAuth: true }),
    );

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.fieldErrors.terms_version?.[0]).toContain('Invalid terms version');
  });

  it('marks a timeout as a timeout, not a generic network failure', async () => {
    const abortError = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    mockFetch().mockRejectedValue(abortError);

    const err = await expectApiError(apiFetch('/feed/', { timeoutMs: 1 }));

    expect(err.isTimeout).toBe(true);
    expect(err.isNetwork).toBe(false);
  });

  it('flags 429 and preserves Retry-After', async () => {
    mockFetch().mockResolvedValue(jsonResponse({ detail: 'throttled' }, 429, { 'retry-after': '42' }));

    const err = await expectApiError(apiFetch('/clips/', { method: 'POST', body: {} }));

    expect(err.isRateLimited).toBe(true);
    expect(err.message).toContain('42');
  });
});
