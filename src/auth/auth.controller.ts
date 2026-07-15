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
import { AuthService } from './auth.service';
import { SupabaseAuthGuard } from './auth.guard';
import { AdminGuard } from './admin.guard';

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
