<task id="ses_f0f1ece05ffeaobCKm5yMTit8a" state="completed">
<task_result>
# RECON-06 — Accessibility / Keyboard / Focus

**Scope:** `frontend/` (34 files, 5,155 non-test LOC). Read every source file end-to-end; every finding below was confirmed by reading the component, not by grep pattern-match. `mobile/` and `docs/mobile/` untouched (uncommitted parallel work present — `mobile/src/store/player.ts` etc.).
**Not executed:** `vitest` / `tsc` / `vite build` — running them writes cache dirs, which the read-only rule forbids. The 48-test baseline is taken from the brief and matches my own count of `it(` blocks (48). **No result in this report depends on a test run.**

---

## 1. Verdict table

Severity: **C** = blocks a core-loop step for a keyboard or screen-reader user · **H** = core loop degraded, or a whole surface unusable · **M** = real WCAG failure, workaround exists · **L** = polish.

| # | Defect | WCAG 2.2 SC | file:line | Sev | Blocks core loop? |
|---|---|---|---|---|---|
| 1 | File input is `className="hidden"` and its only trigger is a `<div onClick>` — no role, no tabIndex, no key handler. **Keyboard user cannot open a file picker at all.** | 2.1.1, 4.1.2 | `pages/Upload.tsx:189-195` + `179-182` | **C** | **YES — upload** |
| 2 | `htmlFor` appears **zero times in the entire app**. All 14 `<label>`s are unassociated; no `<input>`/`<select>` has an `id`. Login/register has **no accessible name on any field**. | 1.3.1, 3.3.2, 4.1.2 | `pages/Login.tsx:144,160,177,195,211`; `Upload.tsx:239,255`; `Profile.tsx:387,398,456,466`; `ShareModal.tsx:118` | **C** | **YES — sign in, register, upload** |
| 3 | Comment composer input has **no label at all** — placeholder only, and the placeholder vanishes on focus. | 1.3.1, 3.3.2, 4.1.2 | `components/comments/CommentSheet.tsx:186-192` | **C** | **YES — post a comment** |
| 4 | Creator bar is a `<div onClick>` with `e.stopPropagation()`. This is the *only* way to open a creator's profile from the feed. | 2.1.1 | `components/feed/ReelCard.tsx:189-202` | **C** | **YES — open a profile** |
| 5 | Entire Explore grid is `<div onClick>`; the play affordance inside is a `<div>`, not a button. Nothing in Explore is keyboard-reachable. | 2.1.1 | `pages/Explore.tsx:114-122` + `124-136` | **C** | **YES — browse/discover** |
| 6 | Inbox rows are `<div onClick>`; play icon is a `<div>`. Nothing playable by keyboard. | 2.1.1 | `pages/Inbox.tsx:107-115` + `117-129` | **C** | YES (share inbox) |
| 7 | Profile "Liked Reels" rows are `<div onClick>` with **no inner button** — unlike the uploads list, which does have one. Liked reels are unplayable by keyboard. | 2.1.1 | `pages/Profile.tsx:337-343`, `345-351` | **C** | YES (profile audio) |
| 8 | Scrubber is `<div onClick>`: no `role="slider"`, no `aria-valuenow`, no key handler. **No seeking by keyboard at all.** | 2.1.1, 4.1.2 | `components/feed/ReelCard.tsx:312-319` | **H** | **YES — seek** |
| 9 | **5 modals, none is a dialog.** `role="dialog"`=0, `aria-modal`=0 app-wide. No focus trap, no Escape handler anywhere, no focus restore, no focus move on open, background not `inert`. | 2.1.2, 2.4.3, 4.1.2 | `CommentSheet.tsx:74`, `ShareModal.tsx:69`, `OnboardingModal.tsx:58`, `Profile.tsx:368`, `Profile.tsx:441` | **H** | YES — comment, share, onboarding, edit |
| 10 | 9 icon-only buttons with **no accessible name whatsoever** (no text, no `aria-label`, no `title`). | 4.1.2 | `MiniPlayer.tsx:80`; `CommentSheet.tsx:90`,`193`; `ShareModal.tsx:79`,`129`; `Profile.tsx:273`,`372`,`445`; `Login.tsx:224` | **H** | **YES — post comment (`CommentSheet:193`)** |
| 11 | 4 more buttons are named by a **bare number** — like/comment/share counts and the speed rate. `title=` is present but **shadowed**, because button content outranks `title` in name computation. | 4.1.2 | `ReelCard.tsx:396`(→`title="Like Reel"`, name = "12"), `:417`, `:435`, `:175`(→"1X") | **H** | YES — like, skip, share |
| 12 | `playbackError` is set on 4 distinct conditions and put in context, then **read by zero components**. Comment at `player.tsx:219-222` claims "The UI distinguishes these" — it does not. | 4.1.3 | `stores/player.tsx:51,223-231,262,374` | **H** | **YES — playback failure is invisible** |
| 13 | **Three core-loop failures are `console.warn`-only**: post comment, send share, delete comment/share/clip. No visual error, no live region. | 3.3.1, 4.1.3 | `CommentSheet.tsx:55-57,66-68`; `ShareModal.tsx:61-63`; `Profile.tsx:70-71,111-113,122-124`; `Inbox.tsx:44-46,62-64` | **H** | **YES — silent failure on 3 core steps** |
| 14 | `handsFreeMode` is **inert**. Guarded nowhere: viewability autoplay, auto-advance scroll, and `handleAutoAdvance` all ignore it. `Feed.tsx:139` renders "Manual Navigation Mode" — a false statement. | 4.1.2, 3.3.2 | `player.tsx:43` (state), `:86-88,104-106,166-178`; `ReelList.tsx:76-95,98-106`; `Feed.tsx:136-141` | **H** | YES — no way to stop forced behaviour |
| 15 | **11 `focus:outline-none` remain** (Login ×5, Profile ×3, Upload ×2, CommentSheet ×1, ShareModal ×1). The brief's "removed in navigation" is true only of `BottomNav`. | 2.4.7 Focus Visible [AA] | `Login.tsx:153,169,186,204,222`; `Profile.tsx:392,461,470`; `Upload.tsx:249,261`; `CommentSheet.tsx:191`; `ShareModal.tsx:127` | **H** | YES — every form |
| 16 | `aria-invalid` / `aria-describedby` = **0 occurrences**. No error is ever associated with the field it describes. | 3.3.1 | app-wide | **H** | **YES — every form** |
| 17 | **No `prefers-reduced-motion` anywhere in `src/`** — zero occurrences. 8 keyframe animations incl. an infinite `shimmer`, plus `html { scroll-behavior: smooth }`. | 2.3.3 [AAA] / 2.2.2 [A] | `styles/tokens.css:114-117,160-197`; `ReelList.tsx:103` | **H** | YES — motion, auto-advance |
| 18 | **Continuous 60 fps re-render, forever, even when paused.** `update()` calls `setAudioFrequencies()` on *every* rAF tick inside an unconditional loop. | 2.2.2, 2.3.3 | `stores/player.tsx:143-160` | **H** | No (perf + motion) |
| 19 | Upload success **auto-redirects after 2.5 s** — content appears, is unreadable, and the user is navigated away. No pause, no dismissal, not announced. | 2.2.1, 4.1.3 | `pages/Upload.tsx:125-127` | **H** | YES — upload result |
| 20 | **N `<h1>`s on the feed** (one per `ReelCard`); Profile starts at `<h2>` then jumps to `<h4>`; Explore/Inbox skip h2. | 1.3.1, 2.4.6 | `ReelCard.tsx:246`; `Profile.tsx:161→292,356`; `Explore.tsx:59→148`; `Inbox.tsx:71→144`; `ShareModal.tsx:75→94` | **M** | No |
| 21 | Selected state conveyed by **colour alone** on 4 tab-like UIs; `aria-pressed` exists exactly once in the app (hands-free). | 1.4.1, 4.1.2 | `Login.tsx:113-131`; `Profile.tsx:229-253`; `Explore.tsx:77-89`; `OnboardingModal.tsx:89-115` | **M** | No |
| 22 | 8 `disabled` buttons: disabling a focused button **removes it from the tab order and drops focus to `<body>`**. `aria-busy` on the follow button is a misuse (it means "content is updating", not "action in flight"). | 2.4.3, 4.1.2 | `Login:241`, `Upload:281`, `Profile:428`, `CommentSheet:195`, `ReelCard:209-210`, `OnboardingModal:137`, `ShareModal:131,167` | **M** | No |
| 23 | `text-white/40` = **3.77:1** and `text-white/30` = **2.61:1** — **72 occurrences**, at 9–11 px. | 1.4.3 [AA] | all 13 component/page files | **M** | No |
| 24 | **Only 2 buttons in the app meet a 44 px target** (both in `ErrorBoundary`, `minHeight: 44`). 9 controls fall **below the 24 px AA floor** (2.5.8): ~13 px Reply/Delete/Cancel, 16×16 close buttons, 16×16 password toggle. `--tap-target: 64px` is declared and **never referenced**. | 2.5.8 [AA] / 2.5.5 [AAA] | `tokens.css:80` (dead); `CommentSheet:139,150,173`; `Login:224`; `Profile:372,419,426,445,482,489`; `ReelCard:206` | **M** | No |
| 25 | `SessionAnnouncer` repeat-fire: `SessionMessage.id` is generated (`SessionAnnouncer.tsx:37-39`) and **never consumed as a key**. A second identical session-expiry produces identical DOM text, so SRs do not re-announce. | 4.1.3 | `SessionAnnouncer.tsx:31,37-42,101` | **M** | No |
| 26 | `ef_session_expired` fires only on the **non-OK** path. The `catch` (network throw) clears tokens with **no event** — the one case that needs announcing. | 4.1.3 | `api/client.ts:88` vs `:99-102` | **M** | No |
| 27 | Session expiry announced `polite`. It is a **loss of function** — the user is being signed out and the tree is being replaced. | 4.1.3 | `SessionAnnouncer.tsx:74-75` | **L** | No |
| 28 | `title` static; no `document.title` write anywhere. 5 "routes", one title. | 2.4.2 | `index.html:6` | **L** | No |
| 29 | No `<footer>`, no `<section>`; the single `<nav>` is `md:hidden`, so **desktop has no navigation landmark**. The Header's desktop tabs are a bare `<div>` with **zero `aria-current`** (source has exactly 2, both in `BottomNav`). | 1.3.1, 2.4.1, 4.1.2 | `BottomNav.tsx:20`; `Header.tsx:82-106` | **M** | No |
| 30 | Emoji carry meaning in profile stats and are not hidden: `❤️ {likes} • 💬 {comments} • 🔄 {shares}` → announced as "red heart … loudly crying face … counterclockwise arrows button". | 1.1.1, 1.4.1 | `Profile.tsx:294` | **M** | No |
| 31 | No labelled player region. `new Audio()` is **never attached to the DOM** — there is no `<audio>` element in the accessibility tree; all playback state is hand-rolled divs. MiniPlayer has no `role="region"`/`aria-label`. | 1.3.1, 4.1.2 | `stores/player.tsx:63`; `MiniPlayer.tsx:23-24` | **M** | No |
| 32 | 24 decorative waveform bars per card + 5 in MiniPlayer, updating at 60 fps, **not `aria-hidden`**. | 1.1.1 | `ReelCard.tsx:252-279`; `MiniPlayer.tsx:38-46` | **M** | No |
| 33 | No `autocomplete` on username/email/password. | 1.3.5 [AA] | `Login.tsx:147,163,198,215` | **M** | YES — auth friction |
| 34 | No text alternative for the audio content. The "transcript" is a **hardcoded string**, identical on every clip. | 1.1.1 | `ReelCard.tsx:282-284` | **M** | No |
| 35 | `document.title` + `aria-current` fixed, but no error is associated with its region anywhere except `ReelCard:232`. `ListError`, `Feed:104`, `Explore:100`, `Inbox:90`, `Profile:382`, `Login:135`, `Upload:172`, `OnboardingModal:79` all render unassociated error text. | 3.3.1, 4.1.3 | 8 sites | **M** | No |
| 36 | Dead tokens: `--tap-target` (`:80`), all 6 `--cat-*` (`:152-157`), `[data-theme="light"]` (`:90`) — `data-theme` is never set. Light theme would be **broken**, not working, if enabled. | — | `tokens.css:80,90,152` | **L** | No |
| 37 | `Login.tsx:221` `onKeyDown` Enter → `handleSubmit` duplicates native form submission. | — | `Login.tsx:221` | **L** | No |
| 38 | `OnboardingModal:137` disables the submit button at 0 tags, making the `errorMsg` guard at `:38-41` **unreachable dead code**. | — | `OnboardingModal.tsx:38-41,137` | **L** | No |
| 39 | `navigator.clipboard.writeText` is not awaited and has no `.catch` — `setCopied(true)` at `:35` fires regardless, so **"Copied" is shown on failure**. | 3.3.1 | `ShareModal.tsx:32-37` | **L** | No |
| 40 | Brand token exists but is bypassed: `--terracotta: #e8a87c` / `--accent` (`tokens.css:40-41`) is referenced from **exactly one place** (`ReelList.tsx:180`). All 9 components hardcode `#FF6321`. | — | `tokens.css:40`; grep §10 | **L** | No |

