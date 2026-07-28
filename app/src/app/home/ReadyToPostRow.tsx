"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

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
  initialClipId?: string | null;
};

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "youtube", label: "YouTube Shorts" },
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
];

export function ReadyToPostRow({ clips, initialClipId }: ReadyToPostRowProps) {
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

  function markLocalPosted(clipId: string) {
    setPostedClipIds((current) => {
      const next = new Set(current);
      next.add(clipId);
      return next;
    });
    setActiveClipId(null);
    router.replace("/home");
    router.refresh();
  }

  if (visibleClips.length === 0) {
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
  markLocalPosted: (clipId: string) => void;
}) {
  const [copyState, setCopyState] = useState<Platform | null>(null);
  const [isPosting, setIsPosting] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [shareFallback, setShareFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canPost = Boolean(clip.renderedUrl);

  async function shareClip() {
    if (!clip.renderedUrl) {
      return;
    }

    setError(null);
    setIsSharing(true);
    setShareFallback(false);

    try {
      const response = await fetch(clip.renderedUrl);
      if (!response.ok) {
        throw new Error("Video download failed.");
      }

      const blob = await response.blob();
      const file = new File([blob], `clipmind-${clip.id}.mp4`, {
        type: blob.type || "video/mp4",
      });
      const shareData: ShareData = {
        files: [file],
        title: "ClipMind clip",
      };

      if (
        navigator.share &&
        (!navigator.canShare || navigator.canShare(shareData))
      ) {
        await navigator.share(shareData);
      } else {
        setShareFallback(true);
      }
    } catch {
      setShareFallback(true);
    } finally {
      setIsSharing(false);
    }
  }

  async function copyCaption(platform: Platform) {
    const caption = clip.postCopyVariants?.[platform] ?? "";
    try {
      await navigator.clipboard.writeText(caption);
      setCopyState(platform);
      setError(null);
    } catch {
      setError("Copy failed.");
    }
  }

  async function markPosted() {
    setIsPosting(true);
    setError(null);

    try {
      const response = await fetch(`/api/clips/${clip.id}/posted`, {
        method: "POST",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? "Post update failed.");
        return;
      }

      markLocalPosted(clip.id);
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
          {clip.renderedUrl ? (
            <video
              className={styles.postPlayer}
              controls
              data-testid="post-video"
              playsInline
              poster={clip.thumbUrl ?? undefined}
              preload="metadata"
              src={clip.renderedUrl}
            />
          ) : (
            <p className={styles.playerFallback}>Rendered video is still loading.</p>
          )}
        </div>

        <div className={styles.saveRow}>
          <button
            className={styles.saveButton}
            data-testid="save-share-button"
            disabled={!canPost || isSharing}
            onClick={shareClip}
            type="button"
          >
            {isSharing ? "Preparing" : "Save to device"}
          </button>
          {clip.renderedUrl ? (
            <a
              className={styles.downloadLink}
              download
              href={clip.renderedUrl}
            >
              Download
            </a>
          ) : null}
        </div>
        {shareFallback ? (
          <p className={styles.postNotice}>Use Download for this browser.</p>
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
