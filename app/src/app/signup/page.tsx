import { cookies } from "next/headers";

import { CREATOR_ACCESS_COOKIE } from "../../../lib/review-auth";
import { loadSignedInSignupAffordance } from "../../../lib/signup-page";
import { logoutCreator } from "../session-actions";

import { SignupFlow } from "./SignupFlow";
import styles from "./signup.module.css";

export default async function SignupPage() {
  const cookieStore = await cookies();
  const accessCookie = cookieStore.get(CREATOR_ACCESS_COOKIE)?.value;
  const signedIn = await loadSignedInSignupAffordance(
    accessCookie
      ? `${CREATOR_ACCESS_COOKIE}=${encodeURIComponent(accessCookie)}`
      : null,
  );

  return (
    <main className={styles.screen}>
      {signedIn ? (
        <section className={styles.panel} aria-labelledby="signup-title">
          <p className={styles.eyebrow}>Invite signup</p>
          <h1 className={styles.title} id="signup-title">
            Create your ClipMind
          </h1>
          <div className={styles.signedInCard}>
            <p className={styles.signedInMessage}>{signedIn.message}</p>
            <form action={logoutCreator}>
              <button className={styles.secondaryButton} type="submit">
                Log out
              </button>
            </form>
          </div>
        </section>
      ) : (
        <SignupFlow />
      )}
    </main>
  );
}
