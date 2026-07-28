"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  MAX_ANCHOR_HOUR,
  MAX_RUNWAY_THRESHOLD_DAYS,
  MAX_SLOTS_PER_DAY,
  MIN_ANCHOR_HOUR,
  MIN_RUNWAY_THRESHOLD_DAYS,
  MIN_SLOTS_PER_DAY,
  hourLabel,
  type ScheduleSettings,
} from "../../../lib/schedule-settings";

import styles from "./rhythm.module.css";

type RhythmControlsProps = {
  initialSettings: ScheduleSettings;
};

type SaveState = "idle" | "saving" | "saved" | "error";

export function RhythmControls({ initialSettings }: RhythmControlsProps) {
  const router = useRouter();
  const [settings, setSettings] = useState(initialSettings);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const saveToken = useRef(0);
  const clearTimer = useRef<number | null>(null);

  function updateSettings(update: (current: ScheduleSettings) => ScheduleSettings) {
    const previous = settings;
    const next = update(previous);
    setSettings(next);
    void persist(next, previous);
  }

  async function persist(next: ScheduleSettings, previous: ScheduleSettings) {
    const token = saveToken.current + 1;
    saveToken.current = token;
    clearSavedTimer();
    setSaveState("saving");

    try {
      const response = await fetch("/api/schedule", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(next),
      });

      if (!response.ok) {
        throw new Error("Schedule save failed.");
      }

      const body = (await response.json()) as { schedule: ScheduleSettings };
      if (saveToken.current !== token) {
        return;
      }

      setSettings(body.schedule);
      setSaveState("saved");
      router.refresh();
      clearTimer.current = window.setTimeout(() => {
        if (saveToken.current === token) {
          setSaveState("idle");
        }
      }, 1800);
    } catch {
      if (saveToken.current !== token) {
        return;
      }

      setSettings(previous);
      setSaveState("error");
    }
  }

  function clearSavedTimer() {
    if (clearTimer.current !== null) {
      window.clearTimeout(clearTimer.current);
      clearTimer.current = null;
    }
  }

  return (
    <>
      <section className={styles.card} aria-labelledby="cadence-title">
        <div className={styles.cardHeader}>
          <h2 className={styles.sectionTitle} id="cadence-title">
            Cadence
          </h2>
          <SaveIndicator state={saveState} />
        </div>
        <p className={styles.preview}>{cadenceSentence(settings)}</p>
        <div className={styles.controlRow}>
          <span>Slots per day</span>
          <Stepper
            label="Slots per day"
            max={MAX_SLOTS_PER_DAY}
            min={MIN_SLOTS_PER_DAY}
            onChange={(slotsPerDay) =>
              updateSettings((current) => ({ ...current, slotsPerDay }))
            }
            unit={(value) => String(value)}
            value={settings.slotsPerDay}
          />
        </div>
        <label className={styles.selectRow}>
          First post
          <select
            aria-label="First post hour"
            onChange={(event) =>
              updateSettings((current) => ({
                ...current,
                anchorHour: Number(event.target.value),
              }))
            }
            value={settings.anchorHour}
          >
            {hourOptions().map((hour) => (
              <option key={hour} value={hour}>
                {hourLabel(hour)}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className={styles.card} aria-labelledby="nudges-title">
        <div className={styles.cardHeader}>
          <h2 className={styles.sectionTitle} id="nudges-title">
            Nudges
          </h2>
        </div>
        <ToggleRow
          checked={settings.reviewReminders}
          label="Review reminders"
          onChange={(reviewReminders) =>
            updateSettings((current) => ({ ...current, reviewReminders }))
          }
        />
        <ToggleRow
          checked={settings.runwayWarnings}
          label="Runway warnings"
          onChange={(runwayWarnings) =>
            updateSettings((current) => ({ ...current, runwayWarnings }))
          }
        />
        <div
          className={`${styles.controlRow} ${
            settings.runwayWarnings ? "" : styles.disabledRow
          }`}
        >
          <span>Runway threshold</span>
          <Stepper
            disabled={!settings.runwayWarnings}
            label="Runway threshold"
            max={MAX_RUNWAY_THRESHOLD_DAYS}
            min={MIN_RUNWAY_THRESHOLD_DAYS}
            onChange={(runwayThresholdDays) =>
              updateSettings((current) => ({ ...current, runwayThresholdDays }))
            }
            unit={(value) => `${value} ${value === 1 ? "day" : "days"}`}
            value={settings.runwayThresholdDays}
          />
        </div>
        <ToggleRow
          checked={settings.postTimeNudges}
          label="Post-time nudges"
          onChange={(postTimeNudges) =>
            updateSettings((current) => ({ ...current, postTimeNudges }))
          }
        />
      </section>
    </>
  );
}

function Stepper({
  disabled = false,
  label,
  max,
  min,
  onChange,
  unit,
  value,
}: {
  disabled?: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  unit: (value: number) => string;
  value: number;
}) {
  return (
    <div className={styles.stepper} aria-label={label}>
      <button
        aria-label={`Decrease ${label.toLowerCase()}`}
        disabled={disabled || value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        type="button"
      >
        -
      </button>
      <span>{unit(value)}</span>
      <button
        aria-label={`Increase ${label.toLowerCase()}`}
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        type="button"
      >
        +
      </button>
    </div>
  );
}

function ToggleRow({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={styles.toggleRow}>
      <span>{label}</span>
      <input
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
    </label>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "idle") {
    return null;
  }

  return (
    <span
      className={`${styles.saveState} ${
        state === "error" ? styles.errorState : ""
      }`}
      aria-live="polite"
    >
      {state === "saved" ? <CheckIcon /> : null}
      {state === "saving" ? "Saving" : state === "saved" ? "Saved" : "Try again"}
    </span>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.saveIcon}
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="3"
      viewBox="0 0 24 24"
      width="16"
    >
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function cadenceSentence(settings: ScheduleSettings): string {
  const unit = settings.slotsPerDay === 1 ? "post" : "posts";
  return `${settings.slotsPerDay} ${unit} a day, first at ${hourLabel(
    settings.anchorHour,
  )}.`;
}

function hourOptions(): number[] {
  return Array.from(
    { length: MAX_ANCHOR_HOUR - MIN_ANCHOR_HOUR + 1 },
    (_value, index) => MIN_ANCHOR_HOUR + index,
  );
}
