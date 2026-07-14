import { Module } from '@nestjs/common';
import { ProxyModule } from './proxy/proxy.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [AuthModule, ProxyModule],
})
export class AppModule {}
