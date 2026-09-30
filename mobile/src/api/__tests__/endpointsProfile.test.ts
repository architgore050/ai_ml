import { getPublicProfile, getPublicProfileClips } from '../endpoints/profile';
import { apiFetch } from '../client';

jest.mock('../client', () => ({ apiFetch: jest.fn() }));
const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

const clip = {
  id: '11111111-1111-1111-1111-111111111111', title: 'A clip', creator_name: 'alice', creator_id: 42,
  category: 'music', hls_playlist_url: null, likes: 0, shares: 0, skips: 0, comment_count: 0, is_liked: false,
};

const profile = {
  id: 42, username: 'alice', profile_picture: null, profile_picture_url: null,
  followers_count: 12, following_count: 3, uploads_count: 1, is_following: false,
  date_joined: '2026-09-30T00:00:00Z',
};

beforeEach(() => mockApiFetch.mockReset());

describe('public profile endpoints', () => {
  it('gets a public profile by integer User id and validates its follow state', async () => {
    mockApiFetch.mockResolvedValue(profile);

    await expect(getPublicProfile(42)).resolves.toEqual(profile);
    expect(mockApiFetch).toHaveBeenCalledWith('/profile/42/');
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'refuses malformed user id %s before it reaches a Django path converter',
    async (id) => {
      await expect(getPublicProfile(id)).rejects.toThrow('positive integer User id');
      expect(mockApiFetch).not.toHaveBeenCalled();
    },
  );

  it('keeps only DRF’s opaque cursor when loading subsequent public clips', async () => {
    mockApiFetch.mockResolvedValue({
      next: 'https://api.example.test/profile/42/clips/?cursor=opaque%2Bcursor',
      previous: null,
      results: [clip],
    });

    await expect(getPublicProfileClips(42)).resolves.toEqual({ clips: [clip], next: 'opaque+cursor' });
    expect(mockApiFetch).toHaveBeenCalledWith('/profile/42/clips/');

    mockApiFetch.mockResolvedValue({ next: null, previous: null, results: [] });
    await expect(getPublicProfileClips(42, 'opaque+cursor')).resolves.toEqual({ clips: [], next: null });
    expect(mockApiFetch).toHaveBeenLastCalledWith('/profile/42/clips/?cursor=opaque%2Bcursor');
  });

  it('rejects a paginated profile clip response that does not have the cursor envelope', async () => {
    mockApiFetch.mockResolvedValue({ count: 1, next: null, previous: null, results: [clip] });
    await expect(getPublicProfileClips(42)).rejects.toThrow();
  });
});
