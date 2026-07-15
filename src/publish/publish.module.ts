import { Module } from '@nestjs/common';
import { ProduceController } from './produce.controller';
import { ScheduleService } from './schedule.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule], // guard; PrismaService từ PrismaModule (global)
  controllers: [ProduceController],
  providers: [ScheduleService],
})
export class PublishModule {}
