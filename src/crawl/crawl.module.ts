import { Module } from '@nestjs/common';
import { CrawlController } from './crawl.controller';
import { CrawlService } from './crawl.service';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [AuthModule, StorageModule], // guard + ký link ảnh bìa; Prisma từ PrismaModule (global)
  controllers: [CrawlController],
  providers: [CrawlService],
})
export class CrawlModule {}
