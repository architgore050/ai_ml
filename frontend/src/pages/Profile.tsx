import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  User as UserIcon,
  Heart,
  Music,
  Edit3,
  Trash2,
  LogOut,
  Play,
  Pause,
  Camera,
  X,
  AlertCircle,
  RotateCw,
} from "lucide-react";
import { clipsAPI, profileAPI } from "../api/client";
import { useAuth } from "../stores/auth";
import { usePlayer } from "../stores/player";
import { FeedClip, OwnProfile, PublicProfile } from "../types/echoflow";

interface ProfilePageProps {
  targetUserId?: number | null;
  onBackToMyProfile?: () => void;
}

/**
 * Stand-in for a value the server did not send. `|| 0` used to stand in here,
 * which made a 500, a 401 and a network drop indistinguishable from a genuine
 * zero — the page told the user they had no followers, no uploads and no
 * audio reels, none of which had been read.
 */
const NOT_AVAILABLE = "—";

type ProfilePhase = "loading" | "ready" | "error";

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Render a count the server actually sent, or an explicit "not read". */
function formatCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : NOT_AVAILABLE;
}

/**
 * Render the account creation date, or nothing at all. The previous
 * `date_joined || Date.now()` rendered *today* as the join date whenever the
 * profile had not loaded — a fabricated claim about account history, on
 * someone else's profile as well as your own.
 */
function formatJoinedDate(value: string | null | undefined): string {
  if (!value) return NOT_AVAILABLE;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? NOT_AVAILABLE : parsed.toLocaleDateString();
}

/**
 * Both profile serializers send a presigned `profile_picture_url` next to the
 * raw storage key (`get_profile_picture_url`, present in both `Meta.fields`).
 * `OwnProfile` / `PublicProfile` in `src/types/echoflow.ts` declare only
 * `profile_picture`, so the signed field is read here through a narrow
 * structural type rather than by widening to `any`. Correcting the type
 * belongs in `types/echoflow.ts`, which this change does not touch.
 */
type ProfileWithSignedAvatar = { profile_picture_url?: string | null };

function signedAvatarUrl(profile: OwnProfile | PublicProfile | null): string | null {
  const signed = (profile as (OwnProfile | PublicProfile | null) & ProfileWithSignedAvatar)
    ?.profile_picture_url;
  return typeof signed === "string" && signed.length > 0 ? signed : null;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * The dialog contract this app had nowhere: `role="dialog"`, `aria-modal`,
 * focus moved on open, a Tab trap, Escape, and focus restored to the opener.
 * `onClose` is read through a ref so the effect keys on `open` alone —
 * depending on the callback identity would re-focus the panel on every
 * keystroke and swallow typing in the form behind it.
 */
function useModalDialog(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || active === panel)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      const opener = openerRef.current;
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open]);

  return panelRef;
}

const Skeleton: React.FC<{ className?: string }> = ({ className = "" }) => (
  <span
    aria-hidden="true"
    className={`inline-block h-6 w-14 rounded bg-white/10 align-middle ${className}`}
  />
);

const StatBlock: React.FC<{
  label: string;
  value: number | null | undefined;
  loading: boolean;
  accent?: boolean;
}> = ({ label, value, loading, accent = false }) => (
  <div className="p-3 rounded-xl bg-black/50 border border-white/10">
    <span className={`block text-2xl font-black font-mono ${accent ? "text-[#FF6321]" : "text-white"}`}>
      {loading ? <Skeleton /> : formatCount(value)}
    </span>
    <span className="text-[10px] font-mono uppercase text-white/40 tracking-wider">{label}</span>
  </div>
);

/**
 * An honest failure: a live region, the server's own reason, and a way back.
 * The old behaviour was `console.warn` followed by a render, so a failed fetch
 * produced a fully-formed profile reading 0 / 0 / 0.
 */
const LoadError: React.FC<{
  heading: string;
  detail: string | null;
  onRetry: () => void;
}> = ({ heading, detail, onRetry }) => (
  <div
    role="alert"
    className="p-8 rounded-2xl bg-[#111111] border border-rose-500/30 text-center space-y-3"
  >
    <p className="flex items-center justify-center gap-2 text-sm font-black uppercase text-rose-400">
      <AlertCircle className="w-4 h-4" aria-hidden="true" />
      {heading}
    </p>
    {detail && <p className="text-xs font-mono text-white/50">{detail}</p>}
    <button
      type="button"
      onClick={onRetry}
      className="px-4 py-2.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/15 text-xs font-black uppercase tracking-wider text-white inline-flex items-center gap-2"
    >
      <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
      Retry
    </button>
  </div>
);

