import { apiFetch } from '../client';
import { getSubscription, getSubscriptionManageUrl, syncSubscription } from '../endpoints/subscription';

jest.mock('../client', () => ({ apiFetch: jest.fn() }));

const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;
const appUserId = '123e4567-e89b-12d3-a456-426614174000';

beforeEach(() => mockApiFetch.mockReset());

it('parses the stable RevenueCat app user id from the API', async () => {
  mockApiFetch.mockResolvedValue({
    app_user_id: appUserId,
    is_pro: true,
    expires_at: null,
    grace_until: null,
    last_synced: '2026-10-01T00:00:00Z',
    limits: { max_clip_duration_seconds: '600' },
  });

  await expect(getSubscription()).resolves.toMatchObject({ app_user_id: appUserId, is_pro: true });
  expect(mockApiFetch).toHaveBeenCalledWith('/subscription/');
});

it('rejects a response without a stable customer id', async () => {
  mockApiFetch.mockResolvedValue({ is_pro: false, limits: {} });
  await expect(getSubscription()).rejects.toThrow();
});

it('uses the sync and manage routes without inventing retries', async () => {
  mockApiFetch.mockResolvedValueOnce({ detail: 'sync queued' }).mockResolvedValueOnce({ url: 'https://billing.example.test/portal' });
  await expect(syncSubscription()).resolves.toEqual({ detail: 'sync queued' });
  await expect(getSubscriptionManageUrl()).resolves.toEqual({ url: 'https://billing.example.test/portal' });
  expect(mockApiFetch).toHaveBeenNthCalledWith(1, '/subscription/sync/', { method: 'POST' });
  expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/subscription/manage/');
});
