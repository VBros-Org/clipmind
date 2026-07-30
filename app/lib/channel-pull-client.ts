import type {
  ChannelPullStage,
  ChannelPullStatusView,
} from "./channel-pull-status";

export type StartChannelPullResult = ChannelPullStatusView & {
  channelUrl: string | null;
};

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json">>;

export async function startChannelPull(
  channelUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<StartChannelPullResult> {
  const response = await fetchImpl("/api/voice/channel-pull", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channelUrl,
    }),
  });
  const body = (await response.json().catch(() => null)) as
    | (Partial<StartChannelPullResult> & { error?: string })
    | null;

  if (!response.ok) {
    throw new Error(body?.error ?? "Recent video pull could not start.");
  }

  return {
    stage: (body?.stage ?? "listing") as ChannelPullStage,
    error: body?.error ?? null,
    errorCode: body?.errorCode ?? null,
    channelUrl: body?.channelUrl ?? null,
  };
}

export async function fetchChannelPullStatus(
  fetchImpl: FetchLike = fetch,
): Promise<ChannelPullStatusView | null> {
  const response = await fetchImpl("/api/voice/channel-pull", {
    cache: "no-store",
  });
  if (!response.ok) {
    return null;
  }

  const body = (await response.json().catch(() => null)) as
    | Partial<ChannelPullStatusView>
    | null;
  return {
    stage: (body?.stage ?? null) as ChannelPullStage | null,
    error: body?.error ?? null,
    errorCode: body?.errorCode ?? null,
  };
}
