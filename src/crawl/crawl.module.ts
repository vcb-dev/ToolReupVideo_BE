import { Module } from '@nestjs/common';
import { CrawlController } from './crawl.controller';
import { CrawlService } from './crawl.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule], // guard; PrismaService từ PrismaModule (global)
  controllers: [CrawlController],
  providers: [CrawlService],
})
export class CrawlModule {}
