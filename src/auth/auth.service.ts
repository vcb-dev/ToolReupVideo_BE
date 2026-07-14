import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly supabaseUrl = process.env.SUPABASE_URL;
  private readonly anonKey = process.env.SUPABASE_ANON_KEY;

  private ensureConfig() {
    if (!this.supabaseUrl || !this.anonKey) {
      throw new Error(
        'Thiếu SUPABASE_URL hoặc SUPABASE_ANON_KEY trong file .env của Backend',
      );
    }
  }

  // Đăng nhập: nhờ Supabase Auth kiểm tra email + mật khẩu.
  // Trả về access_token (JWT do Supabase ký) để FE dùng cho các request sau.
  async login(email: string, password: string) {
    this.ensureConfig();
    try {
      const res = await axios.post(
        `${this.supabaseUrl}/auth/v1/token?grant_type=password`,
        { email, password },
        {
          headers: {
            apikey: this.anonKey,
            'Content-Type': 'application/json',
          },
        },
      );
      const data = res.data;
      return {
        ok: true,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
        user: { id: data.user?.id, email: data.user?.email },
      };
    } catch (error) {
      const raw =
        error.response?.data?.error_description ||
        error.response?.data?.msg ||
        error.message;
      this.logger.warn(`Đăng nhập thất bại (${email}): ${raw}`);
      throw new UnauthorizedException(this.toVietnamese(raw));
    }
  }

  // Xác minh access_token với Supabase. Hợp lệ -> trả về thông tin user.
  async getUser(token: string) {
    this.ensureConfig();
    try {
      const res = await axios.get(`${this.supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: this.anonKey,
          Authorization: `Bearer ${token}`,
        },
      });
      return { id: res.data.id, email: res.data.email };
    } catch (error) {
      throw new UnauthorizedException(
        'Phiên đăng nhập không hợp lệ hoặc đã hết hạn',
      );
    }
  }

  private toVietnamese(msg: string): string {
    const m = msg || '';
    if (/invalid login credentials/i.test(m)) return 'Email hoặc mật khẩu không đúng';
    if (/email not confirmed/i.test(m)) return 'Tài khoản chưa xác nhận email';
    if (/rate limit/i.test(m)) return 'Bạn thử quá nhiều lần, vui lòng chờ ít phút';
    return m || 'Đăng nhập thất bại';
  }
}
