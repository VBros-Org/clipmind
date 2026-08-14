import type { PipelineStage } from "./upload-status-client";

export type UploadProgress = {
  fileName: string;
  loaded: number;
  total: number;
  percent: number;
};

export type UploadResponse = {
  videoId: string;
  stage: PipelineStage;
  bytes: number;
};

export type MultipartUploadSession = {
  intentId: string;
  status: string;
  fileName: string | null;
  size: number;
  partSizeBytes: number;
  uploadedParts: UploadedPart[];
  videoId: string | null;
};

export type UploadedPart = {
  partNumber: number;
  size: number;
};

export type PlannedUploadPart = {
  partNumber: number;
  start: number;
  end: number;
  size: number;
};

export type UploadFileMultipartOptions = {
  fetchImpl?: FetchLike;
  storage?: StorageLike | null;
  signal?: AbortSignalLike;
  onIntentReady?: (intentId: string) => void;
};

export type UploadFileLike = {
  name: string;
  size: number;
  lastModified: number;
  type: string;
  slice(start?: number, end?: number, contentType?: string): UploadBlobLike;
};

export type UploadBlobLike = {
  size: number;
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type AbortSignalLike = {
  aborted: boolean;
  addEventListener?: (
    event: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ) => void;
  removeEventListener?: (event: "abort", listener: () => void) => void;
};

export type FetchOptions = {
  method?: string;
  credentials?: string;
  cache: "no-store";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignalLike;
};

export type FetchResponseLike = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type FetchLike = (
  input: string,
  init: FetchOptions,
) => Promise<FetchResponseLike>;

type XMLHttpRequestConstructorLike = new () => XMLHttpRequestLike;

type XMLHttpRequestLike = {
  upload: {
    onprogress: ((event: ProgressEventLike) => void) | null;
  };
  status: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  open(method: string, url: string): void;
  abort(): void;
  send(body: unknown): void;
};

type ProgressEventLike = {
  lengthComputable: boolean;
  loaded: number;
};

declare const XMLHttpRequest: XMLHttpRequestConstructorLike;

type ResumeRecord = {
  intentId: string;
  fileName: string;
  size: number;
  lastModified: number;
  type: string;
  updatedAt: string;
};

type ResumeStore = Record<string, ResumeRecord>;

const RESUME_STORAGE_KEY = "clipmind.multipartUploads.v1";
const MAX_PART_ATTEMPTS = 3;

export async function uploadFileMultipart(
  file: UploadFileLike,
  onProgress: (progress: UploadProgress) => void,
  options: UploadFileMultipartOptions = {},
): Promise<UploadResponse> {
  const fetchImpl = options.fetchImpl ?? (fetch as FetchLike);
  const storage = options.storage ?? defaultResumeStorage();
  const session = await resolveMultipartSession(file, fetchImpl, storage, options.signal);
  options.onIntentReady?.(session.intentId);

  const plannedParts = planMultipartUploadParts(file.size, session.partSizeBytes);
  let completedBytes = uploadedBytesForPlannedParts(plannedParts, session.uploadedParts);
  emitProgress(file, completedBytes, onProgress);

  const missingParts = missingMultipartUploadParts(plannedParts, session.uploadedParts);
  for (const part of missingParts) {
    assertNotCancelled(options.signal);
    await uploadPartWithRetry(file, session.intentId, part, fetchImpl, options.signal, (loaded) => {
      emitProgress(file, completedBytes + loaded, onProgress);
    });
    completedBytes += part.size;
    emitProgress(file, completedBytes, onProgress);
  }

  const response = await fetchImpl(
    `/api/videos/uploads/multipart/${session.intentId}/complete`,
    {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      signal: options.signal,
    },
  );
  const body = (await safeJson(response)) as { error?: string } | UploadResponse;
  if (!response.ok) {
    forgetResumeRecord(file, storage);
    throw new Error("error" in body && body.error ? body.error : "Upload failed.");
  }

  forgetResumeRecord(file, storage);
  emitProgress(file, file.size, onProgress);
  return body as UploadResponse;
}

export async function abortMultipartUpload(
  intentId: string,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<void> {
  await fetchImpl(`/api/videos/uploads/multipart/${intentId}/abort`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
  });
}

export function clearMultipartUploadResume(
  file: UploadFileLike,
  storage: StorageLike | null = defaultResumeStorage(),
): void {
  forgetResumeRecord(file, storage);
}

export function planMultipartUploadParts(
  totalBytes: number,
  partSizeBytes: number,
): PlannedUploadPart[] {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    return [];
  }
  if (!Number.isSafeInteger(partSizeBytes) || partSizeBytes <= 0) {
    throw new Error("Multipart part size must be a positive integer.");
  }

  const parts: PlannedUploadPart[] = [];
  for (
    let start = 0, partNumber = 1;
    start < totalBytes;
    start += partSizeBytes, partNumber += 1
  ) {
    const end = Math.min(start + partSizeBytes, totalBytes);
    parts.push({
      partNumber,
      start,
      end,
      size: end - start,
    });
  }

  return parts;
}

