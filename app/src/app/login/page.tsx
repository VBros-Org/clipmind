import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  CREATOR_ACCESS_COOKIE,
  CREATOR_ACCESS_COOKIE_MAX_AGE_SECONDS,
  loadCreatorSessionForAccessCode,
  normalizeAccessCode,
} from "../../../lib/review-auth";

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
