import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule], // SupabaseAuthGuard; PrismaService từ PrismaModule (global)
  controllers: [StatsController],
})
export class StatsModule {}
