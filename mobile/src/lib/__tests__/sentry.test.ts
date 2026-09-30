jest.mock('@sentry/react-native', () => ({ init: jest.fn() }));

import * as Sentry from '@sentry/react-native';

import { initMobileSentry } from '../sentry';

const init = Sentry.init as jest.MockedFunction<typeof Sentry.init>;

describe('initMobileSentry', () => {
  const previousDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  const previousChannel = process.env.EXPO_PUBLIC_RELEASE_CHANNEL;

  beforeEach(() => {
    init.mockClear();
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    delete process.env.EXPO_PUBLIC_RELEASE_CHANNEL;
  });

  afterAll(() => {
    if (previousDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    else process.env.EXPO_PUBLIC_SENTRY_DSN = previousDsn;
    if (previousChannel === undefined) delete process.env.EXPO_PUBLIC_RELEASE_CHANNEL;
    else process.env.EXPO_PUBLIC_RELEASE_CHANNEL = previousChannel;
  });

  it('stays inert in development without a DSN and never sends default PII', () => {
    initMobileSentry();
    expect(init).toHaveBeenCalledWith(expect.objectContaining({
      dsn: undefined,
      enabled: false,
      environment: 'development',
      sendDefaultPii: false,
      tracesSampleRate: 1,
    }));
  });

  it('enables production reporting only when a DSN is provided', () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://public@example.ingest.sentry.io/123';
    process.env.EXPO_PUBLIC_RELEASE_CHANNEL = 'production';
    initMobileSentry();
    expect(init).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      environment: 'production',
      sendDefaultPii: false,
      tracesSampleRate: 0.1,
    }));
  });
});
