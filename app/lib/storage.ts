import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
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
    command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand,
  ): Promise<unknown>;
}

export type SourcePresigner = (
  client: S3ClientLike,
  command: GetObjectCommand,
  expiresInSeconds: number,
) => Promise<string>;

export type R2StorageOptions = {
  env?: StorageEnv;
  s3Client?: S3ClientLike;
  presignSource?: SourcePresigner;
};

export interface R2Storage {
  uploadSource(
    videoId: string,
    localPathOrStream: SourceUploadInput,
    options?: SourceUploadOptions,
  ): Promise<string>;
  presignSourceUrl(key: string, ttlSeconds?: number): Promise<string>;
  uploadRender(clipId: string, stream: StorageUploadBody): Promise<string>;
  uploadThumbnail(clipId: string, stream: StorageUploadBody): Promise<string>;
  deleteSource(key: string): Promise<void>;
  deleteMediaObject(key: string): Promise<void>;
  probeBuckets(): Promise<StorageProbeResult[]>;
}

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

async function defaultSourcePresigner(
  client: S3ClientLike,
  command: GetObjectCommand,
  expiresInSeconds: number,
): Promise<string> {
  return getSignedUrl(client as S3Client, command, {
    expiresIn: expiresInSeconds,
  });
}

function publicUrlForKey(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${key}`;
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
