import Link from "next/link";

import { loadHomeOverview } from "../../../lib/app-overview";
import { AppShell } from "../AppShell";
import { requireCreatorSession } from "../app-session";

import { HomeVisibilityRefresh } from "./HomeVisibilityRefresh";
import { HomeNudges } from "./HomeNudges";
import { PostedWinLine } from "./PostedWinLine";
import { PushHealthCard } from "./PushHealthCard";
import {
  ReadyToPostRow,
  type ReadyToPostClipView,
} from "./ReadyToPostRow";
import styles from "./home.module.css";

type HomePageProps = {
  searchParams?: Promise<{
    post?: string;
  }>;
};

export default async function HomePage({ searchParams }: HomePageProps) {
  const session = await requireCreatorSession();
  const params = (await searchParams) ?? {};
  const overview = await loadHomeOverview(session.creatorId);

  return (
    <AppShell
      activeTab="home"
      pushNudgesEnabled={overview.pushNudgesEnabled}
      reviewCount={overview.reviewCount}
    >
      <HomeVisibilityRefresh />
      <section className={styles.stack}>
        <PostedWinLine postedThisWeek={overview.stats.postedThisWeek} />
        <RunwayHero runway={overview.runway} />
        <PushHealthCard pushNudgesEnabled={overview.pushNudgesEnabled} />
        {overview.nextUp ? <NextUpCard nextUp={overview.nextUp} /> : null}
        <HomeNudges nudges={overview.nudges} />
        <ReadyToPostRow
          clips={overview.readyToPost.map(serializeReadyClip)}
          uploadCards={overview.uploadCards}
          initialClipId={params.post ?? null}
        />
        <footer className={styles.stats} aria-label="Clip stats">
          <span>{formatClipStat(overview.stats.totalPosted, "posted")}</span>
          <span>{formatClipStat(overview.stats.totalClipsMade, "made")}</span>
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

  if (runway.tone === "refill") {
    return (
      <Link
        aria-labelledby="runway-title"
        className={`${styles.runwayHero} ${styles.refill} ${styles.runwayHeroLink}`}
        data-testid="runway-hero"
        href="/upload"
      >
        <p className={styles.runwayNumber} id="runway-title">
          0
        </p>
        <p className={styles.runwayLabel}>Refill your runway</p>
        <span className={styles.runwayAction}>Add a long video</span>
      </Link>
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
      <p className={styles.runwayLabel}>
        {formatRunwayDays(runway.days) === "1" ? "day of posts left" : "days of posts left"}
      </p>
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
        {nextUp.thumbUrl ? (
          <img alt="" className={styles.nextImage} src={nextUp.thumbUrl} />
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

function serializeReadyClip(
  clip: Awaited<ReturnType<typeof loadHomeOverview>>["readyToPost"][number],
): ReadyToPostClipView {
  return {
    id: clip.id,
    videoId: clip.videoId,
    renderedUrl: clip.renderedUrl,
    thumbUrl: clip.thumbUrl,
    scheduledForIso: clip.scheduledForIso,
    postCopyVariants: clip.postCopyVariants,
    label: clip.label,
  };
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

function formatClipStat(count: number, verb: "posted" | "made"): string {
  return `${count} ${count === 1 ? "clip" : "clips"} ${verb}`;
}
