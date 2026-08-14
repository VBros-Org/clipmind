"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  clipWindowDurationSeconds,
  clipWindowOffsetSeconds,
  clipWindowStartSeconds,
  clipWindowTimeFromOffsetSeconds,
  shouldSeekPreviewToStart,
} from "../../../lib/clip-preview-window";
import {
  REJECT_REASONS,
  type RejectReason,
} from "../../../lib/reject-reasons";
import {
  REJECT_UNDO_WINDOW_MS,
  RejectUndoTimer,
  type RejectUndoCommitCause,
  type RejectUndoSnapshot,
} from "../../../lib/reject-undo";
import { formatScheduledForLabel } from "../../../lib/schedule-label";
import { deleteVideo } from "../../../lib/video-delete-client";
import {
  VideoDeleteSheet,
  type VideoDeleteTarget,
} from "../VideoDeleteSheet";
import styles from "./review.module.css";

type Platform = "youtube" | "tiktok" | "instagram";

type ClipStatus =
  | "candidate"
  | "accepted"
  | "rejected"
  | "scheduled"
  | "posted";

type PostCopyVariants = Record<Platform, string>;

export type ReviewClipView = {
  id: string;
  videoId: string;
  status: ClipStatus;
  startMs: number;
  endMs: number;
  renderedUrl: string | null;
  renderFailedAt: string | null;
  renderError: string | null;
  thumbUrl: string | null;
  postCopyVariants: PostCopyVariants | null;
  scheduledFor: string | null;
  transcript: string | null;
  mindRank: number | null;
  mindRankReason: string | null;
  rejectReason: string | null;
  createdAt: string;
};

export type ReviewVideoGroupView = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  totalClips: number;
  clips: ReviewClipView[];
};

type ReviewBoardProps = {
  groups: ReviewVideoGroupView[];
  initialClipId?: string | null;
};

type PreviewPayload = {
  previewUrl: string;
  startMs: number;
  endMs: number;
};

type RejectReasonPrompt = {
  clipId: string;
  deadlineMs: number;
};

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "youtube", label: "YouTube" },
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
];

const REJECT_REASON_WINDOW_MS = 8_000;

