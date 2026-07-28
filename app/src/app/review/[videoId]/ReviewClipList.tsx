"use client";

import { useEffect, useRef, useState } from "react";

import styles from "./video.module.css";

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
  status: ClipStatus;
  startMs: number;
  endMs: number;
  renderedUrl: string | null;
  postCopyVariants: PostCopyVariants | null;
  transcript: string | null;
  mindRank: number | null;
  mindRankReason: string | null;
  createdAt: string;
};

type ReviewClipListProps = {
  clips: ReviewClipView[];
  previewSourceUrl: string | null;
};

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "youtube", label: "YouTube" },
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
];

export function ReviewClipList({
  clips,
  previewSourceUrl,
}: ReviewClipListProps) {
  const [items, setItems] = useState(clips);

  return (
    <section className={styles.clipList}>
      {items.map((clip) => (
        <ClipCard
          clip={clip}
          key={clip.id}
          previewSourceUrl={previewSourceUrl}
          updateClip={(nextClip) => {
            setItems((current) =>
              current.map((item) => (item.id === nextClip.id ? nextClip : item)),
            );
          }}
        />
      ))}
    </section>
  );
}

function ClipCard({
  clip,
  previewSourceUrl,
  updateClip,
}: {
  clip: ReviewClipView;
  previewSourceUrl: string | null;
  updateClip: (clip: ReviewClipView) => void;
}) {
  const [isBusy, setIsBusy] = useState(false);
  const [isRendering, setIsRendering] = useState(
    clip.status === "accepted" && !clip.renderedUrl,
  );
  const [copyState, setCopyState] = useState<Platform | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoSource = clip.renderedUrl ?? previewSourceUrl;
  const isPreview = !clip.renderedUrl;
  const canReview = clip.status === "candidate";

  useEffect(() => {
    if (!isRendering || clip.renderedUrl) {
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
        if (nextClip.renderedUrl) {
          setIsRendering(false);
          window.clearInterval(interval);
        }
      }
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [clip.id, clip.renderedUrl, isRendering, updateClip]);

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
      setIsRendering(body.rendering && !body.clip.renderedUrl);
    } finally {
      setIsBusy(false);
    }
  }

  async function rejectClip() {
    setIsBusy(true);
    try {
      const response = await fetch(`/api/clips/${clip.id}/reject`, {
        method: "POST",
      });
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { clip: ReviewClipView };
      updateClip(body.clip);
      setIsRendering(false);
    } finally {
      setIsBusy(false);
    }
  }

  function seekToStart() {
    const video = videoRef.current;
    if (!video || !isPreview) {
      return;
    }

    const startSeconds = clip.startMs / 1000;
    if (Math.abs(video.currentTime - startSeconds) > 0.2) {
      video.currentTime = startSeconds;
    }
  }

  function keepPreviewInWindow() {
    const video = videoRef.current;
    if (!video || !isPreview) {
      return;
    }

    if (video.currentTime >= clip.endMs / 1000) {
      video.pause();
      video.currentTime = clip.startMs / 1000;
    }
  }

  return (
    <article
      className={`${styles.clipCard} ${
        clip.status === "rejected" ? styles.clipCardRejected : ""
      }`}
    >
      <div className={styles.videoWrap}>
        {videoSource ? (
          <video
            className={styles.video}
            controls
            onLoadedMetadata={seekToStart}
            onPlay={seekToStart}
            onTimeUpdate={keepPreviewInWindow}
            playsInline
            preload="metadata"
            ref={videoRef}
            src={videoSource}
          />
        ) : (
          <p className={styles.empty}>Source video is unavailable.</p>
        )}
      </div>

      <div className={styles.clipMain}>
        <header className={styles.clipHeader}>
          <div>
            <span className={styles.rank}>{rankLabel(clip.mindRank)}</span>
            <p className={styles.meta}>{formatDuration(clip.startMs, clip.endMs)}</p>
          </div>
          <span className={styles.status}>
            {isRendering ? "rendering" : clip.status}
          </span>
        </header>

        <p className={styles.reason}>
          {clip.mindRankReason || "No rank reason saved."}
        </p>
        <p className={styles.snippet}>{transcriptSnippet(clip.transcript)}</p>

        <div className={styles.actions}>
          <button
            className={`${styles.button} ${styles.accept}`}
            disabled={!canReview || isBusy}
            onClick={acceptClip}
            type="button"
          >
            Accept
          </button>
          <button
            className={`${styles.button} ${styles.reject}`}
            disabled={!canReview || isBusy}
            onClick={rejectClip}
            type="button"
          >
            Reject
          </button>
        </div>

        <section className={styles.captions}>
          <h2 className={styles.captionsTitle}>Captions</h2>
          {clip.postCopyVariants ? (
            PLATFORMS.map((platform) => (
              <div className={styles.captionRow} key={platform.id}>
                <span className={styles.captionPlatform}>{platform.label}</span>
                <p className={styles.captionText}>
                  {clip.postCopyVariants?.[platform.id]}
                </p>
                <button
                  className={styles.copyButton}
                  onClick={async () => {
                    await navigator.clipboard.writeText(
                      clip.postCopyVariants?.[platform.id] ?? "",
                    );
                    setCopyState(platform.id);
                  }}
                  type="button"
                >
                  {copyState === platform.id ? "Copied" : "Copy"}
                </button>
              </div>
            ))
          ) : (
            <p className={styles.empty}>Captions are not ready.</p>
          )}
        </section>
      </div>
    </article>
  );
}

function rankLabel(rank: number | null): string {
  return rank === null ? "Rank none" : `Rank ${rank}`;
}

function formatDuration(startMs: number, endMs: number): string {
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  return `${seconds}s clip`;
}

function transcriptSnippet(transcript: string | null): string {
  const text = transcript?.trim();
  if (!text) {
    return "No transcript saved.";
  }

  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}
