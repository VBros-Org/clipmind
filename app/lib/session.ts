import { CREATOR_ACCESS_COOKIE } from "./review-auth";

export function handleLogoutCreatorSession(): Response {
  return new Response(null, {
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
