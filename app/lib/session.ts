import type { PrismaClient } from "@prisma/client";

import {
  appendCreatorSessionCookie,
  CREATOR_ACCESS_COOKIE,
  loadCreatorSessionFromCookieHeader,
} from "./review-auth";
import { SIGNUP_CREATOR_COOKIE } from "./signup";

type SessionApiOptions = {
  prismaClient?: PrismaClient;
};

export function handleLogoutCreatorSession(): Response {
  const response = new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      "Location": "/login",
      "Set-Cookie": cookieHeader(CREATOR_ACCESS_COOKIE, "", {
        maxAge: 0,
        httpOnly: true,
      }),
    },
  });
  response.headers.append(
    "Set-Cookie",
    cookieHeader(SIGNUP_CREATOR_COOKIE, "", {
      maxAge: 0,
      httpOnly: true,
    }),
  );
  return response;
}

export async function handleSessionHeartbeat(
  request: Request,
  options: SessionApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSessionFromCookieHeader(
    request.headers.get("cookie"),
    options,
  );
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  return appendCreatorSessionCookie(
    new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
      },
    }),
    session,
  );
}

export async function handleRevealCreatorAccessCode(
  request: Request,
  options: SessionApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSessionFromCookieHeader(
    request.headers.get("cookie"),
    options,
  );
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  return appendCreatorSessionCookie(
    json(
      {
        accessCode: session.accessCode,
      },
      200,
    ),
    session,
  );
}

function cookieHeader(
  name: string,
  value: string,
  options: {
    maxAge: number;
    httpOnly: boolean;
  },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${options.maxAge}`,
  ];

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function json(payload: unknown, status: number): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
