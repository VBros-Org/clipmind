"use client";

import { useRef, useState } from "react";

import styles from "./upload.module.css";

export function UploadPicker() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function openPicker() {
    inputRef.current?.click();
  }

  function showNextBuildToast() {
    setToast("Coming in the next build.");
    window.setTimeout(() => {
      setToast(null);
    }, 2400);
  }

  return (
    <>
      <button className={styles.dropZone} onClick={openPicker} type="button">
        <span className={styles.dropIcon} aria-hidden="true">
          <svg
            fill="none"
            height="24"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            width="24"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v8" />
            <path d="M8 12h8" />
          </svg>
        </span>
        <span>Add a long video</span>
      </button>
      <input
        ref={inputRef}
        className={styles.fileInput}
        type="file"
        accept="video/*"
        onChange={showNextBuildToast}
      />
      {toast ? (
        <p className={styles.toast} role="status">
          {toast}
        </p>
      ) : null}
    </>
  );
}