**Summary of counts:** 22 `aria-*` in source, of which 10 are `aria-current` in `BottomNav` and 7 are `aria-live` across 4 regions. `aria-label`=2, `aria-pressed`=1, `aria-hidden`=1, `aria-busy`=1. `role="dialog"`=0, `aria-modal`=0, `role="tab"`=0, `role="progressbar"`=0, `role="slider"`=0, `role="group"`=0, `aria-expanded`=0, `aria-invalid`=0, `aria-describedby`=0, `htmlFor`=0, `autoComplete`=0, `Escape` handler=0, `.focus()`=0, `autoFocus`=0, `inert`=0, `prefers-reduced-motion`=0.

---

## 2. Can the core loop be completed by keyboard only?

**No. Three of the eleven steps fail outright, and four more fail silently.** Step-by-step, with the exact failure point.

**Prerequisite — sign in: FAILS.**
Tab into the form. Every field is focusable, and tab order matches DOM order (username → email → dob → [guardian] → password → toggle → submit), so ordering is fine. But **no field has an accessible name** — `Login.tsx:144-146` is `<label className="…">Username</label>` with no `htmlFor`, and `Login.tsx:147-154` is an `<input>` with no `id`. Accessible name falls back to the placeholder, so a screen reader announces "e.g. soundwave, edit text" — **the field's purpose is never stated**. The password toggle at `Login.tsx:224-234` is a 16×16 box with no name and no `aria-pressed`; a sighted keyboard user can guess it, a screen-reader user cannot identify it. Worse, `:221` binds Enter on the password field *and* the form has a native submit — a double-submit path.
> Failure point: `Login.tsx:144-154` (labels), `Login.tsx:224-234` (unnamed 16 px toggle).

**1. Browse feed: PARTIAL.**
`ReelList.tsx:111-115` is a `<div>` with `overflow-y-auto` and `.scrollbar-hide`, with **no `tabIndex`, no `role`, no `onKeyDown`**. It is not in the tab order, so **arrow keys, Page Up/Down, Home/End do not scroll it**. There is no reel-to-reel navigation of any kind. `tokens.css:207-212` hides the scrollbar on both engines (Firefox `scrollbar-width: none`, WebKit `::-webkit-scrollbar { display: none }`), so there is no visual position indicator either.
The user *can* still reach reel 2+ — but only by **tabbing through all ~11 controls of reel 1**, and the browser scrolls each newly focused control into view. So the reel changes as a side effect of tabbing, with no announcement and no focus move: a keyboard user has no idea a new clip started playing, or which one.
> Failure point: `ReelList.tsx:111-115` — no keyboard scroll affordance, no arrow-key reel navigation.

**2. Play/pause: PASSES (barely).**
`ReelCard.tsx:351-365` is a real `<button>`; its name resolves from `title="Play / Pause Reel"`. Reachable, Enter/Space work. Two caveats: the title does not change with state (always "Play / Pause Reel" whether playing or paused), and it is 56×56 — fine. The *card* itself (`ReelCard.tsx:158-161`) is a `<div onClick>` and is unreachable, which is harmless because the button duplicates the action.
> Passes. Add a state-changing name (`aria-pressed` or a dynamic label) as a follow-up.

**3. Like / skip: like FAILS on naming; skip FAILS twice.**
- **Like** (`ReelCard.tsx:396-414`) is a real `<button>`, so it is focusable and activates. But its only children are a `<div>` wrapper with a `<Heart>` icon and `<span>{likesCount}</span>`. Accessible name computation is **aria-labelledby → aria-label → content → title**; content outranks `title`, so the button is announced as **"12"** — the `title="Like Reel"` is never used as the name. Identical for comment (`:417`) and share (`:435`). There is no `aria-pressed`, so liked/unliked is not exposed either — only the heart's fill colour and the count change.
- **Skip ±10 s** (`ReelCard.tsx:338-348`, `:367-377`) are 40×40 `<button>`s named only by `title`. Reachable, but **below the 44 px target**.
- **Seek: hard fail.** `ReelCard.tsx:312-319` is `<div onClick>` — no `role="slider"`, no `aria-valuenow/min/max`, no `onKeyDown`. **There is no way to seek by keyboard, at all.**
> Failure point: `ReelCard.tsx:396/417/435` (name = bare number), `ReelCard.tsx:312-319` (no seek).

**4. View comments: FAILS.**
`ReelCard.tsx:417-432` is a real `<button>`, so it opens. `CommentSheet` mounts (`Feed.tsx:172-176`). Then: **no `role="dialog"`, no `aria-modal`, no focus move, no focus trap, no Escape, no `inert` background** (`CommentSheet.tsx:74-78`). Focus stays on the now-covered "Comments" button. Tabbing walks straight *behind* the sheet into the feed and the page header — the modal is not modal in any sense. The close button (`:90-96`) is a 28×28 icon with **no name**. The list heading is an `<h3>` with no `h1`/`h2` above it.
> Failure point: `CommentSheet.tsx:74-78` (no dialog semantics), `:90-96` (unnamed).

**5. Post a comment: FAILS.**
The input (`CommentSheet.tsx:186-192`) has **no `<label>`, no `aria-label`, no `id`** — placeholder only, and `placeholder-white/30` is 2.61:1. It is focusable, so the user can type, but the field is unnamed and the field is not described. The submit button (`:193-199`) is a 36×36 icon with **no name**. And the failure path at `:55-57` is `console.warn` only — **a rejected comment is completely silent**, the input is not cleared, no error appears. A user who types a comment, hits send on a flaky connection, and sees nothing at all will reasonably assume it posted.
> Failure point: `CommentSheet.tsx:186-199` (unnamed field + unnamed button), `:55-57` (silent failure).

**6. Share: FAILS.**
`ReelCard.tsx:435-450` is a real `<button>` but named "3" (see step 3). `ShareModal.tsx:69-70` — no `role="dialog"`, no `aria-modal`, no focus management, no Escape. The close button (`:79-85`) is a 24×24 icon with **no name**. The "Find Listener by Username" `<label>` (`:118-120`) has **no `htmlFor`** and the input (`:122-128`) has **no `id`** — unnamed field. The search submit (`:129-135`) is unnamed. `searchError` (`:137-139`) renders as a bare `<p>` with no `role="alert"`, no `aria-describedby`, no `aria-invalid` — **not announced and not associated**. And `handleSendToUser`'s catch (`:61-63`) is `console.warn` only, so **a failed share is silent** while the button still reads "Stream".
> Failure point: `ShareModal.tsx:69-85,118-139,61-63`.

**7. Open a profile: FAILS.**
`ReelCard.tsx:189-202` is the creator bar:
```
        <div
          onClick={(e) => {
            e.stopPropagation();
            onCreatorClick?.(clip.creator_id);
          }}
          className="flex items-center gap-2.5 group/creator"
        >
```
No `role`, no `tabIndex`, no `onKeyDown`. **This is the only route from the feed to a creator's profile.** It is completely unreachable by keyboard. (The avatar button in the header, `Header.tsx:152-171`, *is* a real `<button>` but is hardcoded to `setActiveTab("profile")` — it goes to *your own* profile, not a creator's.)
> Failure point: `ReelCard.tsx:189-202`.

**8. Follow: PASSES.**
`ReelCard.tsx:206-228` is a real `<button>`, focusable, with text "Follow"/"Following" that changes with state. `aria-busy` at `:210` is a misuse but harmless. It is **~22 px tall — below the 24 px AA floor**. The optimistic-update failure is properly announced (`ReelCard.tsx:232-238`, `role="status" aria-live="polite"`) — the best-implemented error path in the app, and the precedent to copy.
> Passes. Size and `aria-pressed` are follow-ups.

**9. Upload: FAILS — hardest block.**
`Upload.tsx:179-182` is the drop zone:
```
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`relative p-8 rounded-2xl border-2 border-dashed transition-all cursor-pointer flex flex-col items-center justify-center text-center space-y-3 ${…}`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="…"
              onChange={handleFileChange}
              className="hidden"
            />
```
The `<input>` is `display: none` — **not in the accessibility tree, not focusable, and not openable by keyboard**. The only trigger is the `<div onClick>` above it, which is unreachable. **There is no keyboard route to a file picker anywhere on this page.** The "Click to replace audio asset" affordance at `:207-209` is a `<span>` styled to look like a link, also unreachable. The title and category fields (`:239-258`) have unassociated labels. The submit button is correctly named. On success, `:125-127` redirects after **2.5 s** — content the user cannot read in time, never announced, with no way to extend.
> Failure point: `Upload.tsx:189-195` + `179-182` — the file input is `display:none` behind an unreachable div.

**Cross-cutting:** a keyboard user who reaches any error state finds focus on a removed node (all 8 `disabled` buttons drop focus to `<body>`; the ErrorBoundary replaces the whole tree without moving focus).

**Verdict: 2 of 11 steps fully pass (play/pause, follow); 3 fail outright (upload, open-profile, post-comment naming); 4 more fail silently (comment failure, share failure, playback failure, upload result).**

---

## 3. Focus management

**Modal open/close — no focus management whatsoever.**
Across all five modals: `role="dialog"`=0, `aria-modal`=0, `aria-labelledby`=0, `aria-expanded`=0, `inert`=0, `Escape` handler=0, `.focus()`=0, `autoFocus`=0. Verified by grep across all of `src/`.

| Modal | Container | Semantics | Move on open | Trap | Escape | Restore |
|---|---|---|---|---|---|---|
| `CommentSheet.tsx:74` | `<div className="fixed inset-0 z-50 …">` | none | no | no | no | no |
| `ShareModal.tsx:69` | `<div className="fixed inset-0 z-50 …">` | none | no | no | no | no |
| `OnboardingModal.tsx:58` | `<div className="fixed inset-0 z-50 …">` | none | no | no | no | no |
| `Profile.tsx:368` (edit profile) | `<div className="fixed inset-0 z-50 …">` | none | no | no | no | no |
| `Profile.tsx:441` (edit clip) | `<div className="fixed inset-0 z-50 …">` | none | no | no | no | no |

Concretely, opening Comments: focus stays on the covered trigger; Tab walks into the header and the feed behind the `bg-black/80` backdrop; Escape does nothing; the only exit is a 28×28 unnamed button. The backdrop has `onClick={(e) => e.stopPropagation()}` on the *inner* panel (`CommentSheet.tsx:77`) and no handler on the outer — so it is inert in both directions. WCAG **2.4.3 Focus Order** and **4.1.2** both fail; there is no **2.1.2 No Keyboard Trap** violation because there is no trap at all, which is arguably worse.

