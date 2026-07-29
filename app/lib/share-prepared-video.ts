export type PreparedVideoShareData = {
  files: unknown[];
  title: string;
};

export type PreparedVideoShareNavigator = {
  canShare?: (data: PreparedVideoShareData) => boolean;
  share?: (data: PreparedVideoShareData) => Promise<void> | void;
};

export type PreparedVideoShareOutcome =
  | { status: "shared" }
  | { status: "unsupported" }
  | { status: "cancelled" }
  | { status: "failed"; error: unknown };

const SHARE_TITLE = "ClipMind clip";

export function createPreparedVideoShareData(
  file: unknown,
): PreparedVideoShareData {
  return {
    files: [file],
    title: SHARE_TITLE,
  };
}

export function canSharePreparedVideoFile(
  navigatorLike: PreparedVideoShareNavigator | null | undefined,
  file: unknown,
): boolean {
  if (!navigatorLike?.share) {
    return false;
  }

  if (!navigatorLike.canShare) {
    return true;
  }

  try {
    return navigatorLike.canShare(createPreparedVideoShareData(file));
  } catch {
    return false;
  }
}

export function sharePreparedVideoFile(
  navigatorLike: PreparedVideoShareNavigator | null | undefined,
  file: unknown,
): Promise<PreparedVideoShareOutcome> {
  const shareData = createPreparedVideoShareData(file);

  if (!navigatorLike?.share || !canSharePreparedVideoFile(navigatorLike, file)) {
    return Promise.resolve({ status: "unsupported" });
  }

  try {
    const shareResult = navigatorLike.share(shareData);
    return Promise.resolve(shareResult)
      .then(() => ({ status: "shared" }) as const)
      .catch((error: unknown) => shareErrorOutcome(error));
  } catch (error) {
    return Promise.resolve(shareErrorOutcome(error));
  }
}

function shareErrorOutcome(error: unknown): PreparedVideoShareOutcome {
  if (errorName(error) === "AbortError") {
    return { status: "cancelled" };
  }

  return {
    status: "failed",
    error,
  };
}

function errorName(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("name" in error)) {
    return null;
  }

  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}
