import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { SupabaseAuthGuard } from './auth.guard';
import { AdminGuard } from './admin.guard';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Đăng nhập bằng email + mật khẩu (tài khoản do admin tạo trên Supabase)
  // Chống brute-force: tối đa 5 lần thử / 60 giây / IP.
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async login(@Body() body: { email: string; password: string }) {
    return this.authService.login(body?.email, body?.password);
  }

  // Gia hạn phiên bằng refresh_token (FE gọi khi access_token hết hạn)
  // Nới hơn login vì nhiều tab có thể refresh: tối đa 30 lần / 60 giây / IP.
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async refresh(@Body() body: { refresh_token: string }) {
    return this.authService.refresh(body?.refresh_token);
  }

  // Kiểm tra phiên hiện tại còn hợp lệ không (FE gọi khi tải trang)
  @Get('me')
  @UseGuards(SupabaseAuthGuard)
  async me(@Req() req: any) {
    return { ok: true, user: req.user };
  }

  // ---- Quản lý tài khoản nhân viên (chỉ admin) ----

  @Get('users')
  @UseGuards(SupabaseAuthGuard, AdminGuard)
  async listUsers() {
    return { ok: true, users: await this.authService.listUsers() };
  }

  @Post('users')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard, AdminGuard)
  async createUser(@Body() body: { email: string; password: string }) {
    const user = await this.authService.createUser(body?.email, body?.password);
    return { ok: true, user };
  }

  @Patch('users/:id')
  @UseGuards(SupabaseAuthGuard, AdminGuard)
  async updateUser(
    @Param('id') id: string,
    @Body() body: { email?: string; password?: string },
  ) {
    const user = await this.authService.updateUser(id, body);
    return { ok: true, user };
  }

  @Delete('users/:id')
  @UseGuards(SupabaseAuthGuard, AdminGuard)
  async deleteUser(@Param('id') id: string) {
    return this.authService.deleteUser(id);
  }
}