**Navigation / route change — no management, and no announcement.**
`App.tsx:21` holds `activeTab` in `useState`. Changing it swaps which page renders inside `<main>` (`App.tsx:79-101`) and nothing else. No focus move, no announcement, no `document.title` change. A screen-reader user's cursor stays wherever it was — usually on the nav button they just pressed, which is correct — but the new page's heading is never announced. Concretely: pressing "Creator Studio" swaps the feed for the upload form and says nothing. **2.4.2 Page Titled** technically passes (there is a `<title>`), but the practical failure is total: a screen-reader user cannot tell the app navigated.

There is a second, unrelated bug in the same area: `AuthenticatedApp` (`App.tsx:139-149`) checks only `isAuthenticated`, while `MainContent` (`App.tsx:59-61`) checks `!isAuthenticated && !isLoading`. So during the auth-loading window a **Login page flashes** and then gets replaced. No announcement, and focus is on a node that is about to be unmounted.

**Feed advance — no focus move, and the focus target is destroyed.**
`ReelList.tsx:98-106` fires `scrollIntoView({ behavior: "smooth" })` 1 s after `progress >= 0.99`, and `player.tsx:166-178` independently calls `nextClip("auto")` on `timeupdate` and on `ended` — **two owners of the same event** (RECON-01 flags this too). Neither moves focus. Because each card's DOM subtree is *not* reused across clips (`key={clip.id}` at `ReelList.tsx:118`), any focus that was inside the previous card is **destroyed** and drops to `<body>`. A keyboard user who tabbed to "Next Reel" and then waited for the clip to end loses their place entirely, with no announcement that anything happened. This is the single most disorienting focus defect in the app.

**Error injection — no focus move.**
`ErrorBoundary.tsx:58-63` replaces the tree with `role="alert"` + `<h1>Something broke</h1>` + two buttons. The `role="alert"` is correct and the `harness.test.tsx:25-42` test pins it. But **focus is never moved to the alert or the "Try again" button**, so it stays on a removed node. Its two buttons are the only ones in the app that meet a 44 px target (`minHeight: 44` at `:96` and `:113`) — worth preserving. Also: the boundary is the **outermost** element (`App.tsx:151-160`), so a throw inside `AuthProvider` or `PlayerProvider` *render* is caught; a throw in their `useEffect` is not, since boundaries do not catch effect/async errors.

**`disabled` drops focus.** 8 sites set `disabled` on a button the user just activated. A disabled button is removed from the tab order, so focus falls to `<body>` mid-interaction — for `CommentSheet.tsx:195` that happens on **every single comment submit**, since the button disables whenever the input is empty.

---

## 4. Live regions

**Inventory — 4 regions in the entire app, all `polite`:**

| Region | file:line | Politeness | Verdict |
|---|---|---|---|
| Backend health | `Header.tsx:118-122` `role="status" aria-live="polite"` | polite | Correct — but the region sits inside `hidden lg:flex`, so it **does not exist in the a11y tree on mobile**, which is the primary form factor. |
| Follow failure | `ReelCard.tsx:232-238` `role="status" aria-live="polite"` | polite | **Best in app.** Persists until the next attempt. Copy this. |
| Network banner | `NetworkBanner.tsx:82-85` | polite | Under-prioritised — losing connectivity is a blocking condition, not a status update. |
| Session notice | `SessionAnnouncer.tsx:73-75` | polite | **Under-prioritised** — see below. |

**What is announced:** follow failure, offline/reconnect, session expiry, backend health text.
**What is silently lost — the five events the brief asked about:**

| Event | Announced? | Evidence |
|---|---|---|
| **Session expiry** | **Partially.** Fires and is announced, with two real defects. | ✅ `client.ts:88` does dispatch `ef_session_expired`; `auth.tsx:60` and `SessionAnnouncer.tsx:44` both listen. ❌ (a) Politeness is wrong — this is a loss of function; the tree is being replaced by a login screen. ❌ (b) **Repeat-fire is broken**: `SessionAnnouncer.tsx:37-39` builds `id: \`${eventName}-${counter.current}\`` and **never uses it as a key**. A second expiry renders byte-identical text, and a live region whose text does not change is not re-announced. The `id` field documents an intent the implementation does not honour. ❌ (c) The **network-throw path never dispatches the event at all** — `client.ts:99-102` clears tokens silently. That is the case most likely to be a transient blip, and it is the one that goes unannounced. |
| **Network loss** | Announced, `polite`. | `NetworkBanner.tsx:83-84`. Content and dismissal behaviour are correct. Only the politeness is arguable. |
| **Like failure** | **No.** | `ReelCard.tsx:93-95` — optimistic toggle, silent rollback, `console` only. No region, no visual change beyond the heart un-filling. |
| **Share success** | **Weak, accidental.** | `ShareModal.tsx:110` swaps the button's *text* to "Direct Stream URL Copied". No live region. Works only if the SR user happens to be on that button and re-reads it. And `:34-35` sets `copied` without awaiting or catching `writeText`, so it claims success on failure. |
| **Share failure** | **No.** | `ShareModal.tsx:61-63` — `console.warn` only; the button still reads "Stream". |
| **Upload failure** | **No.** | `Upload.tsx:128-134` sets `errorMessage`; rendered at `:171-176` as a plain `<div>` with **no `role="alert"`**. Appears silently. |
| **Upload success** | **No, and 2.5 s.** | `Upload.tsx:152-168` — no `role="status"`, then `setTimeout(onUploadSuccess, 2500)` at `:125-127`. |
| **Playback failure** | **No.** | `player.tsx:223-231` distinguishes 409/403/404/other into `playbackError`, and `:219-222` comments *"The UI distinguishes these; collapsing them loses the only signal the user can act on."* **No component reads `playbackError`.** Grep across `src/` returns only `player.tsx` and one test mock. The comment describes behaviour that does not exist — the same pattern as `ErrorBoundary.tsx:28`. |
| **Comment post/delete failure** | **No.** | `CommentSheet.tsx:55-57`, `:66-68`. |
| **Feed load / cold-queue / error** | **No.** | `Feed.tsx:78-101` (cold-preparing + loading) and `:103-122` (error) — none in a live region. The `retryCountdown` at `:87` ticks every second, unannounced. |
| **Unread count change** | **No.** | `App.tsx:38` polls every 30 s and updates the badge; no live region. |
| **Tab-change navigation** | **No.** | `App.tsx:21`. |
| **Onboarding selection** | **No.** | `OnboardingModal.tsx:122-125` "N Vibes Armed" is static text. |

**Correctly implemented, for contrast:** both `NetworkBanner` (`:82-106`) and `SessionNotice` (`:73-100`) keep the live region **mounted when empty** and vary only `display`/`padding`/`maxWidth`, with an explicit comment explaining that a region inserted at the same tick as its text is unreliable. `harness.test.tsx:111-120` and `navNetworkBanner.test.tsx:84-98` both pin it. This is genuinely good work and should be the model for the missing regions. Note both idle regions do render a 0×0 `box-shadow`-free box — harmless.

---

## 5. Names, roles, headings, landmarks

**Icon-only buttons with no name at all (9):**

| file:line | Control | Note |
|---|---|---|
| `MiniPlayer.tsx:80-89` | play/pause | **The persistent player's primary control.** No text, no `aria-label`, no `title`. |
| `CommentSheet.tsx:90-96` | close (X) | 28×28 |
| `CommentSheet.tsx:193-199` | submit comment (Send) | 36×36 — **core loop** |
| `ShareModal.tsx:79-85` | close (X) | 24×24 |
| `ShareModal.tsx:129-135` | search submit | 36×36 |
| `Profile.tsx:372-378` | close edit-profile (X) | **16×16**, no padding |
| `Profile.tsx:445-451` | close edit-clip (X) | **16×16**, no padding |
| `Profile.tsx:273-286` | per-clip play | 44×44; **N identical unnamed buttons** in a list |
| `Login.tsx:224-234` | show/hide password | **16×16**, no name, no `aria-pressed` |

**Buttons named by a bare number or an unlabelled value (4) — `title` present but inert because content outranks it:**
- `ReelCard.tsx:396-414` like → name **"12"** (`title="Like Reel"` never used)
- `ReelCard.tsx:417-432` comment → name **"7"**
- `ReelCard.tsx:435-450` share → name **"3"**
- `ReelCard.tsx:175-183` speed → name **"1X"**, no indication it is a control

**`title`-only names (unreliable — not exposed on touch, suppressed by some SR/browser combinations):** `ReelCard.tsx:338,351,367,379`; `MiniPlayer.tsx:67,92`; `Profile.tsx:180,191,300,312`; `Inbox.tsx:154`. A `title` is a *fallback*, not a name. The brief's "already known: unread badge lacks an accessible name" is **imprecise** — see §15.

**One actively wrong name:** `Header.tsx:152-171`, the avatar button, has `title="My Profile"` but its only child is `<img alt={user?.username}>` (or the initial letter). Content-derived naming again means the button is announced as **the user's own username** — so "alice" is the name of a button that goes to the profile page. Inaccurate and confusing.

**`role="button"` on non-buttons: zero.** The codebase's failure mode is the opposite — 11 `<div onClick>` with no role at all (enumerated exhaustively in §10). There is no `role="button"` misuse to report.

**Headings — 4 distinct violations:**

| Page | Sequence | Defect |
|---|---|---|
| Feed | `ReelCard.tsx:246` `<h1>` **× N cards** | **N `<h1>`s per page**, one per reel. The page itself has no heading. `Feed.tsx:85,110` use `<h2>` for loading/error — so on the error path the page's only heading is an `<h2>`. |
| Profile | `Profile.tsx:161` `<h2>` → `:292` `<h4>` → `:356` `<h4>` | **No `<h1>`**, then **h2→h4 skip**. `:371`,`:444` are `<h3>` inside modals. |
| Explore | `Explore.tsx:59` `<h1>` → `:148` `<h3>` | **h1→h3 skip.** |
| Inbox | `Inbox.tsx:71` `<h1>` → `:144` `<h3>` | **h1→h3 skip.** |
| ShareModal | `:75` `<h3>` → `:94` `<h4>` | No `h1`/`h2` ancestor in the dialog; used as if the title were a label, but no `aria-labelledby` links them. |
| CommentSheet | `:82` `<h3>` only | No `h1`/`h2` ancestor. |
| Upload | `:143` `<h1>` → `:158` `<h2>` | **Correct.** |
| Login | `:102` `<h1>` only | Correct (the form has no heading, but it is a single-purpose page). |

**Landmarks — 3, and one is conditionally absent:**
- `<header>` ×1 (`Header.tsx:61`), `<main>` ×1 (`App.tsx:79`), `<nav>` ×1 (`BottomNav.tsx:20`).
- **The `<nav>` is `md:hidden`** → on desktop there is **no navigation landmark**, and the Header's desktop destinations (`Header.tsx:82-106`) are a bare `<div>` with **zero `aria-current`** (source has exactly 2 occurrences, both in `BottomNav.tsx:32,67`). So a desktop screen-reader user has no navigation region and no current-page signal.
- **No `<footer>`, no `<section>`, no `<aside>`** anywhere.
- **`Login.tsx` has no landmarks at all** — a bare `<div>` at `:91`. No `<main>`, no `<header>`.
- `2.4.1 Bypass Blocks` is satisfied by the presence of `<main>` on the authenticated shell, so a skip link is a should-have rather than a requirement. Given only 7 focusable elements precede `<main>`, I would not spend MVP budget on one.
- **Page title:** `index.html:6` is static; no `document.title` write anywhere in `src/`.

**Meaning by colour alone (1.4.1):** the 4 tab-like UIs — `Login.tsx:113-131` (login/register), `Profile.tsx:229-253` (uploads/liked), `Explore.tsx:77-89` (categories), `OnboardingModal.tsx:89-115` (tags). `aria-pressed` exists **once** in the whole app (`Header.tsx:135-149`, hands-free). The onboarding tag grid is the worst case: the selected state is a border + ring + background tint, and the only non-colour cue is a `<Check>` icon inside a `<div>` (`:108-114`) that is not exposed as state — so a screen-reader user can neither see nor hear which vibes are armed, while the count at `:122-125` ("N Vibes Armed") is unannounced.

