"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  MAX_CAPTION_CORPUS_CHARS,
  MAX_CAPTION_CORPUS_LINES,
  capCaptionCorpusInput,
  countCaptionCorpusLines,
} from "../../../lib/caption-corpus";
import {
  fetchChannelPullStatus,
  startChannelPull,
} from "../../../lib/channel-pull-client";
import {
  channelPullProgressLine,
  isActiveChannelPullStage,
  type ChannelPullStatusView,
} from "../../../lib/channel-pull-status";

import styles from "./rhythm.module.css";

type VoiceCardProps = {
  initialCaptionCorpus: string;
  initialCaptionCount: number;
  initialChannelUrl: string;
  initialChannelPullStatus: ChannelPullStatusView;
  hasMind: boolean;
};

type VoiceSaveState = "idle" | "teaching" | "saved" | "error";
type ChannelPullSaveState = "idle" | "pulling" | "error";
const CHANNEL_PULL_POLL_MS = 3_000;

export function VoiceCard({
  initialCaptionCorpus,
  initialCaptionCount,
  initialChannelUrl,
  initialChannelPullStatus,
}: VoiceCardProps) {
  const router = useRouter();
  const [captionCorpus, setCaptionCorpus] = useState(initialCaptionCorpus);
  const [captionCount, setCaptionCount] = useState(initialCaptionCount);
  const [channelUrl, setChannelUrl] = useState(initialChannelUrl);
  const [channelPullStatus, setChannelPullStatus] = useState(
    initialChannelPullStatus,
  );
  const [channelPullState, setChannelPullState] =
    useState<ChannelPullSaveState>("idle");
  const [saveState, setSaveState] = useState<VoiceSaveState>("idle");
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveCaptionCount = countCaptionCorpusLines(captionCorpus);
  const channelPullLine = channelPullProgressLine(channelPullStatus);

  useEffect(() => {
    if (!isActiveChannelPullStage(channelPullStatus.stage)) {
      if (channelPullState === "pulling") {
        setChannelPullState("idle");
        router.refresh();
      }
      return;
    }

    let cancelled = false;
    async function poll() {
      const status = await fetchChannelPullStatus();
      if (!cancelled && status) {
        setChannelPullStatus(status);
      }
    }

    void poll();
    const interval = window.setInterval(poll, CHANNEL_PULL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [channelPullState, channelPullStatus.stage, router]);

  async function teachMind() {
    setSaveState("teaching");
    setConfirmation(null);
    setError(null);

    try {
      const response = await fetch("/api/voice/corpus", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          captionCorpus,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | {
            captionCorpus?: string | null;
            captionCount?: number;
            confirmation?: string;
            error?: string;
          }
        | null;

      if (!response.ok) {
        throw new Error(body?.error ?? "Could not teach your Mind.");
      }

      const nextCaptionCorpus = body?.captionCorpus ?? "";
      setCaptionCorpus(nextCaptionCorpus);
      setCaptionCount(body?.captionCount ?? countCaptionCorpusLines(nextCaptionCorpus));
      setConfirmation(body?.confirmation ?? "Mind updated.");
      setSaveState("saved");
      router.refresh();
    } catch (requestError) {
      setSaveState("error");
      setError(errorMessage(requestError));
    }
  }

  async function pullChannel() {
    setChannelPullState("pulling");
    setConfirmation(null);
    setError(null);

    try {
      const result = await startChannelPull(channelUrl);
      setChannelPullStatus(result);
      if (result.channelUrl) {
        setChannelUrl(result.channelUrl);
      }
    } catch (requestError) {
      setChannelPullState("error");
      setError(errorMessage(requestError));
    }
  }

  return (
    <section
      className={styles.card}
      aria-labelledby="voice-title"
      data-testid="voice-card"
    >
      <div className={styles.cardHeader}>
        <h2 className={styles.sectionTitle} id="voice-title">
          Voice
        </h2>
        <span className={styles.saveState} aria-live="polite">
          {saveState === "teaching"
            ? "Teaching"
            : saveState === "saved"
              ? "Saved"
              : saveState === "error"
                ? "Try again"
                : null}
        </span>
      </div>
      <p className={styles.voiceSummary}>
        {captionCount > 0
          ? `Your Mind knows ${captionCount} of your captions.`
          : "No pasted captions saved yet."}
      </p>
      <div className={styles.voiceChannelBlock}>
        <label className={styles.voiceLabel}>
          YouTube channel
          <input
            className={styles.voiceInput}
            data-testid="voice-channel-input"
            inputMode="url"
            onChange={(event) => setChannelUrl(event.target.value)}
            placeholder="@yourhandle or youtube.com/@yourhandle"
            value={channelUrl}
          />
        </label>
        <button
          className={styles.teachButton}
          data-testid="pull-channel-button"
          disabled={
            !channelUrl.trim() ||
            channelPullState === "pulling" ||
            isActiveChannelPullStage(channelPullStatus.stage)
          }
          onClick={pullChannel}
          type="button"
        >
          Pull my recent videos
        </button>
        {channelPullLine ? (
          <p
            className={
              channelPullStatus.stage === "failed"
                ? styles.voiceError
                : styles.voiceConfirmation
            }
            data-testid="channel-pull-progress"
            role={channelPullStatus.stage === "failed" ? "alert" : undefined}
          >
            {channelPullLine}
          </p>
        ) : null}
      </div>
      <label className={styles.voiceLabel}>
        Paste a few recent captions
        <textarea
          className={styles.voiceTextarea}
          data-testid="voice-corpus-textarea"
          maxLength={MAX_CAPTION_CORPUS_CHARS}
          onChange={(event) =>
            setCaptionCorpus(capCaptionCorpusInput(event.target.value))
          }
          rows={7}
          value={captionCorpus}
        />
      </label>
      <div className={styles.voiceFooter}>
        <span>
          {liveCaptionCount}/{MAX_CAPTION_CORPUS_LINES}
        </span>
        <button
          className={styles.teachButton}
          data-testid="teach-voice-button"
          disabled={saveState === "teaching"}
          onClick={teachMind}
          type="button"
        >
          Teach your Mind
        </button>
      </div>
      {confirmation ? (
        <p className={styles.voiceConfirmation} data-testid="voice-confirmation">
          {confirmation}
        </p>
      ) : null}
      {error ? (
        <p className={styles.voiceError} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
