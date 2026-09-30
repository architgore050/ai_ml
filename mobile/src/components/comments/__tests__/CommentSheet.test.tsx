import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { CommentSheet } from '../CommentSheet';
import { createComment, getComments } from '../../../api/endpoints/comments';

jest.mock('../../../api/endpoints/comments', () => ({ createComment: jest.fn(), deleteComment: jest.fn(), getComments: jest.fn(), updateComment: jest.fn() }));
const mockGet = getComments as jest.MockedFunction<typeof getComments>;
const mockCreate = createComment as jest.MockedFunction<typeof createComment>;
const CLIP = '11111111-1111-1111-1111-111111111111';
const comment = { id: '22222222-2222-2222-2222-222222222222', clip: CLIP, author_username: 'alice', author_id: 2, parent: null, text: 'hello', reply_count: 0, created_at: '2026-09-30T00:00:00Z' };

beforeEach(() => { mockGet.mockReset(); mockCreate.mockReset(); mockGet.mockResolvedValue({ comments: [comment], next: null }); });

describe('CommentSheet', () => {
  it('loads only the selected clip and exposes its comments', async () => {
    const screen = await render(<CommentSheet visible clipId={CLIP} viewerId={1} onClose={jest.fn()} />);
    await screen.findByText('hello');
    expect(mockGet).toHaveBeenCalledWith(CLIP);
  });

  it('posts a top-level comment into the selected clip', async () => {
    mockCreate.mockResolvedValue({ ...comment, id: 'new', text: 'new comment' });
    const screen = await render(<CommentSheet visible clipId={CLIP} viewerId={1} onClose={jest.fn()} />);
    await screen.findByText('hello');
    fireEvent.changeText(screen.getByPlaceholderText('Add a comment'), 'new comment');
    await screen.findByDisplayValue('new comment');
    await fireEvent.press(screen.getByRole('button', { name: 'Post comment' }));
    await screen.findByText('new comment');
    expect(mockCreate).toHaveBeenCalledWith(CLIP, 'new comment');
  });

  it('posts a reply with the selected same-clip parent', async () => {
    mockCreate.mockResolvedValue({ ...comment, id: 'reply', parent: comment.id, text: 'a reply' });
    const screen = await render(<CommentSheet visible clipId={CLIP} viewerId={1} onClose={jest.fn()} />);
    await screen.findByText('hello');
    await fireEvent.press(screen.getByRole('button', { name: 'Reply to comment by alice' }));
    fireEvent.changeText(screen.getByPlaceholderText('Reply to alice'), 'a reply');
    await screen.findByDisplayValue('a reply');
    await fireEvent.press(screen.getByRole('button', { name: 'Post comment' }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith(CLIP, 'a reply', comment));
  });
});