---

## 6. Forms

**`htmlFor` = 0 occurrences in the entire app. No `<input>`, `<select>`, or `<textarea>` has an `id`. `aria-invalid` = 0. `aria-describedby` = 0. `autoComplete` = 0.**

Every one of the 14 `<label>` elements is a visual label that labels nothing. The inputs then fall back to `placeholder` for their name — and placeholders are the weakest possible source: they vanish on focus (WCAG 3.3.2 explicitly calls this out), they are not reliably exposed by all screen readers, and here they are `placeholder-white/20` (1.77:1) or `placeholder-white/30` (2.61:1).

| Surface | file:line | Defect |
|---|---|---|
| Login / register | `Login.tsx:144`→`:147`, `:160`→`:163`, `:177`→`:180`, `:195`→`:198`, `:211`→`:215` | **5 unlabelled fields.** This is the app's front door. |
| Comment composer | `CommentSheet.tsx:186-192` | **No `<label>` at all**, no `aria-label`. Placeholder only. **Core loop.** |
| Upload title | `Upload.tsx:239`→`:242` | Unassociated. Has `required` + `maxLength={255}`. |
| Upload category | `Upload.tsx:255`→`:258` | Unassociated `<select>`. |
| Share username | `ShareModal.tsx:118`→`:122` | Unassociated. |
| Profile edit username | `Profile.tsx:387`→`:388` | Unassociated. |
| Profile avatar | `Profile.tsx:398`→`:399` | Unassociated, and the input is `className="hidden"`. Mitigated only by the visible `<button>` at `:408-415` that proxies it — **this is the correct pattern and is exactly what `Upload.tsx:179-195` lacks.** |
| Profile clip title | `Profile.tsx:456`→`:457` | Unassociated. **No `required`, no `maxLength`** — unlike the upload form. |
| Profile clip category | `Profile.tsx:466`→`:467` | Unassociated `<select>`. |

**Error surfacing — no field is ever described by its error, and no error is announced:**

| file:line | Error | Rendering |
|---|---|---|
| `Login.tsx:134-138` | auth failure | bare `<div>`, **no `role="alert"`** — the primary error surface of the app is silent |
| `Upload.tsx:171-176` | upload failure | bare `<div>` with an `<AlertCircle>`, no `role` |
| `ShareModal.tsx:137-139` | user not found | bare `<p>`, no role, not linked to `:122` |
| `Profile.tsx:381-383` | profile save failure | bare `<p>`, no role, not linked to `:388` |
| `OnboardingModal.tsx:78-82` | tag/init failure | bare `<div>`, no role — **and unreachable**, see below |
| `ReelCard.tsx:232-238` | follow failure | ✅ `role="status" aria-live="polite"` — the one correct instance |
| `ReelList.tsx:166-188` | feed load failure | bare `<p>`, no role |
| `Feed.tsx:103-122` | feed load failure | bare `<h2>` + `<p>`, no role |

**Required conveyed to AT:** `required` is present on 5 inputs (`Login.tsx:152,168,185,203`, `Upload.tsx:248`) — correct and native. `OnboardingModal.tsx:137` disables the submit button at 0 tags, which makes the `errorMsg` guard at `:38-41` **dead code**; a disabled submit button is also never focusable, so a keyboard user tabbing onto it gets nothing and no explanation of why. **No field uses `aria-required`, `aria-invalid`, or `aria-describedby` anywhere.**

**Autocomplete:** absent from all four auth fields. WCAG **1.3.5 Identify Input Purpose** (AA) — on mobile this is also a real completion-rate cost, not just a compliance line.

**Other form defects:** `Login.tsx:221` binds Enter on the password field *in addition to* the native form submit — a duplicate-submission path. `CommentSheet.tsx:195` disables submit whenever the input is empty, which drops focus to `<body>` on every submit attempt.

---

## 7. Media / player a11y

**There is no media element in the accessibility tree.** `player.tsx:63` does `const audio = new Audio()` and **never appends it to the document**. No `<audio>`, no `<video>`, no `controls`, no `role`. A screen reader encounters **zero** media semantics: no play state, no track name, no duration, no volume, no position. Every piece of playback state is re-implemented as `div`s and buttons with no ARIA at all.

**Labelled player region: none.** `MiniPlayer.tsx:23-24` is a bare `<div className="fixed bottom-16 …">` with no `role="region"`, no `aria-label`, no `<h2>`. There is no "Now playing" boundary for a screen-reader user to find.

**Can pause be reached by keyboard?** Yes, in two places (`ReelCard.tsx:351-365` at 56×56, `MiniPlayer.tsx:80-89` at 36×36) — **but the MiniPlayer one has no accessible name**, so a screen-reader user tabbing to it finds an unnamed button and cannot tell it is pause. And neither announces state: no `aria-pressed`, and the `title` never changes between "Play / Pause Reel". **WCAG 1.4.2 Audio Control (A) passes** — the criterion requires pause *or* volume control, and pause exists. I want to be precise here rather than overclaim: the missing volume control is **not** a 1.4.2 failure, because the "or" is satisfied. (`volume`/`_setVolume` at `player.tsx:41` is dead API surface, and `prevClip` (`:345-351`) is never called — there is no rewind control, but that is a product gap, not a violation.)

**Progress / position: zero exposure.** `role="progressbar"`=0, `role="slider"`=0, `aria-valuenow`=0. Three progress indicators exist and all are purely visual:
- `ReelCard.tsx:312-319` — the scrubber; no `role`, no values, no key handling
- `ReelCard.tsx:321-331` — the fill
- `MiniPlayer.tsx:26-31` — the rim

The elapsed/duration text at `ReelCard.tsx:308-309` *is* rendered as text (`formatTime`), so a screen reader can read it, but it updates 4×/s and is not in a live region, so it is read only if the user happens to be on it.

**Described tracks: no.** No `aria-describedby` links anything to a clip title. `ReelCard.tsx:246-249` renders the title as an `<h1>` (wrong level, see §5), and the quote at `:282-284` is a **hardcoded string identical on every clip** — so it is not a transcript and not an alternative for the audio. For an audio-first product this is the substantive content gap: there is no text equivalent for what the user is hearing.

**Autoplay / auto-advance for AT: hostile, and mandated.** `ReelList.tsx:76-95` plays any clip ≥60% visible; `:98-106` scrolls to the next after 1 s; `player.tsx:86-88` and `:104-106` independently call `handleAutoAdvance` on `timeupdate` and `ended` — **two owners of the same event**, and `player.tsx:175-177` adds an 800 ms `setTimeout` on top. Net effect: the feed changes content on its own, with no announcement, no focus move, and no way to turn it off (`handsFreeMode` is inert). A screen-reader user has no idea playback moved; a vestibular-sensitive user has no way to stop it. Note this is a **spec mandate** (`FRONTEND-REQUIREMENTS.md:880-894`, `:1100`) — see §14.

**Volume bars are decorative and mislabelled as data.** `player.tsx:125-137` is admirably honest that there is no `AnalyserNode` and that the bars are a deterministic pseudo-reactive envelope, not a spectrum. But `ReelCard.tsx:287-300` presents `v[0.13, -0.19, 0.99]`, `similarityScore` (`:150`, computed as `0.92 + (likes % 7) * 0.01`), and `192kbps ABR` as measured telemetry. `ReelCard.tsx:283` presents a fixed sentence as a transcript. These are fabricated data displayed as measurements — out of a11y scope, but it is the same class of defect as the audit's P0-1 and it sits inside the player surface, so I am flagging it rather than staying silent.

**Visualiser is not `aria-hidden`.** 24 bars per card (`ReelCard.tsx:252-279`) + 5 in MiniPlayer (`MiniPlayer.tsx:38-46`), all re-rendering at 60 fps. The only `aria-hidden` in the entire app is `Header.tsx:125` (the health dot).

---

## 8. Touch targets & contrast (incl. terracotta `#e8a87c` feasibility)

**Design tokens (`styles/tokens.css`, 213 lines) — the source of truth by its own docstring, `:5-7`:**

```
--terracotta: #e8a87c;   --accent: var(--terracotta);   --accent-hover: #d4956a;   (tokens.css:40-42)
--sage/#aad0b1, --secondary;  --honey-gold/#f1ce6d, --tertiary                     (:43-46)
--error/#ffb4ab, --danger;  --on-error: #690005;  --background: #121416             (:49-52)
--text-primary/secondary/tertiary → --on-surface / --on-surface-variant / --outline (:59-61)
--tap-target: 64px   (:80)          --content-max: 470px   (:81)
--transition: 0.2s ease  (:85)
[data-theme="light"] { … }  (:90-112)   --cat-* ×6  (:152-157)
```

**Three tokens are dead: `--tap-target` (`:80`) is never referenced anywhere; all six `--cat-*` are never referenced; `[data-theme="light"]` is never activated** (`data-theme` appears nowhere but that block). The token-based palette is *well-tuned* — `--text-primary` 15.3:1, `--text-secondary` 11.6:1, `--text-tertiary` 6.3:1 on the app background. **The contrast problem is caused precisely by bypassing the tokens.**

**Contrast, measured. Note the feed renders on `#0A0A0A` (`App.tsx:64`), not the token's `#121416`:**

| Colour | Ratio on `#0A0A0A` | Verdict |
|---|---|---|
| `text-white/60` | **7.30:1** | PASS AA |
| `text-white/50` | **5.29:1** | PASS AA |
| `text-white/40` | **3.77:1** | **FAIL AA** — 45 occurrences |
| `text-white/30` | **2.61:1** | **FAIL** — 15 occurrences |
| `placeholder-white/20` | **1.77:1** | **FAIL** |
| `#F5F5F5` / `text-white` | 18.2 / 19.8:1 | PASS |

`text-white/40` and `/30` appear **72 times across all 13 component and page files**, at `text-[9px]`–`text-[11px]`. Eight distinct `text-[9px]` sites alone. WCAG **1.4.3** (AA) — and at 9 px, **1.4.4 Resize Text** is failing in practice even though zoom is not blocked.

**Terracotta `#e8a87c` — feasibility. It is a strict improvement, with one hard constraint.**

| Pairing | `#FF6321` (current) | `#e8a87c` (terracotta) | Change |
|---|---|---|---|
| black text **on** brand fill (category chips `ReelCard:165`, play button `:357`, all CTAs) | 7.06:1 ✅ | **10.32:1** ✅ AAA | **better** |
| brand as **text** on `#0A0A0A` | 6.65:1 ✅ | **9.73:1** ✅ | **better** |
| brand as text on `#111111` cards | 6.35:1 ✅ | **9.28:1** ✅ | better |
| `#690005` (`--on-error`) on brand fill — `ErrorBoundary:104` | **4.40:1 ❌ FAIL AA** | **6.44:1 ✅ PASS AA** | **fixes a live failure** |
| **white text on** brand fill | 2.98:1 ❌ | **2.03:1 ❌❌** | **worse — hard prohibition** |

**Conclusions:**
1. **The migration is contrast-positive for every pattern the app currently uses.** The app is disciplined about `text-black` on brand fills, so the one real hazard is prospective, not present.
2. **It repairs a live AA failure**: `ErrorBoundary.tsx:103-104` pairs `var(--accent)` with `var(--on-error)` and currently fails at 4.40:1. Terracotta takes it to 6.44:1.
3. **Rule to encode in the token file: terracotta is a dark-theme brand only. Never white on terracotta.** As a fill it requires near-black text.
4. **The light theme is a landmine.** Terracotta as text on `[data-theme="light"]`'s `--background: #f5f0eb` is **1.80:1** and on `--surface-container: #f2ede6` is **1.75:1** — catastrophic. The light block needs its own darkened `--accent`. It is currently unreachable dead CSS, and because components hardcode `#0A0A0A`/`#111111`/`#F5F5F5`, enabling it would put a full-viewport near-black root div over it — i.e. it would **break**, not work.
5. **The brand token is bypassed.** `--terracotta`/`--accent` is referenced from exactly **one** place in the app: `ReelList.tsx:180` (the Retry button). All 9 components hardcode `#FF6321` — and with three spellings (`#FF6321`, `#ff753b`, `#ff763a`), which is exactly what the prior audit's D1 said the token would collapse.

