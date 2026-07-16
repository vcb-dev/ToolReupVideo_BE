import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { ProxyModule } from './proxy/proxy.module';
import { AuthModule } from './auth/auth.module';
import { DataModule } from './data/data.module';
import { CrawlModule } from './crawl/crawl.module';
import { PublishModule } from './publish/publish.module';
import { StatsModule } from './stats/stats.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    // Rate limit mặc định: 100 request / 60 giây / IP (áp cho route nào gắn
    // ThrottlerGuard). Route nhạy cảm (login/refresh) siết chặt hơn bằng @Throttle.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    PrismaModule,
    AuthModule,
    ProxyModule,
    DataModule,
    CrawlModule,
    PublishModule,
    StatsModule,
    StorageModule,
  ],
})
export class AppModule {}
