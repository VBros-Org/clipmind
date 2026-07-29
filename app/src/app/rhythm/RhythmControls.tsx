"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  MAX_RUNWAY_THRESHOLD_DAYS,
  MAX_SLOTS_PER_DAY,
  MIN_RUNWAY_THRESHOLD_DAYS,
  MIN_SLOTS_PER_DAY,
  QUARTER_HOUR_MINUTES,
  buildEvenSlotTimes,
  slotTimeParts,
  type ScheduleSettings,
} from "../../../lib/schedule-settings";

import styles from "./rhythm.module.css";
import {
  hasGrantedPushPermission,
  subscribeToPushNudges,
} from "./push-client";

type RhythmControlsProps = {
  initialSettings: ScheduleSettings;
};

type SaveState = "idle" | "saving" | "saved" | "error";

export function RhythmControls({ initialSettings }: RhythmControlsProps) {
  const router = useRouter();
  const [settings, setSettings] = useState(initialSettings);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [editingSlotIndex, setEditingSlotIndex] = useState<number | null>(null);
  const saveToken = useRef(0);
  const clearTimer = useRef<number | null>(null);
  const slotTimes = slotTimesForSettings(settings);

  useEffect(() => {
    if (!settings.pushNudges || !hasGrantedPushPermission()) {
      return;
    }

    let active = true;
    const syncToken = () => {
      if (!active) {
        return;
      }

      void subscribeToPushNudges({ requestPermission: false }).catch((error) => {
        console.error("Push subscription refresh failed", error);
      });
    };

    syncToken();
    window.addEventListener("focus", syncToken);
    navigator.serviceWorker?.addEventListener("controllerchange", syncToken);

    return () => {
      active = false;
      window.removeEventListener("focus", syncToken);
      navigator.serviceWorker?.removeEventListener("controllerchange", syncToken);
    };
  }, [settings.pushNudges]);

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
    } catch (error) {
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

  async function updatePushNudges(pushNudges: boolean) {
    if (!pushNudges) {
      updateSettings((current) => ({ ...current, pushNudges }));
      return;
    }

    clearSavedTimer();
    setSaveState("saving");

    try {
      await subscribeToPushNudges({ requestPermission: true });
      updateSettings((current) => ({ ...current, pushNudges: true }));
    } catch (error) {
      console.error("Push subscription failed", error);
      setSettings((current) => ({ ...current, pushNudges: false }));
      setSaveState("error");
    }
  }

  function updateSlotTime(index: number, slotTime: string) {
    const nextSlotTimes = [...slotTimes];
    nextSlotTimes[index] = slotTime;
    if (hasDuplicateSlotTimes(nextSlotTimes)) {
      clearSavedTimer();
      setSaveState("error");
      return;
    }

    const sorted = sortSlotTimes(nextSlotTimes);
    setEditingSlotIndex(sorted.indexOf(slotTime));
    updateSettings((current) => settingsWithSlotTimes(current, sorted));
  }

  function addSlot() {
    if (slotTimes.length >= MAX_SLOTS_PER_DAY) {
      return;
    }

    const slotTime = nextAvailableSlotTime(slotTimes);
    const sorted = sortSlotTimes([...slotTimes, slotTime]);
    setEditingSlotIndex(sorted.indexOf(slotTime));
    updateSettings((current) => settingsWithSlotTimes(current, sorted));
  }

  function removeSlot(index: number) {
    if (slotTimes.length <= MIN_SLOTS_PER_DAY) {
      return;
    }

    const sorted = slotTimes.filter(
      (_slotTime, slotIndex) => slotIndex !== index,
    );
    setEditingSlotIndex((current) => {
      if (current === null) {
        return null;
      }

      if (current === index) {
        return null;
      }

      return current > index ? current - 1 : current;
    });
    updateSettings((current) => settingsWithSlotTimes(current, sorted));
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
        <p className={styles.preview} data-testid="cadence-preview">
          {cadenceSentence(settings)}
        </p>
        <div className={styles.slotList} data-testid="slot-list">
          {slotTimes.map((slotTime, index) => (
            <SlotTimeRow
              canRemove={slotTimes.length > MIN_SLOTS_PER_DAY}
              index={index}
              isEditing={editingSlotIndex === index}
              key={index}
              onRemove={() => removeSlot(index)}
              onToggleEditing={() =>
                setEditingSlotIndex((current) =>
                  current === index ? null : index,
                )
              }
              onUpdate={(nextSlotTime) => updateSlotTime(index, nextSlotTime)}
              slotTime={slotTime}
            />
          ))}
        </div>
        <button
          className={styles.addSlotButton}
          data-testid="add-slot-button"
          disabled={slotTimes.length >= MAX_SLOTS_PER_DAY}
          onClick={addSlot}
          type="button"
        >
          + Add slot
        </button>
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
        <ToggleRow
          checked={settings.pushNudges}
          disabled={saveState === "saving"}
          label="Push nudges"
          onChange={(pushNudges) => {
            void updatePushNudges(pushNudges);
          }}
        />
      </section>
    </>
  );
}

