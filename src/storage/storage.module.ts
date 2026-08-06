import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';
import { AiResultsService } from './ai-results.service';
import { StoragePlayController } from './play.controller';
import { MediaController } from './media.controller';
import { LocalFilesController } from './local-files.controller';
import { SourceUploadController } from './source-upload.controller';
import { UploadSweeperService } from './upload-sweeper.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule], // SupabaseAuthGuard cho Play/Media controller; Prisma từ PrismaModule (global)
  // 2 controller nội bộ ingest/processed đã BỎ: AI không gọi ngược BE nữa,
  // BE tự poll kết quả từ AI qua AiResultsService.
  controllers: [
    StorageController,
    StoragePlayController,
    MediaController,
    LocalFilesController, // /files/* — chỉ có tác dụng khi STORAGE_PROVIDER=local
    SourceUploadController, // người dùng tự tải video lên Kho
  ],
  providers: [StorageService, AiResultsService, UploadSweeperService],
  exports: [StorageService],
})
export class StorageModule {}
