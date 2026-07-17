import { Module } from '@nestjs/common';
import { ProduceController } from './produce.controller';
import { AutomationController } from './automation.controller';
import { ScheduleService } from './schedule.service';
import { AutomationService } from './automation.service';
import { PostTargetService } from './post-target.service';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [AuthModule, StorageModule], // guard + StorageService (ký URL asset); Prisma global
  controllers: [ProduceController, AutomationController],
  providers: [ScheduleService, AutomationService, PostTargetService],
})
export class PublishModule {}