**Touch targets — WCAG 2.5.8 Target Size (Minimum), AA, 24×24 CSS px (new in 2.2). `--tap-target: 64px` is declared and never used.**

**Below the 24 px AA floor (9 controls) — these fail 2.5.8 outright:**

| file:line | Control | ≈ size |
|---|---|---|
| `CommentSheet.tsx:139-148` | Reply | ~13 px (10 px text, no padding) |
| `CommentSheet.tsx:150-156` | Delete | ~13 px |
| `CommentSheet.tsx:173-182` | Cancel reply | ~13 px |
| `Login.tsx:224-234` | show/hide password | **16×16** (no padding) |
| `Profile.tsx:372-378` | close edit-profile | **16×16** |
| `Profile.tsx:445-451` | close edit-clip | **16×16** |
| `Profile.tsx:419-425`, `:482-487` | Cancel | ~21 px |
| `Profile.tsx:426-432`, `:489-495` | Save | ~21 px |
| `ReelCard.tsx:206-228` | Follow | ~22 px |

**24–44 px (pass AA 2.5.8, fail AAA 2.5.5):** `ReelCard:338,367` 40×40 · `ReelCard:396,417,435` 36×36 · `ReelCard:175` ~24 px · `ReelCard:379` ~30 px · `CommentSheet:90` 28×28 · `CommentSheet:193` 36×36 · `ShareModal:79` 24×24 · `ShareModal:129` 36×36 · `MiniPlayer:67,80,92` 28–36 px · `Header:135` ~26 px · `Header:152` 40×40 · `Inbox:154` 32×32 · `Profile:180,191,300,312` 30–36 px.

**Meets 44 px — 5 controls total:** `ReelCard:351` 56×56 · `Profile:273` 44×44 · `BottomNav:28` 48×48 · **`ErrorBoundary:92,109` (`minHeight: 44`) — the only two buttons in the app that comply.**

**One-line fix with the widest reach:** `--tap-target: 64px` already exists. A `.tap-target { min-block-size: var(--tap-target); min-inline-size: var(--tap-target) }` utility applied to the icon-button primitive fixes ~25 controls at once and gives the dead token a purpose.

---

## 9. Motion / auto-advance

**`prefers-reduced-motion` appears zero times in `src/`.** No media query of any kind.

**Unconditional animation inventory:**

| Site | Animation | Notes |
|---|---|---|
| `player.tsx:143-160` | **60 fps rAF loop, infinite** | `update()` calls `setAudioFrequencies()` (a new array) on **every** tick, then unconditionally re-queues. The `else` branch at `:154-156` runs when **paused** — so the app re-renders the whole `ReelCard` tree 60×/s **forever, even paused, even on another tab**. Not gated on `isPlaying` for the *loop*, only for the *formula*. |
| `ReelCard.tsx:264` | `transition-all duration-75` × 24 bars | 24 elements animating at 60 fps |
| `ReelCard.tsx:322` | `transition-all duration-150` | progress fill |
| `MiniPlayer.tsx:28,42` | `transition-all duration-200` / `duration-75` | |
| `Header.tsx:69` | `animate-pulse` | **Runs forever** on the brand dot, unconditionally |
| `Header.tsx:127` | `animate-pulse` while probing | correctly gated on `checking` |
| `Upload.tsx:165` | `animate-pulse` | forever, on the success screen |
| `Feed.tsx:81,97` · `Explore.tsx:96` · `Inbox.tsx:86` | `animate-spin` | 3 loading spinners, no gate |
| `CommentSheet.tsx:76` | `animate-in slide-in-from-bottom-5 duration-200` | |
| `ShareModal.tsx:70` | `animate-in zoom-in-95 duration-150` | |
| `Upload.tsx:153` | `animate-in zoom-in-95 duration-200` | |
| `tokens.css:196` | `.skeleton { animation: shimmer 1.4s infinite linear }` | |
| **`tokens.css:116`** | **`html { scroll-behavior: smooth }`** | **not gated** — affects every scroll in the app, including `ReelList.tsx:103`'s `scrollIntoView({behavior: "smooth"})` |
| `App.tsx:64`, `Header.tsx:61,68,90`, `ReelCard.tsx:357,403,426,444`, `Profile.tsx:232,279,282`, `Login.tsx:242`, `Upload.tsx:282`, `OnboardingModal.tsx:139` | `transition-all` / `hover:scale-105` / `active:scale-95` | broad, ungated |

WCAG **2.3.3 Animation from Interactions** is AAA, so strictly it is not a conformance blocker; but **2.2.2 Pause, Stop, Hide** (A) is, and the auto-advance has no stop control. The unbounded rAF loop is the more serious item — it is a permanent 60 fps CPU/GPU load with no way for a user to opt out, and it is the thing a `prefers-reduced-motion` block plus a paused-state guard would fix.

**Auto-advance: forced, uncontrollable, and spec-mandated.**

- `ReelList.tsx:98-106` — after `progress >= 0.99`, `setTimeout(…, 1000)` → `scrollIntoView({behavior:"smooth"})`
- `player.tsx:86-88` — `timeupdate` handler calls `handleAutoAdvance()` at ≥0.99
- `player.tsx:104-106` — `ended` handler calls `handleAutoAdvance()` again
- `player.tsx:166-178` — `handleAutoAdvance` → `setTimeout(nextClip, 800)`

**Three independent triggers for one event**, none of which is guarded by `handsFreeMode`, none of which announces, none of which moves focus. `FRONTEND-REQUIREMENTS.md:880-894` and `:1100` explicitly mandate this ("Auto-advance on completion … advances 1 s"; "the user effectively gets a continuous autoplay feed"). So the defect is not that auto-advance exists — it is that **the spec never asked for a stop control, and the control that was built for the job (`handsFreeMode`) is wired to nothing.**

`handsFreeMode` — confirmed inert, and the brief's suspicion is correct:
- declared `player.tsx:43`, defaulting to **`true`**
- read at **zero** conditionals in the entire app; surfaced only as a context value (`:375`)
- consumed for display at `Header.tsx:48,137-148` and `Feed.tsx:27,137-141`
- `Feed.tsx:139` renders **"Manual Navigation Mode"** when it is off — while the feed still autoplays and still auto-advances. **A false statement shown to the user, in a control that looks like a mode switch.**

---

## 10. Grep evidence for "checked and clear" claims

**Complete enumeration of every non-interactive element with a click handler** (brace-aware scan of all opening tags across `src/`, excluding tests). **All 11 lack `onKeyDown`, `tabIndex`, `role`, and `aria-label` — there is not one partial case:**

| file:line | Element | Present | Missing |
|---|---|---|---|
| `components/comments/CommentSheet.tsx:75` | `<div>` backdrop | NONE | onKeyDown, tabIndex, role, aria-label |
| `components/common/Header.tsx:64` | `<div>` brand → feed | NONE | all four |
| `components/feed/MiniPlayer.tsx:34` | `<div>` visualiser → feed | NONE | all four |
| `components/feed/MiniPlayer.tsx:50` | `<div>` clip info → feed | NONE | all four |
| `components/feed/ReelCard.tsx:158` | `<div>` whole card → play | NONE | all four |
| `components/feed/ReelCard.tsx:189` | `<div>` creator → profile | NONE | all four |
| `components/feed/ReelCard.tsx:312` | `<div>` scrubber → seek | NONE | all four |
| `pages/Explore.tsx:114` | `<div>` clip card → play | NONE | all four |
| `pages/Inbox.tsx:107` | `<div>` share row → play | NONE | all four |
| `pages/Profile.tsx:337` | `<div>` liked row → play | NONE | all four |
| `pages/Upload.tsx:179` | `<div>` drop zone → file picker | NONE | all four |

**Confirmed CLEAR (genuinely correct, do not touch):**

| Claim | Evidence |
|---|---|
| No `role="button"` misuse on non-buttons | grep `role="button"` → 0 |
| `aria-current` on the mobile nav | `BottomNav.tsx:32,67` — exactly 2 in source; `navNetworkBanner.test.tsx:172-204` pins exactly one, on the active item, including the separate "Create" branch |
| `focus-visible` ring on the nav's primary action | `BottomNav.tsx:48` `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white`; pinned at `navNetworkBanner.test.tsx:206-224` including the contrast check |
| `aria-pressed` on the hands-free toggle | `Header.tsx:138` |
| Backend health is a real probe with a real accessible name | `Header.tsx:50,118-131`; `useBackendHealth` confirmed mounted at `Header.tsx:5,50`; dot is `aria-hidden="true"` (`:125`) |
| Network banner: no timer, dismissible, live region mounted-when-empty | `NetworkBanner.tsx:45-132`; **no `setTimeout` in the file**; pinned by `navNetworkBanner.test.tsx:48-166` including the 60 s-advance test |
| ErrorBoundary is an `alert` with a real recovery affordance | `ErrorBoundary.tsx:60,92,109`; pinned by `harness.test.tsx:25-59` |
| Follow-failure is announced and rolls back | `ReelCard.tsx:232-238`; pinned by `reelCard.test.tsx:140-155` |
| `html lang="en"` | `index.html:2` |
| **Pinch-zoom is not blocked** | `index.html:5` — no `maximum-scale`, no `user-scalable=no`. (Many apps fail 1.4.4 here; this one does not.) |
| Play/pause reachable by keyboard | `ReelCard.tsx:351-365` — real `<button>`, 56×56 |
| Follow reachable and state-named | `ReelCard.tsx:206-228` — real `<button>`, text changes Follow/Following |
| No `role="alert"` spam | 1 instance only |
| `aria-label` used where a name is genuinely needed | 2 instances, both correct (`SessionAnnouncer.tsx:107`, `NetworkBanner.tsx:114`) |
| 44 px targets exist | 5 controls, incl. both `ErrorBoundary` buttons |
| `<main>` landmark exists on the authenticated shell | `App.tsx:79` |
| `prefers-reduced-motion` **is** honoured | ❌ **NOT CLEAR — 0 occurrences.** Listed here only to make the negative explicit. |
| `--tap-target` is used | ❌ **NOT CLEAR — declared at `tokens.css:80`, referenced nowhere.** |
| `[data-theme="light"]` is reachable | ❌ **NOT CLEAR — `data-theme` never set; would break if enabled.** |
| `--cat-*` colours are used | ❌ **NOT CLEAR — all 6 dead.** |
| `document.title` is updated per route | ❌ **NOT CLEAR — never written.** |
| `htmlFor` associates any label | ❌ **NOT CLEAR — 0 occurrences.** |
| `aria-invalid` / `aria-describedby` associate any error | ❌ **NOT CLEAR — 0 occurrences each.** |
| `autoComplete` on auth fields | ❌ **NOT CLEAR — 0 occurrences.** |
| Any Escape handler | ❌ **NOT CLEAR — 0 occurrences.** |
| Any `.focus()` / `autoFocus` / `inert` | ❌ **NOT CLEAR — 0 occurrences each.** |
| Any `role="dialog"` / `aria-modal` | ❌ **NOT CLEAR — 0 occurrences each.** |
| Any `role="slider"` / `role="progressbar"` / `role="tab"` | ❌ **NOT CLEAR — 0 each.** |
| Any keyboard-scroll affordance on the reel list | ❌ **NOT CLEAR — no `tabIndex`, no `onKeyDown`.** |
| `playbackError` is rendered | ❌ **NOT CLEAR — set and exposed, read by nothing.** |
| `handsFreeMode` gates anything | ❌ **NOT CLEAR — gates nothing.** |
| Test suite covers keyboard/focus | ❌ **NOT CLEAR — `userEvent.tab()`: 0, `toHaveFocus()`: 0, `getByLabelText`: 0, `toHaveAccessibleName`: 1** (`navNetworkBanner.test.tsx:186`). |

---

## 11. Prioritised fix set

### (a) Tokens / primitives — 1 file + 1 new primitive

