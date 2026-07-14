import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SupabaseAuthGuard } from './auth.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SupabaseAuthGuard],
  // Xuất ra để ProxyModule dùng chung guard bảo vệ route xử lý video
  exports: [AuthService, SupabaseAuthGuard],
})
export class AuthModule {}
