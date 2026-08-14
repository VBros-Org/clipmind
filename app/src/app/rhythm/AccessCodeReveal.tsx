"use client";

import { useState } from "react";

import styles from "./rhythm.module.css";

type RevealState = "idle" | "loading" | "shown" | "error";

export function AccessCodeReveal() {
  const [state, setState] = useState<RevealState>("idle");
  const [accessCode, setAccessCode] = useState("");

  async function revealAccessCode() {
    if (state === "shown") {
      setAccessCode("");
      setState("idle");
      return;
    }

    setState("loading");
    try {
      const response = await fetch("/api/session/access-code", {
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as
        | {
            accessCode?: string;
            error?: string;
          }
        | null;
      if (!response.ok || !body?.accessCode) {
        throw new Error(body?.error ?? "Creator code could not be shown.");
      }

      setAccessCode(body.accessCode);
      setState("shown");
    } catch {
      setAccessCode("");
      setState("error");
    }
  }

  async function copyAccessCode() {
    if (!accessCode) {
      return;
    }

    await navigator.clipboard?.writeText(accessCode);
  }

  return (
    <div className={styles.accessReveal}>
      <button
        className={styles.revealButton}
        disabled={state === "loading"}
        onClick={revealAccessCode}
        type="button"
      >
        {state === "shown" ? "Hide creator code" : "Show creator code"}
      </button>
      {state === "shown" ? (
        <div className={styles.revealedAccessCode}>
          <span>{accessCode}</span>
          <button
            className={styles.copyCodeButton}
            onClick={copyAccessCode}
            type="button"
          >
            Copy
          </button>
        </div>
      ) : null}
      {state === "error" ? (
        <p className={styles.revealError} role="alert">
          Creator code could not be shown.
        </p>
      ) : null}
    </div>
  );
}
