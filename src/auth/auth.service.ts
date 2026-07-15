import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly supabaseUrl = process.env.SUPABASE_URL;
  private readonly anonKey = process.env.SUPABASE_ANON_KEY;
  private readonly serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  private ensureConfig() {
    if (!this.supabaseUrl || !this.anonKey) {
      throw new Error(
        'Thiếu SUPABASE_URL hoặc SUPABASE_ANON_KEY trong file .env của Backend',
      );
    }
  }

  // Email admin (được phép tạo/xóa tài khoản), khai báo trong ADMIN_EMAILS (ngăn cách bởi dấu phẩy).
  isAdmin(email?: string): boolean {
    if (!email) return false;
    const admins = (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    return admins.includes(email.toLowerCase());
  }

  private ensureAdminApi() {
    this.ensureConfig();
    if (!this.serviceKey) {
      throw new ServiceUnavailableException(
        'Chưa cấu hình SUPABASE_SERVICE_ROLE_KEY trong .env — không thể quản lý tài khoản.',
      );
    }
  }

  private adminHeaders() {
    return {
      apikey: this.serviceKey as string,
      Authorization: `Bearer ${this.serviceKey}`,
      'Content-Type': 'application/json',
    };
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
        user: {
          id: data.user?.id,
          email: data.user?.email,
          is_admin: this.isAdmin(data.user?.email),
        },
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
      return {
        id: res.data.id,
        email: res.data.email,
        is_admin: this.isAdmin(res.data.email),
      };
    } catch (error) {
      throw new UnauthorizedException(
        'Phiên đăng nhập không hợp lệ hoặc đã hết hạn',
      );
    }
  }

  // ---- Quản lý tài khoản nhân viên (Supabase Admin API, cần service role) ----

  async createUser(email: string, password: string) {
    this.ensureAdminApi();
    if (!email || !password || password.length < 6) {
      throw new BadRequestException(
        'Email hợp lệ và mật khẩu ≥ 6 ký tự là bắt buộc.',
      );
    }
    try {
      const res = await axios.post(
        `${this.supabaseUrl}/auth/v1/admin/users`,
        { email, password, email_confirm: true },
        { headers: this.adminHeaders() },
      );
      return { id: res.data.id, email: res.data.email };
    } catch (error) {
      const raw =
        error.response?.data?.msg ||
        error.response?.data?.error_description ||
        error.response?.data?.message ||
        error.message;
      this.logger.warn(`Tạo tài khoản thất bại (${email}): ${raw}`);
      throw new BadRequestException(
        /already|exists|registered/i.test(raw)
          ? 'Email này đã có tài khoản.'
          : raw,
      );
    }
  }

  async listUsers() {
    this.ensureAdminApi();
    const res = await axios.get(
      `${this.supabaseUrl}/auth/v1/admin/users?per_page=200`,
      { headers: this.adminHeaders() },
    );
    const users = res.data?.users || [];
    return users.map((u: any) => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      is_admin: this.isAdmin(u.email),
    }));
  }

  private async getUserById(id: string) {
    const res = await axios.get(
      `${this.supabaseUrl}/auth/v1/admin/users/${id}`,
      { headers: this.adminHeaders() },
    );
    return { id: res.data.id, email: res.data.email };
  }

  // Tài khoản admin được bảo vệ: không cho sửa/xóa qua giao diện.
  private async assertEditable(id: string) {
    const target = await this.getUserById(id);
    if (this.isAdmin(target.email)) {
      throw new ForbiddenException(
        'Tài khoản admin được bảo vệ — không thể sửa hoặc xóa.',
      );
    }
    return target;
  }

  async updateUser(
    id: string,
    changes: { email?: string; password?: string },
  ) {
    this.ensureAdminApi();
    await this.assertEditable(id);

    const body: Record<string, string> = {};
    if (changes.email?.trim()) body.email = changes.email.trim();
    if (changes.password) {
      if (changes.password.length < 6) {
        throw new BadRequestException('Mật khẩu mới phải ≥ 6 ký tự.');
      }
      body.password = changes.password;
    }
    if (Object.keys(body).length === 0) {
      throw new BadRequestException('Không có thông tin nào để cập nhật.');
    }

    try {
      const res = await axios.put(
        `${this.supabaseUrl}/auth/v1/admin/users/${id}`,
        body,
        { headers: this.adminHeaders() },
      );
      return { id: res.data.id, email: res.data.email };
    } catch (error) {
      const raw =
        error.response?.data?.msg ||
        error.response?.data?.message ||
        error.message;
      this.logger.warn(`Sửa tài khoản thất bại (${id}): ${raw}`);
      throw new BadRequestException(
        /already|exists|registered/i.test(raw)
          ? 'Email này đã có tài khoản khác dùng.'
          : raw,
      );
    }
  }

  async deleteUser(id: string) {
    this.ensureAdminApi();
    await this.assertEditable(id); // chặn xóa tài khoản admin
    await axios.delete(`${this.supabaseUrl}/auth/v1/admin/users/${id}`, {
      headers: this.adminHeaders(),
    });
    return { ok: true };
  }

  private toVietnamese(msg: string): string {
    const m = msg || '';
    if (/invalid login credentials/i.test(m)) return 'Email hoặc mật khẩu không đúng';
    if (/email not confirmed/i.test(m)) return 'Tài khoản chưa xác nhận email';
    if (/rate limit/i.test(m)) return 'Bạn thử quá nhiều lần, vui lòng chờ ít phút';
    return m || 'Đăng nhập thất bại';
  }
}
