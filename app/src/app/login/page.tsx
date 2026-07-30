import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { prisma } from "../../../lib/db";
import {
  CREATOR_ACCESS_COOKIE,
  CREATOR_ACCESS_COOKIE_MAX_AGE_SECONDS,
  loadCreatorSessionForAccessCode,
  normalizeAccessCode,
} from "../../../lib/review-auth";
import { normalizeCreatorTimezone } from "../../../lib/timezone";
import { TimezoneInput } from "../TimezoneInput";

import styles from "./login.module.css";

type LoginPageProps = {
  searchParams?: Promise<{
    error?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = (await searchParams) ?? {};

  return (
    <main className={styles.screen}>
      <section className={styles.panel}>
        <h1 className={styles.title}>ClipMind</h1>
        <p className={styles.copy}>Enter your creator code to open ClipMind.</p>
        <form action={loginCreator} className={styles.form}>
          <TimezoneInput />
          <label className={styles.label}>
            Creator code
            <input
              className={styles.input}
              name="accessCode"
              autoComplete="one-time-code"
              inputMode="text"
              required
            />
          </label>
          {params.error ? (
            <p className={styles.error}>That code did not work.</p>
          ) : null}
          <button className={styles.button} type="submit">
            Continue
          </button>
        </form>
      </section>
    </main>
  );
}

async function loginCreator(formData: FormData) {
  "use server";

  const accessCode = normalizeAccessCode(String(formData.get("accessCode") ?? ""));
  const session = await loadCreatorSessionForAccessCode(accessCode);
  if (!session) {
    redirect("/login?error=1");
  }

  const timezone = normalizeCreatorTimezone(String(formData.get("timezone") ?? ""));
  if (timezone) {
    await prisma.creator.update({
      where: {
        id: session.creatorId,
      },
      data: {
        timezone,
      },
    });
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: CREATOR_ACCESS_COOKIE,
    value: session.accessCode,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: CREATOR_ACCESS_COOKIE_MAX_AGE_SECONDS,
  });

  redirect("/home");
}
