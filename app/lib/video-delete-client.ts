export const POSTED_HISTORY_DELETE_MESSAGE =
  "This video has posted clips. Posted history cannot be deleted.";

export type DeleteVideoResponse = {
  videoId: string;
  deleted: {
    videos: number;
    clips: number;
    learningEvents: number;
    objects: number;
  };
};

export type DeleteVideoResult =
  | {
      outcome: "deleted";
      response: DeleteVideoResponse;
    }
  | {
      outcome: "posted_guard";
      message: string;
    }
  | {
      outcome: "error";
      message: string;
    };

type DeleteVideoErrorBody = {
  error?: string;
  reason?: string;
};

type FetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

type FetchLike = (
  input: string,
  init: {
    method: "DELETE";
    cache: "no-store";
  },
) => Promise<FetchResponse>;

export async function deleteVideo(
  videoId: string,
  fetchImpl: FetchLike = fetch,
): Promise<DeleteVideoResult> {
  const response = await fetchImpl(`/api/videos/${videoId}`, {
    method: "DELETE",
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as
    | DeleteVideoErrorBody
    | DeleteVideoResponse
    | null;

  if (response.ok) {
    return {
      outcome: "deleted",
      response: body as DeleteVideoResponse,
    };
  }

  if (
    response.status === 409 &&
    isDeleteVideoErrorBody(body) &&
    body.reason === "posted history"
  ) {
    return {
      outcome: "posted_guard",
      message: body.error ?? POSTED_HISTORY_DELETE_MESSAGE,
    };
  }

  return {
    outcome: "error",
    message:
      isDeleteVideoErrorBody(body) && body.error ? body.error : "Delete failed.",
  };
}

function isDeleteVideoErrorBody(
  body: DeleteVideoErrorBody | DeleteVideoResponse | null,
): body is DeleteVideoErrorBody {
  return Boolean(
    body &&
      typeof body === "object" &&
      ("error" in body || "reason" in body),
  );
}
