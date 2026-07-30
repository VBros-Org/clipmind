import Link from "next/link";
import { notFound } from "next/navigation";

import { loadAppFrameData } from "../../../../lib/app-overview";
import { loadReviewGroup, type ReviewVideoGroup } from "../../../../lib/review";
import { formatVideoLabel } from "../../../../lib/video-label";
import { AppShell } from "../../AppShell";
import { requireCreatorSession } from "../../app-session";
import {
  ReviewBoard,
  type ReviewClipView,
  type ReviewVideoGroupView,
} from "../ReviewBoard";
import styles from "../review.module.css";

type ReviewVideoPageProps = {
  params: Promise<{
    videoId: string;
  }>;
};

export default async function ReviewVideoPage({ params }: ReviewVideoPageProps) {
  const session = await requireCreatorSession();
  const { videoId } = await params;
  const [frame, group] = await Promise.all([
    loadAppFrameData(session.creatorId),
    loadReviewGroup(session.creatorId, videoId),
  ]);

  if (!group) {
    notFound();
  }

  return (
    <AppShell
      activeTab="review"
      pushNudgesEnabled={frame.pushNudgesEnabled}
      reviewCount={frame.reviewCount}
    >
      <section className={styles.pageStack}>
        <header className={styles.header}>
          <Link className={styles.emptyAction} href="/review">
            Back to Review
          </Link>
          <p className={styles.eyebrow}>Review</p>
          <h1 className={styles.title}>{formatVideoLabel(group.createdAt)}</h1>
          <p className={styles.subhead}>Clips are ordered by Mind rank.</p>
        </header>
        <ReviewBoard groups={[serializeGroup(group)]} />
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
    thumbUrl: clip.thumbUrl,
    postCopyVariants: clip.postCopyVariants,
    transcript: clip.transcript,
    mindRank: clip.mindRank,
    mindRankReason: clip.mindRankReason,
    rejectReason: clip.rejectReason,
    createdAt: clip.createdAt.toISOString(),
  };
}
