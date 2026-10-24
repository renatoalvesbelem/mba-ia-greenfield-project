import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageInvalidPartsError } from './storage.errors';

export interface StoragePart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface StorageCompletedPart {
  partNumber: number;
  etag: string;
}

export interface StorageObjectMetadata {
  contentLength: number;
  contentType?: string;
  etag?: string;
}

export interface StorageGetObjectOptions {
  responseContentDisposition?: string;
  responseContentType?: string;
}

const INVALID_PARTS_ERROR_NAMES = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'NoSuchUpload',
]);

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

@Injectable()
export class StorageService implements OnModuleInit {
  constructor(
    @Inject(S3_CLIENT) private readonly s3Client: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly s3PublicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.s3Client.send(
        new HeadBucketCommand({ Bucket: this.storage.bucket }),
      );
    } catch (error) {
      if (errorName(error) !== 'NotFound') {
        throw error;
      }
      await this.createBucket();
    }
  }

  private async createBucket(): Promise<void> {
    try {
      await this.s3Client.send(
        new CreateBucketCommand({ Bucket: this.storage.bucket }),
      );
    } catch (error) {
      const name = errorName(error);
      if (
        name !== 'BucketAlreadyOwnedByYou' &&
        name !== 'BucketAlreadyExists'
      ) {
        throw error;
      }
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const response = await this.s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.storage.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!response.UploadId) {
      throw new Error(
        'S3 did not return an UploadId for CreateMultipartUpload',
      );
    }
    return response.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    ttlSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.s3PublicClient,
      new UploadPartCommand({
        Bucket: this.storage.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async listParts(key: string, uploadId: string): Promise<StoragePart[]> {
    const parts: StoragePart[] = [];
    let partNumberMarker: string | undefined;
    let isTruncated = true;

    while (isTruncated) {
      const response = await this.s3Client.send(
        new ListPartsCommand({
          Bucket: this.storage.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: partNumberMarker,
        }),
      );

      for (const part of response.Parts ?? []) {
        if (
          part.PartNumber === undefined ||
          part.ETag === undefined ||
          part.Size === undefined
        ) {
          continue;
        }
        parts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          size: part.Size,
        });
      }

      isTruncated = response.IsTruncated ?? false;
      partNumberMarker = response.NextPartNumberMarker;
    }

    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: StorageCompletedPart[],
  ): Promise<void> {
    const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      await this.s3Client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.storage.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: sortedParts.map((part) => ({
              ETag: part.etag,
              PartNumber: part.partNumber,
            })),
          },
        }),
      );
    } catch (error) {
      const name = errorName(error);
      if (name && INVALID_PARTS_ERROR_NAMES.has(name)) {
        throw new StorageInvalidPartsError((error as Error).message);
      }
      throw error;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.s3Client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.storage.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string): Promise<StorageObjectMetadata> {
    const response = await this.s3Client.send(
      new HeadObjectCommand({ Bucket: this.storage.bucket, Key: key }),
    );
    return {
      contentLength: response.ContentLength ?? 0,
      contentType: response.ContentType,
      etag: response.ETag,
    };
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.storage.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }),
    );
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    let isTruncated = true;

    while (isTruncated) {
      const response = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.storage.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const object of response.Contents ?? []) {
        if (!object.Key) {
          continue;
        }
        await this.s3Client.send(
          new DeleteObjectCommand({
            Bucket: this.storage.bucket,
            Key: object.Key,
          }),
        );
      }

      isTruncated = response.IsTruncated ?? false;
      continuationToken = response.NextContinuationToken;
    }
  }

  async presignGetObject(
    key: string,
    ttlSeconds: number,
    options: StorageGetObjectOptions = {},
  ): Promise<string> {
    return getSignedUrl(
      this.s3PublicClient,
      new GetObjectCommand({
        Bucket: this.storage.bucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
        ResponseContentType: options.responseContentType,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async presignInternalGetObject(
    key: string,
    ttlSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.s3Client,
      new GetObjectCommand({ Bucket: this.storage.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }
}