function SlotTimeRow({
  canRemove,
  index,
  isEditing,
  onRemove,
  onToggleEditing,
  onUpdate,
  slotTime,
}: {
  canRemove: boolean;
  index: number;
  isEditing: boolean;
  onRemove: () => void;
  onToggleEditing: () => void;
  onUpdate: (slotTime: string) => void;
  slotTime: string;
}) {
  const slotNumber = index + 1;
  const parts = slotTimeParts(slotTime);

  return (
    <div className={styles.slotItem} data-testid={`slot-row-${slotNumber}`}>
      <div className={styles.slotRow}>
        <button
          aria-expanded={isEditing}
          className={styles.slotButton}
          data-testid={`slot-time-button-${slotNumber}`}
          onClick={onToggleEditing}
          type="button"
        >
          <span>Slot {slotNumber}</span>
          <strong>{slotTime}</strong>
        </button>
        <button
          aria-label={`Remove slot ${slotNumber}`}
          className={styles.removeSlotButton}
          disabled={!canRemove}
          onClick={onRemove}
          type="button"
        >
          -
        </button>
      </div>
      {isEditing ? (
        <div
          className={styles.timePicker}
          data-testid={`slot-picker-${slotNumber}`}
        >
          <label className={styles.pickerLabel}>
            <span>Hour</span>
            <select
              aria-label={`Slot ${slotNumber} hour`}
              onChange={(event) =>
                onUpdate(
                  slotTimeFromParts(Number(event.target.value), parts.minute),
                )
              }
              value={parts.hour}
            >
              {hourOptions().map((hour) => (
                <option key={hour} value={hour}>
                  {String(hour).padStart(2, "0")}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.pickerLabel}>
            <span>Minute</span>
            <select
              aria-label={`Slot ${slotNumber} minute`}
              onChange={(event) =>
                onUpdate(
                  slotTimeFromParts(parts.hour, Number(event.target.value)),
                )
              }
              value={parts.minute}
            >
              {QUARTER_HOUR_MINUTES.map((minute) => (
                <option key={minute} value={minute}>
                  {String(minute).padStart(2, "0")}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
    </div>
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
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={styles.toggleRow}>
      <span>{label}</span>
      <input
        checked={checked}
        disabled={disabled}
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
  const slotTimes = slotTimesForSettings(settings);
  const unit = slotTimes.length === 1 ? "post" : "posts";
  return `${slotTimes.length} ${unit} a day at ${joinSlotTimes(slotTimes)}.`;
}

function hourOptions(): number[] {
  return Array.from({ length: 24 }, (_value, index) => index);
}

function slotTimesForSettings(settings: ScheduleSettings): string[] {
  return (
    settings.slotTimes ??
    buildEvenSlotTimes(settings.slotsPerDay, settings.anchorHour)
  );
}

function settingsWithSlotTimes(
  current: ScheduleSettings,
  slotTimes: string[],
): ScheduleSettings {
  const firstSlotTime = slotTimes[0] ?? "09:00";
  const firstSlot = slotTimeParts(firstSlotTime);
  return {
    ...current,
    slotsPerDay: slotTimes.length,
    anchorHour: firstSlot.hour,
    slotTimes,
  };
}

function sortSlotTimes(slotTimes: string[]): string[] {
  return [...slotTimes].sort(
    (left, right) => slotTimeMinutes(left) - slotTimeMinutes(right),
  );
}

function hasDuplicateSlotTimes(slotTimes: readonly string[]): boolean {
  return new Set(slotTimes).size !== slotTimes.length;
}

function nextAvailableSlotTime(slotTimes: readonly string[]): string {
  const used = new Set(slotTimes);
  const last = slotTimes[slotTimes.length - 1] ?? "09:00";
  let candidateMinutes = (slotTimeMinutes(last) + 6 * 60) % (24 * 60);

  for (let attempts = 0; attempts < 24 * 4; attempts += 1) {
    const candidate = slotTimeFromMinutes(candidateMinutes);
    if (!used.has(candidate)) {
      return candidate;
    }

    candidateMinutes = (candidateMinutes + 15) % (24 * 60);
  }

  return "00:00";
}

function joinSlotTimes(slotTimes: readonly string[]): string {
  if (slotTimes.length === 1) {
    return slotTimes[0] ?? "";
  }

  if (slotTimes.length === 2) {
    return `${slotTimes[0] ?? ""} and ${slotTimes[1] ?? ""}`;
  }

  return `${slotTimes.slice(0, -1).join(", ")}, and ${
    slotTimes[slotTimes.length - 1] ?? ""
  }`;
}

function slotTimeFromParts(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function slotTimeMinutes(slotTime: string): number {
  const parts = slotTimeParts(slotTime);
  return parts.hour * 60 + parts.minute;
}

function slotTimeFromMinutes(totalMinutes: number): string {
  const minutesInDay = 24 * 60;
  const normalizedMinutes =
    ((totalMinutes % minutesInDay) + minutesInDay) % minutesInDay;
  const hour = Math.floor(normalizedMinutes / 60);
  const minute = normalizedMinutes % 60;
  return slotTimeFromParts(hour, minute);
}