export const ProfilePage: React.FC<ProfilePageProps> = ({ targetUserId, onBackToMyProfile }) => {
  const { user, logout, refreshProfile } = useAuth();
  const { currentClip, isPlaying, playClip, togglePlay } = usePlayer();

  const isOwnProfile = !targetUserId || targetUserId === user?.id;
  // `isOwnProfile` is derived from `targetUserId`, so when it is false
  // `targetUserId` is necessarily a number. Narrowing it once here keeps the
  // type checker on the same page as the runtime condition instead of
  // needing a cast inside the loader.
  const publicProfileId: number | null = isOwnProfile ? null : targetUserId ?? null;

  const [ownProfile, setOwnProfile] = useState<OwnProfile | null>(null);
  const [publicProfile, setPublicProfile] = useState<PublicProfile | null>(null);
  const [userClips, setUserClips] = useState<FeedClip[]>([]);
  const [activeTab, setActiveTab] = useState<"uploads" | "liked">("uploads");

  const [profilePhase, setProfilePhase] = useState<ProfilePhase>("loading");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isLoadingClips, setIsLoadingClips] = useState<boolean>(true);
  const [clipsError, setClipsError] = useState<string | null>(null);

  // Edit Profile modal state
  const [isEditingProfile, setIsEditingProfile] = useState<boolean>(false);
  const [editUsername, setEditUsername] = useState<string>("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);
  const [profileUpdateError, setProfileUpdateError] = useState<string | null>(null);

  // Edit Clip modal state
  const [editingClip, setEditingClip] = useState<FeedClip | null>(null);
  const [clipTitle, setClipTitle] = useState<string>("");
  const [clipCategory, setClipCategory] = useState<string>("");
  const [clipEditError, setClipEditError] = useState<string | null>(null);
  const [clipDeleteError, setClipDeleteError] = useState<string | null>(null);

  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  const closeProfileDialog = useCallback(() => setIsEditingProfile(false), []);
  const closeClipDialog = useCallback(() => setEditingClip(null), []);
  const profileDialogRef = useModalDialog(isEditingProfile, closeProfileDialog);
  const clipDialogRef = useModalDialog(editingClip !== null, closeClipDialog);
  const isDialogOpen = isEditingProfile || editingClip !== null;

  // This page fetches the profile document itself rather than awaiting
  // `refreshProfile()`. That function is `Promise<void>` and swallows its own
  // errors (`stores/auth.tsx` — bare `console.warn`, `profile` stays null), so
  // awaiting it can never report failure and the page cannot tell a 500 from a
  // genuine zero. Same two endpoints, same number of requests. The auth store
  // is still refreshed after a save, which is the only thing `Header` reads.
  const loadProfileData = useCallback(async () => {
    setProfilePhase("loading");
    setProfileError(null);
    setIsLoadingClips(true);
    setClipsError(null);
    setClipEditError(null);
    setClipDeleteError(null);
    setOwnProfile(null);
    setPublicProfile(null);

    let ownerId: number;
    try {
      if (publicProfileId !== null) {
        const pub = await profileAPI.getPublicProfile(publicProfileId);
        setPublicProfile(pub);
        ownerId = pub.id;
      } else {
        const me = await profileAPI.getMyProfile();
        setOwnProfile(me);
        ownerId = me.id;
      }
    } catch (err) {
      setProfileError(describeError(err, "The server did not return this profile."));
      setProfilePhase("error");
      return;
    }

    setProfilePhase("ready");
    try {
      const clipsRes = await profileAPI.getUserClips(ownerId);
      setUserClips(clipsRes.results);
    } catch (err) {
      setClipsError(describeError(err, "The server did not return the audio reel list."));
    } finally {
      setIsLoadingClips(false);
    }
  }, [publicProfileId]);

  useEffect(() => {
    loadProfileData();
  }, [loadProfileData]);

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsUpdatingProfile(true);
    setProfileUpdateError(null);

    const formData = new FormData();
    if (editUsername.trim()) {
      formData.append("username", editUsername.trim());
    }
    if (avatarFile) {
      formData.append("profile_picture", avatarFile);
    }

    try {
      const updated = await profileAPI.updateMyProfile(formData);
      setOwnProfile(updated);
      await refreshProfile();
      setIsEditingProfile(false);
      setAvatarFile(null);
    } catch (err) {
      setProfileUpdateError(describeError(err, "Failed to update profile"));
    } finally {
      setIsUpdatingProfile(false);
    }
  };

  const handleSaveClipEdit = async () => {
    if (!editingClip) return;
    setClipEditError(null);
    try {
      const updated = await clipsAPI.updateClip(editingClip.id, {
        title: clipTitle,
        category: clipCategory,
      });
      setUserClips((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setEditingClip(null);
    } catch (err) {
      // The modal deliberately stays open on failure: the edit is not applied
      // and the user's unsaved text is still on screen. It was previously
      // only `console.warn`, so the page looked like the save worked.
      setClipEditError(describeError(err, "Failed to save changes to this reel."));
    }
  };

  const handleDeleteClip = async (clipId: string) => {
    if (!confirm("Delete this audio reel permanently?")) return;
    setClipDeleteError(null);
    try {
      await clipsAPI.deleteClip(clipId);
      setUserClips((prev) => prev.filter((c) => c.id !== clipId));
      await refreshProfile();
    } catch (err) {
      setClipDeleteError(
        describeError(err, "Failed to delete this reel. It has not been removed.")
      );
    }
  };

  const currentDisplayProfile = publicProfileId === null ? ownProfile : publicProfile;
  const isProfileLoading = profilePhase === "loading";
  const likedClips = ownProfile?.liked_clips;
  const avatarUrl = signedAvatarUrl(currentDisplayProfile);
  const username = currentDisplayProfile?.username;

  return (
    <div className="w-full max-w-4xl mx-auto px-4 md:px-8 py-6 pb-28">
      <div className="space-y-6" inert={isDialogOpen ? true : undefined}>
        {!isOwnProfile && onBackToMyProfile && (
          <button
            type="button"
            onClick={onBackToMyProfile}
            className="text-xs font-mono uppercase font-black text-[#FF6321] hover:underline flex items-center gap-1"
          >
            ← Back to primary account
          </button>
        )}

        {profilePhase === "error" ? (
          <LoadError
            heading="Couldn't load this profile."
            detail={profileError}
            onRetry={loadProfileData}
          />
        ) : (
          <>
            {/* Profile Header Card */}
            <div className="p-6 md:p-8 rounded-2xl md:rounded-3xl bg-[#111111] border border-white/10 shadow-2xl space-y-6">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-5">
                  <div className="relative">
                    {avatarUrl ? (
                      // Decorative: the username is the adjacent heading.
                      <img
                        src={avatarUrl}
                        alt=""
                        className="w-20 h-20 rounded-2xl object-cover border border-white/20 shadow-md"
                      />
                    ) : (
                      <div
                        aria-hidden="true"
                        className="w-20 h-20 rounded-2xl bg-white/10 border border-white/20 flex items-center justify-center text-[#FF6321] text-3xl font-black"
                      >
                        {username?.[0]?.toUpperCase() ?? <UserIcon className="w-10 h-10" />}
                      </div>
                    )}
                  </div>

                  <div>
                    <h1 className="text-2xl md:text-3xl font-black uppercase tracking-tight text-white">
                      {isProfileLoading ? (
                        <Skeleton className="w-32" />
                      ) : username ? (
                        `@${username}`
                      ) : (
                        NOT_AVAILABLE
                      )}
                    </h1>
                    {isProfileLoading && (
                      <p role="status" className="text-[10px] font-mono uppercase text-white/30 mt-1">
                        Loading profile…
                      </p>
                    )}
                    <p className="text-[10px] font-mono uppercase text-white/30 mt-1">
                      Joined:{" "}
                      {isProfileLoading ? (
                        <Skeleton className="w-20" />
                      ) : (
                        formatJoinedDate(currentDisplayProfile?.date_joined)
                      )}
                    </p>
                  </div>
                </div>

                {/* Action buttons */}
                {isOwnProfile && !isProfileLoading && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditUsername(username ?? "");
                        setIsEditingProfile(true);
                      }}
                      className="p-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/15 text-white transition-colors"
                      aria-label="Edit profile"
                      title="Edit Profile"
                    >
                      <Edit3 className="w-4 h-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={logout}
                      className="p-2.5 rounded-xl bg-white/5 hover:bg-rose-500/20 border border-white/15 text-white/50 hover:text-rose-400 transition-colors"
                      aria-label="Log out"
                      title="Log Out"
                    >
                      <LogOut className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>

              {/* Stats Row with Bold Typography & Monospace Metric */}
              <div className="grid grid-cols-3 gap-3 pt-4 border-t border-white/10 text-center">
                <StatBlock
                  label="Followers"
                  value={currentDisplayProfile?.followers_count}
                  loading={isProfileLoading}
                />
                <StatBlock
                  label="Following"
                  value={currentDisplayProfile?.following_count}
                  loading={isProfileLoading}
                />
                <StatBlock
                  label="Audio Reels"
                  value={currentDisplayProfile?.uploads_count}
                  loading={isProfileLoading}
                  accent
                />
              </div>
            </div>

            {/* Tabs for Own Profile */}
            {isOwnProfile && (
              <div className="flex items-center gap-2 p-1 rounded-xl bg-[#111111] border border-white/10">
                <button
                  type="button"
                  onClick={() => setActiveTab("uploads")}
                  aria-pressed={activeTab === "uploads"}
                  className={`flex-1 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 ${
                    activeTab === "uploads"
                      ? "bg-[#FF6321] text-black shadow-[0_0_15px_rgba(255,99,33,0.3)]"
                      : "text-white/40 hover:text-white"
                  }`}
                >
                  <Music className="w-3.5 h-3.5" aria-hidden="true" />
                  {/* `uploads_count` is the server total. `userClips.length` was
                      the length of one 10-item page, displayed ~30px above the
                      real figure it contradicted. */}
                  <span>My Uploads ({formatCount(currentDisplayProfile?.uploads_count)})</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("liked")}
                  aria-pressed={activeTab === "liked"}
                  className={`flex-1 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 ${
                    activeTab === "liked"
                      ? "bg-[#FF6321] text-black shadow-[0_0_15px_rgba(255,99,33,0.3)]"
                      : "text-white/40 hover:text-white"
                  }`}
                >
                  <Heart className="w-3.5 h-3.5" aria-hidden="true" />
                  {/* The backend returns at most 50 (`[:50]`,
                      newest first), so its length is not a total. Saying so is
                      honest; printing "50" for a user with 500 likes is not. */}
                  <span>
                    Liked Reels (
                    {likedClips === undefined
                      ? NOT_AVAILABLE
                      : likedClips.length === 0
                        ? "0"
                        : `${likedClips.length} most recent`}
                    )
                  </span>
                </button>
              </div>
            )}

            {/* Clips Display */}
            {clipsError ? (
              <LoadError
                heading="Couldn't load your audio reels."
                detail={clipsError}
                onRetry={loadProfileData}
              />
            ) : isLoadingClips ? (
              <div
                role="status"
                className="py-20 text-center font-mono text-xs uppercase text-white/40"
              >
                Loading audio library...
              </div>
            ) : activeTab === "uploads" ? (
              userClips.length === 0 ? (
                <div className="p-12 rounded-3xl bg-[#111111] border border-white/10 text-center text-white/40 font-mono text-xs uppercase">
                  No audio reels published to network.
                </div>
              ) : (
                <div className="space-y-3">
                  {clipDeleteError && (
                    <p
                      role="alert"
                      className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs font-mono text-rose-300"
                    >
                      {clipDeleteError}
                    </p>
                  )}
                  {userClips.map((clip) => {
                    const isThisPlaying = currentClip?.id === clip.id && isPlaying;
                    return (
                      <div
                        key={clip.id}
                        className="p-4 rounded-xl bg-[#111111] border border-white/10 flex items-center justify-between gap-4 group"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            if (currentClip?.id === clip.id) togglePlay();
                            else playClip(clip, userClips);
                          }}
                          aria-label={isThisPlaying ? `Pause ${clip.title}` : `Play ${clip.title}`}
                          className={`w-11 h-11 rounded-lg flex items-center justify-center flex-shrink-0 transition-transform ${
                            isThisPlaying
                              ? "bg-[#FF6321] text-black scale-105 shadow-[0_0_15px_rgba(255,99,33,0.35)]"
                              : "bg-white/10 text-white group-hover:bg-[#FF6321] group-hover:text-black"
                          }`}
                        >
                          {isThisPlaying ? (
                            <Pause className="w-4 h-4 fill-current" aria-hidden="true" />
                          ) : (
                            <Play className="w-4 h-4 fill-current ml-0.5" aria-hidden="true" />
                          )}
                        </button>

                        <div className="flex-1 min-w-0">
                          <span className="text-[9px] uppercase font-mono font-bold text-[#FF6321] tracking-wider">
                            {clip.category}
                          </span>
                          <h2 className="text-sm font-black uppercase text-white truncate">{clip.title}</h2>
                          <p className="text-[10px] font-mono text-white/40 mt-0.5">
                            {/* The emoji are decoration; the words carry the
                                meaning, so a screen reader is not told
                                "loudly crying face" instead of "comments". */}
                            <span aria-hidden="true">❤️</span> {clip.likes} likes ·{" "}
                            <span aria-hidden="true">💬</span> {clip.comment_count} comments ·{" "}
                            <span aria-hidden="true">🔄</span> {clip.shares} shares
                          </p>
                        </div>

                        {isOwnProfile && (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingClip(clip);
                                setClipTitle(clip.title);
                                setClipCategory(clip.category);
                                setClipEditError(null);
                              }}
                              className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10"
                              aria-label={`Edit reel details for ${clip.title}`}
                              title="Edit Details"
                            >
                              <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteClip(clip.id)}
                              className="p-2 rounded-lg text-white/40 hover:text-rose-400 hover:bg-white/10"
                              aria-label={`Delete reel ${clip.title}`}
                              title="Delete Reel"
                            >
                              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )
            ) : likedClips === undefined || likedClips.length === 0 ? (
              <div className="p-12 rounded-3xl bg-[#111111] border border-white/10 text-center text-white/40 font-mono text-xs uppercase">
                {likedClips === undefined
                  ? "Liked reels unavailable."
                  : "No audio reels saved yet. Heart reels in the live feed to archive them here."}
              </div>
            ) : (
              <div className="space-y-3">
                {likedClips.map((clip) => {
                  const isThisPlaying = currentClip?.id === clip.id && isPlaying;
                  return (
                    // A real button: this row used to be a `<div onClick>` with
                    // no inner control, so a liked reel was unplayable by
                    // keyboard. The title is a `<span>` rather than a heading
                    // because a heading is not valid phrasing content inside a
                    // button.
                    <button
                      type="button"
                      key={clip.id}
                      onClick={() => {
                        if (currentClip?.id === clip.id) togglePlay();
                        else playClip(clip, likedClips);
                      }}
                      aria-label={isThisPlaying ? `Pause ${clip.title}` : `Play ${clip.title}`}
                      className="w-full p-4 rounded-xl bg-[#111111] border border-white/10 flex items-center gap-4 text-left hover:border-white/20 transition-colors"
                    >
                      <span
                        aria-hidden="true"
                        className={`w-11 h-11 rounded-lg flex items-center justify-center flex-shrink-0 ${
                          isThisPlaying ? "bg-[#FF6321] text-black" : "bg-white/10 text-white"
                        }`}
                      >
                        {isThisPlaying ? (
                          <Pause className="w-4 h-4 fill-current" />
                        ) : (
                          <Play className="w-4 h-4 fill-current ml-0.5" />
                        )}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[9px] uppercase font-mono font-bold text-[#FF6321] tracking-wider">
                          {clip.category} • @{clip.creator_name}
                        </span>
                        <span className="block text-sm font-black uppercase text-white truncate">
                          {clip.title}
                        </span>
                      </span>
                      <Heart className="w-4 h-4 text-[#FF6321] fill-[#FF6321] flex-shrink-0" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Edit Profile Modal */}
      {isEditingProfile && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeProfileDialog();
          }}
        >
          <div
            ref={profileDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-profile-dialog-title"
            tabIndex={-1}
            className="w-full max-w-sm bg-[#111111] border border-white/15 rounded-2xl p-6 shadow-2xl space-y-4 outline-none"
          >
            <div className="flex items-center justify-between pb-2 border-b border-white/10">
              <h3 id="edit-profile-dialog-title" className="text-sm font-black uppercase text-white">
                Edit Profile Details
              </h3>
              <button
                type="button"
                onClick={closeProfileDialog}
                aria-label="Close edit profile dialog"
                className="p-2 -m-2 rounded-lg text-white/40 hover:text-white"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            {profileUpdateError && (
              <p
                id="profile-update-error"
                role="alert"
                className="text-xs font-mono text-rose-400"
              >
                {profileUpdateError}
              </p>
            )}

            <form onSubmit={handleUpdateProfile} className="space-y-4">
              <div>
                <label
                  htmlFor="profile-username"
                  className="text-xs font-mono uppercase text-white/50 block mb-1"
                >
                  Username
                </label>
                <input
                  id="profile-username"
                  type="text"
                  value={editUsername}
                  onChange={(e) => setEditUsername(e.target.value)}
                  aria-invalid={profileUpdateError ? true : undefined}
                  aria-describedby={profileUpdateError ? "profile-update-error" : undefined}
                  className="w-full bg-black border border-white/15 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-[#FF6321]"
                  required
                />
              </div>

              <div>
                <label
                  htmlFor="profile-avatar"
                  className="text-xs font-mono uppercase text-white/50 block mb-1"
                >
                  Avatar Image
                </label>
                <input
                  id="profile-avatar"
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    if (e.target.files?.[0]) setAvatarFile(e.target.files[0]);
                  }}
                  className="hidden"
                />
                {/* The file input is `hidden`, so this button is the only
                    keyboard-reachable route to a file picker on the page. */}
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  className="w-full py-2.5 px-3 rounded-lg bg-black border border-white/15 text-xs font-mono uppercase text-white/60 flex items-center justify-center gap-2 hover:border-white/30"
                >
                  <Camera className="w-4 h-4 text-[#FF6321]" aria-hidden="true" />
                  <span>{avatarFile ? avatarFile.name : "Select Image Asset (Max 5MB)"}</span>
                </button>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-white/10">
                <button
                  type="button"
                  onClick={closeProfileDialog}
                  className="px-3 py-1.5 rounded text-xs font-mono uppercase text-white/50 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isUpdatingProfile}
                  className="px-4 py-1.5 rounded bg-[#FF6321] text-black text-xs font-black uppercase tracking-wider"
                >
                  {isUpdatingProfile ? "Saving..." : "Save Profile"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Clip Modal */}
      {editingClip && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeClipDialog();
          }}
        >
          <div
            ref={clipDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-clip-dialog-title"
            tabIndex={-1}
            className="w-full max-w-sm bg-[#111111] border border-white/15 rounded-2xl p-6 shadow-2xl space-y-4 outline-none"
          >
            <div className="flex items-center justify-between pb-2 border-b border-white/10">
              <h3 id="edit-clip-dialog-title" className="text-sm font-black uppercase text-white">
                Edit Reel
              </h3>
              <button
                type="button"
                onClick={closeClipDialog}
                aria-label="Close edit reel dialog"
                className="p-2 -m-2 rounded-lg text-white/40 hover:text-white"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            {clipEditError && (
              <p role="alert" className="text-xs font-mono text-rose-400">
                {clipEditError}
              </p>
            )}

            <div className="space-y-3">
              <div>
                <label
                  htmlFor="clip-title"
                  className="text-xs font-mono uppercase text-white/50 block mb-1"
                >
                  Title
                </label>
                <input
                  id="clip-title"
                  type="text"
                  value={clipTitle}
                  onChange={(e) => setClipTitle(e.target.value)}
                  maxLength={255}
                  className="w-full bg-black border border-white/15 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-[#FF6321]"
                />
              </div>

              <div>
                <label
                  htmlFor="clip-category"
                  className="text-xs font-mono uppercase text-white/50 block mb-1"
                >
                  Category
                </label>
                {/* Free text, deliberately. `AudioClip.category` is a
                    free-form CharField, and this `<select>` offered six
                    hardcoded options that matched nothing the backend stores:
                    a clip tagged `tech` opened a form with no matching option,
                    and touching the control rewrote the real value. Choosing a
                    canonical vocabulary is a product decision; round-tripping
                    whatever is already stored is not. */}
                <input
                  id="clip-category"
                  type="text"
                  value={clipCategory}
                  onChange={(e) => setClipCategory(e.target.value)}
                  maxLength={50}
                  className="w-full bg-black border border-white/15 rounded-lg px-3 py-2 text-xs text-white uppercase focus:outline-none focus:border-[#FF6321]"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-white/10">
                <button
                  type="button"
                  onClick={closeClipDialog}
                  className="px-3 py-1.5 text-xs font-mono uppercase text-white/50 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveClipEdit}
                  className="px-4 py-1.5 rounded bg-[#FF6321] text-black text-xs font-black uppercase tracking-wider"
                >
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
