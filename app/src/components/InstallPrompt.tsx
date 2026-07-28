"use client";

import { useEffect, useState } from "react";

import {
  detectInstallPlatform,
  type InstallPlatformState,
} from "../../lib/install";

import styles from "./install-prompt.module.css";

type InstallPromptProps = {
  placement: "landing" | "banner";
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
};

type NavigatorWithStandalone = Navigator & {
  standalone?: boolean;
};

export function InstallPrompt({ placement }: InstallPromptProps) {
  const [platformState, setPlatformState] = useState<
    InstallPlatformState | "checking"
  >("checking");
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);

  useEffect(() => {
    const standaloneQuery = window.matchMedia("(display-mode: standalone)");
    const detectCurrentState = (hasPrompt: boolean) =>
      detectInstallPlatform({
        userAgent: navigator.userAgent,
        displayModeStandalone: standaloneQuery.matches,
        hasBeforeInstallPrompt: hasPrompt,
        maxTouchPoints: navigator.maxTouchPoints,
        navigatorStandalone: Boolean(
          (navigator as NavigatorWithStandalone).standalone,
        ),
      });

    const refreshInstalledState = () => {
      setPlatformState(detectCurrentState(Boolean(deferredPrompt)));
    };

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      setPlatformState("android-installable");
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setOverlayOpen(false);
      setPlatformState("installed");
    };

    setPlatformState(detectCurrentState(false));
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    standaloneQuery.addEventListener("change", refreshInstalledState);

    return () => {
      window.removeEventListener(
        "beforeinstallprompt",
        handleBeforeInstallPrompt,
      );
      window.removeEventListener("appinstalled", handleAppInstalled);
      standaloneQuery.removeEventListener("change", refreshInstalledState);
    };
  }, [deferredPrompt]);

  if (platformState === "installed") {
    return null;
  }

  if (placement === "banner" && platformState === "checking") {
    return null;
  }

  if (platformState === "unsupported") {
    return null;
  }

  const canPrompt =
    platformState === "android-installable" && deferredPrompt !== null;
  const opensGuide = platformState === "ios-guided";
  const disabled = placement === "landing" && platformState === "checking";

  async function handleInstallClick() {
    if (canPrompt && deferredPrompt) {
      const promptEvent = deferredPrompt;
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice.catch(() => null);
      setDeferredPrompt(null);

      if (choice?.outcome !== "accepted") {
        setPlatformState("unsupported");
      }

      return;
    }

    if (opensGuide) {
      setOverlayOpen(true);
    }
  }

  return (
    <>
      <div className={placement === "banner" ? styles.banner : styles.landing}>
        {placement === "banner" ? (
          <p className={styles.bannerText}>Add ClipMind to your home screen.</p>
        ) : null}
        <button
          className={styles.installButton}
          disabled={disabled}
          onClick={handleInstallClick}
          type="button"
        >
          Install ClipMind
        </button>
      </div>

      {overlayOpen ? (
        <div className={styles.overlay} role="presentation">
          <section
            aria-labelledby="install-guide-title"
            aria-modal="true"
            className={styles.sheet}
            role="dialog"
          >
            <h2 className={styles.sheetTitle} id="install-guide-title">
              Add ClipMind to your home screen
            </h2>
            <ol className={styles.steps}>
              <li className={styles.step}>
                <ShareIcon />
                <span>Tap Share</span>
              </li>
              <li className={styles.step}>
                <AddHomeIcon />
                <span>Tap Add to Home Screen</span>
              </li>
            </ol>
            <button
              className={styles.closeButton}
              onClick={() => setOverlayOpen(false)}
              type="button"
            >
              Done
            </button>
          </section>
        </div>
      ) : null}
    </>
  );
}

function ShareIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.stepIcon}
      fill="none"
      viewBox="0 0 48 48"
    >
      <path
        d="M24 30V8M15 17L24 8L33 17"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="4"
      />
      <path
        d="M14 22H11C9.34 22 8 23.34 8 25V37C8 38.66 9.34 40 11 40H37C38.66 40 40 38.66 40 37V25C40 23.34 38.66 22 37 22H34"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="4"
      />
    </svg>
  );
}

function AddHomeIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.stepIcon}
      fill="none"
      viewBox="0 0 48 48"
    >
      <path
        d="M10 23L24 12L38 23V39C38 40.1 37.1 41 36 41H12C10.9 41 10 40.1 10 39V23Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="4"
      />
      <path
        d="M24 26V36M19 31H29"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="4"
      />
    </svg>
  );
}
