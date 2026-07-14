import { Module } from '@nestjs/common';
import { CrawlController } from './crawl.controller';
import { CrawlService } from './crawl.service';
import { AuthModule } from '../auth/auth.module';
import { DataModule } from '../data/data.module';

@Module({
  imports: [AuthModule, DataModule], // guard + SupabaseRest/Admin dùng chung
  controllers: [CrawlController],
  providers: [CrawlService],
})
export class CrawlModule {}
