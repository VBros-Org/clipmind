import { createSign } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import type { DueNudge } from "./nudges";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_AUDIENCE = "https://oauth2.googleapis.com/token";

type PushOptions = {
  prismaClient?: PushDbClient;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: Date;
};

type PushDbClient = PrismaClient | Prisma.TransactionClient;

export type PushSendResult = {
  creatorId: string;
  attempted: number;
  sent: number;
  disabled: number;
  failures: PushSendFailure[];
  messageIds: string[];
};

export type PushSendFailure = {
  tokenId: string;
  status: number;
  errorCode: string | null;
};

type FcmAccessToken = {
  accessToken: string;
  expiresAtMs: number;
};

type FcmEnv = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

type FcmSendResponse =
  | {
      status: "sent";
      messageId: string;
    }
  | {
      status: "invalid";
      statusCode: number;
      errorCode: string | null;
    }
  | {
      status: "failed";
      statusCode: number;
      errorCode: string | null;
    };

let cachedAccessToken: FcmAccessToken | null = null;

export function resetFcmAccessTokenCacheForTests(): void {
  cachedAccessToken = null;
}

export async function sendPushNudgeToCreator(
  creatorId: string,
  nudge: DueNudge,
  options: PushOptions = {},
): Promise<PushSendResult> {
  const db = options.prismaClient ?? prisma;
  const subscriptions = await db.pushSubscription.findMany({
    where: {
      creatorId,
      disabledAt: null,
    },
    orderBy: {
      createdAt: "asc",
    },
    select: {
      id: true,
      token: true,
    },
  });

  const result: PushSendResult = {
    creatorId,
    attempted: subscriptions.length,
    sent: 0,
    disabled: 0,
    failures: [],
    messageIds: [],
  };

  if (subscriptions.length === 0) {
    return result;
  }

  const env = requireFcmEnv(options.env);
  const accessToken = await getFcmAccessToken(env, options);
  const now = options.now ?? new Date();

  for (const subscription of subscriptions) {
    let response: FcmSendResponse;
    try {
      response = await sendFcmMessage(subscription.token, nudge, env, {
        ...options,
        accessToken,
      });
    } catch (error) {
      result.failures.push({
        tokenId: subscription.id,
        status: 0,
        errorCode: shortErrorMessage(error),
      });
      continue;
    }

    if (response.status === "sent") {
      result.sent += 1;
      result.messageIds.push(response.messageId);
      continue;
    }

    result.failures.push({
      tokenId: subscription.id,
      status: response.statusCode,
      errorCode: response.errorCode,
    });

    if (response.status === "invalid") {
      await db.pushSubscription.update({
        where: {
          id: subscription.id,
        },
        data: {
          disabledAt: now,
        },
      });
      result.disabled += 1;
    }
  }

  return result;
}

export function requireFcmEnv(
  source: Record<string, string | undefined> = process.env,
): FcmEnv {
  const projectId = clean(source.FCM_PROJECT_ID);
  const clientEmail = clean(source.FCM_CLIENT_EMAIL);
  const privateKey = clean(source.FCM_PRIVATE_KEY)?.replace(/\\n/g, "\n");
  const missing = [
    ["FCM_PROJECT_ID", projectId],
    ["FCM_CLIENT_EMAIL", clientEmail],
    ["FCM_PRIVATE_KEY", privateKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`FCM env missing required variables: ${missing.join(", ")}.`);
  }

  return {
    projectId: projectId as string,
    clientEmail: clientEmail as string,
    privateKey: privateKey as string,
  };
}

async function getFcmAccessToken(
  env: FcmEnv,
  options: PushOptions,
): Promise<string> {
  const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  const nowMs = nowSeconds * 1000;

  if (cachedAccessToken && cachedAccessToken.expiresAtMs - 60_000 > nowMs) {
    return cachedAccessToken.accessToken;
  }

  const assertion = signServiceAccountJwt(env, nowSeconds);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(TOKEN_AUDIENCE, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const body = (await response.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;

  if (!response.ok || !body?.access_token) {
    throw new Error(`FCM OAuth token exchange failed with ${response.status}.`);
  }

  cachedAccessToken = {
    accessToken: body.access_token,
    expiresAtMs: nowMs + (body.expires_in ?? 3600) * 1000,
  };

  return body.access_token;
}

function signServiceAccountJwt(env: FcmEnv, nowSeconds: number): string {
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const claims = {
    iss: env.clientEmail,
    scope: FCM_SCOPE,
    aud: TOKEN_AUDIENCE,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(claims)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();

  return `${signingInput}.${signer.sign(env.privateKey, "base64url")}`;
}

async function sendFcmMessage(
  token: string,
  nudge: DueNudge,
  env: FcmEnv,
  options: PushOptions & { accessToken: string },
): Promise<FcmSendResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(
      env.projectId,
    )}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          data: stringifyData({
            ...nudge.data,
            title: nudge.notificationTitle,
            body: nudge.body,
          }),
          webpush: {
            headers: {
              TTL: "3600",
              Urgency: "normal",
            },
          },
        },
      }),
    },
  );

  const body = (await response.json().catch(() => null)) as unknown;

  if (response.ok) {
    const messageId =
      isRecord(body) && typeof body.name === "string" ? body.name : "";
    return {
      status: "sent",
      messageId,
    };
  }

  const errorCode = fcmErrorCode(body);
  if (isInvalidTokenError(response.status, errorCode)) {
    return {
      status: "invalid",
      statusCode: response.status,
      errorCode,
    };
  }

  return {
    status: "failed",
    statusCode: response.status,
    errorCode,
  };
}

function isInvalidTokenError(status: number, errorCode: string | null): boolean {
  if (errorCode === "INVALID_ARGUMENT") {
    return false;
  }

  return errorCode === "UNREGISTERED" || status === 404;
}

function fcmErrorCode(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) {
    return null;
  }

  const details = body.error.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (isRecord(detail) && typeof detail.errorCode === "string") {
        return detail.errorCode;
      }
    }
  }

  return typeof body.error.status === "string" ? body.error.status : null;
}

function stringifyData(
  data: Record<string, string | number | boolean | null | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message || "Unknown error.").replace(/\s+/g, " ").slice(0, 120);
}
