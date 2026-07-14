import { Module } from '@nestjs/common';
import { DataController } from './data.controller';
import { SupabaseRestService } from './supabase-rest.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule], // dùng chung SupabaseAuthGuard
  controllers: [DataController],
  providers: [SupabaseRestService],
})
export class DataModule {}
