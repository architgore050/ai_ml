import { createComment, deleteComment, getComments, updateComment } from '../endpoints/comments';
import { apiFetch } from '../client';

jest.mock('../client', () => ({ apiFetch: jest.fn() }));
const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;
const CLIP = '11111111-1111-1111-1111-111111111111';
const comment = { id: '22222222-2222-2222-2222-222222222222', clip: CLIP, author_username: 'alice', author_id: 2, parent: null, text: 'hello', reply_count: 0, created_at: '2026-09-30T00:00:00Z' };

beforeEach(() => mockApiFetch.mockReset());

describe('comment endpoints', () => {
  it('lists only one clip and retains DRF’s opaque cursor', async () => {
    mockApiFetch.mockResolvedValue({ next: `https://api.test/comments/?clip=${CLIP}&cursor=next%2Bpage`, previous: null, results: [comment] });
    await expect(getComments(CLIP)).resolves.toEqual({ comments: [comment], next: 'next+page' });
    expect(mockApiFetch).toHaveBeenCalledWith(`/comments/?clip=${CLIP}`);
  });

  it('posts trimmed text and rejects empty text before it spends comment throttle budget', async () => {
    mockApiFetch.mockResolvedValue(comment);
    await expect(createComment(CLIP, ' hello ')).resolves.toEqual(comment);
    expect(mockApiFetch).toHaveBeenCalledWith('/comments/', { method: 'POST', body: { clip: CLIP, text: 'hello' } });
    mockApiFetch.mockReset();
    await expect(createComment(CLIP, ' \n ')).rejects.toThrow('cannot be empty');
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('patches text and deletes through detail paths', async () => {
    mockApiFetch.mockResolvedValue(comment);
    await updateComment(comment.id, 'edited');
    expect(mockApiFetch).toHaveBeenLastCalledWith(`/comments/${comment.id}/`, { method: 'PATCH', body: { text: 'edited' } });
    mockApiFetch.mockResolvedValue(null);
    await deleteComment(comment.id);
    expect(mockApiFetch).toHaveBeenLastCalledWith(`/comments/${comment.id}/`, { method: 'DELETE' });
  });
});
