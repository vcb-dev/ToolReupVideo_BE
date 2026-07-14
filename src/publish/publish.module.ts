import { Module } from '@nestjs/common';
import { ProduceController } from './produce.controller';
import { ScheduleService } from './schedule.service';
import { AuthModule } from '../auth/auth.module';
import { DataModule } from '../data/data.module';

@Module({
  imports: [AuthModule, DataModule],
  controllers: [ProduceController],
  providers: [ScheduleService],
})
export class PublishModule {}
