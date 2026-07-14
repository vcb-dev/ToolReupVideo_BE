import { Module } from '@nestjs/common';
import { CrawlController } from './crawl.controller';
import { CrawlService } from './crawl.service';
import { SupabaseAdminService } from './supabase-admin.service';
import { SupabaseRestService } from '../data/supabase-rest.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule], // dùng chung SupabaseAuthGuard
  controllers: [CrawlController],
  providers: [CrawlService, SupabaseAdminService, SupabaseRestService],
})
export class CrawlModule {}
