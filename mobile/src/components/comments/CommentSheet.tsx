import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { X } from 'lucide-react-native';

import { createComment, deleteComment, getComments, updateComment } from '../../api/endpoints/comments';
import type { Comment } from '../../api/schema';
import { accent, border, content, spacing, surface, zIndex } from '../../design/tokens';
import { typography } from '../../design/typography';
import { IconButton } from '../ui/Button';

export type CommentSheetProps = { visible: boolean; clipId: string; viewerId: number | null; onClose: () => void };

/** Clip-scoped top-level thread. Replies are intentionally absent until the server's parent/clip invariant is committed. */
export function CommentSheet({ visible, clipId, viewerId, onClose }: CommentSheetProps) {
  if (!visible) return null;
  return <CommentThread key={clipId} clipId={clipId} viewerId={viewerId} onClose={onClose} />;
}

function CommentThread({ clipId, viewerId, onClose }: Omit<CommentSheetProps, 'visible'>) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<Comment | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    setRefreshing(true); setError(null);
    void getComments(clipId).then(
      (page) => { if (mounted.current) { setComments(page.comments); setNext(page.next); } },
      (err: unknown) => { if (mounted.current) setError(err instanceof Error ? err.message : 'Could not load comments.'); },
    ).finally(() => { if (mounted.current) { setLoading(false); setRefreshing(false); } });
  }, [clipId]);

  useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; }; }, [refresh]);

  const submit = () => {
    if (saving) return;
    setSaving(true); setError(null);
    const task = editing ? updateComment(editing.id, text) : createComment(clipId, text);
    void task.then(
      (saved) => { if (!mounted.current) return; setComments((items) => editing ? items.map((item) => item.id === saved.id ? saved : item) : [saved, ...items]); setText(''); setEditing(null); },
      (err: unknown) => { if (mounted.current) setError(err instanceof Error ? err.message : 'Could not save comment.'); },
    ).finally(() => { if (mounted.current) setSaving(false); });
  };
  const remove = (id: string) => {
    void deleteComment(id).then(() => { if (mounted.current) setComments((items) => items.filter((item) => item.id !== id)); }, (err: unknown) => { if (mounted.current) setError(err instanceof Error ? err.message : 'Could not delete comment.'); });
  };
  const loadMore = () => {
    if (!next || loading) return;
    setLoading(true);
    void getComments(clipId, next).then((page) => { if (mounted.current) { setComments((items) => [...items, ...page.comments]); setNext(page.next); } }).finally(() => { if (mounted.current) setLoading(false); });
  };

  return <Modal transparent animationType="slide" visible onRequestClose={onClose} accessibilityViewIsModal>
    <View style={styles.scrim}><Pressable style={StyleSheet.absoluteFill} accessibilityElementsHidden onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.header}><Text style={styles.title}>Comments</Text><IconButton accessibilityLabel="Close comments" onPress={onClose}><X color={content.primary} size={20} /></IconButton></View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={accent.base} />} contentContainerStyle={styles.list}>
          {loading && comments.length === 0 ? <ActivityIndicator color={accent.base} /> : null}
          {!loading && comments.length === 0 ? <Text style={styles.empty}>Be the first to comment.</Text> : null}
          {comments.map((comment) => <View key={comment.id} style={styles.comment}><Text style={typography.microLabel}>{comment.author_username}</Text><Text style={styles.commentText}>{comment.text}</Text>{comment.author_id === viewerId ? <View style={styles.row}><Pressable accessibilityRole="button" accessibilityLabel={`Edit comment by ${comment.author_username}`} onPress={() => { setEditing(comment); setText(comment.text); }}><Text style={styles.link}>Edit</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`Delete comment by ${comment.author_username}`} onPress={() => remove(comment.id)}><Text style={styles.link}>Delete</Text></Pressable></View> : null}</View>)}
          {next ? <Pressable accessibilityRole="button" accessibilityLabel="Load more comments" onPress={loadMore}><Text style={styles.link}>Load more</Text></Pressable> : null}
        </ScrollView>
        <View style={styles.composer}><TextInput value={text} onChangeText={setText} placeholder={editing ? 'Edit comment' : 'Add a comment'} placeholderTextColor={content.tertiary} multiline maxLength={500} style={styles.input} /><Pressable accessibilityRole="button" accessibilityLabel={editing ? 'Save comment' : 'Post comment'} disabled={saving || !text.trim()} onPress={submit} style={[styles.post, (saving || !text.trim()) && styles.disabled]}>{saving ? <ActivityIndicator color={surface.base} /> : <Text style={styles.postText}>{editing ? 'Save' : 'Post'}</Text>}</Pressable></View>
      </View>
    </View>
  </Modal>;
}

const statusColor = '#ffb4ab';
const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)', zIndex: zIndex.sheet }, sheet: { maxHeight: '78%', minHeight: 300, padding: spacing.stack, gap: spacing.gutter, backgroundColor: surface.container, borderTopLeftRadius: 24, borderTopRightRadius: 24 }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, title: { ...typography.title, color: content.primary }, list: { gap: spacing.gutter, paddingBottom: spacing.stack }, comment: { borderWidth: 1, borderColor: border.default, borderRadius: 12, padding: spacing.gutter, gap: 4 }, commentText: { ...typography.body, color: content.primary }, row: { flexDirection: 'row', gap: spacing.stack }, link: { ...typography.microLabel, color: accent.base, paddingVertical: 4 }, empty: { ...typography.bodySecondary, color: content.tertiary, textAlign: 'center', padding: spacing.stack }, error: { ...typography.bodySecondary, color: statusColor }, composer: { flexDirection: 'row', gap: spacing.gutter, alignItems: 'flex-end' }, input: { flex: 1, minHeight: 48, maxHeight: 100, borderWidth: 1, borderColor: border.default, borderRadius: 12, padding: spacing.gutter, color: content.primary }, post: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.stack, borderRadius: 999, backgroundColor: accent.base }, postText: { ...typography.label, color: surface.base }, disabled: { opacity: 0.45 },
});
