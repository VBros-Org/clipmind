import Link from "next/link";

import { loadHomeOverview } from "../../../lib/app-overview";
import { AppShell } from "../AppShell";
import { requireCreatorSession } from "../app-session";

import { HomeNudges } from "./HomeNudges";
import styles from "./home.module.css";

export default async function HomePage() {
  const session = await requireCreatorSession();
  const overview = await loadHomeOverview(session.creatorId);

  return (
    <AppShell activeTab="home" reviewCount={overview.reviewCount}>
      <section className={styles.stack}>
        <RunwayHero runway={overview.runway} />
        {overview.nextUp ? <NextUpCard nextUp={overview.nextUp} /> : null}
        <HomeNudges nudges={overview.nudges} />
        <footer className={styles.stats} aria-label="Clip stats">
          <span>{overview.stats.totalPosted} posted</span>
          <span>{overview.stats.totalClipsMade} clips made</span>
        </footer>
      </section>
    </AppShell>
  );
}

function RunwayHero({
  runway,
}: {
  runway: Awaited<ReturnType<typeof loadHomeOverview>>["runway"];
}) {
  if (runway.kind === "needs_schedule") {
    return (
      <section
        className={styles.runwayHero}
        aria-labelledby="runway-title"
        data-testid="runway-hero"
      >
        <p className={styles.runwayNumber} id="runway-title">
          {runway.clipCount}
        </p>
        <p className={styles.runwayLabel}>
          {runway.clipCount === 1 ? "clip ready" : "clips ready"}
        </p>
        <Link className={styles.runwayLink} href="/rhythm">
          set your rhythm to see runway
        </Link>
      </section>
    );
  }

  return (
    <section
      className={`${styles.runwayHero} ${styles[runway.tone]}`}
      aria-labelledby="runway-title"
      data-testid="runway-hero"
    >
      <p className={styles.runwayNumber} id="runway-title">
        {formatRunwayDays(runway.days)}
      </p>
      <p className={styles.runwayLabel}>days of posts left</p>
    </section>
  );
}

function NextUpCard({
  nextUp,
}: {
  nextUp: Awaited<ReturnType<typeof loadHomeOverview>>["nextUp"];
}) {
  if (!nextUp) {
    return null;
  }

  return (
    <section className={styles.nextUp} aria-labelledby="next-up-title">
      <div className={styles.nextThumb} aria-hidden="true">
        {nextUp.renderedUrl ? (
          <video
            className={styles.nextVideo}
            muted
            playsInline
            preload="metadata"
            src={nextUp.renderedUrl}
          />
        ) : (
          <div className={styles.poster}>Scheduled</div>
        )}
      </div>
      <div className={styles.nextCopy}>
        <p className={styles.sectionLabel}>Next up</p>
        <h2 className={styles.nextTitle} id="next-up-title">
          {nextUp.label}
        </h2>
        <time className={styles.nextTime} dateTime={nextUp.scheduledForIso}>
          {formatScheduledTime(nextUp.scheduledForIso)}
        </time>
        <p className={styles.captionState}>
          {nextUp.hasCaptions ? "Captions ready" : "Captions pending"}
        </p>
        <Link className={styles.openClip} href={`/review?clip=${nextUp.id}`}>
          Open clip
        </Link>
      </div>
    </section>
  );
}

function formatRunwayDays(days: number): string {
  if (Number.isInteger(days)) {
    return String(days);
  }

  if (days < 10) {
    return days.toFixed(1);
  }

  return String(Math.round(days));
}

function formatScheduledTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Time not set";
  }

  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
