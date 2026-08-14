"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { HomeUploadCard } from "../../../lib/home-upload-cards";
import {
  POSTED_WIN_EVENT_NAME,
  storePostedWin,
  type PostedWinPayload,
} from "../../../lib/posted-win";
import {
  canSharePreparedVideoFile,
  sharePreparedVideoFile,
  type PreparedVideoShareNavigator,
} from "../../../lib/share-prepared-video";
import {
  formatMediaPreparationProgress,
  saveDisabledReason,
  type MediaPreparationProgress,
} from "../../../lib/post-media-prep";
import styles from "./home.module.css";

type Platform = "youtube" | "tiktok" | "instagram";

type PostCopyVariants = Record<Platform, string>;

export type ReadyToPostClipView = {
  id: string;
  videoId: string;
  renderedUrl: string | null;
  thumbUrl: string | null;
  scheduledForIso: string;
  postCopyVariants: PostCopyVariants | null;
  label: string;
};

type ReadyToPostRowProps = {
  clips: ReadyToPostClipView[];
  uploadCards: HomeUploadCard[];
  initialClipId?: string | null;
};

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "youtube", label: "YouTube Shorts" },
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
];

type PreparedMedia = {
  canShareVideo: boolean;
  file: File;
  objectUrl: string;
};

export function ReadyToPostRow({
  clips,
  uploadCards,
  initialClipId,
}: ReadyToPostRowProps) {
  const router = useRouter();
  const [activeClipId, setActiveClipId] = useState<string | null>(() =>
    initialClipId && clips.some((clip) => clip.id === initialClipId)
      ? initialClipId
      : null,
  );
  const [postedClipIds, setPostedClipIds] = useState<Set<string>>(new Set());
  const visibleClips = useMemo(
    () => clips.filter((clip) => !postedClipIds.has(clip.id)),
    [clips, postedClipIds],
  );
  const activeClip = useMemo(
    () =>
      activeClipId
        ? visibleClips.find((clip) => clip.id === activeClipId) ?? null
        : null,
    [activeClipId, visibleClips],
  );

  useEffect(() => {
    if (initialClipId && visibleClips.some((clip) => clip.id === initialClipId)) {
      setActiveClipId(initialClipId);
    }
  }, [initialClipId, visibleClips]);

  function openClip(clipId: string) {
    setActiveClipId(clipId);
    writePostToUrl(clipId);
  }

  function closeClip() {
    setActiveClipId(null);
    writePostToUrl(null);
  }

  function markLocalPosted(clipId: string, postedThisWeek: number | null) {
    if (postedThisWeek !== null) {
      const detail = { postedThisWeek } satisfies PostedWinPayload;
      storePostedWin(sessionStorage, postedThisWeek);
      window.dispatchEvent(
        new CustomEvent(POSTED_WIN_EVENT_NAME, {
          detail,
        }),
      );
    }

    setPostedClipIds((current) => {
      const next = new Set(current);
      next.add(clipId);
      return next;
    });
    setActiveClipId(null);
    router.replace("/home");
    router.refresh();
  }

  if (visibleClips.length === 0 && uploadCards.length === 0) {
    return null;
  }

  return (
    <>
      <section className={styles.readySection} aria-labelledby="ready-title">
        <header className={styles.readyHeader}>
          <p className={styles.sectionLabel}>Ready to post</p>
          <h2 className={styles.readyTitle} id="ready-title">
            Scheduled clips
          </h2>
        </header>
        <div className={styles.readyRow}>
          {uploadCards.map((card) => (
            <Link
              className={`${styles.uploadStateCard} ${
                card.variant === "failed" ? styles.uploadStateCardFailed : ""
              }`}
              data-testid={
                card.variant === "failed"
                  ? "home-upload-failed-card"
                  : "home-upload-processing-card"
              }
              href={card.href}
              key={card.id}
            >
              <span className={styles.uploadStateMeta}>{card.label}</span>
              <span className={styles.uploadStateTitle}>{card.title}</span>
              <span className={styles.uploadStateBody}>{card.body}</span>
            </Link>
          ))}
          {visibleClips.map((clip) => (
            <button
              className={styles.readyBox}
              data-testid="ready-post-box"
              key={clip.id}
              onClick={() => openClip(clip.id)}
              type="button"
            >
              <span className={styles.readyThumb}>
                {clip.thumbUrl ? (
                  <img
                    alt=""
                    className={styles.readyImage}
                    data-testid="ready-thumb"
                    src={clip.thumbUrl}
                  />
                ) : (
                  <span className={styles.poster} aria-hidden="true" />
                )}
                <span className={styles.readyTimeChip}>
                  {formatScheduledTime(clip.scheduledForIso)}
                </span>
              </span>
              <span className={styles.readyMeta}>
                <span className={styles.readyTime}>
                  {formatScheduledTime(clip.scheduledForIso)}
                </span>
                <span className={styles.readyLabel}>{clip.label}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {activeClip ? (
        <PostSheet
          clip={activeClip}
          closeClip={closeClip}
          markLocalPosted={markLocalPosted}
        />
      ) : null}
    </>
  );
}

function PostSheet({
  clip,
  closeClip,
  markLocalPosted,
}: {
  clip: ReadyToPostClipView;
  closeClip: () => void;
  markLocalPosted: (clipId: string, postedThisWeek: number | null) => void;
}) {
  const [copyState, setCopyState] = useState<Platform | null>(null);
  const [copyFallbackPlatform, setCopyFallbackPlatform] =
    useState<Platform | null>(null);
  const [isPosting, setIsPosting] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [isPreparingVideo, setIsPreparingVideo] = useState(false);
  const [preparedMedia, setPreparedMedia] = useState<PreparedMedia | null>(null);
  const [prepareProgress, setPrepareProgress] =
    useState<MediaPreparationProgress>({
      loadedBytes: 0,
      totalBytes: null,
    });
  const [shareFallback, setShareFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canPost = Boolean(clip.renderedUrl);
  const preparedFile = preparedMedia?.file ?? null;
  const canShareVideo = preparedMedia?.canShareVideo ?? false;
  const disabledSaveReason = saveDisabledReason({
    canPost,
    canShareVideo,
    hasPreparedFile: Boolean(preparedFile),
    isPreparingVideo,
    progress: prepareProgress,
  });

  useEffect(() => {
    const renderedUrl = clip.renderedUrl;
    const controller = new AbortController();
    let cancelled = false;
    let objectUrl: string | null = null;

    setPreparedMedia(null);
    setPrepareProgress({
      loadedBytes: 0,
      totalBytes: null,
    });
    setShareFallback(false);
    setCopyState(null);
    setCopyFallbackPlatform(null);
    setError(null);

    if (!renderedUrl) {
      setIsPreparingVideo(false);
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    const videoUrl = renderedUrl;
    setIsPreparingVideo(true);

    async function prepareVideoFile() {
      try {
        const response = await fetch(videoUrl, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Video download failed.");
        }

        const blob = await readPreparedVideoBlob(response, (progress) => {
          if (!cancelled) {
            setPrepareProgress(progress);
          }
        });
        if (cancelled) {
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        const file = new File([blob], `clipmind-${clip.id}.mp4`, {
          type: blob.type || "video/mp4",
        });
        const nextCanShare = canSharePreparedVideoFile(
          navigator as PreparedVideoShareNavigator,
          file,
        );

        setPreparedMedia({
          canShareVideo: nextCanShare,
          file,
          objectUrl,
        });
        setShareFallback(!nextCanShare);
      } catch (prepareError) {
        if (cancelled || errorName(prepareError) === "AbortError") {
          return;
        }

        setError("Video could not be prepared.");
        setShareFallback(true);
      } finally {
        if (!cancelled) {
          setIsPreparingVideo(false);
        }
      }
    }

    void prepareVideoFile();

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [clip.id, clip.renderedUrl]);

  function shareClip() {
    if (!preparedFile || !canShareVideo) {
      setShareFallback(true);
      return;
    }

    const shareResult = sharePreparedVideoFile(
      navigator as PreparedVideoShareNavigator,
      preparedFile,
    );

    setError(null);
    setIsSharing(true);
    setShareFallback(false);

    void shareResult
      .then((result) => {
        if (result.status === "cancelled" || result.status === "shared") {
          return;
        }

        setShareFallback(true);
        if (result.status === "failed") {
          setError("Save failed.");
        }
      })
      .finally(() => {
        setIsSharing(false);
      });
  }

  function saveButtonLabel() {
    if (!canPost || isPreparingVideo || !preparedFile) {
      return "Preparing video";
    }

    if (!canShareVideo) {
      return "Use download";
    }

    if (isSharing) {
      return "Saving";
    }

    return "Save to device";
  }

  function downloadFallbackCopy() {
    if (!canPost) {
      return "The rendered MP4 is not ready yet.";
    }

    if (!preparedMedia) {
      return "Video prep failed. Use Download.";
    }

    if (!canShareVideo) {
      return "This browser cannot save directly.";
    }

    return "Save did not work in this browser.";
  }

  function showDownloadButton() {
    return Boolean(canPost && shareFallback && (!canShareVideo || !preparedMedia));
  }

  function errorName(error: unknown): string | null {
    if (!error || typeof error !== "object" || !("name" in error)) {
      return null;
    }

    const name = (error as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  }

  async function copyCaption(platform: Platform) {
    const caption = clip.postCopyVariants?.[platform] ?? "";
    try {
      await navigator.clipboard.writeText(caption);
      setCopyState(platform);
      setCopyFallbackPlatform(null);
      setError(null);
    } catch {
      setCopyState(null);
      setCopyFallbackPlatform(platform);
      setError("Copy it manually below.");
    }
  }

  async function markPosted() {
    setIsPosting(true);
    setError(null);

    try {
      const response = await fetch(`/api/clips/${clip.id}/posted`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        postedThisWeek?: number;
      } | null;

      if (!response.ok) {
        setError(body?.error ?? "Post update failed.");
        return;
      }

      markLocalPosted(
        clip.id,
        typeof body?.postedThisWeek === "number" ? body.postedThisWeek : null,
      );
    } finally {
      setIsPosting(false);
    }
  }

  return (
    <section
      aria-label="Post clip"
      aria-modal="true"
      className={styles.postSheet}
      data-testid="post-sheet"
      role="dialog"
    >
      <header className={styles.postHeader}>
        <div>
          <p className={styles.sectionLabel}>Post now</p>
          <h2 className={styles.postTitle}>{formatScheduledTime(clip.scheduledForIso)}</h2>
        </div>
        <button className={styles.closeButton} onClick={closeClip} type="button">
          Close
        </button>
      </header>

      <div className={styles.postBody}>
        <div className={styles.postPlayerWrap}>
          {preparedMedia ? (
            <video
              className={styles.postPlayer}
              controls
              data-testid="post-video"
              playsInline
              poster={clip.thumbUrl ?? undefined}
              preload="metadata"
              src={preparedMedia.objectUrl}
            />
          ) : (
            <p className={styles.playerFallback}>
              {clip.renderedUrl
                ? formatMediaPreparationProgress(prepareProgress)
                : "Rendered video is still loading."}
            </p>
          )}
        </div>

        <div className={styles.saveRow}>
          <button
            className={styles.saveButton}
            data-testid="save-share-button"
            disabled={!canPost || !preparedFile || !canShareVideo || isSharing}
            onClick={shareClip}
            type="button"
          >
            {saveButtonLabel()}
          </button>
          {disabledSaveReason ? (
            <p className={styles.saveHint} data-testid="save-disabled-reason">
              {disabledSaveReason}
            </p>
          ) : preparedFile && canShareVideo ? (
            <p className={styles.saveHint}>choose Save Video to add it to Photos.</p>
          ) : null}
        </div>
        {shareFallback ? (
          <div className={styles.downloadFallbackRow}>
            <p className={styles.postNotice}>{downloadFallbackCopy()}</p>
            {showDownloadButton() && (preparedMedia?.objectUrl || clip.renderedUrl) ? (
              <a
                className={styles.downloadLink}
                download
                href={preparedMedia?.objectUrl ?? clip.renderedUrl ?? ""}
              >
                Download
              </a>
            ) : null}
          </div>
        ) : null}

        <section className={styles.captionPanel} aria-label="Platform captions">
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
                      data-testid="post-caption-copy-fallback"
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
                  data-testid="post-caption-copy"
                  onClick={() => copyCaption(platform.id)}
                  type="button"
                >
                  {copyState === platform.id ? "Copied" : "Copy"}
                </button>
              </div>
            ))
          ) : (
            <p className={styles.postNotice}>Captions are not ready.</p>
          )}
        </section>

        {error ? <p className={styles.postError}>{error}</p> : null}
      </div>

      <div className={styles.postActions}>
        <button
          className={styles.markPostedButton}
          data-testid="mark-posted-button"
          disabled={!canPost || isPosting}
          onClick={markPosted}
          type="button"
        >
          {isPosting ? "Marking" : "Mark as posted"}
        </button>
      </div>
    </section>
  );
}

async function readPreparedVideoBlob(
  response: Response,
  onProgress: (progress: MediaPreparationProgress) => void,
): Promise<Blob> {
  const totalBytes = parseContentLength(response.headers.get("content-length"));
  const contentType = response.headers.get("content-type") || "video/mp4";

  onProgress({
    loadedBytes: 0,
    totalBytes,
  });

  if (!response.body) {
    const blob = await response.blob();
    onProgress({
      loadedBytes: blob.size,
      totalBytes: blob.size || totalBytes,
    });
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let loadedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunks.push(value);
    loadedBytes += value.byteLength;
    onProgress({
      loadedBytes,
      totalBytes,
    });
  }

  return new Blob(chunks, {
    type: contentType,
  });
}

function parseContentLength(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function writePostToUrl(clipId: string | null) {
  const url = new URL(window.location.href);
  if (clipId) {
    url.searchParams.set("post", clipId);
  } else {
    url.searchParams.delete("post");
  }

  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

function formatScheduledTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Time not set";
  }

  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
