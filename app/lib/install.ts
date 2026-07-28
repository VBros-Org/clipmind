export type InstallPlatformState =
  | "android-installable"
  | "ios-guided"
  | "installed"
  | "unsupported";

export type InstallPlatformInput = {
  userAgent: string;
  displayModeStandalone?: boolean;
  hasBeforeInstallPrompt?: boolean;
  maxTouchPoints?: number;
  navigatorStandalone?: boolean;
};

export function detectInstallPlatform({
  userAgent,
  displayModeStandalone = false,
  hasBeforeInstallPrompt = false,
  maxTouchPoints = 0,
  navigatorStandalone = false,
}: InstallPlatformInput): InstallPlatformState {
  if (displayModeStandalone || navigatorStandalone) {
    return "installed";
  }

  if (hasBeforeInstallPrompt) {
    return "android-installable";
  }

  if (isIosSafari(userAgent, maxTouchPoints)) {
    return "ios-guided";
  }

  return "unsupported";
}

function isIosSafari(userAgent: string, maxTouchPoints: number): boolean {
  const ua = userAgent.toLowerCase();
  const isIosDevice =
    /iphone|ipad|ipod/.test(ua) ||
    (ua.includes("macintosh") && maxTouchPoints > 1);
  const isSafari = ua.includes("safari");
  const isOtherIosBrowser =
    ua.includes("crios") ||
    ua.includes("fxios") ||
    ua.includes("edgios") ||
    ua.includes("opios");

  return isIosDevice && isSafari && !isOtherIosBrowser;
}
