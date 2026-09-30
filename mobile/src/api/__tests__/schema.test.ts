import {
  AUTO_TRIGGER,
  bareArraySchema,
  commentSchema,
  cursorSchema,
  feedClipSchema,
  feedDegradedSchema,
  handRolledSchema,
  legalComplianceSchema,
  limitNumber,
  pageNumberSchema,
  subscriptionStatusSchema,
} from '../schema';

/**
 * Envelope tests. D5's whole reason for parsing at the boundary: the backend has
 * FOUR coexisting shapes, and picking the wrong one is SILENT. `res.results` on
 * a cursor page is `undefined`, which renders as "no comments" rather than as an
 * error — so each envelope needs a test proving it accepts its own shape and
 * does not quietly accept another's.
 */

const clip = {
  id: 'c1',
  title: 'Rain on tin',
  creator_name: 'dev',
  creator_id: 7,
  category: 'instrumental',
  hls_playlist_url: 'https://localhost:19443/hls/c1/master.m3u8',
  likes: 3,
  shares: 1,
  skips: 0,
  comment_count: 2,
  is_liked: false,
};

describe('envelope 1: PageNumberPagination', () => {
  const schema = pageNumberSchema(feedClipSchema);

  it('parses count/next/previous/results', () => {
    const parsed = schema.parse({
      count: 42,
      next: 'https://x/next',
      previous: null,
      results: [clip],
    });
    expect(parsed.count).toBe(42);
    expect(parsed.results).toHaveLength(1);
  });

  it('REJECTS a cursor envelope, because `count` is the discriminator', () => {
    // If this passed, a paginated endpoint that dropped `count` would silently
    // become "page 1 of 1" and the user could never reach page 2.
    expect(() => schema.parse({ next: null, previous: null, results: [] })).toThrow();
  });
});

describe('envelope 2: CursorPagination (no count)', () => {
  const schema = cursorSchema(commentSchema);

  it('parses without a count field', () => {
    const parsed = schema.parse({
      next: 'https://x/next',
      previous: null,
      results: [
        {
          id: 'k1',
          clip: 'c1',
          author_username: 'dev',
          parent: null,
          text: 'nice',
          reply_count: 0,
          created_at: '2026-09-29T00:00:00Z',
        },
      ],
    });
    expect(parsed.results[0]?.text).toBe('nice');
  });
  it('tolerates an extra `count` — a client must not break on a backend addition', () => {
    // Zod strips unknown keys by default, so a page-number payload also parses
    // here and `count` is simply dropped. That leniency is deliberate: the
    // asymmetry that matters is the OTHER direction (below), where `count` is
    // REQUIRED and a cursor payload is correctly rejected. An over-strict
    // `.strict()` here would break the app the day the backend adds a field.
    const parsed = schema.parse({ count: 1, next: null, previous: null, results: [] });
    expect(parsed.results).toEqual([]);
    expect('count' in parsed).toBe(false);
  });

  it('is distinguished from the page-number envelope by `count` being required', () => {
    // This is the invariant that actually protects the user: if `count` were
    // optional, a paginated endpoint that dropped it would silently become
    // "page 1 of 1" and page 2 would be unreachable.
    expect(() => pageNumberSchema(feedClipSchema).parse({ next: null, previous: null, results: [] })).toThrow();
  });
});

describe('envelope 3: hand-rolled with a sentinel `next`', () => {
  const schema = handRolledSchema(feedClipSchema);

  it('accepts the literal "auto_trigger" sentinel', () => {
    const parsed = schema.parse({ next: AUTO_TRIGGER, results: [clip] });
    expect(parsed.next).toBe('auto_trigger');
  });

  it('accepts a URL, null, and an absent `next`', () => {
    expect(schema.parse({ next: 'https://x', results: [] }).next).toBe('https://x');
    expect(schema.parse({ next: null, results: [] }).next).toBeNull();
    expect(schema.parse({ results: [] }).next).toBeUndefined();
  });
});

describe('envelope 4: bare top-level array', () => {
  const array = bareArraySchema(feedClipSchema);
  const object = handRolledSchema(feedClipSchema);

  it('/share/inbox/ returns an array, not an object', () => {
    const parsed = array.parse([clip, { ...clip, id: 'c2' }]);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]?.id).toBe('c2');
  });

  it('the object schema REJECTS the array — the two are not interchangeable', () => {
    // The old client defensively accepted both (api.ts:209-211). Keeping that
    // tolerance is fine; pretending they are the same shape is not, because it
    // is how a `.results` access on an array silently yields undefined.
    expect(object.safeParse([clip]).success).toBe(false);
  });
});

describe('GET /feed/ 202 cold start', () => {
  it('parses retry_after_ms — a server hint, not a suggestion', () => {
    const parsed = feedDegradedSchema.parse({ retry_after_ms: 1500, degraded: true });
    expect(parsed.retry_after_ms).toBe(1500);
  });

  it('tolerates a body with no retry hint', () => {
    expect(feedDegradedSchema.parse({ detail: 'warming up' }).retry_after_ms).toBeUndefined();
  });
});

describe('subscription limits are ALL strings', () => {
  it('parses limits and coerces the string "60" to a number', () => {
    // DictField(child=CharField) — the value arrives as a string. A truthiness
    // check works, but arithmetic on it concatenates.
    const parsed = subscriptionStatusSchema.parse({
      app_user_id: '123e4567-e89b-12d3-a456-426614174000',
      is_pro: false,
      expires_at: null,
      last_synced: '2026-10-01T00:00:00Z',
      limits: { max_clip_duration_seconds: '60', daily_upload_limit: '5' },
    });

    expect(parsed.limits?.max_clip_duration_seconds).toBe('60');
    expect(typeof parsed.limits?.max_clip_duration_seconds).toBe('string');
    expect(limitNumber(parsed.limits, 'max_clip_duration_seconds')).toBe(60);
  });

  it('returns null for a missing or unparseable limit rather than NaN', () => {
    expect(limitNumber(undefined, 'x')).toBeNull();
    expect(limitNumber({}, 'x')).toBeNull();
    expect(limitNumber({ x: 'not-a-number' }, 'x')).toBeNull();
  });
});

describe('legal/compliance', () => {
  it('parses the officer contacts and version list', () => {
    const parsed = legalComplianceSchema.parse({
      compliance_officer: { name: 'CCO', email: 'c@example.com' },
      grievance_officer: { name: 'GO', email: 'g@example.com' },
      nodal_contact: { name: 'NC', email: 'n@example.com' },
      terms_versions: ['v1.0', 'v1.1'],
      current_terms_version: 'v1.1',
      privacy_version: 'v1.0',
      physical_address: '1 Test St',
    });
    expect(parsed.current_terms_version).toBe('v1.1');
  });
});
