import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ProxyModule } from './proxy/proxy.module';
import { AuthModule } from './auth/auth.module';
import { DataModule } from './data/data.module';
import { CrawlModule } from './crawl/crawl.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    AuthModule,
    ProxyModule,
    DataModule,
    CrawlModule,
  ],
})
export class AppModule {}
