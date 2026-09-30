import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Check, Search, Send, X } from 'lucide-react-native';

import {
  accent,
  border,
  content,
  radius,
  spacing,
  status,
  surface,
  zIndex,
} from '../../design/tokens';
import { typography } from '../../design/typography';
import { findShareUser, sendShare } from '../../api/endpoints/share';
import {
  applySearchResult,
  beginSearch,
  confirmSend,
  emptyShareDraft,
  failSearch,
  failSend,
  isSendDisabled,
  NO_PEER_LIST_COPY,
  RESEND_NOTICE,
  SHARE_UNAVAILABLE_COPY,
  shareKey,
  startSend,
  type ShareDraftState,
  type ShareSendKey,
} from '../../lib/shareDraft';
import { IconButton } from '../ui/Button';
import { hitSlop, onAccent, touchableStyle, uiStyles } from '../ui/primitives';

/**
 * The share sheet: find one listener by username, send them this clip.
 *
 * ## PROVENANCE, AND THE ONE THING DELIBERATELY NOT PORTED
 * `frontend/src/components/sharing/ShareModal.tsx` is the reference
 * implementation and it is correct — its comments are the value, not its markup.
 * Ported: the submit-driven search, the result row that shows the STORED
 * username, `shareKey`'s clip-scoping, the per-key in-flight guard, the
 * reset-on-open rule, and the empty state.
 *
 * **The "Network Peers" list is not ported, because it was never a UI.** The old
 * client hardcoded four rows carrying real `User` primary keys 1-4; one tap wrote
 * a `ShareEvent`, incremented the clip's share counter and dropped an unread
 * inbox item into a stranger's account, then rendered a green "Sent" (`651ac0c`).
 * There is no peer list, contact list, suggestions endpoint or "people you follow"
 * endpoint in this codebase — `GET /share/find-user/` is the only user directory
 * and it is exact-match. `NO_PEER_LIST_COPY` is the honest alternative to
 * inventing one, and no send control exists in the tree until a search has
 * produced a recipient.
 *
 * ## THE INVARIANT: NO `receiver_id` WITHOUT A SEARCH RESULT
 * The old bug was "a share went to a stranger", so the fix is not "be careful with
 * the id" — it is that no other id is reachable. Three layers, two in
 * `lib/shareDraft.ts` and one here:
 *   1. `startSend` refuses with `'no-recipient'` and no request is made.
 *   2. This component renders no send control until `draft.recipient` is set.
 *   3. `onSend` takes NO ARGUMENT, so no `onPress` — however it is wired — can
 *      supply an id. The one it passes comes from `attempt.recipient`, whose type
 *      is `z.number().int().positive()` parsed out of a `find-user` response body.
 *      A clip UUID cannot inhabit that type.
 *
 * ## MOUNT-PER-OPEN, NOT RESET-IN-AN-EFFECT
 * `ShareModal` holds no state; `ShareSheet` holds all of it and exists only while
 * `visible` is true. "Sent state resets when the sheet closes" is therefore
 * STRUCTURAL — the state cannot outlive the sheet — rather than an effect that
 * runs a tick after the reopen paint, which would show the previous clip's "Sent"
 * for one frame. The web client had to do it in an effect
 * (`ShareModal.tsx:124-134`) because it was mounted once for the feed's lifetime
 * and only ever flipped `isOpen`; the split here makes the effect unnecessary.
 * `key={clipId}` extends the same argument to a clip change mid-session.
 *
 * It also settles the ABA question for free: a response that lands after a close
 * finds no state with a pending key for it, so `confirmSend`/`failSend` treat it
 * as a no-op — the same argument `followState.ts::isCurrentRequest` makes.
 *
 * ## THE SEARCH IS SUBMIT-DRIVEN, AND THAT IS A THROTTLE DECISION
 * `find-user` draws on `share_poll` = 1000/hour (`settings.py:1014`), a budget the
 * view sizes for an inbox poller at 3.6 s intervals. A debounced-on-keystroke
 * search turns one typo into six requests, so there is exactly one request per
 * submit — via the keyboard's search key or the button, both on the same handler.
 * `findShareUser` also refuses a query longer than `User.username`'s 150 columns
 * before the request; `maxLength` is deliberately NOT set on the input, because a
 * silently truncated pasted name is worse than saying so.
 *
 * ## 404 AND 409 ARE NOT THE SAME SENTENCE
 * A 409 means the name matches more than one account and the server refused to
 * guess which (`views/social.py:174-186`); a 404 means nobody has it. The web
 * client has no 409 branch and falls through to a generic message, which tells
 * someone looking for a colleague that the colleague does not exist. Both paths
 * live in `lib/shareDraft.ts` and are asserted to differ.
 *
 * ## A11y
 * `accessibilityViewIsModal` is RN's `aria-modal`: it tells VoiceOver and TalkBack
 * to ignore the reel behind. Focus moves in through `autoFocus` on the input —
 * the platform-native equivalent of the web client's `dialogRef.focus()` — and
 * there is no focus to restore afterwards, because RN's `Modal` is its own window.
 * That is also why the DOM focus trap in `ShareModal.tsx:154-184` has no
 * counterpart here: the platform has already trapped it. Three dismiss routes: the
 * close button, the scrim, and Android's hardware back (`onRequestClose`).
 *
 * The scrim is hidden from the a11y tree on purpose — a full-screen invisible
 * button is a VoiceOver trap, and the labelled close button is the dismiss action
 * a screen-reader user actually needs.
 *
 * ## HOW A CALLER MOUNTS IT — a callback, not a route
 * `ActionCluster` takes `onOpenShare: () => void` and nothing else
 * (`ActionCluster.tsx:256`), so the sheet is a CONTROL the feed owns rather than a
 * destination. Mount it once, above the reel, and drive it with state:
 *
 *     <ShareModal
 *       visible={shareClipId === clip.id}
 *       clipId={clip.id}
 *       title={clip.title}
 *       creatorName={clip.creator_name}
 *       isShareable={isShareable}
 *       onClose={() => setShareClipId(null)}
 *     />
 *
 * Mounting it once is supported and is the arrangement this component is built
 * for — that is why the reset is mount-per-open and `key`-per-clip rather than an
 * effect. `visible={false}` renders nothing, so there is no "close" work to do.
 * `isShareable` must be the same value `ActionCluster` gates its button on, or the
 * sheet can offer a send the reel has already ruled out.
 */

