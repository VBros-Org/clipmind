"use client";

import styles from "./video-delete.module.css";

export type VideoDeleteTarget = {
  id: string;
  title: string;
  clipCount: number;
};

type VideoDeleteSheetProps = {
  target: VideoDeleteTarget;
  error: string | null;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function VideoDeleteSheet({
  target,
  error,
  isDeleting,
  onCancel,
  onConfirm,
}: VideoDeleteSheetProps) {
  return (
    <section
      aria-label="Delete video"
      aria-modal="true"
      className={styles.backdrop}
      data-testid="video-delete-sheet"
      role="dialog"
    >
      <div className={styles.sheet}>
        <div className={styles.copy}>
          <p className={styles.label}>Delete video</p>
          <h2 className={styles.title}>{target.title}</h2>
          <p className={styles.message}>
            Delete this video and its {target.clipCount}{" "}
            {target.clipCount === 1 ? "clip" : "clips"}? This cannot be undone.
          </p>
        </div>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <div className={styles.actions}>
          <button
            className={styles.cancelButton}
            disabled={isDeleting}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className={styles.confirmButton}
            data-testid="confirm-delete-video"
            disabled={isDeleting}
            onClick={onConfirm}
            type="button"
          >
            {isDeleting ? "Deleting" : "Delete"}
          </button>
        </div>
      </div>
    </section>
  );
}