export function ReviewBoard({ groups: initialGroups, initialClipId }: ReviewBoardProps) {
  const router = useRouter();
  const [groups, setGroups] = useState(initialGroups);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VideoDeleteTarget | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [pendingRejects, setPendingRejects] = useState<
    Record<string, RejectUndoSnapshot>
  >({});
  const [rejectReasonPrompts, setRejectReasonPrompts] = useState<
    Record<string, RejectReasonPrompt>
  >({});
  const [reasonSavingClipId, setReasonSavingClipId] = useState<string | null>(null);
  const didReadInitialClip = useRef(false);
  const rejectUndoTimer = useRef<RejectUndoTimer | null>(null);
  const rejectReasonTimer = useRef<RejectUndoTimer | null>(null);
  const commitRejectRef = useRef<
    (clipId: string, cause: RejectUndoCommitCause) => void
  >(() => {});
  const mountedRef = useRef(false);
  const clipCount = groups.reduce((total, group) => total + group.clips.length, 0);

  commitRejectRef.current = (clipId, cause) => {
    void commitDeferredReject(clipId, cause);
  };

  function syncPendingRejectsFromTimer(timer: RejectUndoTimer) {
    setPendingRejects((current) => {
      const next = Object.fromEntries(
        timer.snapshots().map((snapshot) => [snapshot.clipId, snapshot]),
      );

      return sameSnapshotMap(current, next) ? current : next;
    });
  }

  function syncRejectReasonsFromTimer(timer: RejectUndoTimer) {
    setRejectReasonPrompts((current) => {
      const next = Object.fromEntries(
        timer.snapshots().map((snapshot) => [
          snapshot.clipId,
          {
            clipId: snapshot.clipId,
            deadlineMs: snapshot.deadlineMs,
          },
        ]),
      );

      return sameReasonPromptMap(current, next) ? current : next;
    });
  }

  useEffect(() => {
    mountedRef.current = true;
    const timer = new RejectUndoTimer({
      commit(clipId, cause) {
        commitRejectRef.current(clipId, cause);
      },
      setTimeoutImpl: (handler, timeoutMs) =>
        window.setTimeout(handler, timeoutMs),
      clearTimeoutImpl: (handle) => window.clearTimeout(handle as number),
    });
    const reasonTimer = new RejectUndoTimer({
      commit(clipId) {
        if (mountedRef.current) {
          setRejectReasonPrompts((current) => withoutKey(current, clipId));
        }
      },
      windowMs: REJECT_REASON_WINDOW_MS,
      setTimeoutImpl: (handler, timeoutMs) =>
        window.setTimeout(handler, timeoutMs),
      clearTimeoutImpl: (handle) => window.clearTimeout(handle as number),
    });
    rejectUndoTimer.current = timer;
    rejectReasonTimer.current = reasonTimer;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        timer.pauseAll();
        reasonTimer.pauseAll();
        syncPendingRejectsFromTimer(timer);
        syncRejectReasonsFromTimer(reasonTimer);
      } else {
        timer.resumeAll();
        reasonTimer.resumeAll();
        syncPendingRejectsFromTimer(timer);
        syncRejectReasonsFromTimer(reasonTimer);
        router.refresh();
      }
    };
    const commitForNavigation = () => {
      timer.commitAll("navigation");
      reasonTimer.clearAll();
    };
    const refreshOnFocus = () => {
      router.refresh();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", refreshOnFocus);
    window.addEventListener("beforeunload", commitForNavigation);

    return () => {
      mountedRef.current = false;
      timer.commitAll("navigation");
      reasonTimer.clearAll();
      rejectUndoTimer.current = null;
      rejectReasonTimer.current = null;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", refreshOnFocus);
      window.removeEventListener("beforeunload", commitForNavigation);
    };
  }, [router]);

  useEffect(() => {
    if (Object.keys(pendingRejects).length === 0) {
      return;
    }

    const interval = window.setInterval(() => {
      const timer = rejectUndoTimer.current;
      if (!timer) {
        return;
      }

      setPendingRejects((current) => {
        const next = Object.fromEntries(
          Object.keys(current)
            .map((clipId) => [clipId, timer.snapshot(clipId)] as const)
            .filter(
              (entry): entry is readonly [string, RejectUndoSnapshot] =>
                entry[1] !== null,
            ),
        );

        return sameSnapshotMap(current, next) ? current : next;
      });
    }, 150);

    return () => {
      window.clearInterval(interval);
    };
  }, [pendingRejects]);

  useEffect(() => {
    if (didReadInitialClip.current) {
      return;
    }

    didReadInitialClip.current = true;
    const urlClipId =
      initialClipId ??
      new URLSearchParams(window.location.search).get("clip") ??
      null;

    if (urlClipId && findClip(groups, urlClipId)) {
      setActiveClipId(urlClipId);
    }
  }, [groups, initialClipId]);

  const activeClip = useMemo(
    () => (activeClipId ? findClip(groups, activeClipId) : null),
    [activeClipId, groups],
  );

  function openClip(clipId: string) {
    setActiveClipId(clipId);
    writeClipToUrl(clipId);
  }

  function closeClip() {
    setActiveClipId(null);
    writeClipToUrl(null);
  }

  function updateClip(nextClip: ReviewClipView) {
    setGroups((current) =>
      current.map((group) =>
        group.id === nextClip.videoId
          ? {
              ...group,
              clips: group.clips.map((clip) =>
                clip.id === nextClip.id ? nextClip : clip,
              ),
            }
          : group,
      ),
    );
  }

  function openDeleteSheet(group: ReviewVideoGroupView) {
    setDeleteTarget({
      id: group.id,
      title: group.title,
      clipCount: group.totalClips,
    });
    setDeleteError(null);
  }

  function startDeferredReject(clip: ReviewClipView) {
    const timer = rejectUndoTimer.current;
    if (!timer) {
      return;
    }

    // Accept is intentionally immediate because it commits scheduling and render work.
    // Reject is client-deferred so a thumb slip can be undone without adding a status.
    const snapshot = timer.start(clip.id);
    setPendingRejects((current) => ({
      ...current,
      [clip.id]: snapshot,
    }));
    dismissRejectReasons(clip.id);
    closeClip();
  }

  function undoReject(clipId: string) {
    if (!rejectUndoTimer.current?.undo(clipId)) {
      return;
    }

    setPendingRejects((current) => withoutKey(current, clipId));
  }

  async function commitDeferredReject(
    clipId: string,
    cause: RejectUndoCommitCause,
  ) {
    if (mountedRef.current) {
      setPendingRejects((current) => withoutKey(current, clipId));
    }

    try {
      const response = await fetch(`/api/clips/${clipId}/reject`, {
        method: "POST",
        keepalive: cause !== "timer",
      });

      if (!response.ok) {
        return;
      }

      const body = (await response.json()) as { clip: ReviewClipView };
      if (!mountedRef.current) {
        return;
      }

      updateClip(body.clip);
      showRejectReasons(clipId);
    } catch (error) {
      console.error("Deferred reject failed", error);
    }
  }

  function showRejectReasons(clipId: string) {
    dismissRejectReasons(clipId);
    const snapshot = rejectReasonTimer.current?.start(clipId);
    const deadlineMs = snapshot?.deadlineMs ?? Date.now() + REJECT_REASON_WINDOW_MS;
    setRejectReasonPrompts((current) => ({
      ...current,
      [clipId]: {
        clipId,
        deadlineMs,
      },
    }));
  }

  function dismissRejectReasons(clipId: string) {
    rejectReasonTimer.current?.undo(clipId);
    setRejectReasonPrompts((current) => withoutKey(current, clipId));
  }

  async function saveRejectReason(clipId: string, rejectReason: RejectReason) {
    setReasonSavingClipId(clipId);

    try {
      const response = await fetch(`/api/clips/${clipId}/reject`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          rejectReason,
        }),
      });

      if (!response.ok) {
        return;
      }

      const body = (await response.json()) as { clip: ReviewClipView };
      updateClip(body.clip);
      dismissRejectReasons(clipId);
    } finally {
      setReasonSavingClipId(null);
    }
  }

  async function confirmDeleteVideo() {
    if (!deleteTarget) {
      return;
    }

    const target = deleteTarget;
    setIsDeleting(true);
    setDeleteError(null);

    try {
      const result = await deleteVideo(target.id);
      if (result.outcome !== "deleted") {
        setDeleteError(result.message);
        return;
      }

      if (activeClipId && findClip(groups, activeClipId)?.videoId === target.id) {
        closeClip();
      }
      setGroups((current) => current.filter((group) => group.id !== target.id));
      setDeleteTarget(null);
      router.refresh();
    } finally {
      setIsDeleting(false);
    }
  }

  if (clipCount === 0) {
    return (
      <section className={styles.emptyState}>
        <p>No clips waiting. Upload something long.</p>
        <Link className={styles.emptyAction} href="/upload">
          Upload
        </Link>
      </section>
    );
  }

  return (
    <>
      <section className={styles.groups} aria-label="Review clips">
        {groups.map((group) => (
          <section className={styles.videoGroup} key={group.id}>
            <header className={styles.groupHeader}>
              <div className={styles.groupHeading}>
                <p className={styles.groupLabel}>{group.status}</p>
                <h2 className={styles.groupTitle}>{group.title}</h2>
              </div>
              <div className={styles.groupActions}>
                <span className={styles.groupCount}>
                  {group.totalClips} {group.totalClips === 1 ? "clip" : "clips"}
                </span>
                <button
                  aria-label={`Remove ${group.title}`}
                  className={styles.groupRemoveButton}
                  data-testid="remove-review-video-button"
                  onClick={() => openDeleteSheet(group)}
                  type="button"
                >
                  Remove
                </button>
              </div>
            </header>
            <div className={styles.clipStrip}>
              {group.clips.map((clip) => (
                <ClipCard
                  clip={clip}
                  isReasonSaving={reasonSavingClipId === clip.id}
                  key={clip.id}
                  openClip={openClip}
                  pendingReject={pendingRejects[clip.id] ?? null}
                  rejectReasonPrompt={rejectReasonPrompts[clip.id] ?? null}
                  saveRejectReason={saveRejectReason}
                  dismissRejectReasons={dismissRejectReasons}
                  undoReject={undoReject}
                />
              ))}
            </div>
          </section>
        ))}
      </section>

      {activeClip ? (
        <ReviewSheet
          clip={activeClip}
          closeClip={closeClip}
          deferReject={startDeferredReject}
          updateClip={updateClip}
        />
      ) : null}

      {deleteTarget ? (
        <VideoDeleteSheet
          error={deleteError}
          isDeleting={isDeleting}
          onCancel={() => {
            if (!isDeleting) {
              setDeleteTarget(null);
            }
          }}
          onConfirm={confirmDeleteVideo}
          target={deleteTarget}
        />
      ) : null}
    </>
  );
}