| # | Change | File | Why first |
|---|---|---|---|
| A1 | **Replace all `text-white/40` (3.77:1) and `text-white/30` (2.61:1) with `var(--text-secondary)` (11.6:1) / `var(--text-tertiary)` (6.3:1)**, or raise the opacity floor. 72 sites, 13 files. | all | Largest single WCAG failure by volume; purely mechanical; also fixes the 9 px legibility problem |
| A2 | **Consume `--tap-target: 64px`**: add a `.tap-target` utility and apply to the icon-button primitive. Kills 25 sub-44 px controls including all 9 sub-24 px ones. | `tokens.css` + primitive | One line fixes more targets than any other change |
| A3 | **Adopt `--accent` (terracotta) and delete the three `#FF6321` spellings.** Contrast-positive everywhere it is currently used; fixes `ErrorBoundary:104` from 4.40:1 to 6.44:1. Encode the rule: *brand fill ⇒ near-black text; never white on brand.* | `tokens.css` + 9 components | Reframes the "cosmetic" migration as the a11y remediation it is (§15) |
| A4 | **Add the `@media (prefers-reduced-motion: reduce)` block**: kill `.skeleton` shimmer, all `animate-pulse`/`animate-spin`, `html { scroll-behavior: smooth }`, and the `scrollIntoView` smooth behaviour. Gate on the media query in JS for the auto-advance. | `tokens.css` | 0 → 100% coverage; also cuts the permanent 60 fps load |
| A5 | **Add `<Sheet>`**: `role="dialog" aria-modal="true" aria-labelledby`, focus move on open, real focus trap, Escape, backdrop click, focus restore, background scroll lock. | new `components/common/Sheet.tsx` | Replaces 5 hand-rolled modals; the single highest-leverage component in this report |
| A6 | **Add `<IconButton>`** requiring an `aria-label` prop (TS-enforced), with `min-block-size: var(--tap-target)` and the `focus-visible:ring` baked in. | new primitive | Makes defects A2/#10/#15 structurally impossible |
| A7 | Add a `focus-visible` ring utility; **remove the remaining 11 `focus:outline-none`**. | 5 files | 2.4.7 |
| A8 | **Delete or wire the dead tokens**: `--tap-target` (via A2), `--cat-*` ×6, `[data-theme="light"]` (add a darkened `--accent`, or delete the block). | `tokens.css` | Either they are live or they are lies |

### (b) Components — leaf files, fully parallelisable

| # | Change | Files |
|---|---|---|
| B1 | **Associate all 14 labels** (`htmlFor` + `id`), and give the comment composer and the file input real labels. Add `autoComplete` to all four auth fields. | `Login`, `Upload`, `Profile`, `ShareModal`, `CommentSheet` |
| B2 | **Name the 9 unnamed buttons + override the 4 number-named ones** with `aria-label`. Add `aria-pressed` to like/follow/toggle-play. | `MiniPlayer`, `CommentSheet`, `ShareModal`, `Profile`, `Login`, `ReelCard` |
| B3 | **Render `playbackError`** — the 4 states exist and are already distinguished. Use `role="alert"`. | `player.tsx` (hub, single-owner) |
| B4 | **Stop swallowing the three core-loop errors**: comment post, share send, delete. Give each a `role="status"` region, following the `ReelCard:232` precedent. | `CommentSheet`, `ShareModal`, `Inbox`, `Profile` |
| B5 | **Fix the three keyboard-invisible click surfaces**: make the creator bar a `<button>`; make the Explore and Inbox rows contain real `<button>`s; give the liked-reels list the play button the uploads list already has. | `ReelCard`, `Explore`, `Inbox`, `Profile` |
| B6 | **Fix the scrubber**: `role="slider"`, `aria-valuemin/max/now/valuetext`, `tabIndex={0}`, Arrow/Home/End/PageUp/PageDown. Also guard it so a non-current card cannot seek the current clip. | `ReelCard` (hub) |
| B7 | **Add `aria-live` to the 8 unassociated error/loading regions** and the 2 loading states; add `role="status"` to upload success and invalidate the 2.5 s redirect. | `Login`, `Upload`, `Feed`, `ReelList`, `Explore`, `Inbox`, `Profile`, `OnboardingModal`, `ShareModal` |
| B8 | **`aria-pressed` on the 4 colour-only state UIs**; `role="group"` + a name for the tag grid. | `Login`, `Profile`, `Explore`, `OnboardingModal` |
| B9 | **Headings**: one `<h1>` per page, demote `ReelCard:246` to `<h2>`/`<h3>`, add the missing `<h1>` to Profile, close the h2→h4 and h1→h3 skips. | `ReelCard`, `Profile`, `Explore`, `Inbox` |
| B10 | **Add `aria-current="page"` to the Header's desktop nav** and give it `role="navigation"`; label the unread badge (`5 unread`, not a bare `5`). | `Header` |
| B11 | **`aria-hidden` the 24+5 visualiser bars**; `role="region" aria-label="Now playing"` on MiniPlayer; `aria-describedby` the clip title. | `ReelCard`, `MiniPlayer` |
| B12 | **Guard the rAF loop on `isPlaying`** and skip `setState` when the array is unchanged. Kills 60 fps re-render while paused. | `player.tsx` (hub) |
| B13 | **Stop `disabled` from dropping focus**: `aria-disabled` + `onClick` guard, or move focus to the submit button. Fix the `aria-busy` misuse. | 6 files |
| B14 | **Name the avatar button** "My Profile" (`aria-label` beats the `img alt`), not the username. | `Header` |

### (c) Flow-level — sequential, needs decisions

| # | Change | Why flow-level |
|---|---|---|
| C1 | **Make `handsFreeMode` real, or delete it.** Either gate `ReelList:76-95`, `ReelList:98-106`, `player:86-88/104-106/166-178` and `MiniPlayer`, or remove the toggle and the "Manual Navigation Mode" copy. **Pick one owner for auto-advance** (3 triggers today). **Decide the default** — `true` means continuous autoplay with no opt-out. | Crosses `player.tsx` + `ReelList` + `Header` + `Feed`; needs a product decision; if auto-advance is spec-mandated, the fix is a control, not a deletion |
| C2 | **Focus management on navigation**: focus the new page's `<h1>` on tab change, update `document.title`, and announce the change. Also fix the LoginPage flash during auth loading. | Crosses `App.tsx` + all 5 pages |
| C3 | **Focus on feed advance**: announce the new clip, and either preserve or deliberately move focus so it is not destroyed with the card. | Needs a decision on whether the feed is a "reading" context or a "browsing" context |
| C4 | **Move focus to the ErrorBoundary's "Try again"** when the tree is replaced. | 3 lines, but it is a real behaviour change |
| C5 | **Fix the repeat-announce hole in `SessionAnnouncer`** (consume the `id`), dispatch `ef_session_expired` on the network-throw path, and reconsider polite → assertive for session loss. | Crosses `client.ts` + `auth.tsx` + `SessionAnnouncer` |
| C6 | **Give the audio a text equivalent.** The quote at `ReelCard:283` is hardcoded; the backend already runs Whisper, so a real transcript exists. Expose it as an expandable transcript per clip. | Content + flow; the substantive gap for an audio-first product |
| C7 | **Reel-to-reel keyboard navigation**: arrow keys on the list, `tabIndex={0}` on the scroll container, and a position indicator to replace the hidden scrollbar. | Needs a decision on the interaction model (does ArrowUp move the reel, or scroll it?) |

### **MINIMUM VIABLE SET for an MVP launch**

Nine changes. Everything else is post-MVP.

1. **B1** — associate all labels + `autoComplete`. *You cannot ship an auth form where no field has a name.*
2. **B1 (drop zone)** — make the file input reachable by keyboard. *Upload is otherwise impossible without a mouse.*
3. **B2** — name the 9 unnamed buttons. *Includes the comment-submit button; four of them are ≤24 px.*
4. **A5 + B5** — the `<Sheet>` primitive + convert the 5 modals. *One primitive fixes 5 surfaces; B5 makes the creator bar and the three card lists real controls.*
5. **B6** — keyboard-operable scrubber with `role="slider"`.
6. **B4 + B3** — stop swallowing comment/share/playback failures. *Three core-loop steps currently fail invisibly.*
7. **C1** — make `handsFreeMode` real, or delete it and the "Manual Navigation Mode" copy. *Do not ship a control that lies and a feed nobody can stop.*
8. **A1** — `text-white/40` → a passing token. *72 sites, mechanical, largest failure by volume.*
9. **A4** — the `prefers-reduced-motion` block. *One media query; also stops the permanent 60 fps loop.*

