import { DataSource, Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  TEST_ENTITIES,
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video, VideoStatus } from './video.entity';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(TEST_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `video_chan_${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    return videoRepository.create({
      channel_id: channelId,
      public_id: 'abcdefghijk',
      title: 'My Video',
      original_filename: 'my-video.mp4',
      content_type: 'video/mp4',
      size_bytes: 123456,
      storage_key: 'videos/1/original.mp4',
      ...overrides,
    });
  }

  it('should enforce unique public_id constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id));

    const otherChannel = await createChannel();

    await expect(
      videoRepository.save(buildVideo(otherChannel.id)),
    ).rejects.toThrow();
  });

  it('should default status to draft when not provided', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel.id));

    expect(saved.status).toBe(VideoStatus.DRAFT);
  });

  it('should reject a status value outside the enum', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" (channel_id, public_id, title, status, original_filename, content_type, size_bytes, storage_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          channel.id,
          'zzzzzzzzzzz',
          'Title',
          'uploading',
          'file.mp4',
          'video/mp4',
          100,
          'videos/x/original.mp4',
        ],
      ),
    ).rejects.toThrow();
  });

  it('should enforce the foreign key to channels', async () => {
    await expect(
      videoRepository.save(buildVideo('00000000-0000-0000-0000-000000000000')),
    ).rejects.toThrow();
  });

  it('should round-trip size_bytes as a number', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      buildVideo(channel.id, { size_bytes: 10737418240 }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(10737418240);
    expect(typeof found.size_bytes).toBe('number');
  });

  it('should round-trip metadata as jsonb', async () => {
    const channel = await createChannel();
    const metadata = {
      width: 1920,
      height: 1080,
      codec: 'h264',
      bitrate: 5000,
      frame_rate: 30,
      format: 'mp4',
    };
    const saved = await videoRepository.save(
      buildVideo(channel.id, { metadata }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.metadata).toEqual(metadata);
  });

  it('should allow null metadata', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      buildVideo(channel.id, { metadata: null }),
    );

    expect(saved.metadata).toBeNull();
  });

  it('should auto-generate created_at and updated_at timestamps', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel.id));

    expect(saved.created_at).toBeInstanceOf(Date);
    expect(saved.updated_at).toBeInstanceOf(Date);
  });
});
