import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  CREATOR_ACCESS_COOKIE,
  loadCreatorSessionForAccessCode,
} from "../../../lib/review-auth";
import { loadReviewVideos } from "../../../lib/review";

import styles from "./review.module.css";

const STATUS_LABELS = [
  "candidate",
  "accepted",
  "rejected",
  "scheduled",
  "posted",
] as const;

export default async function ReviewPage() {
  const session = await requireCreatorSession();
  const videos = await loadReviewVideos(session.creatorId);

  return (
    <main className={styles.screen}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Review</p>
          <h1 className={styles.title}>Your videos</h1>
          <p className={styles.muted}>Newest videos are first.</p>
        </header>

        <section className={styles.list}>
          {videos.length === 0 ? (
            <p className={styles.muted}>No videos yet.</p>
          ) : (
            videos.map((video) => (
              <Link
                className={styles.videoCard}
                href={`/review/${video.id}`}
                key={video.id}
              >
                <div className={styles.videoTop}>
                  <div>
                    <h2 className={styles.videoTitle}>
                      {video.sourceUrl ?? video.sourceKey ?? video.id}
                    </h2>
                    <p className={styles.muted}>Status: {video.status}</p>
                  </div>
                  <time className={styles.date}>
                    {formatDate(video.createdAt)}
                  </time>
                </div>

                <div className={styles.counts}>
                  {STATUS_LABELS.map((status) => (
                    <span className={styles.count} key={status}>
                      <span className={styles.countNumber}>
                        {video.counts[status]}
                      </span>
                      <span className={styles.countLabel}>{status}</span>
                    </span>
                  ))}
                </div>

                <span className={styles.open}>Open review</span>
              </Link>
            ))
          )}
        </section>
      </div>
    </main>
  );
}

async function requireCreatorSession() {
  const cookieStore = await cookies();
  const session = await loadCreatorSessionForAccessCode(
    cookieStore.get(CREATOR_ACCESS_COOKIE)?.value,
  );
  if (!session) {
    redirect("/login");
  }

  return session;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
