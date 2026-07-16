import { Module } from '@nestjs/common';
import { ProduceController } from './produce.controller';
import { ScheduleService } from './schedule.service';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [AuthModule, StorageModule], // guard + StorageService (ký URL asset); Prisma global
  controllers: [ProduceController],
  providers: [ScheduleService],
})
export class PublishModule {}
