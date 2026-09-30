jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: { configure: jest.fn(), logIn: jest.fn(), logOut: jest.fn(), getCustomerInfo: jest.fn() },
}));

import Purchases from 'react-native-purchases';
import {
  __resetRevenueCatForTests,
  hasActiveRevenueCatEntitlement,
  identifyRevenueCat,
  logoutRevenueCat,
  revenueCatEntitlementId,
} from '../revenuecat';

const mockPurchases = Purchases as unknown as {
  configure: jest.Mock;
  logIn: jest.Mock;
  logOut: jest.Mock;
};

beforeEach(() => {
  __resetRevenueCatForTests();
  jest.clearAllMocks();
  process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY = 'goog_public_key';
  process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY = 'appl_public_key';
  delete process.env.EXPO_PUBLIC_REVENUECAT_ENTITLEMENT_ID;
});

it('configures once and logs in with the backend-owned id', async () => {
  await identifyRevenueCat('123e4567-e89b-12d3-a456-426614174000');
  await identifyRevenueCat('123e4567-e89b-12d3-a456-426614174000');
  expect(mockPurchases.configure).toHaveBeenCalledTimes(1);
  expect(mockPurchases.logIn).toHaveBeenCalledTimes(2);
  expect(mockPurchases.logIn).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174000');
});

it('maps only the configured active entitlement to pro', () => {
  expect(hasActiveRevenueCatEntitlement({ entitlements: { active: { pro: {} } } })).toBe(true);
  expect(hasActiveRevenueCatEntitlement({ entitlements: { active: {} } })).toBe(false);
  expect(revenueCatEntitlementId()).toBe('pro');
});

it('logs out only after the SDK has been configured', async () => {
  await logoutRevenueCat();
  expect(mockPurchases.logOut).not.toHaveBeenCalled();
  await identifyRevenueCat('123e4567-e89b-12d3-a456-426614174000');
  await logoutRevenueCat();
  expect(mockPurchases.logOut).toHaveBeenCalledTimes(1);
});
