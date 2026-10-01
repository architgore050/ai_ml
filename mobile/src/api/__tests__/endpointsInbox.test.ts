import { getShareInbox, markShareRead } from '../endpoints/share';
import { apiFetch } from '../client';

jest.mock('../client', () => ({ apiFetch: jest.fn() }));
const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

const item = {
  id: 'share-1', sender_name: 'alice', clip_title: 'A clip', clip_hls_url: null,
  created_at: '2026-09-30T00:00:00Z', is_read: false,
  clip: { id: '11111111-1111-1111-1111-111111111111', title: 'A clip', creator_name: 'alice', creator_id: 2, category: 'music', hls_playlist_url: null, likes: 0, shares: 0, skips: 0, comment_count: 0, is_liked: false },
};

beforeEach(() => mockApiFetch.mockReset());

describe('share inbox endpoints', () => {
  it('parses the inbox as a bare array, not a page envelope', async () => {
    mockApiFetch.mockResolvedValue([item]);
    await expect(getShareInbox()).resolves.toEqual([item]);
    expect(mockApiFetch).toHaveBeenCalledWith('/share/inbox/');
  });

  it('rejects a paginated envelope so a contract drift cannot look empty', async () => {
    mockApiFetch.mockResolvedValue({ results: [item], next: null });
    await expect(getShareInbox()).rejects.toThrow();
  });

  it('marks a share with POST and no body', async () => {
    mockApiFetch.mockResolvedValue(null);
    await markShareRead('share-1');
    expect(mockApiFetch).toHaveBeenCalledWith('/share/share-1/mark-read/', { method: 'POST' });
  });
});
