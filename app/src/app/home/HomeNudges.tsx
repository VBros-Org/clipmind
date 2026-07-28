"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import type { HomeNudge } from "../../../lib/home-rules";

import styles from "./home.module.css";

type HomeNudgesProps = {
  nudges: HomeNudge[];
};

const STORAGE_KEY = "clipmind.dismissedHomeNudges";

export function HomeNudges({ nudges }: HomeNudgesProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  const visibleNudges = useMemo(
    () => nudges.filter((nudge) => !dismissed.has(nudge.id)),
    [dismissed, nudges],
  );

  if (visibleNudges.length === 0) {
    return null;
  }

  function dismiss(id: string) {
    setDismissed((current) => {
      const next = new Set(current);
      next.add(id);
      writeDismissed(next);
      return next;
    });
  }

  return (
    <section className={styles.nudges} aria-label="Next actions">
      {visibleNudges.map((nudge) => (
        <article className={styles.nudgeCard} key={nudge.id}>
          <Link className={styles.nudgeLink} href={nudge.href}>
            {nudge.title}
          </Link>
          <button
            aria-label={`Dismiss ${nudge.title}`}
            className={styles.dismiss}
            onClick={() => dismiss(nudge.id)}
            type="button"
          >
            Dismiss
          </button>
        </article>
      ))}
    </section>
  );
}

function readDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function writeDismissed(value: Set<string>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...value]));
}
