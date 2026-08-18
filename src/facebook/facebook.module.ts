import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { FacebookController } from './facebook.controller';
import { FacebookService } from './facebook.service';
import { PendingSweeperService } from './pending-sweeper.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [FacebookController],
  providers: [FacebookService, PendingSweeperService],
  exports: [FacebookService],
})
export class FacebookModule {}
