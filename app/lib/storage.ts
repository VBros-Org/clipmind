import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
  S3Client,
  type CompletedPart,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { requireStorageEnv, type StorageEnv } from "./env";

const DEFAULT_SOURCE_PRESIGN_TTL_SECONDS = 60 * 60;
const VIDEO_MP4_CONTENT_TYPE = "video/mp4";
const JPEG_CONTENT_TYPE = "image/jpeg";

export type StorageUploadBody = NonNullable<PutObjectCommandInput["Body"]>;
export type SourceUploadInput = string | StorageUploadBody;
export type SourceUploadOptions = {
  contentLength?: number;
};

export interface S3ClientLike {
  send(
    command:
      | AbortMultipartUploadCommand
      | CompleteMultipartUploadCommand
      | CreateMultipartUploadCommand
      | DeleteObjectCommand
      | GetObjectCommand
      | ListMultipartUploadsCommand
      | ListObjectsV2Command
      | ListPartsCommand
      | PutObjectCommand
      | UploadPartCommand,
  ): Promise<unknown>;
}

export type SourcePresigner = (
  client: S3ClientLike,
  command: GetObjectCommand,
  expiresInSeconds: number,
) => Promise<string>;

export type SourcePartPresigner = (
  client: S3ClientLike,
  command: UploadPartCommand,
  expiresInSeconds: number,
) => Promise<string>;

export type R2StorageOptions = {
  env?: StorageEnv;
  s3Client?: S3ClientLike;
  presignSource?: SourcePresigner;
  presignSourcePart?: SourcePartPresigner;
};

export interface R2Storage {
  uploadSource(
    videoId: string,
    localPathOrStream: SourceUploadInput,
    options?: SourceUploadOptions,
  ): Promise<string>;
  createSourceMultipartUpload(input: {
    key: string;
    contentType: string;
  }): Promise<{ uploadId: string }>;
  presignSourcePartUpload(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    ttlSeconds?: number;
  }): Promise<string>;
  listSourceUploadParts(input: {
    key: string;
    uploadId: string;
  }): Promise<SourceUploadPart[]>;
  completeSourceMultipartUpload(input: {
    key: string;
    uploadId: string;
    parts: SourceUploadPart[];
  }): Promise<void>;
  abortSourceMultipartUpload(input: {
    key: string;
    uploadId: string;
  }): Promise<void>;
  presignSourceUrl(key: string, ttlSeconds?: number): Promise<string>;
  uploadRender(clipId: string, stream: StorageUploadBody): Promise<string>;
  uploadThumbnail(clipId: string, stream: StorageUploadBody): Promise<string>;
  deleteSource(key: string): Promise<void>;
  deleteMediaObject(key: string): Promise<void>;
  listSourceMultipartUploads(prefix?: string): Promise<SourceMultipartUpload[]>;
  listSourceObjects(prefix?: string): Promise<SourceObject[]>;
  listMediaObjects(prefix?: string): Promise<SourceObject[]>;
  probeBuckets(): Promise<StorageProbeResult[]>;
}

export type SourceUploadPart = {
  partNumber: number;
  size: number;
  etag: string;
};

export type SourceMultipartUpload = {
  key: string;
  uploadId: string;
  initiated: Date | null;
};

export type SourceObject = {
  key: string;
  size: number;
  lastModified: Date | null;
};

export type StorageProbeResult = {
  bucket: string;
  key: string;
};

export type StorageProbeTarget = {
  bucket: string;
  label: string;
};

