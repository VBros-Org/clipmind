ALTER TABLE "Schedule" ADD COLUMN "slotTimes" JSONB;

UPDATE "Schedule" AS s
SET "slotTimes" = (
  SELECT jsonb_agg(
    to_jsonb(
      lpad((slot_minute / 60)::text, 2, '0') ||
      ':' ||
      lpad((slot_minute % 60)::text, 2, '0')
    )
    ORDER BY slot_minute
  )
  FROM (
    SELECT (((s."anchorHour" * 60) + slot_index * (1440 / s."slotsPerDay")) % 1440) AS slot_minute
    FROM generate_series(0, s."slotsPerDay" - 1) AS slot_index
  ) AS legacy_slots
)
WHERE s."slotsPerDay" BETWEEN 1 AND 4
  AND s."anchorHour" BETWEEN 0 AND 23
  AND 1440 % s."slotsPerDay" = 0;
