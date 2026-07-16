import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';
import { IngestInternalController } from './ingest.controller';
import { ProcessedInternalController } from './processed.controller';
import { StoragePlayController } from './play.controller';
import { MediaController } from './media.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule], // SupabaseAuthGuard cho Play/Media controller; Prisma từ PrismaModule (global)
  controllers: [
    StorageController,
    IngestInternalController,
    ProcessedInternalController,
    StoragePlayController,
    MediaController,
  ],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
