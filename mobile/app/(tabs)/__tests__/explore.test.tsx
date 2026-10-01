import { act, fireEvent, render } from '@testing-library/react-native';

import Screen from '../explore';
import { getSuggestions, mintPlaybackToken } from '../../../src/api/endpoints/feed';
import { loadClip, pause, resume, usePlayerStore } from '../../../src/store/player';

jest.mock('../../../src/hooks/useBackendStatus', () => ({ useBackendStatus: () => 'ok' }));
jest.mock('../../../src/api/endpoints/feed', () => ({
  getSuggestions: jest.fn(),
  mintPlaybackToken: jest.fn(),
}));
jest.mock('../../../src/store/player', () => {
  const { create } = require('zustand');
  return {
    loadClip: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    usePlayerStore: create(() => ({
      playingClipId: null,
      playback: 'idle',
      setQueue: jest.fn(),
      setActiveIndex: jest.fn(),
      setCardStatus: jest.fn(),
    })),
  };
});

const mockSuggestions = getSuggestions as jest.MockedFunction<typeof getSuggestions>;
const mockMintPlaybackToken = mintPlaybackToken as jest.MockedFunction<typeof mintPlaybackToken>;
const mockLoadClip = loadClip as jest.MockedFunction<typeof loadClip>;
const mockPause = pause as jest.MockedFunction<typeof pause>;
const mockResume = resume as jest.MockedFunction<typeof resume>;

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

beforeEach(() => {
  mockSuggestions.mockReset();
  mockMintPlaybackToken.mockReset();
  mockLoadClip.mockReset();
  mockPause.mockReset();
  mockResume.mockReset();
  usePlayerStore.setState({ playingClipId: null, playback: 'idle' });
});

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

  it('shows an accessible play control and starts the selected clip', async () => {
    mockSuggestions.mockResolvedValue({ clips: [clip('a')], next: null });
    mockMintPlaybackToken.mockResolvedValue({ status: 'ok', token: 'clip-scoped-token' });
    const screen = await render(<Screen />);

    const play = await screen.findByRole('button', { name: 'Play clip a' });
    await fireEvent.press(play);

    expect(mockMintPlaybackToken).toHaveBeenCalledWith('a');
    expect(mockLoadClip).toHaveBeenCalledWith(clip('a'), 'clip-scoped-token');
  });

  it('uses the visible control to pause or resume the active Discover clip', async () => {
    mockSuggestions.mockResolvedValue({ clips: [clip('a')], next: null });
    usePlayerStore.setState({ playingClipId: 'a', playback: 'playing' });
    const screen = await render(<Screen />);

    await fireEvent.press(await screen.findByRole('button', { name: 'Pause clip a' }));
    expect(mockPause).toHaveBeenCalledTimes(1);

    await act(async () => {
      usePlayerStore.setState({ playback: 'paused' });
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Play clip a' }));
    expect(mockResume).toHaveBeenCalledTimes(1);
  });
});
