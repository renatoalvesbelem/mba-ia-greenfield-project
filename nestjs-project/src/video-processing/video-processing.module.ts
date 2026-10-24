import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaModule } from '../media/media.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video-processor';

@Module({
  imports: [
    QueueModule,
    StorageModule,
    MediaModule,
    UsersModule,
    TypeOrmModule.forFeature([Video]),
  ],
  providers: [VideoProcessingService, VideoProcessor],
})
export class VideoProcessingModule {}