export type ShareModalProps = {
  /** The clip being shared. A UUID — `AudioClip.id`, NOT a `User.pk`. */
  clipId: string;
  /** Clip title, for the summary row. Optional; the sheet works without it. */
  title?: string;
  /** `FeedClip.creator_name`, for the summary row. */
  creatorName?: string;
  /**
   * False when the clip must not be shared.
   *
   * The copy deliberately says the clip cannot be shared and NOT why: a caller
   * holding only a UUID learns nothing about moderation or licensing state, which
   * is the rule `cardStatusReport` applies to its two 403 causes
   * (`ReelCard.tsx:331-342`) and that `ActionCluster`'s share label follows.
   *
   * Honoured twice — a standing notice, and a refusal inside `startSend` — so a
   * clip that becomes unshareable while the sheet is open cannot be sent.
   */
  isShareable: boolean;
  /** Mount state. False renders nothing at all; see the mount-per-open note. */
  visible: boolean;
  /** Dismiss: the close button, the scrim, and Android's back gesture. */
  onClose: () => void;
};

/** `lucide-react-native@1.48.0` — the sizes used below. */
const ICON_SIZE = 20;
const AVATAR_SIZE = 36;

/**
 * State-less wrapper. `if (!visible) return null` lives HERE and every hook lives
 * below, in a component that only exists while the sheet is up.
 *
 * `key={clipId}` is load-bearing and not decoration. React reconciles by type and
 * position, so a sheet left open while the feed moves to another clip would keep
 * the SAME instance — carrying the previous clip's recipient, its in-flight key and
 * its "Sent" badge into a share about a different clip. That is the old web
 * client's defect in its other form (`sentUsers` keyed by recipient alone,
 * `651ac0c`), and the clip-scoped `shareKey` does not save it: `draft.clipId`
 * would disagree with the `clipId` prop the send URL is built from. The `key`
 * makes a clip change a remount, so state cannot span two clips at all.
 */
export function ShareModal(props: ShareModalProps) {
  if (!props.visible) return null;
  return <ShareSheet key={props.clipId} {...props} />;
}

