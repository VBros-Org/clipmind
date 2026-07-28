import Link from "next/link";

import { InstallPrompt } from "../components/InstallPrompt";

import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.screen}>
      <section className={styles.hero} aria-labelledby="landing-title">
        <img
          alt=""
          className={styles.icon}
          height="112"
          src="/icons/clipmind-192.png"
          width="112"
        />
        <div className={styles.copy}>
          <h1 className={styles.title} id="landing-title">
            ClipMind
          </h1>
          <p className={styles.line}>
            Upload a long video. ClipMind ranks the clips, writes captions in
            your voice, and you tap post.
          </p>
        </div>
        <div className={styles.actions}>
          <InstallPrompt placement="landing" />
          <Link className={styles.signupLink} href="/signup">
            Have an invite? Create your ClipMind
          </Link>
          <Link className={styles.loginLink} href="/login">
            Log in
          </Link>
        </div>
      </section>
    </main>
  );
}
