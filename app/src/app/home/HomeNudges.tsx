"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import type { HomeNudge } from "../../../lib/home-rules";

import styles from "./home.module.css";

type HomeNudgesProps = {
  nudges: HomeNudge[];
};

const PERSISTENT_STORAGE_KEY = "clipmind.dismissedHomeNudges";
const SESSION_STORAGE_KEY = "clipmind.dismissedHomeNudges.session";

export function HomeNudges({ nudges }: HomeNudgesProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    setDismissed(readDismissed(nudges));
  }, [nudges]);

  const visibleNudges = useMemo(
    () => nudges.filter((nudge) => !dismissed.has(nudge.id)),
    [dismissed, nudges],
  );

  if (visibleNudges.length === 0) {
    return null;
  }

  function dismiss(nudge: HomeNudge) {
    setDismissed((current) => {
      const next = new Set(current);
      next.add(nudge.id);
      writeDismissed(nudge);
      return next;
    });
  }

  return (
    <section className={styles.nudges} aria-label="Next actions">
      {visibleNudges.map((nudge) => (
        <article
          className={`${styles.nudgeCard} ${
            nudge.kind === "failed" ? styles.nudgeCardFailed : ""
          }`}
          key={nudge.id}
        >
          <Link className={styles.nudgeLink} href={nudge.href}>
            {nudge.title}
          </Link>
          <button
            aria-label={`Dismiss ${nudge.title}`}
            className={styles.dismiss}
            onClick={() => dismiss(nudge)}
            type="button"
          >
            Dismiss
          </button>
        </article>
      ))}
    </section>
  );
}

function readDismissed(nudges: readonly HomeNudge[]): Set<string> {
  const persistent = readDismissedKey(localStorage, PERSISTENT_STORAGE_KEY);
  const session = readDismissedKey(sessionStorage, SESSION_STORAGE_KEY);
  const dismissed = new Set<string>();

  for (const nudge of nudges) {
    const source = nudge.dismissal === "session" ? session : persistent;
    if (source.has(nudge.id)) {
      dismissed.add(nudge.id);
    }
  }

  return dismissed;
}

function readDismissedKey(storage: Storage, key: string): Set<string> {
  try {
    return new Set(JSON.parse(storage.getItem(key) ?? "[]"));
  } catch {
    return new Set();
  }
}

function writeDismissed(nudge: HomeNudge) {
  const key =
    nudge.dismissal === "session" ? SESSION_STORAGE_KEY : PERSISTENT_STORAGE_KEY;
  const storage = nudge.dismissal === "session" ? sessionStorage : localStorage;
  const dismissed = readDismissedKey(storage, key);
  dismissed.add(nudge.id);
  storage.setItem(key, JSON.stringify([...dismissed]));
}
