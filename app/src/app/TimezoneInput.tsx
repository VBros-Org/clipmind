"use client";

import { useEffect, useState } from "react";

import { resolvedCreatorTimezone } from "./client-timezone";

export function TimezoneInput({ name = "timezone" }: { name?: string }) {
  const [timezone, setTimezone] = useState("");

  useEffect(() => {
    setTimezone(resolvedCreatorTimezone() ?? "");
  }, []);

  return <input name={name} readOnly type="hidden" value={timezone} />;
}
