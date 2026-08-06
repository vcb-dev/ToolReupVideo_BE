import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [AuthModule, StorageModule], // StorageModule: dọn ảnh bìa của video tải lên
  controllers: [ProxyController],
  providers: [ProxyService],
})
export class ProxyModule {}