export function createR2Storage(options: R2StorageOptions = {}): R2Storage {
  const storageEnv = options.env ?? requireStorageEnv();
  const s3Client = options.s3Client ?? createR2Client(storageEnv);
  const presignSource = options.presignSource ?? defaultSourcePresigner;
  const presignSourcePart = options.presignSourcePart ?? defaultSourcePartPresigner;

  return {
    async uploadSource(videoId, localPathOrStream, uploadOptions = {}) {
      const key = sourceKeyForVideo(videoId);
      await putObject(s3Client, {
        Bucket: storageEnv.R2_SOURCES_BUCKET,
        Key: key,
        Body: uploadBodyFromSource(localPathOrStream),
        ContentType: VIDEO_MP4_CONTENT_TYPE,
        ContentLength: uploadOptions.contentLength,
      });
      return key;
    },

    async createSourceMultipartUpload(input) {
      const result = (await s3Client.send(
        new CreateMultipartUploadCommand({
          Bucket: storageEnv.R2_SOURCES_BUCKET,
          Key: input.key,
          ContentType: input.contentType,
        }),
      )) as { UploadId?: string };

      const uploadId = result.UploadId?.trim();
      if (!uploadId) {
        throw new Error(`R2 did not return a multipart upload id for ${input.key}.`);
      }

      return { uploadId };
    },

    async presignSourcePartUpload(input) {
      return presignSourcePart(
        s3Client,
        new UploadPartCommand({
          Bucket: storageEnv.R2_SOURCES_BUCKET,
          Key: input.key,
          UploadId: input.uploadId,
          PartNumber: input.partNumber,
        }),
        input.ttlSeconds ?? DEFAULT_SOURCE_PRESIGN_TTL_SECONDS,
      );
    },

    async listSourceUploadParts(input) {
      return listUploadParts(
        s3Client,
        storageEnv.R2_SOURCES_BUCKET,
        input.key,
        input.uploadId,
      );
    },

    async completeSourceMultipartUpload(input) {
      await s3Client.send(
        new CompleteMultipartUploadCommand({
          Bucket: storageEnv.R2_SOURCES_BUCKET,
          Key: input.key,
          UploadId: input.uploadId,
          MultipartUpload: {
            Parts: input.parts.map(toCompletedPart),
          },
        }),
      );
    },

    async abortSourceMultipartUpload(input) {
      await abortMultipartUpload(
        s3Client,
        storageEnv.R2_SOURCES_BUCKET,
        input.key,
        input.uploadId,
      );
    },

    async presignSourceUrl(key, ttlSeconds = DEFAULT_SOURCE_PRESIGN_TTL_SECONDS) {
      return presignSource(
        s3Client,
        new GetObjectCommand({
          Bucket: storageEnv.R2_SOURCES_BUCKET,
          Key: key,
        }),
        ttlSeconds,
      );
    },

    async uploadRender(clipId, stream) {
      const key = renderKeyForClip(clipId);
      await putObject(s3Client, {
        Bucket: storageEnv.R2_MEDIA_BUCKET,
        Key: key,
        Body: stream,
        ContentType: VIDEO_MP4_CONTENT_TYPE,
      });
      return publicUrlForKey(storageEnv.R2_MEDIA_PUBLIC_BASE, key);
    },

    async uploadThumbnail(clipId, stream) {
      const key = thumbnailKeyForClip(clipId);
      await putObject(s3Client, {
        Bucket: storageEnv.R2_MEDIA_BUCKET,
        Key: key,
        Body: stream,
        ContentType: JPEG_CONTENT_TYPE,
      });
      return key;
    },

    async deleteSource(key) {
      await deleteObject(s3Client, storageEnv.R2_SOURCES_BUCKET, key);
    },

    async deleteMediaObject(key) {
      await deleteObject(s3Client, storageEnv.R2_MEDIA_BUCKET, key);
    },

    async listSourceMultipartUploads(prefix = "") {
      return listMultipartUploads(s3Client, storageEnv.R2_SOURCES_BUCKET, prefix);
    },

    async listSourceObjects(prefix = "") {
      return listObjects(s3Client, storageEnv.R2_SOURCES_BUCKET, prefix);
    },

    async listMediaObjects(prefix = "") {
      return listObjects(s3Client, storageEnv.R2_MEDIA_BUCKET, prefix);
    },

    async probeBuckets() {
      const targets: StorageProbeTarget[] = [
        { bucket: storageEnv.R2_SOURCES_BUCKET, label: "sources" },
        { bucket: storageEnv.R2_MEDIA_BUCKET, label: "media" },
      ];
      const results: StorageProbeResult[] = [];

      for (const target of targets) {
        try {
          results.push(await probeBucket(s3Client, target.bucket));
        } catch (error) {
          throw bucketProbeError(target, error);
        }
      }

      return results;
    },
  };
}

export function uploadSource(
  videoId: string,
  localPathOrStream: SourceUploadInput,
  uploadOptions?: SourceUploadOptions,
  storageOptions?: R2StorageOptions,
): Promise<string> {
  return createR2Storage(storageOptions).uploadSource(
    videoId,
    localPathOrStream,
    uploadOptions,
  );
}

export function presignSourceUrl(
  key: string,
  ttlSeconds?: number,
  options?: R2StorageOptions,
): Promise<string> {
  return createR2Storage(options).presignSourceUrl(key, ttlSeconds);
}

