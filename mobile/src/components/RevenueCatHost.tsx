import { useSubscription } from '../hooks/useSubscription';

/** Keeps RevenueCat identified for the authenticated session. Renders nothing. */
export function RevenueCatHost(): null {
  useSubscription();
  return null;
}
