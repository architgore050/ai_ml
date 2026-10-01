import * as Sentry from '@sentry/react-native';

/** Preview/production error reporting. A missing DSN deliberately leaves it inert. */
export function initMobileSentry(): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN?.trim();
  const environment = process.env.EXPO_PUBLIC_RELEASE_CHANNEL?.trim() || 'development';
  Sentry.init({
    dsn,
    enabled: Boolean(dsn) && environment !== 'development',
    environment,
    sendDefaultPii: false,
    tracesSampleRate: environment === 'production' ? 0.1 : 1,
  });
}
