"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  MAX_CAPTION_CORPUS_CHARS,
  MAX_CAPTION_CORPUS_LINES,
  capCaptionCorpusInput,
  countCaptionCorpusLines,
} from "../../../lib/caption-corpus";

import styles from "./rhythm.module.css";

type VoiceCardProps = {
  initialCaptionCorpus: string;
  initialCaptionCount: number;
  hasMind: boolean;
};

type VoiceSaveState = "idle" | "teaching" | "saved" | "error";

export function VoiceCard({
  initialCaptionCorpus,
  initialCaptionCount,
  hasMind,
}: VoiceCardProps) {
  const router = useRouter();
  const [captionCorpus, setCaptionCorpus] = useState(initialCaptionCorpus);
  const [captionCount, setCaptionCount] = useState(initialCaptionCount);
  const [saveState, setSaveState] = useState<VoiceSaveState>("idle");
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveCaptionCount = countCaptionCorpusLines(captionCorpus);

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
          disabled={!hasMind || saveState === "teaching"}
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
