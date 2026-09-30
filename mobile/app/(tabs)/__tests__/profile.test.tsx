import { fireEvent, render } from '@testing-library/react-native';

import Screen from '../profile';
import { getMyProfile } from '../../../src/api/endpoints/auth';

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

jest.mock('../../../src/hooks/useBackendStatus', () => ({ useBackendStatus: () => 'ok' }));
jest.mock('../../../src/api/endpoints/auth', () => ({ getMyProfile: jest.fn() }));
const mockProfile = getMyProfile as jest.MockedFunction<typeof getMyProfile>;

beforeEach(() => mockProfile.mockReset());

describe('own Profile', () => {
  it('renders only its own profile response and liked clips', async () => {
    mockProfile.mockResolvedValue({
      id: 1, username: 'listener', followers_count: 3, following_count: 4, uploads_count: 5,
      liked_clips: [{ id: '11111111-1111-1111-1111-111111111111', title: 'Liked clip', creator_name: 'creator', creator_id: 2, category: 'music', hls_playlist_url: null, likes: 0, shares: 0, skips: 0, comment_count: 0, is_liked: true }],
    });
    const screen = await render(<Screen />);

    await screen.findByText('listener');
    expect(screen.getByText('Liked clip')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('offers a retry when the profile request fails', async () => {
    mockProfile.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ id: 1, username: 'listener' });
    const screen = await render(<Screen />);

    await screen.findByText('offline');
    await fireEvent.press(screen.getByRole('button', { name: 'Retry profile' }));
    expect(mockProfile).toHaveBeenCalledTimes(2);
  });
});
