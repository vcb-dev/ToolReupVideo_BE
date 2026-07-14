import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { SupabaseAuthGuard } from './auth.guard';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Đăng nhập bằng email + mật khẩu (tài khoản do admin tạo trên Supabase)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: { email: string; password: string }) {
    return this.authService.login(body?.email, body?.password);
  }

  // Kiểm tra phiên hiện tại còn hợp lệ không (FE gọi khi tải trang)
  @Get('me')
  @UseGuards(SupabaseAuthGuard)
  async me(@Req() req: any) {
    return { ok: true, user: req.user };
  }
}