export function missingMultipartUploadParts(
  plannedParts: PlannedUploadPart[],
  uploadedParts: UploadedPart[],
): PlannedUploadPart[] {
  const uploaded = uploadedPartNumberSet(plannedParts, uploadedParts);
  return plannedParts.filter((part) => !uploaded.has(part.partNumber));
}

export function uploadedBytesForPlannedParts(
  plannedParts: PlannedUploadPart[],
  uploadedParts: UploadedPart[],
): number {
  const uploaded = uploadedPartNumberSet(plannedParts, uploadedParts);
  return plannedParts
    .filter((part) => uploaded.has(part.partNumber))
    .reduce((sum, part) => sum + part.size, 0);
}

export function isUploadCancelledError(error: unknown): boolean {
  return (
    error instanceof UploadCancelledError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError")
  );
}

async function resolveMultipartSession(
  file: UploadFileLike,
  fetchImpl: FetchLike,
  storage: StorageLike | null,
  signal: AbortSignalLike | undefined,
): Promise<MultipartUploadSession> {
  const stored = readResumeRecord(file, storage);
  if (stored) {
    const session = await fetchMultipartSession(stored.intentId, fetchImpl, signal).catch(
      () => null,
    );
    if (session?.status === "uploading" && session.size === file.size) {
      return session;
    }
    forgetResumeRecord(file, storage);
  }

  const session = await createMultipartSession(file, fetchImpl, signal);
  writeResumeRecord(file, session.intentId, storage);
  return session;
}

async function createMultipartSession(
  file: UploadFileLike,
  fetchImpl: FetchLike,
  signal: AbortSignalLike | undefined,
): Promise<MultipartUploadSession> {
  const response = await fetchImpl("/api/videos/uploads/multipart", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "video/mp4",
      size: file.size,
    }),
    signal,
  });
  const body = (await safeJson(response)) as { error?: string } | MultipartUploadSession;
  if (!response.ok) {
    throw new Error("error" in body && body.error ? body.error : "Upload failed.");
  }

  return body as MultipartUploadSession;
}

async function fetchMultipartSession(
  intentId: string,
  fetchImpl: FetchLike,
  signal: AbortSignalLike | undefined,
): Promise<MultipartUploadSession> {
  const response = await fetchImpl(`/api/videos/uploads/multipart/${intentId}`, {
    credentials: "include",
    cache: "no-store",
    signal,
  });
  const body = (await safeJson(response)) as { error?: string } | MultipartUploadSession;
  if (!response.ok) {
    throw new Error("error" in body && body.error ? body.error : "Upload failed.");
  }

  return body as MultipartUploadSession;
}

async function uploadPartWithRetry(
  file: UploadFileLike,
  intentId: string,
  part: PlannedUploadPart,
  fetchImpl: FetchLike,
  signal: AbortSignalLike | undefined,
  onPartProgress: (loaded: number) => void,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt += 1) {
    assertNotCancelled(signal);
    try {
      const signedUrl = await signUploadPart(intentId, part.partNumber, fetchImpl, signal);
      const blob = file.slice(part.start, part.end, file.type || "video/mp4");
      await putPart(signedUrl, blob, signal, onPartProgress);
      return;
    } catch (error) {
      if (isUploadCancelledError(error) || signal?.aborted) {
        throw new UploadCancelledError();
      }
      lastError = error;
    }
  }

  throw new Error(
    `Upload failed on part ${part.partNumber}: ${errorMessage(lastError)}`,
  );
}

