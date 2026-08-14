"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ChangeEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { deleteVideo } from "../../../lib/video-delete-client";
import {
  fetchRecentUploads,
  fetchVideoStatus,
  retryUploadAndRefreshStatus,
  type PipelineStage,
  type StatusResponse,
  type UploadView,
} from "../../../lib/upload-status-client";
import {
  failedStageFromPipelineError,
  failedUploadStageLabel,
  uploadStageLabel,
} from "../../../lib/upload-stage-copy";
import {
  createScreenWakeLockManager,
  type ScreenWakeLockManager,
} from "../../../lib/screen-wake-lock";
import {
  uploadTransferFailed,
  uploadTransferIdle,
  uploadTransferStarted,
  uploadTransferSucceeded,
  type UploadTransferState,
} from "../../../lib/upload-transfer-state";
import {
  VideoDeleteSheet,
  type VideoDeleteTarget,
} from "../VideoDeleteSheet";
import styles from "./upload.module.css";

type UploadProgress = {
  fileName: string;
  loaded: number;
  total: number;
  percent: number;
};

type UploadResponse = {
  videoId: string;
  stage: PipelineStage;
  bytes: number;
};

const CLIENT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const POLL_MS = 3_000;

const STEPS: {
  id: Exclude<PipelineStage, "failed">;
  label: string;
  line: string;
}[] = [
  {
    id: "learning_voice",
    label: "Learning your voice",
    line: "Your corpus is being distilled into a voice profile.",
  },
  {
    id: "waking_mind",
    label: "Waking your Mind",
    line: "A dedicated Mind is being created for this creator.",
  },
  {
    id: "teaching_taste",
    label: "Teaching it your taste",
    line: "Your voice and clip taste are being seeded as Tenets.",
  },
  {
    id: "uploaded",
    label: "Uploaded",
    line: "Source video is saved.",
  },
  {
    id: "transcribing",
    label: "Transcribing",
    line: "Clip service is reading the audio.",
  },
  {
    id: "candidates",
    label: "Finding moments",
    line: "Candidate clip windows are being written.",
  },
  {
    id: "ranking",
    label: "Ranking by your Mind",
    line: "Your Mind is judging the strongest moments.",
  },
  {
    id: "captions",
    label: "Writing captions",
    line: "Top ranked clips are getting platform captions.",
  },
  {
    id: "done",
    label: "Done",
    line: "Clips and captions are ready for review.",
  },
];

const NORMAL_STEP_IDS = new Set<string>([
  "uploaded",
  "transcribing",
  "candidates",
  "ranking",
  "captions",
  "done",
]);

