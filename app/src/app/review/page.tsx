import { loadAppFrameData } from "../../../lib/app-overview";
import { loadReviewGroups, type ReviewVideoGroup } from "../../../lib/review";
import { formatVideoLabel } from "../../../lib/video-label";
import { AppShell } from "../AppShell";
import { requireCreatorSession } from "../app-session";

import {
  ReviewBoard,
  type ReviewClipView,
  type ReviewVideoGroupView,
} from "./ReviewBoard";
import styles from "./review.module.css";

type ReviewPageProps = {
  searchParams?: Promise<{
    clip?: string;
  }>;
};

export default async function ReviewPage({ searchParams }: ReviewPageProps) {
  const session = await requireCreatorSession();
  const params = (await searchParams) ?? {};
  const [frame, groups] = await Promise.all([
    loadAppFrameData(session.creatorId),
    loadReviewGroups(session.creatorId),
  ]);

  return (
    <AppShell activeTab="review" reviewCount={frame.reviewCount}>
      <section className={styles.pageStack}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Review</p>
          <h1 className={styles.title}>Judge clips</h1>
          <p className={styles.subhead}>Clips are ordered by Mind rank.</p>
        </header>
        <ReviewBoard
          groups={groups.map(serializeGroup)}
          initialClipId={params.clip ?? null}
        />
      </section>
    </AppShell>
  );
}

function serializeGroup(group: ReviewVideoGroup): ReviewVideoGroupView {
  return {
    id: group.id,
    title: formatVideoLabel(group.createdAt),
    status: group.status,
    createdAt: group.createdAt.toISOString(),
    totalClips: group.totalClips,
    clips: group.clips.map(serializeClip),
  };
}

function serializeClip(clip: ReviewVideoGroup["clips"][number]): ReviewClipView {
  return {
    id: clip.id,
    videoId: clip.videoId,
    status: clip.status,
    startMs: clip.startMs,
    endMs: clip.endMs,
    renderedUrl: clip.renderedUrl,
    postCopyVariants: clip.postCopyVariants,
    transcript: clip.transcript,
    mindRank: clip.mindRank,
    mindRankReason: clip.mindRankReason,
    createdAt: clip.createdAt.toISOString(),
  };
}
