import { act, fireEvent, render } from '@testing-library/react-native';

import Screen from '../explore';
import { getSuggestions } from '../../../src/api/endpoints/feed';

jest.mock('../../../src/hooks/useBackendStatus', () => ({ useBackendStatus: () => 'ok' }));
jest.mock('../../../src/api/endpoints/feed', () => ({ getSuggestions: jest.fn() }));

const mockSuggestions = getSuggestions as jest.MockedFunction<typeof getSuggestions>;

const clip = (id: string) => ({
  id,
  title: `clip ${id}`,
  creator_name: 'creator',
  creator_id: 1,
  category: 'music',
  hls_playlist_url: `https://media.example/${id}.m3u8`,
  likes: 0,
  shares: 0,
  skips: 0,
  comment_count: 0,
  is_liked: false,
});

beforeEach(() => mockSuggestions.mockReset());

describe('Discover', () => {
  it('uses the exact category value and renders results', async () => {
    mockSuggestions.mockResolvedValue({ clips: [clip('a')], next: null });
    const screen = await render(<Screen />);

    await screen.findByText('clip a');
    expect(mockSuggestions).toHaveBeenCalledWith('all');

    await fireEvent.press(screen.getByRole('button', { name: 'Music' }));
    await screen.findByText('clip a');
    expect(mockSuggestions).toHaveBeenLastCalledWith('music');
  });

  it('paginates with the cursor the endpoint returned', async () => {
    mockSuggestions
      .mockResolvedValueOnce({ clips: [clip('a')], next: 'opaque-cursor' })
      .mockResolvedValueOnce({ clips: [clip('b')], next: null });
    const screen = await render(<Screen />);

    await screen.findByText('clip a');
    await act(async () => {
      screen.getByTestId('discover-list').props.onEndReached();
    });

    await screen.findByText('clip b');
    expect(mockSuggestions).toHaveBeenLastCalledWith('all', 'opaque-cursor');
  });

  it('offers a retry when the initial request fails', async () => {
    mockSuggestions
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ clips: [], next: null });
    const screen = await render(<Screen />);

    await screen.findByText('offline');
    await fireEvent.press(screen.getByRole('button', { name: 'Retry Discover' }));
    expect(mockSuggestions).toHaveBeenCalledTimes(2);
  });
});