function ShareSheet({ clipId, title, creatorName, isShareable, onClose }: ShareModalProps) {
  /**
   * One sheet, one draft. `emptyShareDraft` is a lazy initialiser rather than a
   * value, so a fresh mount cannot inherit anything, and `draft.clipId` is the
   * clip every send key is scoped to.
   */
  const [draft, setDraft] = useState<ShareDraftState>(() => emptyShareDraft(clipId));
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);

  /**
   * Submit-driven: one request per press.
   *
   * The `if (searching) return` guard is here rather than in `shareDraft`, and it
   * is much weaker than the send guard on purpose. A duplicate `find-user` costs a
   * round trip and a little `share_poll` budget and cannot corrupt anything; a
   * duplicate `send-share` writes a second inbox row into a stranger's account.
   * Two different guards because the failure modes are not the same.
   */
  const onSearch = useCallback(async () => {
    if (searching) return;
    const begin = beginSearch(draft, query);
    setDraft(begin.state);
    if (begin.kind !== 'ready') return;

    setSearching(true);
    try {
      const found = await findShareUser(begin.query);
      // Functional update: a response that lands after the user has typed a new
      // name must not resurrect the row they just replaced.
      setDraft((prev) => applySearchResult(prev, found));
    } catch (err: unknown) {
      setDraft((prev) => failSearch(prev, err));
    } finally {
      setSearching(false);
    }
  }, [draft, query, searching]);

  /**
   * The request and its settle.
   *
   * `clipId` comes from the prop rather than from the draft; they cannot disagree
   * because the draft is built from this prop and nothing writes to it. The settle
   * quotes the KEY back, and `confirmSend`/`failSend` ignore a key that is no
   * longer outstanding — so a response that lands after the sheet has moved on
   * writes nothing instead of marking whatever is on screen now.
   *
   * `receiverId` is a parameter of THIS function and not of `onSend`, which is
   * what keeps the press handler argument-free: by the time an id exists, it came
   * out of `startSend`'s `'sent'` branch, i.e. out of a search result.
   */
  const dispatchSend = useCallback(
    async (key: ShareSendKey, receiverId: number) => {
      try {
        await sendShare(clipId, receiverId);
        setDraft((prev) => confirmSend(prev, key));
      } catch (err: unknown) {
        setDraft((prev) => failSend(prev, key, err));
      }
    },
    [clipId],
  );

  /**
   * The send. **No parameter, and that is the point** — see the module docstring.
   *
   * `startSend` decides and this handler only executes. On `'ignored'` the
   * returned state IS the current one, so the unconditional `setDraft` re-renders
   * nothing; on `'refused'` the copy rides in on the state so there is one
   * rendering path for every failure.
   */
  const onSend = useCallback(() => {
    const attempt = startSend(draft, isShareable);
    setDraft(attempt.state);
    if (attempt.kind !== 'sent') return;
    void dispatchSend(attempt.key, attempt.recipient.id);
  }, [dispatchSend, draft, isShareable]);

  const recipient = draft.recipient;
  /** `null` before any search, which is why there is no control to press. */
  const key = recipient ? shareKey(clipId, recipient.id) : null;
  const pending = key !== null && draft.pendingKeys[key] === true;
  const sent = key !== null && draft.sentKeys[key] === true;
  /**
   * `isSendDisabled`, NOT `canSend`. The two differ in exactly one state —
   * `pending` — and the difference is deliberate: a press while a request is in
   * flight is a DUPLICATE, not an invalid press, so the control stays enabled and
   * the platform's `busy` state carries the news. See `isSendDisabled`'s docstring
   * for the WCAG 2.4.3 argument and for why it is also what makes the
   * duplicate-press guard reachable through the real press path in a test.
   */
  const sendDisabled = isSendDisabled(draft, isShareable);

  /**
   * The send control's accessible name carries the state, because a screen reader
   * gets no colour and no spinner: `busy` in `accessibilityState` covers "working"
   * on both platforms, and the label changes on success so "Sent" is announced
   * rather than merely drawn.
   */
  const sendLabel = sent
    ? `Sent to @${recipient?.username}`
    : pending
      ? `Sending to @${recipient?.username}`
      : `Send this clip to @${recipient?.username}`;

  return (
    /*
     * `Modal`, not an absolutely-positioned View. Three things come free and all
     * three matter: the reel behind cannot take a touch while the sheet is up (an
     * overlay View leaves `PlayOverlay`'s full-bleed pressable live underneath),
     * Android's hardware back routes to `onRequestClose`, and the content becomes
     * its own window — which is what lets `autoFocus` land.
     *
     * `zIndex.sheet` (800) sits on the BACKDROP, not on the modal: `Modal` renders
     * in its own window above this app's, so the token would be inert there. It is
     * applied because the value exists (tokens.ts:605), because it is the right
     * relationship to `nav` (200) if this ever renders inline, and because it keeps
     * the intent readable. It is below `toast` (5000) and the banners, so a
     * network failure can still be reported over an open sheet.
     */
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View testID="share-sheet-backdrop" style={styles.backdrop} accessibilityViewIsModal>
        {/*
         * The scrim: `absoluteFill` UNDER the sheet, which is rendered after it, so
         * a tap inside the sheet hits the sheet and a tap anywhere else hits this.
         * A Pressable rather than a tap handler on the backdrop, so the dismiss
         * target is exactly the visible dimmed area.
         */}
        <Pressable
          testID="share-sheet-scrim"
          style={styles.scrim}
          onPress={onClose}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />

        {/*
         * `ScrollView` with `keyboardShouldPersistTaps="handled"` so the search
         * and send controls stay tappable while the keyboard is up. Without it RN
         * swallows the first tap on a button to dismiss the keyboard, which reads
         * as a dead control — and the search button is the FIRST thing a user
         * presses.
         */}
        <ScrollView
          testID="share-sheet"
          style={styles.sheetScroll}
          contentContainerStyle={styles.sheetContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text testID="share-sheet-title" accessibilityRole="header" style={styles.title}>
              Share clip
            </Text>
            <IconButton
              testID="share-sheet-close"
              accessibilityLabel="Close share sheet"
              onPress={onClose}
              hitSlop={hitSlop}
              style={styles.closeTarget}
            >
              <X size={ICON_SIZE} color={content.secondary} />
            </IconButton>
          </View>

          {/* Who is getting this. Context only — nothing here is pressable. */}
          <View testID="share-clip-summary" style={styles.summary}>
            <Text style={styles.summaryTitle} numberOfLines={1}>
              {title ?? 'This clip'}
            </Text>
            {creatorName ? (
              <Text style={styles.summaryMeta} numberOfLines={1}>
                {`@${creatorName}`}
              </Text>
            ) : null}
          </View>

          {!isShareable ? (
            <View testID="share-unavailable" style={styles.notice}>
              <Text style={styles.noticeText}>{SHARE_UNAVAILABLE_COPY}</Text>
            </View>
          ) : null}

          {/*
           * `onSubmitEditing` and the button call the SAME handler, so the
           * keyboard's search key and the button cannot disagree about when a
           * request is made. The two-source version of this is how a sheet ends up
           * firing twice per search.
           */}
          <View style={styles.searchRow}>
            <TextInput
              testID="share-search-input"
              style={[uiStyles.input, styles.searchInput]}
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={() => void onSearch()}
              placeholder="Exact username"
              placeholderTextColor={content.tertiary}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              returnKeyType="search"
              accessibilityLabel="Username to search for"
              accessibilityHint="Exact spelling. Only registered usernames are searched."
            />
            <Pressable
              testID="share-search-submit"
              accessibilityRole="button"
              accessibilityLabel="Search for this username"
              accessibilityState={{ disabled: searching, busy: searching }}
              onPress={() => void onSearch()}
              disabled={searching}
              hitSlop={hitSlop}
              style={({ pressed }) => [
                touchableStyle(styles.searchTarget),
                pressed && styles.pressed,
                searching && styles.dimmed,
              ]}
            >
              {searching ? (
                <ActivityIndicator color={content.primary} />
              ) : (
                <Search size={ICON_SIZE} color={content.primary} />
              )}
            </Pressable>
          </View>

          {draft.searchError ? (
            <View
              testID="share-search-error"
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              pointerEvents="none"
              style={styles.errorBox}
            >
              <Text style={styles.errorText}>{draft.searchError}</Text>
            </View>
          ) : null}

          {/*
           * Result row, or the honest empty state.
           *
           * There is no peer list, so the "no result" branch is a PROMPT and the
           * explanation of why there is nothing else to offer — not a spinner and
           * not an empty box. The old client rendered four hardcoded rows of real
           * `User` pks here (`651ac0c`); a list in this position is not a
           * convenience, it is a write to a stranger's inbox waiting to happen.
           */}
          {recipient ? (
            <View testID="share-result" style={styles.result}>
              <View style={styles.resultRow}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarInitial}>
                    {(recipient.username[0] ?? '?').toUpperCase()}
                  </Text>
                </View>
                {/*
                 * The STORED username, never the typed query. `iexact` matched
                 * `ALICE` against `alice` (`views/social.py:169`), and showing the
                 * query back would claim to a stranger that you know their name
                 * at a case you guessed.
                 */}
                <Text testID="share-result-username" style={styles.resultName} numberOfLines={1}>
                  {`@${recipient.username}`}
                </Text>
                <Pressable
                  testID="share-send"
                  accessibilityRole="button"
                  accessibilityLabel={sendLabel}
                  accessibilityState={{ disabled: sendDisabled, busy: pending }}
                  onPress={onSend}
                  disabled={sendDisabled}
                  hitSlop={hitSlop}
                  style={({ pressed }) => [
                    touchableStyle(styles.sendTarget),
                    sent ? styles.sendTargetSent : styles.sendTargetIdle,
                    pressed && styles.pressed,
                    sendDisabled && styles.dimmed,
                  ]}
                >
                  {sent ? (
                    <Check size={ICON_SIZE} color={onAccent} />
                  ) : pending ? (
                    <ActivityIndicator color={onAccent} />
                  ) : (
                    <Send size={ICON_SIZE} color={onAccent} />
                  )}
                </Pressable>
              </View>

              <Text testID="share-send-state" style={styles.resultState}>
                {sent ? 'Sent. It is in their inbox now.' : 'Tap send to put this clip in their inbox.'}
              </Text>

              {/*
               * The honest bit. The "Sent" state is LOCAL — this app cannot read
               * back what it sent, because `GET /share/` is the RECIPIENT's inbox
               * (`views/social.py:90`) — and the server will record the same share
               * again if asked. A badge with no caveat implies a state the client
               * cannot observe.
               */}
              <Text testID="share-resend-notice" style={styles.resultState}>
                {RESEND_NOTICE}
              </Text>

              {draft.sendError ? (
                <View
                  testID="share-send-error"
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                  pointerEvents="none"
                  style={styles.errorBox}
                >
                  <Text style={styles.errorText}>{draft.sendError}</Text>
                </View>
              ) : null}
            </View>
          ) : (
            <View testID="share-empty-state" style={styles.empty}>
              <Text style={styles.emptyTitle}>Who is this for?</Text>
              <Text style={styles.emptyText}>{NO_PEER_LIST_COPY}</Text>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  /** Full-bleed dim. `justifyContent: flex-end` — the sheet rises from the bottom. */
  // RN 0.86 exposes `absoluteFill` only; `absoluteFillObject` is gone
  // (`ReelCard.tsx:376`).
  backdrop: {
    ...StyleSheet.absoluteFill,
    zIndex: zIndex.sheet,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
  },
  scrim: { ...StyleSheet.absoluteFill },
  sheetScroll: { maxHeight: '85%' },
  sheetContent: {
    gap: spacing.gutter,
    padding: spacing.gutter,
    paddingBottom: spacing.stack,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    backgroundColor: surface.containerHigh,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: border.default,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { ...typography.title, fontSize: 18 },
  closeTarget: { flexDirection: 'row' },
  summary: {
    gap: 2,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: border.default,
  },
  summaryTitle: { ...typography.label, color: content.primary },
  summaryMeta: { ...typography.microLabel, fontSize: 11 },
  notice: {
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: surface.container,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: border.default,
  },
  noticeText: { ...typography.body, fontSize: 13, color: content.secondary },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.gutter },
  searchInput: { flex: 1 },
  searchTarget: {
    borderRadius: radius.md,
    backgroundColor: accent.base,
  },
  pressed: { opacity: 0.7 },
  /** `uiStyles.buttonDisabled` — the house 0.4 for an unavailable control. */
  dimmed: { opacity: 0.4 },
  errorBox: { paddingTop: spacing.gutter },
  /** `ActionCluster.tsx:703` — the house status-line treatment for a failure. */
  errorText: { ...typography.microLabel, color: status.danger },
  result: { gap: 6 },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: accent.soft,
  },
  avatarInitial: { ...typography.label, color: content.primary },
  resultName: { ...typography.label, flex: 1, color: content.primary },
  resultState: { ...typography.microLabel, fontSize: 10 },
  sendTarget: { flexDirection: 'row', borderRadius: radius.full, paddingHorizontal: 12 },
  sendTargetIdle: { backgroundColor: accent.base },
  /**
   * SENT is the accent fill at half strength, NOT a green.
   *
   * The delivered state here is a LOCAL record (`confirmSend`) and there is no
   * server confirmation to colour — see `RESEND_NOTICE`. Painting it green would
   * claim a delivery the client cannot observe, which is the green "Sent" the old
   * client showed for a share that had gone to a stranger.
   */
  sendTargetSent: { backgroundColor: accent.base, opacity: 0.5 },
  empty: { gap: 6 },
  emptyTitle: { ...typography.label, color: content.primary },
  emptyText: { ...typography.body, fontSize: 13, color: content.tertiary },
});
