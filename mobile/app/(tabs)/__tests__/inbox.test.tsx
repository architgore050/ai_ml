import { fireEvent, render } from '@testing-library/react-native';

import Screen from '../inbox';
import { getShareInbox, markShareRead } from '../../../src/api/endpoints/share';

jest.mock('../../../src/hooks/useBackendStatus', () => ({ useBackendStatus: () => 'ok' }));
jest.mock('../../../src/api/endpoints/share', () => ({ getShareInbox: jest.fn(), markShareRead: jest.fn() }));
const mockInbox = getShareInbox as jest.MockedFunction<typeof getShareInbox>;
const mockMarkRead = markShareRead as jest.MockedFunction<typeof markShareRead>;

const item = {
  id: 'share-1', sender_name: 'alice', clip_title: 'A clip', clip_hls_url: null,
  created_at: '2026-09-30T00:00:00Z', is_read: false,
  clip: { id: '11111111-1111-1111-1111-111111111111', title: 'A clip', creator_name: 'alice', creator_id: 2, category: 'music', hls_playlist_url: null, likes: 0, shares: 0, skips: 0, comment_count: 0, is_liked: false },
};

beforeEach(() => {
  mockInbox.mockReset();
  mockMarkRead.mockReset();
});

describe('Inbox', () => {
  it('renders an unread share and refreshes after marking it read', async () => {
    mockInbox.mockResolvedValue([item]);
    mockMarkRead.mockResolvedValue();
    const screen = await render(<Screen />);

    await screen.findByText('A clip');
    await fireEvent.press(screen.getByRole('button', { name: 'Mark A clip as read' }));
    expect(mockMarkRead).toHaveBeenCalledWith('share-1');
    expect(mockInbox).toHaveBeenCalledTimes(2);
  });
});