async function signUploadPart(
  intentId: string,
  partNumber: number,
  fetchImpl: FetchLike,
  signal: AbortSignalLike | undefined,
): Promise<string> {
  const response = await fetchImpl(`/api/videos/uploads/multipart/${intentId}/sign`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      partNumbers: [partNumber],
    }),
    signal,
  });
  const body = (await safeJson(response)) as
    | { error?: string }
    | { urls?: Array<{ partNumber: number; url: string }> };
  if (!response.ok) {
    throw new Error("error" in body && body.error ? body.error : "Upload failed.");
  }

  const url =
    "urls" in body
      ? body.urls?.find((item) => item.partNumber === partNumber)?.url
      : null;
  if (!url) {
    throw new Error("Upload part was not signed.");
  }

  return url;
}

function putPart(
  signedUrl: string,
  blob: UploadBlobLike,
  signal: AbortSignalLike | undefined,
  onPartProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => {
      request.abort();
      reject(new UploadCancelledError());
    };

    request.open("PUT", signedUrl);
    request.upload.onprogress = (event) => {
      onPartProgress(event.lengthComputable ? event.loaded : 0);
    };
    request.onload = () => {
      signal?.removeEventListener?.("abort", abort);
      if (request.status >= 200 && request.status < 300) {
        onPartProgress(blob.size);
        resolve();
        return;
      }
      reject(new Error(`R2 part upload failed with HTTP ${request.status}.`));
    };
    request.onerror = () => {
      signal?.removeEventListener?.("abort", abort);
      reject(new Error("R2 part upload failed."));
    };
    request.onabort = () => {
      signal?.removeEventListener?.("abort", abort);
      reject(new UploadCancelledError());
    };

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener?.("abort", abort, { once: true });
    request.send(blob);
  });
}

function uploadedPartNumberSet(
  plannedParts: PlannedUploadPart[],
  uploadedParts: UploadedPart[],
): Set<number> {
  const expectedSizes = new Map(
    plannedParts.map((part) => [part.partNumber, part.size]),
  );
  const uploaded = new Set<number>();
  for (const part of uploadedParts) {
    if (expectedSizes.get(part.partNumber) === part.size) {
      uploaded.add(part.partNumber);
    }
  }

  return uploaded;
}

function emitProgress(
  file: UploadFileLike,
  loaded: number,
  onProgress: (progress: UploadProgress) => void,
): void {
  const safeLoaded = Math.max(0, Math.min(file.size, loaded));
  onProgress({
    fileName: file.name,
    loaded: safeLoaded,
    total: file.size,
    percent:
      file.size > 0 ? Math.min(100, Math.round((safeLoaded / file.size) * 100)) : 0,
  });
}

function readResumeRecord(
  file: UploadFileLike,
  storage: StorageLike | null,
): ResumeRecord | null {
  const store = readResumeStore(storage);
  const record = store[fileSignature(file)];
  if (!record || record.size !== file.size || record.lastModified !== file.lastModified) {
    return null;
  }

  return record;
}

function writeResumeRecord(
  file: UploadFileLike,
  intentId: string,
  storage: StorageLike | null,
): void {
  if (!storage) {
    return;
  }

  const store = readResumeStore(storage);
  store[fileSignature(file)] = {
    intentId,
    fileName: file.name,
    size: file.size,
    lastModified: file.lastModified,
    type: file.type,
    updatedAt: new Date().toISOString(),
  };
  storage.setItem(RESUME_STORAGE_KEY, JSON.stringify(store));
}

function forgetResumeRecord(
  file: UploadFileLike,
  storage: StorageLike | null,
): void {
  if (!storage) {
    return;
  }

  const store = readResumeStore(storage);
  delete store[fileSignature(file)];
  storage.setItem(RESUME_STORAGE_KEY, JSON.stringify(store));
}

function readResumeStore(storage: StorageLike | null): ResumeStore {
  if (!storage) {
    return {};
  }

  const raw = storage.getItem(RESUME_STORAGE_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ResumeStore)
      : {};
  } catch {
    return {};
  }
}

function fileSignature(file: UploadFileLike): string {
  return [file.name, file.size, file.lastModified, file.type].join(":");
}

async function safeJson(response: FetchResponseLike): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function assertNotCancelled(signal: AbortSignalLike | undefined): void {
  if (signal?.aborted) {
    throw new UploadCancelledError();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled.");
  }
}

function defaultResumeStorage(): StorageLike | null {
  const candidate = globalThis as typeof globalThis & {
    localStorage?: StorageLike;
  };
  return candidate.localStorage ?? null;
}
