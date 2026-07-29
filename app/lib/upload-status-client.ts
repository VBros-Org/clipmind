export type PipelineStage =
  | "learning_voice"
  | "waking_mind"
  | "teaching_taste"
  | "uploaded"
  | "transcribing"
  | "candidates"
  | "ranking"
  | "captions"
  | "done"
  | "failed";

export type UploadView = {
  id: string;
  label: string;
  status: string;
  pipelineStage: string;
  pipelineError: string | null;
  createdAtIso: string;
  clipCount: number;
};

export type StatusResponse = {
  stage: PipelineStage;
  error: string | null;
  failedStage: PipelineStage | null;
  clipCount: number;
};

export type FetchOptions = {
  method?: string;
  cache: "no-store";
};

type FetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

type FetchLike = (input: string, init: FetchOptions) => Promise<FetchResponse>;

export type RetryUploadResult =
  | {
      outcome: "retrying";
      stage: PipelineStage;
    }
  | {
      outcome: "refetched";
      status: StatusResponse;
    }
  | {
      outcome: "error";
      message: string;
      status: StatusResponse | null;
    };

export const STATUS_FETCH_OPTIONS: FetchOptions = {
  cache: "no-store",
};

export const RETRY_FETCH_OPTIONS: FetchOptions = {
  method: "POST",
  cache: "no-store",
};

export async function fetchRecentUploads(
  fetchImpl: FetchLike = fetch,
): Promise<UploadView[] | null> {
  const response = await fetchImpl("/api/videos/recent", STATUS_FETCH_OPTIONS);
  if (!response.ok) {
    return null;
  }

  const body = (await response.json().catch(() => null)) as
    | { uploads?: UploadView[] }
    | null;

  return Array.isArray(body?.uploads) ? body.uploads : null;
}

export async function fetchVideoStatus(
  videoId: string,
  fetchImpl: FetchLike = fetch,
): Promise<StatusResponse | null> {
  const response = await fetchImpl(
    `/api/videos/${videoId}/status`,
    STATUS_FETCH_OPTIONS,
  );

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as StatusResponse;
}

export async function retryUploadAndRefreshStatus(
  videoId: string,
  fetchImpl: FetchLike = fetch,
): Promise<RetryUploadResult> {
  const response = await fetchImpl(
    `/api/videos/${videoId}/retry`,
    RETRY_FETCH_OPTIONS,
  );
  const body = (await response.json().catch(() => null)) as
    | { stage?: PipelineStage; error?: string }
    | null;

  if (response.ok) {
    return {
      outcome: "retrying",
      stage: body?.stage ?? "transcribing",
    };
  }

  if (response.status === 409) {
    const status = await fetchVideoStatus(videoId, fetchImpl);
    if (status) {
      return {
        outcome: "refetched",
        status,
      };
    }
  }

  return {
    outcome: "error",
    message: body?.error ?? "Retry failed.",
    status: null,
  };
}
