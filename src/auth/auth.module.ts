import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SupabaseAuthGuard } from './auth.guard';
import { AdminGuard } from './admin.guard';
import { DeletePinService } from './delete-pin.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SupabaseAuthGuard, AdminGuard, DeletePinService],
  // Xuất ra để ProxyModule/DataModule/StorageModule dùng chung guard + kiểm PIN xoá
  exports: [AuthService, SupabaseAuthGuard, AdminGuard, DeletePinService],
})
export class AuthModule {}
