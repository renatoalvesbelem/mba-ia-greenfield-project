import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { generatePublicId } from '../videos/public-id.util';
import {
  thumbnailStorageKey,
  videoStorageKey,
} from '../videos/videos.constants';
import {
  Video,
  VideoMetadata,
  VideoStatus,
} from '../videos/entities/video.entity';
import { createTestVideoFile, removeTestFile } from './fixtures';

const MINIMAL_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

export interface SeedReadyVideoOptions {
  title?: string;
  originalFilename?: string;
  contentType?: string;
  withThumbnail?: boolean;
  durationSeconds?: number;
  processingError?: string | null;
}

export async function seedReadyVideo(
  dataSource: DataSource,
  storage: StorageService,
  channelId: string,
  opts: SeedReadyVideoOptions = {},
): Promise<Video> {
  const id = randomUUID();
  const publicId = generatePublicId();
  const contentType = opts.contentType ?? 'video/mp4';
  const originalFilename = opts.originalFilename ?? 'aula.mp4';
  const storageKey = videoStorageKey(id, 'mp4');
  const withThumbnail = opts.withThumbnail ?? true;
  const durationSeconds = opts.durationSeconds ?? 2;

  const filePath = await createTestVideoFile(durationSeconds);
  const buffer = await fs.readFile(filePath);
  await storage.putObject(storageKey, buffer, contentType);
  await removeTestFile(filePath);

  let thumbnailKey: string | null = null;
  if (withThumbnail) {
    thumbnailKey = thumbnailStorageKey(id);
    await storage.putObject(
      thumbnailKey,
      Buffer.from(MINIMAL_JPEG_BASE64, 'base64'),
      'image/jpeg',
    );
  }

  const metadata: VideoMetadata = {
    width: 320,
    height: 240,
    codec: 'h264',
    bitrate: null,
    frame_rate: 15,
    format: 'mp4',
  };

  const videoRepository = dataSource.getRepository(Video);
  const video = videoRepository.create({
    id,
    channel_id: channelId,
    public_id: publicId,
    title: opts.title ?? 'Ready Video',
    status: VideoStatus.READY,
    original_filename: originalFilename,
    content_type: contentType,
    size_bytes: buffer.length,
    storage_key: storageKey,
    thumbnail_key: thumbnailKey,
    upload_id: null,
    duration_seconds: durationSeconds,
    metadata,
    processing_error: opts.processingError ?? null,
    processed_at: new Date(),
  });

  return videoRepository.save(video);
}

export interface TestUserSession {
  accessToken: string;
  userId: string;
  channelId: string;
  email: string;
}

export async function registerChannelAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<TestUserSession> {
  const authService = app.get(AuthService);
  const mailServiceInstance = (authService as any).mailService;
  let capturedToken = '';
  jest
    .spyOn(mailServiceInstance, 'sendConfirmationEmail')
    .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
      capturedToken = t;
    });

  const registerRes = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password });

  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: capturedToken });

  const loginRes = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password });

  const channelsService = app.get(ChannelsService);
  const channel = await channelsService.findByUserId(registerRes.body.id);
  if (!channel) {
    throw new Error('Channel was not created for the test user');
  }

  return {
    accessToken: loginRes.body.access_token as string,
    userId: registerRes.body.id as string,
    channelId: channel.id,
    email,
  };
}
