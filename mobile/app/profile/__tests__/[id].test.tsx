import { fireEvent, render } from '@testing-library/react-native';

import Screen from '../[id]';
import { toggleFollow } from '../../../src/api/endpoints/social';

const mockParams = jest.fn();
const mockProfile = jest.fn();
const mockAuth = jest.fn();
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams() }));
jest.mock('../../../src/hooks/useBackendStatus', () => ({ useBackendStatus: () => 'ok' }));
jest.mock('../../../src/hooks/usePublicProfile', () => ({ usePublicProfile: (...args: unknown[]) => mockProfile(...args) }));
jest.mock('../../../src/store/auth', () => ({ useAuthStore: (selector: (s: { user: { id: number } }) => unknown) => selector(mockAuth()) }));
jest.mock('../../../src/api/endpoints/social', () => ({ toggleFollow: jest.fn() }));
const mockToggleFollow = toggleFollow as jest.MockedFunction<typeof toggleFollow>;

const loaded = {
  profile: { id: 42, username: 'alice', followers_count: 12, following_count: 3, uploads_count: 1, is_following: false },
  clips: [{ id: '11111111-1111-1111-1111-111111111111', title: 'Public clip', creator_name: 'alice', creator_id: 42, category: 'music', hls_playlist_url: null, likes: 0, shares: 0, skips: 0, comment_count: 0, is_liked: false }],
  loading: false, refreshing: false, loadingMore: false, error: null, refresh: jest.fn(), loadMore: jest.fn(),
};

beforeEach(() => {
  mockParams.mockReset(); mockProfile.mockReset(); mockAuth.mockReset(); mockToggleFollow.mockReset();
  mockParams.mockReturnValue({ id: '42' }); mockProfile.mockReturnValue(loaded); mockAuth.mockReturnValue({ user: { id: 1 } });
});

describe('public profile', () => {
  it('renders public fields and hydrates Follow from the server response', async () => {
    const screen = await render(<Screen />);
    expect(mockProfile).toHaveBeenCalledWith(42);
    expect(screen.getAllByText('alice')).toHaveLength(2);
    expect(screen.getByText('Public clip')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Follow' })).toBeTruthy();
  });

  it('sends one follow toggle and adopts the server status', async () => {
    mockToggleFollow.mockResolvedValue({ status: 'followed' });
    const screen = await render(<Screen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Follow' }));
    expect(mockToggleFollow).toHaveBeenCalledWith(42);
    await screen.findByRole('button', { name: 'Following' });
  });

  it('treats an invalid route id as unavailable without sending a request', async () => {
    mockParams.mockReturnValue({ id: 'clip-uuid' });
    mockProfile.mockReturnValue({ ...loaded, profile: null, clips: [], error: 'Invalid profile.' });
    const screen = await render(<Screen />);
    expect(mockProfile).toHaveBeenCalledWith(null);
    expect(screen.getByText('Invalid profile.')).toBeTruthy();
  });
});
