"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";

import {
  MAX_CAPTION_CORPUS_CHARS,
  MAX_CAPTION_CORPUS_LINES,
  capCaptionCorpusInput,
  countCaptionCorpusLines,
} from "../../../lib/caption-corpus";
import { UploadPicker } from "../upload/UploadPicker";

import styles from "./signup.module.css";

type SignupStep = "invite" | "profile" | "access" | "corpus";
type SignupError = string | null;

const CAPTION_PRESETS = [
  {
    id: "clean-bold",
    label: "Clean bold",
    line: "Big centered words with a clean outline.",
  },
  {
    id: "outline-pop",
    label: "Outline pop",
    line: "High contrast captions with a punchy highlight.",
  },
  {
    id: "karaoke",
    label: "Karaoke",
    line: "Word-by-word emphasis for fast speech.",
  },
] as const;

export function SignupFlow() {
  const [step, setStep] = useState<SignupStep>("invite");
  const [inviteCode, setInviteCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [channelUrl, setChannelUrl] = useState("");
  const [captionPreset, setCaptionPreset] = useState("clean-bold");
  const [captionCorpus, setCaptionCorpus] = useState("");
  const [corpusSaveState, setCorpusSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [accessCode, setAccessCode] = useState("");
  const [error, setError] = useState<SignupError>(null);
  const [busy, setBusy] = useState(false);
  const accessCodeRef = useRef<HTMLDivElement | null>(null);

  async function claimInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/signup/claim-invite", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          code: inviteCode,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;

      if (!response.ok) {
        throw new Error(body?.error ?? "Invite code did not work.");
      }

      setStep("profile");
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/signup/create-account", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName,
          channelUrl,
          captionPreset,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | {
            accessCode?: string;
            error?: string;
          }
        | null;

      if (!response.ok || !body?.accessCode) {
        throw new Error(body?.error ?? "Account could not be created.");
      }

      setAccessCode(body.accessCode);
      setStep("access");
      window.setTimeout(() => accessCodeRef.current?.focus(), 0);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function copyAccessCode() {
    if (!accessCode) {
      return;
    }

    await navigator.clipboard?.writeText(accessCode);
  }

  async function saveCaptionCorpus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCorpusSaveState("saving");
    setError(null);

    try {
      const response = await fetch("/api/voice/corpus", {
        method: "PUT",
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
            error?: string;
          }
        | null;

      if (!response.ok) {
        throw new Error(body?.error ?? "Captions could not be saved.");
      }

      setCaptionCorpus(body?.captionCorpus ?? "");
      setCorpusSaveState("saved");
    } catch (requestError) {
      setCorpusSaveState("error");
      setError(errorMessage(requestError));
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="signup-title">
      <p className={styles.eyebrow}>Invite signup</p>
      <h1 className={styles.title} id="signup-title">
        Create your ClipMind
      </h1>

      <StepDots activeStep={step} />

      {step === "invite" ? (
        <form className={styles.form} onSubmit={claimInvite}>
          <label className={styles.label}>
            Invite code
            <input
              autoComplete="one-time-code"
              className={styles.input}
              inputMode="text"
              onChange={(event) => setInviteCode(event.target.value)}
              required
              value={inviteCode}
            />
          </label>
          <button className={styles.button} disabled={busy} type="submit">
            Continue
          </button>
        </form>
      ) : null}

      {step === "profile" ? (
        <form className={styles.form} onSubmit={createAccount}>
          <label className={styles.label}>
            Display name
            <input
              autoComplete="name"
              className={styles.input}
              maxLength={60}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              value={displayName}
            />
          </label>
          <label className={styles.label}>
            Channel URL
            <input
              className={styles.input}
              inputMode="url"
              onChange={(event) => setChannelUrl(event.target.value)}
              placeholder="Optional"
              type="url"
              value={channelUrl}
            />
          </label>

          <fieldset className={styles.presetField}>
            <legend>Caption preset</legend>
            {CAPTION_PRESETS.map((preset) => (
              <label
                className={`${styles.presetOption} ${
                  captionPreset === preset.id ? styles.presetActive : ""
                }`}
                key={preset.id}
              >
                <input
                  checked={captionPreset === preset.id}
                  name="captionPreset"
                  onChange={() => setCaptionPreset(preset.id)}
                  type="radio"
                  value={preset.id}
                />
                <span className={styles.previewStrip} aria-hidden="true" />
                <span>
                  <strong>{preset.label}</strong>
                  <small>{preset.line}</small>
                </span>
              </label>
            ))}
          </fieldset>

          <button className={styles.button} disabled={busy} type="submit">
            Create account
          </button>
        </form>
      ) : null}

      {step === "access" ? (
        <section className={styles.accessStep}>
          <p className={styles.copy}>save this somewhere safe, it is your login</p>
          <div
            className={styles.accessCode}
            ref={accessCodeRef}
            tabIndex={-1}
          >
            {accessCode}
          </div>
          <button className={styles.button} onClick={copyAccessCode} type="button">
            Copy code
          </button>
          <button
            className={styles.secondaryButton}
            onClick={() => setStep("corpus")}
            type="button"
          >
            Continue
          </button>
        </section>
      ) : null}

      {step === "corpus" ? (
        <section className={styles.corpusStep}>
          <div className={styles.corpusHeader}>
            <h2>Upload a long video so your Mind can learn your voice</h2>
            <Link href="/home">Do this later</Link>
          </div>
          <form className={styles.captionCorpusForm} onSubmit={saveCaptionCorpus}>
            <label className={styles.label}>
              Paste a few recent captions
              <textarea
                className={styles.textarea}
                maxLength={MAX_CAPTION_CORPUS_CHARS}
                onChange={(event) =>
                  setCaptionCorpus(capCaptionCorpusInput(event.target.value))
                }
                rows={6}
                value={captionCorpus}
              />
            </label>
            <div className={styles.captionCorpusFooter}>
              <span>
                {countCaptionCorpusLines(captionCorpus)}/{MAX_CAPTION_CORPUS_LINES}
              </span>
              <button
                className={styles.secondaryButton}
                disabled={corpusSaveState === "saving"}
                type="submit"
              >
                {corpusSaveState === "saving" ? "Saving" : "Save captions"}
              </button>
            </div>
            {corpusSaveState === "saved" ? (
              <p className={styles.savedNote}>Captions saved.</p>
            ) : null}
          </form>
          <UploadPicker
            explainer="Your first upload teaches your Mind before ClipMind finds moments and writes captions."
            includeMindSteps
            initialUploads={[]}
          />
        </section>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function StepDots({ activeStep }: { activeStep: SignupStep }) {
  const steps: SignupStep[] = ["invite", "profile", "access", "corpus"];
  const activeIndex = steps.indexOf(activeStep);

  return (
    <ol className={styles.steps} aria-label="Signup steps">
      {steps.map((step, index) => (
        <li
          aria-current={step === activeStep ? "step" : undefined}
          className={index <= activeIndex ? styles.stepActive : ""}
          key={step}
        >
          {index + 1}
        </li>
      ))}
    </ol>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
