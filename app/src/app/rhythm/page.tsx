import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { loadAppFrameData, loadRhythmOverview } from "../../../lib/app-overview";
import { channelPullStatusResponse } from "../../../lib/channelPull";
import { CREATOR_ACCESS_COOKIE } from "../../../lib/review-auth";
import { DEFAULT_SCHEDULE_SETTINGS } from "../../../lib/schedule-settings";
import { AppShell } from "../AppShell";
import { requireCreatorSession } from "../app-session";

import { RhythmControls } from "./RhythmControls";
import { VoiceCard } from "./VoiceCard";
import styles from "./rhythm.module.css";

const CAPTION_PRESETS = [
  { id: "clean-bold", label: "Clean bold" },
  { id: "outline-pop", label: "Outline pop" },
  { id: "karaoke", label: "Karaoke" },
];

type RhythmPageProps = {
  searchParams?: Promise<{
    push?: string;
  }>;
};

export default async function RhythmPage({ searchParams }: RhythmPageProps) {
  const session = await requireCreatorSession();
  const params = (await searchParams) ?? {};
  const [frame, overview] = await Promise.all([
    loadAppFrameData(session.creatorId),
    loadRhythmOverview(session.creatorId),
  ]);

  return (
    <AppShell
      activeTab="rhythm"
      pushNudgesEnabled={frame.pushNudgesEnabled}
      reviewCount={frame.reviewCount}
    >
      <section className={styles.stack}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Rhythm</p>
          <h1 className={styles.title}>Posting cadence</h1>
        </header>

        <RhythmControls
          highlightPushNudges={params.push === "fix"}
          initialSettings={overview.schedule ?? DEFAULT_SCHEDULE_SETTINGS}
        />

        <VoiceCard
          hasMind={overview.creator.hasMind}
          initialCaptionCorpus={overview.creator.captionCorpus}
          initialCaptionCount={overview.creator.captionCount}
          initialChannelPullStatus={channelPullStatusResponse(
            overview.creator.channelPullStage,
            overview.creator.channelPullError,
          )}
          initialChannelUrl={overview.creator.channelUrl ?? ""}
        />

        <section className={styles.accountCard} aria-labelledby="account-title">
          <h2 className={styles.sectionTitle} id="account-title">
            Account
          </h2>
          <div className={styles.channelRow}>
            <span>Display name</span>
            <span>{overview.creator.displayName ?? "No name saved."}</span>
          </div>
          <div className={styles.presetList}>
            {CAPTION_PRESETS.map((preset) => (
              <label
                className={`${styles.presetOption} ${
                  preset.id === overview.creator.captionPreset ? styles.activePreset : ""
                }`}
                key={preset.id}
              >
                <input
                  checked={preset.id === overview.creator.captionPreset}
                  disabled
                  name="captionPreset"
                  readOnly
                  type="radio"
                />
                <span className={styles.previewStrip} aria-hidden="true" />
                <span>{preset.label}</span>
              </label>
            ))}
          </div>
          <div className={styles.channelRow}>
            <span>Channel URL</span>
            <span>{overview.creator.channelUrl ?? "No channel saved."}</span>
          </div>
          <form action={logoutCreator}>
            <button className={styles.logoutButton} type="submit">
              Log out
            </button>
          </form>
        </section>
      </section>
    </AppShell>
  );
}

async function logoutCreator() {
  "use server";

  const cookieStore = await cookies();
  cookieStore.delete(CREATOR_ACCESS_COOKIE);
  redirect("/login");
}
