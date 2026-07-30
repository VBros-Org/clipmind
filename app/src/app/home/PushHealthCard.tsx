"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  PUSH_HEALTH_CARD_TITLE,
  PUSH_HEALTH_EVENT_NAME,
  PUSH_HEALTH_FIX_HREF,
  shouldShowPushHealthCard,
} from "../../../lib/push-health";
import {
  dismissPushHealthIssue,
  isPushHealthDismissed,
  readPushHealthIssue,
} from "../push-health-client";

import styles from "./home.module.css";

export function PushHealthCard({
  pushNudgesEnabled,
}: {
  pushNudgesEnabled: boolean;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function syncVisibleState() {
      setVisible(
        shouldShowPushHealthCard({
          pushEnabled: pushNudgesEnabled,
          issue: readPushHealthIssue(),
          dismissed: isPushHealthDismissed(),
        }),
      );
    }

    syncVisibleState();
    window.addEventListener(PUSH_HEALTH_EVENT_NAME, syncVisibleState);
    return () => {
      window.removeEventListener(PUSH_HEALTH_EVENT_NAME, syncVisibleState);
    };
  }, [pushNudgesEnabled]);

  if (!visible) {
    return null;
  }

  return (
    <article className={styles.pushHealthCard} data-testid="push-health-card">
      <Link className={styles.pushHealthLink} href={PUSH_HEALTH_FIX_HREF}>
        {PUSH_HEALTH_CARD_TITLE}
      </Link>
      <button
        aria-label={`Dismiss ${PUSH_HEALTH_CARD_TITLE}`}
        className={styles.dismiss}
        onClick={dismissPushHealthIssue}
        type="button"
      >
        Dismiss
      </button>
    </article>
  );
}
