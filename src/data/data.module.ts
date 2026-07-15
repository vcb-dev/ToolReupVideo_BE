import { Module } from '@nestjs/common';
import { DataController } from './data.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule], // SupabaseAuthGuard; PrismaService lấy từ PrismaModule (global)
  controllers: [DataController],
})
export class DataModule {}
