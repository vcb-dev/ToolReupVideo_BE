import { Module } from '@nestjs/common';
import { DataController } from './data.controller';
import { TopicsController } from './topics.controller';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  // AuthModule: SupabaseAuthGuard. StorageModule: xoá file gốc kèm bản ghi.
  // PrismaService lấy từ PrismaModule (global).
  imports: [AuthModule, StorageModule],
  controllers: [DataController, TopicsController],
})
export class DataModule {}