export function uploadRender(
  clipId: string,
  stream: StorageUploadBody,
  options?: R2StorageOptions,
): Promise<string> {
  return createR2Storage(options).uploadRender(clipId, stream);
}

export function uploadThumbnail(
  clipId: string,
  stream: StorageUploadBody,
  options?: R2StorageOptions,
): Promise<string> {
  return createR2Storage(options).uploadThumbnail(clipId, stream);
}

export function deleteSourceObject(
  key: string,
  options?: R2StorageOptions,
): Promise<void> {
  return createR2Storage(options).deleteSource(key);
}

export function deleteMediaObject(
  key: string,
  options?: R2StorageOptions,
): Promise<void> {
  return createR2Storage(options).deleteMediaObject(key);
}

export function sourceKeyForVideo(videoId: string): string {
  return `videos/${videoId}/source.mp4`;
}

export function renderKeyForClip(clipId: string): string {
  return `clips/${clipId}.mp4`;
}

export function thumbnailKeyForClip(clipId: string): string {
  return `thumbs/${clipId}.jpg`;
}

export function publicMediaUrlForKey(
  key: string | null | undefined,
  baseUrl = process.env.R2_MEDIA_PUBLIC_BASE,
): string | null {
  const cleanKey = key?.trim().replace(/^\/+/, "");
  const cleanBase = baseUrl?.trim();
  if (!cleanKey || !cleanBase) {
    return null;
  }

  return publicUrlForKey(cleanBase, cleanKey);
}

export function publicMediaKeyFromUrl(
  url: string | null | undefined,
  baseUrl = process.env.R2_MEDIA_PUBLIC_BASE,
): string | null {
  const cleanUrl = url?.trim();
  const cleanBase = baseUrl?.trim().replace(/\/+$/, "");
  if (!cleanUrl || !cleanBase) {
    return null;
  }

  const basePrefix = `${cleanBase}/`;
  if (!cleanUrl.startsWith(basePrefix)) {
    return null;
  }

  const key = cleanUrl
    .slice(basePrefix.length)
    .split(/[?#]/, 1)[0]
    ?.replace(/^\/+/, "");

  return key || null;
}

function createR2Client(storageEnv: StorageEnv): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${storageEnv.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: storageEnv.R2_ACCESS_KEY_ID,
      secretAccessKey: storageEnv.R2_SECRET_ACCESS_KEY,
    },
  });
}

function uploadBodyFromSource(source: SourceUploadInput): StorageUploadBody {
  if (typeof source === "string") {
    return createReadStream(source);
  }
  return source;
}

async function putObject(
  s3Client: S3ClientLike,
  input: PutObjectCommandInput,
): Promise<void> {
  await s3Client.send(new PutObjectCommand(input));
}

async function deleteObject(
  s3Client: S3ClientLike,
  bucket: string,
  key: string,
): Promise<void> {
  try {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
  } catch (error) {
    if (!isMissingObjectError(error)) {
      throw error;
    }
  }
}

async function abortMultipartUpload(
  s3Client: S3ClientLike,
  bucket: string,
  key: string,
  uploadId: string,
): Promise<void> {
  try {
    await s3Client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  } catch (error) {
    if (!isMissingUploadError(error)) {
      throw error;
    }
  }
}

async function defaultSourcePresigner(
  client: S3ClientLike,
  command: GetObjectCommand,
  expiresInSeconds: number,
): Promise<string> {
  return getSignedUrl(client as S3Client, command, {
    expiresIn: expiresInSeconds,
  });
}

async function defaultSourcePartPresigner(
  client: S3ClientLike,
  command: UploadPartCommand,
  expiresInSeconds: number,
): Promise<string> {
  return getSignedUrl(client as S3Client, command, {
    expiresIn: expiresInSeconds,
  });
}

