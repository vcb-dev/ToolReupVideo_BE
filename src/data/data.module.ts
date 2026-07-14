import { Module } from '@nestjs/common';
import { DataController } from './data.controller';
import { SupabaseRestService } from './supabase-rest.service';
import { SupabaseAdminService } from './supabase-admin.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule], // dùng chung SupabaseAuthGuard
  controllers: [DataController],
  providers: [SupabaseRestService, SupabaseAdminService],
  // Xuất để CrawlModule / PublishModule dùng lại (REST theo user + admin service-role)
  exports: [SupabaseRestService, SupabaseAdminService],
})
export class DataModule {}
