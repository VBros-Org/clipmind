export type UploadTransferNotice = "uploading" | "safe" | null;

export type UploadTransferState<TFile> = {
  notice: UploadTransferNotice;
  retryFile: TFile | null;
};

export function uploadTransferIdle<TFile>(): UploadTransferState<TFile> {
  return {
    notice: null,
    retryFile: null,
  };
}

export function uploadTransferStarted<TFile>(): UploadTransferState<TFile> {
  return {
    notice: "uploading",
    retryFile: null,
  };
}

export function uploadTransferSucceeded<TFile>(): UploadTransferState<TFile> {
  return {
    notice: "safe",
    retryFile: null,
  };
}

export function uploadTransferFailed<TFile>(
  retryFile: TFile,
): UploadTransferState<TFile> {
  return {
    notice: null,
    retryFile,
  };
}
