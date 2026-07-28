import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import {
  CREATOR_ACCESS_COOKIE,
  loadCreatorSessionForAccessCode,
} from "../../../../lib/review-auth";
import { loadReviewVideo } from "../../../../lib/review";

import { ReviewClipList, type ReviewClipView } from "./ReviewClipList";
import styles from "./video.module.css";

type ReviewVideoPageProps = {
  params: Promise<{
    videoId: string;
  }>;
};

export default async function ReviewVideoPage({ params }: ReviewVideoPageProps) {
  const session = await requireCreatorSession();
  const { videoId } = await params;
  const video = await loadReviewVideo(session.creatorId, videoId);
  if (!video) {
    notFound();
  }

  return (
    <main className={styles.screen}>
      <div className={styles.shell}>
        <nav className={styles.topBar}>
          <Link className={styles.back} href="/review">
            Back to videos
          </Link>
        </nav>

        <header>
          <h1 className={styles.title}>
            {video.sourceUrl ?? video.sourceKey ?? video.id}
          </h1>
          <p className={styles.subhead}>
            Candidate clips are ordered by Mind rank.
          </p>
        </header>

        <ReviewClipList
          clips={video.clips.map(serializeClip)}
          previewSourceUrl={video.previewSourceUrl}
        />
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

function serializeClip(clip: {
  id: string;
  status: ReviewClipView["status"];
  startMs: number;
  endMs: number;
  renderedUrl: string | null;
  postCopyVariants: ReviewClipView["postCopyVariants"];
  transcript: string | null;
  mindRank: number | null;
  mindRankReason: string | null;
  createdAt: Date;
}): ReviewClipView {
  return {
    id: clip.id,
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
