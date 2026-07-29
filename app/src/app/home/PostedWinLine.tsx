"use client";

import { useEffect, useState } from "react";

import {
  POSTED_WIN_EVENT_NAME,
  consumePostedWin,
  postedWinMessage,
  type PostedWinPayload,
} from "../../../lib/posted-win";

import styles from "./home.module.css";

export function PostedWinLine({
  postedThisWeek,
}: {
  postedThisWeek: number;
}) {
  const [visible, setVisible] = useState(false);
  const [count, setCount] = useState(postedThisWeek);

  useEffect(() => {
    if (visible && postedThisWeek > 0) {
      setCount(postedThisWeek);
    }
  }, [postedThisWeek, visible]);

  useEffect(() => {
    const stored = consumePostedWin(sessionStorage);
    if (stored) {
      setCount(stored.postedThisWeek);
      setVisible(true);
    }

    function handlePostedWin(event: Event) {
      const detail = (event as CustomEvent<PostedWinPayload>).detail;
      consumePostedWin(sessionStorage);
      setCount(detail?.postedThisWeek ?? postedThisWeek);
      setVisible(true);
    }

    window.addEventListener(POSTED_WIN_EVENT_NAME, handlePostedWin);
    return () => {
      window.removeEventListener(POSTED_WIN_EVENT_NAME, handlePostedWin);
    };
  }, [postedThisWeek]);

  if (!visible) {
    return null;
  }

  return (
    <p
      aria-live="polite"
      className={styles.postedWin}
      data-testid="posted-win-line"
    >
      {postedWinMessage(count)}
    </p>
  );
}