export function UploadPicker({
  initialUploads,
  includeMindSteps = false,
  explainer = "ClipMind finds the moments, ranks them by your taste, and writes your captions.",
  pushNudgesEnabled = false,
}: {
  initialUploads: UploadView[];
  includeMindSteps?: boolean;
  explainer?: string;
  pushNudgesEnabled?: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wakeLockRef = useRef<ScreenWakeLockManager | null>(null);
  const [uploads, setUploads] = useState(initialUploads);
  const [activeVideoId, setActiveVideoId] = useState<string | null>(
    () => initialUploads.find((upload) => isProcessing(upload.pipelineStage))?.id ?? null,
  );
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [transferState, setTransferState] = useState<UploadTransferState<File>>(
    () => uploadTransferIdle(),
  );
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VideoDeleteTarget | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const activeUpload = useMemo(
    () =>
      activeVideoId
        ? uploads.find((upload) => upload.id === activeVideoId) ?? null
        : null,
    [activeVideoId, uploads],
  );
  const activeStage = activeUpload?.pipelineStage ?? null;

  const applyFreshUploads = useCallback((freshUploads: UploadView[]) => {
    setUploads(freshUploads);
    setActiveVideoId((currentId) => {
      const current = currentId
        ? freshUploads.find((upload) => upload.id === currentId) ?? null
        : null;
      if (current) {
        return current.id;
      }

      return (
        freshUploads.find((upload) => isProcessing(upload.pipelineStage))?.id ??
        null
      );
    });
  }, []);

  function openPicker() {
    inputRef.current?.click();
  }

  function getWakeLockManager() {
    wakeLockRef.current ??= createScreenWakeLockManager(navigator, document);
    return wakeLockRef.current;
  }

  useEffect(() => {
    return () => {
      void wakeLockRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function refreshRecentUploads() {
      const freshUploads = await fetchRecentUploads();
      if (!cancelled && freshUploads) {
        applyFreshUploads(freshUploads);
      }
    }

    function handleFocus() {
      void refreshRecentUploads();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void refreshRecentUploads();
      }
    }

    void refreshRecentUploads();
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [applyFreshUploads]);

  useEffect(() => {
    if (!activeVideoId || !activeStage || !isProcessing(activeStage)) {
      return;
    }

    const pollingVideoId = activeVideoId;
    let cancelled = false;

    async function pollStatus() {
      const status = await fetchVideoStatus(pollingVideoId);
      if (cancelled || !status) {
        return;
      }

      setUploads((current) => mergeStatus(current, pollingVideoId, status));
    }

    void pollStatus();
    const interval = window.setInterval(pollStatus, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeVideoId, activeStage]);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null;
    if (!file) {
      return;
    }

    if (file.size > CLIENT_MAX_UPLOAD_BYTES) {
      setUploadError("Video must be 2 GB or smaller.");
      event.currentTarget.value = "";
      return;
    }

    await startUploadTransfer(file);
  }

  async function startUploadTransfer(file: File) {
    setUploadError(null);
    setActiveVideoId(null);
    setTransferState(uploadTransferStarted());
    setProgress({
      fileName: file.name,
      loaded: 0,
      total: file.size,
      percent: 0,
    });
    void getWakeLockManager().start();

    try {
      const response = await uploadFile(file, (nextProgress) => {
        setProgress(nextProgress);
      });
      const upload: UploadView = {
        id: response.videoId,
        label: "Just now",
        status: response.stage,
        pipelineStage: response.stage,
        pipelineError: null,
        createdAtIso: new Date().toISOString(),
        clipCount: 0,
      };

      setUploads((current) =>
        [upload, ...current.filter((item) => item.id !== upload.id)].slice(0, 3),
      );
      setActiveVideoId(upload.id);
      setTransferState(uploadTransferSucceeded());
    } catch (error) {
      setTransferState(uploadTransferFailed(file));
      setUploadError(errorMessage(error));
    } finally {
      setProgress(null);
      void wakeLockRef.current?.stop();
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  }

  async function tryFailedTransferAgain() {
    if (!transferState.retryFile || progress) {
      return;
    }

    await startUploadTransfer(transferState.retryFile);
  }

  async function retryUpload(videoId: string) {
    setUploadError(null);

    const result = await retryUploadAndRefreshStatus(videoId);
    if (result.outcome === "refetched") {
      setUploads((current) => mergeStatus(current, videoId, result.status));
      setActiveVideoId(videoId);
      return;
    }

    if (result.outcome === "error") {
      const currentStatus = result.status;
      if (currentStatus) {
        setUploads((current) => mergeStatus(current, videoId, currentStatus));
      }
      setUploadError(result.message);
      return;
    }

    const stage = result.stage;
    setUploads((current) =>
      current.map((upload) =>
        upload.id === videoId
          ? {
              ...upload,
              status: stage,
              pipelineStage: stage,
              pipelineError: null,
            }
          : upload,
      ),
    );
    setActiveVideoId(videoId);
  }

  function openDeleteSheet(upload: UploadView) {
    setDeleteTarget({
      id: upload.id,
      title: upload.label,
      clipCount: upload.clipCount,
    });
    setDeleteError(null);
  }

  async function confirmDeleteVideo() {
    if (!deleteTarget) {
      return;
    }

    const target = deleteTarget;
    setIsDeleting(true);
    setDeleteError(null);

    try {
      const result = await deleteVideo(target.id);
      if (result.outcome !== "deleted") {
        setDeleteError(result.message);
        return;
      }

      const freshUploads = await fetchRecentUploads();
      if (freshUploads) {
        applyFreshUploads(freshUploads);
      } else {
        setUploads((current) =>
          current.filter((upload) => upload.id !== target.id),
        );
        setActiveVideoId((current) => (current === target.id ? null : current));
      }
      setDeleteTarget(null);
      router.refresh();
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <>
      <button
        className={styles.dropZone}
        disabled={progress !== null}
        onClick={openPicker}
        type="button"
      >
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
        onChange={handleFileChange}
      />
      <p className={styles.explainer}>
        {explainer}
      </p>

      {progress ? (
        <section className={styles.progressPanel} aria-live="polite">
          <div className={styles.progressHeader}>
            <p className={styles.progressTitle}>{progress.fileName}</p>
            <p className={styles.progressMeta}>
              {progress.percent}% / {formatBytes(progress.loaded)} of{" "}
              {formatBytes(progress.total)}
            </p>
          </div>
          <div className={styles.progressTrack} aria-hidden="true">
            <span
              className={styles.progressFill}
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </section>
      ) : null}

      {transferState.notice ? (
        <p
          className={`${styles.transferNotice} ${
            styles[`transferNotice_${transferState.notice}`]
          }`}
          data-testid="upload-transfer-notice"
          aria-live="polite"
        >
          {transferState.notice === "uploading"
            ? "Keep ClipMind open while this uploads."
            : pushNudgesEnabled
              ? "Safe to leave. We will nudge you when clips are ready."
              : "Safe to leave. Push is off, so check Upload or Review later."}
        </p>
      ) : null}

      {activeUpload ? (
        <section className={styles.checklist} aria-label="Upload pipeline">
          {visibleSteps(includeMindSteps).map((step) => (
            <ChecklistStep
              currentStage={activeUpload.pipelineStage}
              error={activeUpload.pipelineError}
              key={step.id}
              step={step}
            />
          ))}
          {activeUpload.pipelineStage === "done" ? (
            <Link className={styles.reviewLink} href="/review">
              Open Review
            </Link>
          ) : null}
        </section>
      ) : null}

      {uploadError ? (
        <div className={styles.errorPanel} role="alert">
          <p className={styles.errorText}>{uploadError}</p>
          {transferState.retryFile ? (
            <button
              className={styles.tryAgainButton}
              disabled={progress !== null}
              onClick={tryFailedTransferAgain}
              type="button"
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}

      <section className={styles.recentBlock} aria-labelledby="recent-uploads-title">
        <h2 className={styles.sectionTitle} id="recent-uploads-title">
          Recent uploads
        </h2>
        <RecentUploads
          openDeleteSheet={openDeleteSheet}
          retryUpload={retryUpload}
          uploads={uploads}
        />
      </section>

      {deleteTarget ? (
        <VideoDeleteSheet
          error={deleteError}
          isDeleting={isDeleting}
          onCancel={() => {
            if (!isDeleting) {
              setDeleteTarget(null);
            }
          }}
          onConfirm={confirmDeleteVideo}
          target={deleteTarget}
        />
      ) : null}
    </>
  );
}

function ChecklistStep({
  currentStage,
  error,
  step,
}: {
  currentStage: string;
  error: string | null;
  step: (typeof STEPS)[number];
}) {
  const state = checklistState(step.id, currentStage, error);
  const className = `${styles.checkStep} ${styles[`checkStep_${state}`]}`;

  return (
    <div className={className}>
      <span className={styles.checkMark} aria-hidden="true">
        {state === "complete" ? "OK" : state === "failed" ? "!" : state === "active" ? "..." : ""}
      </span>
      <div className={styles.checkCopy}>
        <p className={styles.checkLabel}>{step.label}</p>
        <p className={styles.checkLine}>
          {state === "failed" ? failedStepLine(error) : step.line}
        </p>
      </div>
    </div>
  );
}

function RecentUploads({
  openDeleteSheet,
  uploads,
  retryUpload,
}: {
  openDeleteSheet: (upload: UploadView) => void;
  uploads: UploadView[];
  retryUpload: (videoId: string) => void;
}) {
  if (uploads.length === 0) {
    return <p className={styles.emptyText}>No uploads yet.</p>;
  }

  return (
    <div className={styles.uploadList}>
      {uploads.map((upload) => (
        <article className={styles.uploadRow} key={upload.id}>
          <div className={styles.uploadCopy}>
            <h3 className={styles.uploadTitle}>{upload.label}</h3>
            <p className={styles.uploadMeta}>
              {upload.clipCount} {upload.clipCount === 1 ? "clip" : "clips"}
            </p>
            {upload.pipelineStage === "failed" ? (
              <p className={styles.failureText}>
                Failed at {failedUploadStageLabel(upload.pipelineError)}.
              </p>
            ) : null}
          </div>
          <div className={styles.uploadActions}>
            <span className={styles.statusChip}>
              {uploadStageLabel(upload.pipelineStage)}
            </span>
            {upload.pipelineStage === "failed" ? (
              <button
                className={styles.retryButton}
                onClick={() => retryUpload(upload.id)}
                type="button"
              >
                Retry
              </button>
            ) : null}
            <button
              aria-label={`Remove ${upload.label}`}
              className={styles.removeButton}
              data-testid="remove-upload-button"
              onClick={() => openDeleteSheet(upload)}
              type="button"
            >
              Remove
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function uploadFile(
  file: File,
  onProgress: (progress: UploadProgress) => void,
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.set("file", file, file.name);

    const request = new XMLHttpRequest();
    request.open("POST", "/api/videos/upload");
    request.responseType = "json";
    request.withCredentials = true;
    request.setRequestHeader("X-ClipMind-File-Size", String(file.size));

    request.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : file.size;
      const percent = total > 0 ? Math.min(99, Math.round((event.loaded / total) * 100)) : 0;
      onProgress({
        fileName: file.name,
        loaded: event.loaded,
        total,
        percent,
      });
    };

    request.onload = () => {
      const body = readXhrJson(request);
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(xhrError(body) ?? "Upload failed."));
        return;
      }

      onProgress({
        fileName: file.name,
        loaded: file.size,
        total: file.size,
        percent: 100,
      });
      resolve(body as UploadResponse);
    };

    request.onerror = () => {
      reject(new Error("Upload failed."));
    };
    request.onabort = () => {
      reject(new Error("Upload cancelled."));
    };

    request.send(form);
  });
}

function mergeStatus(
  uploads: UploadView[],
  videoId: string,
  status: StatusResponse,
): UploadView[] {
  return uploads.map((upload) =>
    upload.id === videoId
      ? {
          ...upload,
          status: status.stage,
          pipelineStage: status.stage,
          pipelineError: status.error,
          clipCount: status.clipCount,
        }
      : upload,
  );
}

function checklistState(
  stepId: Exclude<PipelineStage, "failed">,
  currentStage: string,
  error: string | null,
): "complete" | "active" | "pending" | "failed" {
  const failedStage =
    currentStage === "failed" ? failedStageFromPipelineError(error) : null;
  if (failedStage) {
    if (stepId === failedStage) {
      return "failed";
    }

    return stepIndex(stepId) < stepIndex(failedStage) ? "complete" : "pending";
  }

  if (currentStage === "done") {
    return "complete";
  }

  if (stepId === "uploaded" && currentStage === "uploaded") {
    return "complete";
  }

  if (stepId === currentStage) {
    return "active";
  }

  return stepIndex(stepId) < stepIndex(currentStage) ? "complete" : "pending";
}

function isProcessing(stage: string): boolean {
  return stage !== "done" && stage !== "failed";
}

function stepIndex(stage: string | null): number {
  const index = STEPS.findIndex((step) => step.id === stage);
  return index >= 0 ? index : 0;
}

function visibleSteps(includeMindSteps: boolean): typeof STEPS {
  if (includeMindSteps) {
    return STEPS;
  }

  return STEPS.filter((step) => NORMAL_STEP_IDS.has(step.id));
}

function failedStepLine(error: string | null): string {
  const message = errorMessageFromPipeline(error);
  return message || "This step failed.";
}

function errorMessageFromPipeline(error: string | null): string | null {
  const message = error?.includes(":") ? error.slice(error.indexOf(":") + 1) : error;
  return message?.trim() || null;
}

function readXhrJson(request: XMLHttpRequest): { error?: string } | UploadResponse {
  if (request.response && typeof request.response === "object") {
    return request.response as { error?: string } | UploadResponse;
  }

  try {
    return JSON.parse(request.responseText) as { error?: string } | UploadResponse;
  } catch {
    return {};
  }
}

function xhrError(body: { error?: string } | UploadResponse): string | null {
  return "error" in body ? body.error ?? null : null;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 MB";
  }

  const megabytes = bytes / (1024 * 1024);
  if (megabytes < 1024) {
    return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
  }

  const gigabytes = megabytes / 1024;
  return `${gigabytes.toFixed(gigabytes >= 10 ? 0 : 1)} GB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