**Deliberately out of the MVP set:** C2/C3 (focus on navigation and feed advance), B7 (the 8 remaining live regions — the 3 core-loop ones ship via #6), B8, B9, C6, C7, A3 (terracotta — see §14), A8.

---

## 12. What a fix MUST preserve

**Green signals (do not regress):**
- `npx tsc --noEmit` clean under `strict` + `noUncheckedIndexedAccess`
- `npx vitest run` — **48 tests** (verified count: `backendHealth` 11, `navNetworkBanner` 13, `harness` 7, `reelCard` 8, `mediaMock` 9)
- `npx vite build` succeeds (single ~926 kB chunk)
- backend: `716 passed, 0 failed, 7 skipped`

**Tests that will legitimately need updating, and why:**
- `harness.test.tsx:82` asserts `aria-live="polite"` on the session region. **If you change session expiry to `assertive`, this test fails by design.** That is the correct outcome — update the assertion deliberately, do not avoid the change to keep the test green.
- `reelCard.test.tsx` uses `getByRole("button", {name: /following/i})` and `{name: /^follow$/i}`. Any `aria-label` on the follow button that changes its computed name **breaks these**. Keep "Follow"/"Following" as the accessible name, or update the matchers in the same commit.
- `navNetworkBanner.test.tsx:226-231` asserts all five BottomNav names. Keep them.
- `navNetworkBanner.test.tsx:206-224` pins the `focus-visible` ring and asserts it is **not** `FF6321`-coloured. **Terracotta migration must not change that ring to the brand colour** — on the "Create" tab the fill is the brand colour in both states, so a brand ring is invisible. The existing white ring is correct; keep it.

**Behaviour that must not regress while fixing a11y:**
- **Player continuity across tab switches.** The player is hoisted above the tab switch in `App.tsx`; that is what keeps audio playing. Any focus-management work on navigation must not remount `PlayerProvider`.
- **`BottomNav` has a separate JSX branch for the highlighted "Create" tab** (`:26-60` vs `:62-85`) — the test at `:189-197` exists precisely because an attribute added to one branch silently skips the other. The same trap applies to `aria-label` work.
- **`xhrSetup: { xhr.withCredentials = true }`** (`player.tsx:244-246`) — the `ef_hls_token` cookie must reach the manifest *and every segment*. A11y work must not touch HLS loading.
- **`hls_playlist_url` used verbatim** — never prefix the API base. Unrelated to a11y but the single most-repeated trap in this codebase.
- **The `ReelCard` follow `aria-busy` + `disabled` in-flight guard** (`:107`, `:209-210`) — `reelCard.test.tsx:157-184` pins that a double-tap issues one request. Replacing `disabled` with `aria-disabled` must keep that guard.
- **The live-region-mounted-when-empty pattern** in `NetworkBanner.tsx:82-106` and `SessionAnnouncer.tsx:73-100`, including the explanatory comments. Copy it; do not reintroduce `display: none` toggling.
- **`role="alert"` on the ErrorBoundary** and its two 44 px buttons.

**Genuinely contested — do not "preserve":** the `focus:outline-none` + `focus:border-[#FF6321]` border-colour substitute on 11 inputs. The prior audit called 2.4.11/2.4.13; the AA criterion is **2.4.7 Focus Visible** (2.4.13 is AAA). A 1 px border-colour shift from `white/15` to the brand is a weak indicator and is not a focus ring. Replace it.

---

## 13. Tests that would prove each fix

RTL idioms already established in this repo: `getByRole(name)`, `getByRole("status")`, `toHaveAccessibleName`, `act()` around `window.dispatchEvent`, `vi.useFakeTimers()` + `advanceTimersByTimeAsync`, and the `installFetchMock` helper. The suite currently has **zero** `userEvent.tab()`, **zero** `toHaveFocus()`, **zero** `getByLabelText`.

**Global a11y lint test (highest value, catches regressions nobody will remember):** add `vitest-axe` / `axe-core` and run it against every page. This alone would flag the unnamed buttons, the unassociated labels, the heading skips, and the missing dialog semantics. Note it will **not** catch the keyboard-invisible divs or the silent `console.warn` failures — those need the targeted tests below.

| Fix | Test | Assertion |
|---|---|---|
| **#1 upload keyboard** | render `UploadPage`; `await user.tab()` until the file field is reached | `expect(screen.getByLabelText(/audio file/i)).toBeInTheDocument()`; and `await user.keyboard('{Enter}')` on the proxy control opens it. Must be seen red first: today `queryByLabelText` returns null. |
| **#2 labels** | one `it` per field across Login/Upload/Profile/ShareModal | `expect(screen.getByLabelText('Username')).toBeInTheDocument()` — `getByLabelText` **throws** when a label exists without `htmlFor`, so this is a true red-before-green test. |
| **#3 comment composer** | render `CommentSheet isOpen` | `getByRole('textbox', {name: /comment/i})`; then type and assert the submit button by name: `getByRole('button', {name: /post comment/i})`. |
| **#4 creator bar** | `renderCard(makeClip())`; tab through | `getByRole('button', {name: /alex|open profile/i})` exists; `await user.click(...)` calls `onCreatorClick(CREATOR_ID)`. Red today: no such role. |
| **#5/#6/#7 card rows** | Explore / Inbox / Profile-liked | `getAllByRole('button', {name: /play/i})` has length > 0. Red today: length 0. |
| **#8 scrubber** | `renderCard`; focus the slider | `const s = screen.getByRole('slider'); expect(s).toHaveAttribute('aria-valuenow', '0')`; then `await user.keyboard('{ArrowRight}')` and assert `seek` was called with a positive value (mock `usePlayer`). Red today: `getByRole('slider')` throws. |
| **#9 `<Sheet>`** | one suite, 5 call sites | On open, `expect(inside).toHaveFocus()`; `await user.tab()` ×20 and assert `document.activeElement` is always within the dialog (**trap**); `await user.keyboard('{Escape}')` and assert `onClose` fired; reopen, close, and `expect(trigger).toHaveFocus()` (**restore**). |
| **#10/#11 names** | table-driven over all icon buttons | `getByRole('button', {name: 'Play reel'})`, `{name: /like reel, 12/}` (i.e. label **overrides** the count), `{name: 'Dismiss comments'}`. Red today: name is `""` or `"12"`. |
| **#12 `playbackError`** | mock `getPlaybackToken` → 403, `render` the card | `expect(await screen.findByRole('alert')).toHaveTextContent(/unavailable/i)`. Red today: no alert node exists. |
| **#13 silent failures** | `fetchMock.on("POST", /comments/, () => ({status: 500}))`; submit | `expect(await screen.findByRole('status')).toHaveTextContent(/could not post/i)`. Mirror the existing `reelCard.test.tsx:140-155`, which already proves the pattern. Same for `sendShare`. |
| **#14 `handsFreeMode`** | render `ReelList` with `handsFreeMode: false`; drive `progress` to 1 | assert `scrollIntoView` / `nextClip` was **not** called. Red today: it is called. Also assert the honest inverse — with `true` it **is** called — so the toggle is pinned in both directions. |
| **#15 focus rings** | assert on `className` (the `navNetworkBanner.test.tsx:206-224` idiom) for all 11 inputs | `expect(el.className).not.toMatch(/(^\|\s)focus:outline-none(\s\|$)/)` and `toMatch(/focus-visible:/)` |
| **#16 error association** | submit an invalid Login form | `const input = screen.getByLabelText('Username'); expect(input).toHaveAttribute('aria-invalid', 'true')` and `toHaveAccessibleDescription(/required/i)` |
| **#17 reduced motion** | stub `matchMedia`; assert the stylesheet | Either a `CSS` parse asserting the `@media (prefers-reduced-motion: reduce)` block exists, or — better — assert behaviour: with the query matching, `scrollIntoView` is called without `{behavior:'smooth'}` and the rAF loop does not `setState`. |
| **#18 rAF loop** | render with `isPlaying: false`; advance rAF | spy on the store's setter or count renders; assert the render count is **flat** while paused. Red today: it grows without bound. |
| **#19 2.5 s redirect** | `vi.useFakeTimers()`; complete an upload | assert the success region is present **before** any timer advance, that it is a `role="status"`, and that the redirect has **not** fired at 2.5 s without a user action. |
| **#20 headings** | per page | `getByRole('heading', {level: 1})` has length **1**; then assert no level skips walking the heading list in document order. Red on Feed (N×h1), Profile (h2→h4), Explore/Inbox (h1→h3). |
| **#21 pressed state** | per toggle | `expect(getByRole('button', {name: /comedy/i})).toHaveAttribute('aria-pressed', 'true')` |
| **#22 focus retention** | focus a submit button, then make it disable | `expect(el).toHaveFocus()` after the state change. Red today: focus falls to `<body>`. |
| **#23/24 contrast & size** | static assertion over source | A test that reads the component files and fails on `text-white/40`, `text-white/30`, `placeholder-white/20`, or on any button class lacking `min-h-\[44px\]`/`min-w-\[44px\]`. Crude but it makes the regression **impossible** to reintroduce silently, and it is cheap. Pair with a real computed-contrast test for the token palette. |
| **#25 repeat announce** | dispatch `ef_session_expired` **twice** | assert the region's content changes identity between fires (e.g. a `key`/nonce differs) — red today, since the DOM text is identical. |
| **#30 emoji** | Profile with one clip | `getByText(/1 like/)` or `toHaveAccessibleName` on the stat — red today, where the text is `"❤️ 3 • 💬 0 • 🔄 1"`. |
| **#32 hidden bars** | `renderCard` | `expect(document.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(24)` |

**Minimum bar for acceptance, consistent with the repo's own rule** (`COMPLETION_PLAN.md` §3.4: *"a test you have never seen red is not evidence"*): **every test above must be observed failing against the current code before the fix.** Given the size of the gap, expect most to fail on the first run — that is the expected outcome, not a signal to adjust the test.

---

## 14. Deliberately NOT fixed for MVP — with reasoning

| Item | Reasoning |
|---|---|
| **Terracotta migration (A3)** | **Contrary to `COMPLETION_PLAN.md:149`, which calls it "purely cosmetic, zero behavioural value" — that is wrong; see §15.** But I still recommend deferring it, for a different reason: it is a **large mechanical diff across 9 files** (three hex spellings, ~90 sites) that would collide with the a11y edits landing in the same files, making both reviews harder. **Exception: apply it to `ErrorBoundary.tsx:104` alone**, where it is the difference between 4.40:1 (fail) and 6.44:1 (pass) — a 3-line commit that repairs a live AA failure and is independent of everything else. |
| **C2 focus on navigation + `document.title`** | Real, but the fix needs a decision about what "the page" is in a 5-way `useState` tab shell with no router, and it touches `App.tsx` plus all 5 pages. Ship with the current behaviour and fix in the router commit. The `document.title` half is genuinely trivial and could be a 5-line standalone — worth pulling forward if someone has a free moment. |
| **C3 focus on feed advance** | Requires a product decision I cannot make: in a continuous autoplay feed, is focus *supposed* to follow the reel (disorienting — the user did nothing) or stay put (but then it is destroyed when the card unmounts)? Both are defensible; the answer depends on whether hands-free is the default. Blocked on C1. |
| **B7's remaining 6 live regions** | `Explore`/`Inbox`/`Profile` error text and the loading states. They are real 4.1.3 failures but are on non-core-loop surfaces with a visible message present. Fix after the core three. |
| **B8 `aria-pressed` on the 4 colour-only UIs** | 1.4.1 failures with a visible non-colour cue absent — but the visual states are distinct enough that a sighted keyboard user is not lost. Cheaper to fix alongside the `Sheet` work than separately. |
| **B9 heading hierarchy** | Genuinely wrong (N `<h1>`s on the feed is bad), but screen-reader users navigate by landmark and list, not primarily by heading, in a 5-tab app. Fix when the router lands and each page gets a real `<h1>`. |
| **C6 real transcripts** | The most *substantive* a11y gap for an audio-first product, and the one I am least comfortable deferring — but the backend change (expose Whisper output through the serializer) plus a UI is a feature, not an MVP fix. **Flag to the owner as the top post-MVP item.** |
| **C7 reel arrow-key navigation** | The interaction model is undecided, and it interacts with autoplay. Blocked on C1. |
| **B13 `disabled` → `aria-disabled` across 6 files** | The focus-drop is real but each instance is momentary and self-correcting on the next Tab. The `CommentSheet:195` one is worth pulling forward (it fires on every comment submit). |
| **A8 dead tokens / light theme** | Not user-visible. But leaving `[data-theme="light"]` in place is a **trap** — see §16. |
| **A 44 px target for everything (A2 at 64 px)** | WCAG 2.5.8 AA is 24×24, and only 9 controls fall below it. Shipping `.tap-target` at 24 px clears AA everywhere; raising to the 64 px the token already declares is a **layout** change (it will reflow the ReelCard control row and the comment footer) and should be a design decision, not an a11y patch. |

---

## 15. Disconfirmations

**Things the prior audit (`docs/frontend_rebuild_plan.md` §3.5) got wrong or imprecise:**

1. **"Baseline: 3 `aria-*` attributes in 1,626 lines"** and **"No error boundary anywhere — a throw in `usePlayer` or `useAuth` unmounts the whole tree to a blank page"** — both **stale**. `ErrorBoundary` shipped in `4ed5cf5` and is currently at `App.tsx:151-160`. The audit is dated `2026-09-29`; the file inventory in `COMPLETION_PLAN.md:35-59` is stale in the same way (it lists `Header.tsx` at 128 lines — it is 176; `BottomNav` 73 — it is 90; `NetworkBanner` 59 — it is 133). All line references in §3.5 have drifted: the scrubber is `ReelCard.tsx:312-319`, not `:267-286`; the card is `:158-161`, not `:127-129`.

2. **"All three modals: no `role="dialog'`…"** — **undercount. There are FIVE.** `Profile.tsx:368` (edit profile) and `Profile.tsx:441` (edit clip) are additional hand-rolled modals with identical defects, and neither appears anywhere in the audit, the prior plan's Phase 5, or `COMPLETION_PLAN.md`. Any Sheet-primitive work scoped to the three the audit names will leave two behind.

3. **"9 icon-only buttons with no `aria-label`; `title=` used as the accessible name"** — **the diagnosis is wrong for 4 of them, and the implied fix would not help.** For `ReelCard.tsx:396` (like), `:417` (comment), `:435` (share), and `:175` (speed), the button's computed name comes from its **content** (a bare number: `"12"`, `"7"`, `"3"`, `"1X"`), because name computation is `aria-labelledby → aria-label → content → title`. **`title` is last and is never reached.** So `title="Like Reel"` is not "the accessible name" — it is dead code. Adding `aria-label` to the *other* buttons while assuming these are fine would leave four engagement controls announced as bare numerals. It also conflates two distinct failure modes (no name at all vs. wrong name) under one count.

4. **"Tag selection is a `<div>` checkbox, invisible to assistive tech"** — **wrong.** The tag *is* a real `<button>` (`OnboardingModal.tsx:89`); the `<div>` at `:108-114` is only a visual checkbox *inside* it. The tag is fully in the accessibility tree and keyboard-reachable. The actual defect is narrower and different: **no `aria-pressed`, so the selected state is not exposed** (4.1.2 + 1.4.1). "Invisible to assistive tech" would imply the control needs replacing; it needs one attribute.

5. **"1 px border-colour focus rings fail WCAG 2.4.11/2.4.13"** — **wrong criteria and a big undercount.** 2.4.11 (Focus Not Obscured) is not about focus indicators, and 2.4.13 (Focus Appearance) is **AAA**. The AA criterion is **2.4.7 Focus Visible**. And it cites 2 sites; there are **11** remaining `focus:outline-none` instances (Login ×5, Profile ×3, Upload ×2, CommentSheet ×1, ShareModal ×1). Only `BottomNav` was fixed.

6. **"ReelList's scroll container hides the scrollbar … a keyboard user cannot reach clip 2+"** — **too strong, and the conclusion is wrong.** Because every clip's controls are focusable, tabbing **does** scroll later reels into view (browsers scroll focused elements into view). A keyboard user can reach reel 2+. What is actually true: the container has **no `tabIndex`, so arrow keys / Page Up / PageDown / Home / End do not scroll it**, there is **no reel-to-reel navigation**, and the hidden scrollbar (`tokens.css:207-212`, both engines) removes any position indicator — so reaching reel N means tabbing past ~11 controls of reel N−1 and the feed appears to move on its own. The accurate defect is the *absence of a keyboard scroll path*, not an unreachable feed. The prior phrasing would justify a fix (add `tabIndex`/arrow keys) that does not address the real cost (~11 tab stops per reel).

7. **"Video scrubbing is a hard WCAG 2.1.1 requirement"** (`:130`) — a media-recon artifact. This is an **audio-only** product. The criterion still applies (2.1.1 covers any UI component) and the conclusion survives, but the framing is wrong for the product.

8. **"the unread badge reads as a bare number"** — **imprecise.** The badge is a bare number *structurally* (no `aria-label`, no hidden text), but the enclosing `<button>`'s computed name is `"Inbox 5"`, because the badge sits inside a button that also contains `<span>{tab.label}</span>`. So the button is not nameless. The real defects are: the count is **not in a live region** (silent change), and "Inbox 5" is ambiguous in isolation — nothing states the 5 is an *unread* count. The right fix is `<span class="sr-only">{n} unread</span>`, not "name the button".

**Things `COMPLETION_PLAN.md` gets wrong:**

9. **Line 149: "Terracotta token migration … Purely cosmetic, zero behavioural value."** — **wrong, and it contradicts the prior audit's own D1.** Measured: terracotta takes `ErrorBoundary.tsx:104`'s `#690005`-on-accent from **4.40:1 (fails 1.4.3 AA)** to **6.44:1 (passes)**, and brand-as-text from 6.65:1 to 9.73:1. It is a remediation with a measurable outcome, not a cosmetic change. It is also *contrast-positive for every pattern the app currently uses* — black-on-fill 7.06 → 10.32:1. The correct statement is "large diff, modest blast radius, and it repairs one live AA failure."

10. **Line 142 (D1): "Re-place the `ErrorBoundary` so it actually wraps `AuthProvider`/`PlayerProvider` (today it sits outside both, so it catches neither)".** — **backwards.** `App.tsx:151-160` is:
```
    <ErrorBoundary>
      <AuthProvider>
        <PlayerProvider>
          <AuthenticatedApp />
```
It is the **outermost** element and already wraps both. The accurate statement is narrower: it catches their **render-phase** throws but not throws in their `useEffect`s or async callbacks, which React error boundaries never do. **`ErrorBoundary.tsx:28-29` has the same claim inverted** — *"it sits inside the providers, so a throw in the providers themselves is not caught here"* — which is false. Two documents assert the same thing and both have it backwards. This is precisely the failure mode the owner flagged in `ErrorBoundary.tsx:28` ("a comment describing a method that does not exist"), recurring in a comment about component nesting.

11. **Line 150: "Full a11y sweep — Phase A + C2/C3 cover the keyboard and label defects that block use. Polish (focus-trap refinement, live-region tuning) is post-MVP."** — **understates it, and the phase allocation makes the Definition of Done unreachable.** Cross-referencing the file ownership in §4 against the defects in this report: **no agent owns a11y work in `Login.tsx`, `MiniPlayer.tsx`, `CommentSheet.tsx` (dialog), `ShareModal.tsx` (dialog), or `SessionAnnouncer.tsx`**, and C4's `Upload.tsx` task does not mention the drop zone while A2's `Explore.tsx` and A3's `Inbox.tsx` tasks do not mention their card rows. So **line 206's "Every interactive element is reachable and named" cannot be satisfied by the current partition** — three of my five `C`-severity findings have no owner.

12. **Line 174: "Suite baseline to protect: 716 passed, 0 failed, 7 skipped"** vs **line 30: "Verified baseline before starting: `npm test` 24 passed"** — internally inconsistent, and **the frontend figure is stale: the suite is 48 tests** (verified by counting `it(` blocks). Worth pinning so the DoD in §8 is measurable.

13. **Line 116 (A5): "Define … the light-theme `[data-theme="light"]` block."** — **the block already exists** (`tokens.css:90-112`) and `data-theme` is never set. Worse, A5 as written would *author* a second light theme without noticing that terracotta on `--background: #f5f0eb` is **1.80:1**. And because every component hardcodes `#0A0A0A`/`#111111`/`#F5F5F5`, enabling it would put a full-viewport near-black root div over the theme — it would **break**, not work. A5 should be "delete the light block, or add a darkened `--accent` and a migration plan".

**Claims in my brief that I could not confirm as stated:**

14. **"`focus:outline-none` removed … in navigation"** — true for `BottomNav` only. **11 instances remain** across 5 files (§1 #15). The BottomNav fix is real and well-tested (`navNetworkBanner.test.tsx:206-224`); it was just not generalised.
15. **"`aria-current` on the active nav item"** — true for `BottomNav`; **zero occurrences in `Header.tsx`**, which duplicates the same five destinations on desktop (§1 #29). Confirmed by grep: `aria-current` appears exactly twice in source, both in `BottomNav.tsx:32,67`.
16. **"A1 added `useBackendHealth` + `NetworkBanner` + accessible name on the backend-ready status"** — **confirmed done.** `useBackendHealth` is mounted (`Header.tsx:5,50`), the indicator is `role="status" aria-live="polite"` with a descriptive `title` (`:118-131`), and the decorative dot is `aria-hidden="true"` (`:125`). Two caveats worth carrying forward: the whole block sits inside `hidden lg:flex` (`:114`) so **it does not exist in the a11y tree on mobile**, the primary form factor; and the audit's "A1 … `aria-pressed` on toggles" is satisfied only for the one toggle A1 owned.
17. **"`SessionAnnouncer.tsx` has a stale ~2.5 s reference"** — **confirmed, and there are two, not one.** `SessionAnnouncer.tsx:23` ("as `NetworkBanner` does at 2.5 s") **and** `harness.test.tsx:100-101` ("unlike NetworkBanner's 2.5 s timer"). Both are contradicted by `NetworkBanner.tsx:26` ("There is now no timer anywhere in this file") **and by a passing test** — `navNetworkBanner.test.tsx:48-66` advances 60 s and asserts the notice is still there. A stale comment contradicted by a green test is a stronger signal than one contradicted by prose. **Note the live 2.5 s timer the comments probably meant: `Upload.tsx:125-127`.**
18. **"`handsFreeMode` may be inert"** — **confirmed inert, and worse than "may".** Not merely ungated: `player.tsx:43` defaults it to **`true`**, it is read at **zero** conditionals app-wide, and `Feed.tsx:139` displays **"Manual Navigation Mode"** when it is off — a false statement, not merely a dead flag. RECON-01 §2.6c independently reached this conclusion with matching line numbers (corroboration). One correction to RECON-01: it calls the fix "one line". It is **three unguarded sites** (`ReelList.tsx:76-95`, `ReelList.tsx:98-106`, `player.tsx:166-178` reached from two triggers) plus the default, and the default is a product decision.

**Scope note:** `docs/FRONTEND-REQUIREMENTS.md` — 2,006 lines — contains **zero** accessibility requirements. Not one mention of WCAG, keyboard, screen reader, focus, contrast, tap target, landmark, heading, motion, or transcript. The only two matches for "accessib"/"aria" are about JS-accessible scripts (`:579`) and HLS relative references (`:1517`). Meanwhile the same spec **mandates** the autoplay + auto-advance behaviour that is hostile to AT (`:880-894`, `:1100`) with no stop control and no motion preference. So there was never a contract to regress against, and `COMPLETION_PLAN.md:206` is the **first** place an accessibility requirement appears in the repo. That is why the prior audit's Phase 5 reads as a single deferred phase rather than a set of conformance obligations — and why "the spec says nothing" is not a defence of any of the findings above.

---

## 16. Open questions for the owner

1. **Is auto-advance staying?** `FRONTEND-REQUIREMENTS.md:880-894` and `:1100` mandate it; `handsFreeMode` was built to control it and is wired to nothing; `player.tsx:43` defaults it to `true`. Three options: (a) make the toggle real and **default it to off**, (b) keep it on by default but make the toggle real and add a persistent visible stop control, (c) drop auto-advance and keep manual `Next`. **I need a decision before C1**, and the choice changes what "Manual Navigation Mode" is allowed to say.

2. **What is the accessibility conformance target for launch?** AA (recommended, and what this report assumes), or a narrower "no keyboard traps on the core loop"? This changes the MVP set materially — 2.4.7 (2.4.11/2.4.13) is AA, 2.3.3 reduced-motion is AAA, 2.5.5 at 44 px is AAA vs 2.5.8 at 24 px AA.

3. **Should the light theme be revived or deleted?** `[data-theme="light"]` exists, is unreachable, would **break** if enabled (near-black root div over it), and terracotta on it is **1.80:1**. Delete it, or fund a proper theme with a darkened `--accent`?

4. **Is `--tap-target: 64px` the intended target, or AAA 44 px?** The token says 64. Applying it reflows the ReelCard control row and the comment footer. Design decision, not an a11y patch.

5. **Where does the player state live?** Every fix here lands in `player.tsx`, `ReelCard.tsx`, or `client.ts` — the three single-owner hub files in `COMPLETION_PLAN.md:69-72`. I have 6 findings in them (playbackError, the rAF loop, the scrubber, handsFreeMode, repeat-advance, the session-expiry dispatch gap). **Do you want them in one agent's sequential pass, or split around the hubs?** And do you want the scrubber's `role="slider"` semantics defined here, or deferred with a decision on whether a keyboard-seekable scrubber is even the right control for a 60-second audio clip?

6. **Whose job is the five unowned a11y surfaces?** `Login.tsx`, `MiniPlayer.tsx`, `CommentSheet.tsx`'s dialog, `ShareModal.tsx`'s dialog, and `SessionAnnouncer.tsx` have **no owner** in the current phase allocation, yet they contain 3 of my 5 `C`-severity findings. Do I extend existing agents' file ownership (which breaks the "disjoint files" invariant at `COMPLETION_PLAN.md:62-67`), or add an agent?

7. **Terracotta: full migration now, or `ErrorBoundary:104` only?** I recommend the narrow one now (§14) — it is the difference between a failing and a passing AA criterion in 3 lines, independent of everything else. The full migration should follow the a11y edits so the two diffs do not overlap in review.

8. **Is a real transcript in scope for the MVP?** This is the one I would argue hardest for. The backend already runs Whisper; `ReelCard.tsx:283` displays a hardcoded sentence as if it were the clip's transcript. For an audio-first product this is the substantive content gap behind all the label/announcement work — but it needs a serializer change, so it is a feature, not a patch.

9. **What should a screen reader hear when the reel advances?** This is C3, and it is genuinely undecidable from the code: is the feed a "reading" context (focus should not follow) or a "browsing" one (it should)? Both are defensible and the answer depends on Q1. I did not want to guess.

10. **Should the app have one navigation landmark or two?** `<nav>` is `md:hidden`, so desktop currently has none. The options are: label both (two `<nav aria-label>`s), or make the Header's desktop tabs the only `<nav>` and drop `md:hidden` from `BottomNav`. The second changes the layout; the first is markup only.
</task_result>
</task>