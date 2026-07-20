import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';
import { AiResultsService } from './ai-results.service';
import { StoragePlayController } from './play.controller';
import { MediaController } from './media.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule], // SupabaseAuthGuard cho Play/Media controller; Prisma từ PrismaModule (global)
  // 2 controller nội bộ ingest/processed đã BỎ: AI không gọi ngược BE nữa,
  // BE tự poll kết quả từ AI qua AiResultsService.
  controllers: [StorageController, StoragePlayController, MediaController],
  providers: [StorageService, AiResultsService],
  exports: [StorageService],
})
export class StorageModule {}