function ClipCard({
  clip,
  dismissRejectReasons,
  isReasonSaving,
  openClip,
  pendingReject,
  rejectReasonPrompt,
  saveRejectReason,
  undoReject,
}: {
  clip: ReviewClipView;
  dismissRejectReasons: (clipId: string) => void;
  isReasonSaving: boolean;
  openClip: (clipId: string) => void;
  pendingReject: RejectUndoSnapshot | null;
  rejectReasonPrompt: RejectReasonPrompt | null;
  saveRejectReason: (clipId: string, rejectReason: RejectReason) => void;
  undoReject: (clipId: string) => void;
}) {
  const isRendering = isRenderPending(clip);
  const renderFailed = Boolean(clip.renderFailedAt);
  const isRejected = clip.status === "rejected";
  const isPendingReject = pendingReject !== null;

  return (
    <article
      className={`${styles.clipCard} ${isRejected ? styles.rejectedCard : ""}`}
    >
      <button
        className={styles.clipCardButton}
        data-testid="clip-card"
        disabled={isPendingReject}
        onClick={() => openClip(clip.id)}
        type="button"
      >
        <span className={styles.thumb}>
          {clip.thumbUrl ? (
            <img
              alt=""
              className={styles.thumbImage}
              data-testid="review-thumb"
              src={clip.thumbUrl}
            />
          ) : (
            <span className={styles.poster} aria-hidden="true" />
          )}
          <span className={styles.rankBadge} data-testid="rank-badge">
            {rankBadge(clip.mindRank)}
          </span>
          <span className={styles.durationChip} data-testid="duration-chip">
            {formatDuration(clip.startMs, clip.endMs)}
          </span>
          {isRendering ? <span className={styles.renderChip}>rendering</span> : null}
          {renderFailed ? (
            <span className={styles.renderFailedChip}>render failed</span>
          ) : null}
        </span>
        <span className={styles.cardReason}>
          {clip.mindRankReason || "No Mind reason saved."}
        </span>
        <span className={styles.cardStatus}>
          {statusLabel(clip, isRendering, pendingReject)}
        </span>
      </button>

      {pendingReject ? (
        <div className={styles.rejectUndo} data-testid="reject-undo-state">
          <button
            className={styles.undoButton}
            data-testid="reject-undo-button"
            onClick={() => undoReject(clip.id)}
            type="button"
          >
            Undo
          </button>
          <span className={styles.undoTrack} aria-hidden="true">
            <span
              className={styles.undoBar}
              style={{
                transform: `scaleX(${Math.max(
                  0,
                  Math.min(1, pendingReject.remainingMs / REJECT_UNDO_WINDOW_MS),
                )})`,
              }}
            />
          </span>
        </div>
      ) : null}

      {rejectReasonPrompt ? (
        <div className={styles.reasonChips} data-testid="reject-reason-chips">
          <div className={styles.reasonChipHeader}>
            <span>Reason</span>
            <button
              aria-label="Dismiss reject reasons"
              className={styles.dismissReasonButton}
              data-testid="dismiss-reject-reasons"
              onClick={() => dismissRejectReasons(clip.id)}
              type="button"
            >
              X
            </button>
          </div>
          <div className={styles.reasonChipGrid}>
            {REJECT_REASONS.map((rejectReason) => (
              <button
                className={styles.reasonChip}
                data-testid={`reject-reason-${reasonSlug(rejectReason)}`}
                disabled={isReasonSaving}
                key={rejectReason}
                onClick={() => saveRejectReason(clip.id, rejectReason)}
                type="button"
              >
                {rejectReason}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function ReviewSheet({
  clip,
  closeClip,
  deferReject,
  updateClip,
}: {
  clip: ReviewClipView;
  closeClip: () => void;
  deferReject: (clip: ReviewClipView) => void;
  updateClip: (clip: ReviewClipView) => void;
}) {
  const [isBusy, setIsBusy] = useState(false);
  const [isRendering, setIsRendering] = useState(
    isRenderPending(clip),
  );
  const [isRetryingRender, setIsRetryingRender] = useState(false);
  const [copyState, setCopyState] = useState<Platform | null>(null);
  const [copyFallbackPlatform, setCopyFallbackPlatform] =
    useState<Platform | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [previewOffsetSeconds, setPreviewOffsetSeconds] = useState(0);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [learningNote, setLearningNote] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canReview = clip.status === "candidate";
  const videoSource = clip.renderedUrl ?? preview?.previewUrl ?? null;
  const isPreview = !clip.renderedUrl && preview !== null;
  const scheduledLabel = formatScheduledForLabel(clip.scheduledFor);

  useEffect(() => {
    setIsRendering(isRenderPending(clip));
    setCopyState(null);
    setCopyFallbackPlatform(null);
  }, [clip.id, clip.renderFailedAt, clip.renderedUrl, clip.status]);

  useEffect(() => {
    setLearningNote(false);
    setPreviewOffsetSeconds(0);
    setIsPreviewPlaying(false);
  }, [clip.id]);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewFailed(false);

    if (clip.renderedUrl) {
      return () => {
        cancelled = true;
      };
    }

    void fetch(`/api/clips/${clip.id}/preview`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Preview not available.");
        }

        return (await response.json()) as PreviewPayload;
      })
      .then((payload) => {
        if (!cancelled) {
          setPreview(payload);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [clip.id, clip.renderedUrl]);

  useEffect(() => {
    if (!isRendering || clip.renderedUrl || clip.renderFailedAt) {
      return;
    }

    let cancelled = false;
    const interval = window.setInterval(async () => {
      const response = await fetch(`/api/clips/${clip.id}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        return;
      }

      const nextClip = (await response.json()) as ReviewClipView;
      if (!cancelled) {
        updateClip(nextClip);
        if (nextClip.renderedUrl || nextClip.renderFailedAt) {
          setIsRendering(false);
          window.clearInterval(interval);
        }
      }
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [clip.id, clip.renderFailedAt, clip.renderedUrl, isRendering, updateClip]);

  async function acceptClip() {
    setIsBusy(true);
    try {
      const response = await fetch(`/api/clips/${clip.id}/accept`, {
        method: "POST",
      });

      if (!response.ok) {
        return;
      }

      const body = (await response.json()) as {
        clip: ReviewClipView;
        rendering: boolean;
      };
      updateClip(body.clip);
      setIsRendering(
        body.rendering && !body.clip.renderedUrl && !body.clip.renderFailedAt,
      );
      setLearningNote(true);
    } finally {
      setIsBusy(false);
    }
  }

  function rejectClip() {
    setIsRendering(false);
    deferReject(clip);
  }

  async function retryRender() {
    setIsRetryingRender(true);
    try {
      const response = await fetch(`/api/clips/${clip.id}/render/retry`, {
        method: "POST",
      });

      if (!response.ok) {
        return;
      }

      const body = (await response.json()) as {
        clip: ReviewClipView;
        rendering: boolean;
      };
      updateClip(body.clip);
      setIsRendering(
        body.rendering && !body.clip.renderedUrl && !body.clip.renderFailedAt,
      );
    } finally {
      setIsRetryingRender(false);
    }
  }

  function seekPreview(options: { firstLoad?: boolean } = {}) {
    const video = videoRef.current;
    if (!video || !isPreview || !preview) {
      return;
    }

    const startSeconds = clipWindowStartSeconds(preview);
    if (
      shouldSeekPreviewToStart(video.currentTime, preview, {
        firstLoad: options.firstLoad,
      })
    ) {
      video.currentTime = startSeconds;
    }
    setPreviewOffsetSeconds(clipWindowOffsetSeconds(video.currentTime, preview));
  }

  function keepPreviewInWindow() {
    const video = videoRef.current;
    if (!video || !isPreview || !preview) {
      return;
    }

    if (video.currentTime >= preview.endMs / 1000) {
      video.pause();
      video.currentTime = clipWindowStartSeconds(preview);
      setPreviewOffsetSeconds(0);
      setIsPreviewPlaying(false);
      return;
    }

    if (shouldSeekPreviewToStart(video.currentTime, preview)) {
      video.currentTime = clipWindowStartSeconds(preview);
    }
    setPreviewOffsetSeconds(clipWindowOffsetSeconds(video.currentTime, preview));
  }

  function handlePreviewPlay() {
    seekPreview();
    setIsPreviewPlaying(true);
  }

  function handlePreviewPause() {
    if (isPreview) {
      setIsPreviewPlaying(false);
    }
  }

  function togglePreviewPlayback() {
    const video = videoRef.current;
    if (!video || !isPreview || !preview) {
      return;
    }

    if (video.paused) {
      seekPreview();
      void video.play().catch(() => {
        setIsPreviewPlaying(false);
      });
      return;
    }

    video.pause();
  }

  function scrubPreview(nextOffsetSeconds: number) {
    const video = videoRef.current;
    if (!video || !isPreview || !preview) {
      return;
    }

    const nextTime = clipWindowTimeFromOffsetSeconds(
      nextOffsetSeconds,
      preview,
    );
    video.currentTime = nextTime;
    setPreviewOffsetSeconds(clipWindowOffsetSeconds(nextTime, preview));
  }

  async function copyCaption(platform: Platform) {
    const caption = clip.postCopyVariants?.[platform] ?? "";
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable.");
      }

      await navigator.clipboard.writeText(caption);
      setCopyState(platform);
      setCopyFallbackPlatform(null);
    } catch {
      setCopyState(null);
      setCopyFallbackPlatform(platform);
    }
  }

  return (
    <section
      aria-label="Review clip"
      aria-modal="true"
      className={styles.sheet}
      data-testid="review-sheet"
      role="dialog"
    >
      <header className={styles.sheetHeader}>
        <div>
          <p className={styles.groupLabel}>Clip {rankBadge(clip.mindRank)}</p>
          <h2 className={styles.sheetTitle}>
            {formatDuration(clip.startMs, clip.endMs)}
          </h2>
        </div>
        <button className={styles.closeButton} onClick={closeClip} type="button">
          Close
        </button>
      </header>

      <div className={styles.sheetBody}>
        <div className={styles.playerWrap}>
          {videoSource ? (
            <video
              className={`${styles.player} ${
                isPreview ? styles.previewPlayer : styles.renderedPlayer
              }`}
              controls={!isPreview}
              onLoadedMetadata={() => seekPreview({ firstLoad: true })}
              onPause={handlePreviewPause}
              onPlay={handlePreviewPlay}
              onTimeUpdate={keepPreviewInWindow}
              playsInline
              preload="metadata"
              ref={videoRef}
              src={videoSource}
            />
          ) : (
            <p className={styles.playerFallback}>
              {previewFailed
                ? "Source video is unavailable."
                : "Loading preview."}
            </p>
          )}
          {isPreview && preview ? (
            <div className={styles.previewControls}>
              <button
                className={styles.previewPlayButton}
                onClick={togglePreviewPlayback}
                type="button"
              >
                {isPreviewPlaying ? "Pause" : "Play"}
              </button>
              <input
                aria-label="Preview position"
                className={styles.previewRange}
                max={clipWindowDurationSeconds(preview)}
                min={0}
                onChange={(event) => scrubPreview(Number(event.currentTarget.value))}
                step={0.1}
                type="range"
                value={Math.min(
                  previewOffsetSeconds,
                  clipWindowDurationSeconds(preview),
                )}
              />
              <span className={styles.previewTime}>
                {formatPreviewTime(previewOffsetSeconds)} /{" "}
                {formatPreviewTime(clipWindowDurationSeconds(preview))}
              </span>
            </div>
          ) : null}
        </div>

        <p className={styles.transcript}>{transcriptLine(clip.transcript)}</p>
        {clip.renderFailedAt ? (
          <div className={styles.renderErrorPanel}>
            <p>
              {clip.renderError?.trim() || "Render failed. Try again."}
            </p>
            <button
              className={styles.retryRenderButton}
              disabled={isRetryingRender}
              onClick={retryRender}
              type="button"
            >
              {isRetryingRender ? "Retrying" : "Retry render"}
            </button>
          </div>
        ) : null}
        <blockquote className={styles.reasonQuote}>
          {clip.mindRankReason || "No Mind reason saved."}
        </blockquote>

        <section className={styles.captionPanel} aria-label="Captions">
          <h3 className={styles.captionTitle}>Captions</h3>
          {clip.postCopyVariants ? (
            PLATFORMS.map((platform) => (
              <div className={styles.captionRow} key={platform.id}>
                <div>
                  <p className={styles.captionPlatform}>{platform.label}</p>
                  <p className={styles.captionText}>
                    {clip.postCopyVariants?.[platform.id]}
                  </p>
                  {copyFallbackPlatform === platform.id ? (
                    <textarea
                      aria-label={`${platform.label} caption fallback`}
                      className={styles.copyFallbackText}
                      data-testid="caption-copy-fallback"
                      onClick={(event) => event.currentTarget.select()}
                      onFocus={(event) => event.currentTarget.select()}
                      readOnly
                      rows={4}
                      value={clip.postCopyVariants?.[platform.id] ?? ""}
                    />
                  ) : null}
                </div>
                <button
                  className={styles.copyButton}
                  data-testid="caption-copy-button"
                  onClick={() => copyCaption(platform.id)}
                  type="button"
                >
                  {copyState === platform.id ? (
                    <>
                      <CheckIcon />
                      Copied
                    </>
                  ) : (
                    "Copy"
                  )}
                </button>
              </div>
            ))
          ) : (
            <p className={styles.emptyText}>Captions are not ready.</p>
          )}
        </section>
      </div>

      <div className={styles.sheetActions}>
        {scheduledLabel ? (
          <p
            className={styles.learningNote}
            data-testid="review-scheduled-for"
          >
            {scheduledLabel}
          </p>
        ) : null}
        {learningNote ? (
          <p className={styles.learningNote}>Your Mind will learn from this.</p>
        ) : null}
        <button
          className={`${styles.actionButton} ${styles.rejectButton}`}
          disabled={!canReview || isBusy}
          onClick={rejectClip}
          type="button"
        >
          Reject
        </button>
        <button
          className={`${styles.actionButton} ${styles.acceptButton}`}
          disabled={!canReview || isBusy}
          onClick={acceptClip}
          type="button"
        >
          Accept
        </button>
      </div>
    </section>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.checkIcon}
      fill="none"
      height="18"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="18"
    >
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function writeClipToUrl(clipId: string | null) {
  const url = new URL(window.location.href);
  if (clipId) {
    url.searchParams.set("clip", clipId);
  } else {
    url.searchParams.delete("clip");
  }

  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

function findClip(
  groups: ReviewVideoGroupView[],
  clipId: string,
): ReviewClipView | null {
  for (const group of groups) {
    const clip = group.clips.find((item) => item.id === clipId);
    if (clip) {
      return clip;
    }
  }

  return null;
}

function rankBadge(rank: number | null): string {
  return rank === null ? "NR" : String(rank);
}

function formatDuration(startMs: number, endMs: number): string {
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  return `${seconds}s`;
}

function transcriptLine(transcript: string | null): string {
  const text = transcript?.trim();
  if (!text) {
    return "No transcript saved.";
  }

  return text;
}

function statusLabel(
  clip: ReviewClipView,
  isRendering: boolean,
  pendingReject: RejectUndoSnapshot | null,
): string {
  if (pendingReject) {
    return `Rejected - Undo ${Math.ceil(pendingReject.remainingMs / 1000)}s`;
  }

  if (isRendering) {
    return "rendering";
  }

  if (clip.renderFailedAt) {
    return "render failed";
  }

  if (clip.rejectReason) {
    return `rejected: ${clip.rejectReason}`;
  }

  if (clip.status === "rejected") {
    return "rejected";
  }

  return clip.status;
}

function isRenderPending(
  clip: Pick<ReviewClipView, "status" | "renderedUrl" | "renderFailedAt">,
): boolean {
  return (
    (clip.status === "accepted" || clip.status === "scheduled") &&
    !clip.renderedUrl &&
    !clip.renderFailedAt
  );
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) {
    return record;
  }

  const next = { ...record };
  delete next[key];
  return next;
}

function sameSnapshotMap(
  left: Record<string, RejectUndoSnapshot>,
  right: Record<string, RejectUndoSnapshot>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every(
    (key) =>
      left[key]?.deadlineMs === right[key]?.deadlineMs &&
      left[key]?.remainingMs === right[key]?.remainingMs,
  );
}

function sameReasonPromptMap(
  left: Record<string, RejectReasonPrompt>,
  right: Record<string, RejectReasonPrompt>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every(
    (key) =>
      left[key]?.clipId === right[key]?.clipId &&
      left[key]?.deadlineMs === right[key]?.deadlineMs,
  );
}

function reasonSlug(rejectReason: RejectReason): string {
  return rejectReason.replace(/\s+/g, "-");
}

function formatPreviewTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