function publicUrlForKey(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${key}`;
}

async function listUploadParts(
  s3Client: S3ClientLike,
  bucket: string,
  key: string,
  uploadId: string,
): Promise<SourceUploadPart[]> {
  const parts: SourceUploadPart[] = [];
  let marker: string | undefined;

  for (;;) {
    const result = (await s3Client.send(
      new ListPartsCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: marker,
      }),
    )) as {
      IsTruncated?: boolean;
      NextPartNumberMarker?: string;
      Parts?: Array<{
        PartNumber?: number;
        Size?: number;
        ETag?: string;
      }>;
    };

    for (const part of result.Parts ?? []) {
      const partNumber = part.PartNumber;
      const size = part.Size;
      if (
        typeof partNumber === "number" &&
        Number.isInteger(partNumber) &&
        typeof size === "number" &&
        Number.isFinite(size) &&
        typeof part.ETag === "string" &&
        part.ETag.trim()
      ) {
        parts.push({
          partNumber,
          size,
          etag: part.ETag,
        });
      }
    }

    if (!result.IsTruncated) {
      break;
    }

    marker = result.NextPartNumberMarker;
    if (!marker) {
      break;
    }
  }

  return parts.sort((left, right) => left.partNumber - right.partNumber);
}

async function listMultipartUploads(
  s3Client: S3ClientLike,
  bucket: string,
  prefix: string,
): Promise<SourceMultipartUpload[]> {
  const uploads: SourceMultipartUpload[] = [];
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;

  for (;;) {
    const result = (await s3Client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        Prefix: prefix || undefined,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      }),
    )) as {
      IsTruncated?: boolean;
      NextKeyMarker?: string;
      NextUploadIdMarker?: string;
      Uploads?: Array<{
        Key?: string;
        UploadId?: string;
        Initiated?: Date;
      }>;
    };

    for (const upload of result.Uploads ?? []) {
      const uploadId = upload.UploadId?.trim();
      const key = upload.Key?.trim();
      if (uploadId && key) {
        uploads.push({
          key,
          uploadId,
          initiated: upload.Initiated instanceof Date ? upload.Initiated : null,
        });
      }
    }

    if (!result.IsTruncated) {
      break;
    }

    keyMarker = result.NextKeyMarker;
    uploadIdMarker = result.NextUploadIdMarker;
    if (!keyMarker || !uploadIdMarker) {
      break;
    }
  }

  return uploads;
}

async function listObjects(
  s3Client: S3ClientLike,
  bucket: string,
  prefix: string,
): Promise<SourceObject[]> {
  const objects: SourceObject[] = [];
  let continuationToken: string | undefined;

  for (;;) {
    const result = (await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken,
      }),
    )) as {
      IsTruncated?: boolean;
      NextContinuationToken?: string;
      Contents?: Array<{
        Key?: string;
        Size?: number;
        LastModified?: Date;
      }>;
    };

    for (const object of result.Contents ?? []) {
      const key = object.Key?.trim();
      if (key && Number.isFinite(object.Size)) {
        objects.push({
          key,
          size: object.Size ?? 0,
          lastModified:
            object.LastModified instanceof Date ? object.LastModified : null,
        });
      }
    }

    if (!result.IsTruncated) {
      break;
    }

    continuationToken = result.NextContinuationToken;
    if (!continuationToken) {
      break;
    }
  }

  return objects;
}

function toCompletedPart(part: SourceUploadPart): CompletedPart {
  return {
    ETag: part.etag,
    PartNumber: part.partNumber,
  };
}

async function probeBucket(
  s3Client: S3ClientLike,
  bucket: string,
): Promise<StorageProbeResult> {
  const key = `probes/${randomUUID()}.txt`;
  const marker = `clipmind-r2-probe-${randomUUID()}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: marker,
      ContentType: "text/plain",
    }),
  );

  try {
    const result = (await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    )) as { Body?: { transformToString?: () => Promise<string> } };

    const body = await result.Body?.transformToString?.();
    if (body !== undefined && body !== marker) {
      throw new Error(`Probe readback mismatch for ${bucket}/${key}.`);
    }

    return { bucket, key };
  } finally {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
  }
}

function bucketProbeError(target: StorageProbeTarget, error: unknown): Error {
  const cause = error instanceof Error ? error : new Error(String(error));
  return new Error(
    `R2 ${target.label} bucket probe failed for ${target.bucket}: ${cause.message}`,
    {
      cause,
    },
  );
}

function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: {
      httpStatusCode?: unknown;
    };
  };
  const status = candidate.$metadata?.httpStatusCode;
  if (status === 404) {
    return true;
  }

  return [candidate.name, candidate.Code, candidate.code].some(
    (value) => value === "NoSuchKey" || value === "NotFound",
  );
}

function isMissingUploadError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: {
      httpStatusCode?: unknown;
    };
  };
  const status = candidate.$metadata?.httpStatusCode;
  if (status === 404) {
    return true;
  }

  return [candidate.name, candidate.Code, candidate.code].some(
    (value) =>
      value === "NoSuchUpload" ||
      value === "NoSuchKey" ||
      value === "NotFound",
  );
}
