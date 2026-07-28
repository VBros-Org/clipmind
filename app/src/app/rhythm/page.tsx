import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { loadAppFrameData, loadRhythmOverview } from "../../../lib/app-overview";
import { CREATOR_ACCESS_COOKIE } from "../../../lib/review-auth";
import { AppShell } from "../AppShell";
import { requireCreatorSession } from "../app-session";

import styles from "./rhythm.module.css";

const CAPTION_PRESETS = [
  { id: "clean-bold", label: "Clean bold" },
  { id: "outline-pop", label: "Outline pop" },
  { id: "karaoke", label: "Karaoke" },
];

export default async function RhythmPage() {
  const session = await requireCreatorSession();
  const [frame, overview] = await Promise.all([
    loadAppFrameData(session.creatorId),
    loadRhythmOverview(session.creatorId),
  ]);
  const slotsPerDay = overview.schedule?.slotsPerDay ?? 2;
  const firstHour = overview.schedule?.firstHourUtc ?? 9;

  return (
    <AppShell activeTab="rhythm" reviewCount={frame.reviewCount}>
      <section className={styles.stack}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Rhythm</p>
          <h1 className={styles.title}>Posting cadence</h1>
        </header>

        <section className={styles.card} aria-labelledby="cadence-title">
          <div className={styles.cardHeader}>
            <h2 className={styles.sectionTitle} id="cadence-title">
              Cadence
            </h2>
            <span className={styles.note}>Editable in the next build.</span>
          </div>
          <p className={styles.preview}>
            {overview.schedule
              ? cadenceSentence(slotsPerDay, firstHour)
              : "Set a rhythm to start scheduling."}
          </p>
          <div className={styles.controlRow}>
            <span>Slots per day</span>
            <div className={styles.stepper} aria-label="Slots per day">
              <button disabled type="button">
                -
              </button>
              <span>{slotsPerDay}</span>
              <button disabled type="button">
                +
              </button>
            </div>
          </div>
          <label className={styles.selectRow}>
            First post
            <select disabled value={hourLabel(firstHour)}>
              <option>{hourLabel(firstHour)}</option>
            </select>
          </label>
        </section>

        <section className={styles.card} aria-labelledby="nudges-title">
          <div className={styles.cardHeader}>
            <h2 className={styles.sectionTitle} id="nudges-title">
              Nudges
            </h2>
            <span className={styles.note}>Editable in the next build.</span>
          </div>
          <ToggleRow label="Review reminders" checked />
          <ToggleRow label="Runway warnings" checked />
          <div className={styles.controlRow}>
            <span>Runway threshold</span>
            <div className={styles.stepper} aria-label="Runway threshold">
              <button disabled type="button">
                -
              </button>
              <span>2 days</span>
              <button disabled type="button">
                +
              </button>
            </div>
          </div>
          <ToggleRow label="Post-time nudges" checked />
        </section>

        <section className={styles.accountCard} aria-labelledby="account-title">
          <h2 className={styles.sectionTitle} id="account-title">
            Account
          </h2>
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

function ToggleRow({ label, checked }: { label: string; checked: boolean }) {
  return (
    <label className={styles.toggleRow}>
      <span>{label}</span>
      <input checked={checked} disabled readOnly type="checkbox" />
    </label>
  );
}

function cadenceSentence(slotsPerDay: number, firstHour: number): string {
  const unit = slotsPerDay === 1 ? "post" : "posts";
  return `${slotsPerDay} ${unit} a day, first at ${hourLabel(firstHour)}.`;
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

async function logoutCreator() {
  "use server";

  const cookieStore = await cookies();
  cookieStore.delete(CREATOR_ACCESS_COOKIE);
  redirect("/login");
}
