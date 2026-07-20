import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import axios from 'axios';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/** Key trong bảng app_config chứa danh sách email admin (ngăn cách bởi dấu phẩy). */
const ADMIN_CONFIG_KEY = 'admin_emails';
/** Chu kỳ làm mới danh sách admin từ DB (để thêm/bớt admin không cần deploy lại). */
const ADMIN_REFRESH_MS = 60_000;
/** Khoảng cách tối thiểu giữa 2 lần tải JWKS (chặn spam khi gặp kid lạ liên tục). */
const JWKS_MIN_REFETCH_MS = 60_000;

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  private readonly logger = new Logger(AuthService.name);
  private readonly supabaseUrl = process.env.SUPABASE_URL;
  private readonly anonKey = process.env.SUPABASE_ANON_KEY;
  private readonly serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Lưu ý: giá trị này PHẢI khớp JWT Secret của Supabase
  // (Dashboard -> Settings -> API -> JWT Secret) — không được tự sinh chuỗi mới.
  private readonly jwtSecret = process.env.JWT_SECRET;
  // Chỉ log 1 lần khi phải rơi về gọi mạng, để không spam.
  private warnedLocalFail = false;
  // Cache public key của Supabase theo kid (dùng khi project bật khoá bất đối xứng).
  private readonly jwks = new Map<string, crypto.KeyObject>();
  private jwksFetchedAt = 0;

  // Danh sách admin hiện tại = ADMIN_EMAILS (env, admin gốc) ∪ app_config.admin_emails (DB).
  // Cache trong RAM để isAdmin() vẫn đồng bộ, không query DB mỗi lần gọi.
  private adminSet = this.envAdmins();

  private ensureConfig() {
    if (!this.supabaseUrl || !this.anonKey) {
      throw new Error(
        'Thiếu SUPABASE_URL hoặc SUPABASE_ANON_KEY trong file .env của Backend',
      );
    }
  }

  async onModuleInit() {
    await this.refreshAdmins();
    // Làm mới định kỳ để thay đổi admin trong DB tự có hiệu lực (không cần deploy lại).
    const t = setInterval(() => {
      void this.refreshAdmins();
    }, ADMIN_REFRESH_MS);
    // Không giữ tiến trình sống chỉ vì timer này.
    if (typeof t.unref === 'function') t.unref();
  }

  /** Admin gốc lấy từ biến môi trường ADMIN_EMAILS — luôn có, đảm bảo không bao giờ "trống admin". */
  private envAdmins(): Set<string> {
    return new Set(
      (process.env.ADMIN_EMAILS || '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  /** Nạp lại danh sách admin = env (bootstrap) ∪ app_config.admin_emails (DB). */
  private async refreshAdmins(): Promise<void> {
    const set = this.envAdmins();
    try {
      const row = await this.prisma.app_config.findUnique({
        where: { key: ADMIN_CONFIG_KEY },
      });
      for (const e of (row?.value || '')
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean)) {
        set.add(e);
      }
    } catch {
      // DB chưa sẵn sàng -> vẫn dùng danh sách env.
    }
    this.adminSet = set;
  }

  // Email admin (được phép tạo/xóa tài khoản). Nguồn: ADMIN_EMAILS (env) + app_config (DB).
  isAdmin(email?: string): boolean {
    if (!email) return false;
    return this.adminSet.has(email.toLowerCase());
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

  // Gia hạn phiên: dùng refresh_token để lấy access_token mới từ Supabase.
  // FE gọi khi access_token cũ hết hạn để không phải đăng nhập lại.
  async refresh(refreshToken: string) {
    this.ensureConfig();
    if (!refreshToken) {
      throw new UnauthorizedException('Thiếu refresh_token');
    }
    try {
      const res = await axios.post(
        `${this.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
        { refresh_token: refreshToken },
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
      this.logger.warn(`Gia hạn phiên thất bại: ${raw}`);
      throw new UnauthorizedException(
        'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại',
      );
    }
  }

  // Xác minh access_token với Supabase. Hợp lệ -> trả về thông tin user.
  /**
   * Xác thực token -> {id, email, is_admin}.
   *
   * Ưu tiên VERIFY TẠI CHỖ bằng JWT_SECRET (~0ms, không gọi mạng) —
   * đây là điểm chậm nhất cũ: mỗi request tốn ~340ms hỏi Supabase. Nếu verify
   * tại chỗ hỏng vì BẤT KỲ lý do gì (chưa cấu hình secret, project dùng khoá bất
   * đối xứng, claim lạ...) thì TỰ RƠI VỀ gọi mạng như cũ — không bao giờ khoá
   * nhầm user ra. Token HẾT HẠN hoặc SAI CHỮ KÝ vẫn bị từ chối đúng đắn.
   */
  async getUser(token: string) {
    this.ensureConfig();

    const local = await this.verifyLocally(token);
    if (local) return local;

    // Fallback: hỏi thẳng Supabase (đường cũ, luôn đúng nhưng chậm).
    try {
      const res = await axios.get(`${this.supabaseUrl}/auth/v1/user`, {
        headers: { apikey: this.anonKey, Authorization: `Bearer ${token}` },
      });
      return {
        id: res.data.id,
        email: res.data.email,
        is_admin: this.isAdmin(res.data.email),
      };
    } catch {
      throw new UnauthorizedException(
        'Phiên đăng nhập không hợp lệ hoặc đã hết hạn',
      );
    }
  }

  /**
   * Verify chữ ký + hạn token bằng JWT secret. Trả user nếu HỢP LỆ; null nếu
   * KHÔNG verify tại chỗ được (thiếu secret / khác thuật toán) để caller fallback.
   * Token hết hạn / sai chữ ký -> ném UnauthorizedException (từ chối luôn, KHÔNG
   * fallback, vì gọi mạng cũng sẽ từ chối).
   */
  private async verifyLocally(
    token: string,
  ): Promise<{ id: string; email?: string; is_admin: boolean } | null> {
    // Chọn khoá theo `alg` GHI TRONG HEADER của token, không đoán:
    //   HS256          -> JWT_SECRET (khoá đối xứng, kiểu cũ của Supabase)
    //   ES256/RS256... -> public key lấy từ JWKS (Supabase "JWT signing keys")
    // Trước đây code ép cứng HS256, nên project bật khoá bất đối xứng sẽ nhận
    // 'invalid algorithm' và bị từ chối nhầm -> 401 toàn bộ.
    let header: any;
    try {
      header = (jwt.decode(token, { complete: true }) as any)?.header;
    } catch {
      return null;
    }
    if (!header?.alg) return null;

    let key: jwt.Secret | crypto.KeyObject;
    if (header.alg === 'HS256') {
      if (!this.jwtSecret) return null; // chưa cấu hình -> để fallback
      key = this.jwtSecret;
    } else {
      const pub = await this.jwksKey(header.kid);
      if (!pub) return null; // không lấy được khoá công khai -> để fallback
      key = pub;
    }

    try {
      const payload = jwt.verify(token, key as any, {
        algorithms: [header.alg],
      }) as jwt.JwtPayload;
      if (!payload.sub) return null; // claim lạ -> fallback cho chắc
      return {
        id: String(payload.sub),
        email: payload.email as string | undefined,
        is_admin: this.isAdmin(payload.email as string | undefined),
      };
    } catch (e: any) {
      // CHỈ từ chối thẳng khi token thực sự hỏng: hết hạn hoặc sai chữ ký.
      // Mọi lỗi khác (khoá/thuật toán không khớp cấu hình) -> rơi về gọi mạng,
      // để một sai sót cấu hình không khoá toàn bộ người dùng ra ngoài.
      const bad =
        e?.name === 'TokenExpiredError' ||
        /invalid signature/i.test(e?.message || '');
      if (bad) {
        throw new UnauthorizedException(
          'Phiên đăng nhập không hợp lệ hoặc đã hết hạn',
        );
      }
      if (!this.warnedLocalFail) {
        this.warnedLocalFail = true;
        this.logger.warn(
          `Verify JWT tại chỗ không dùng được (${e?.message}) -> tạm rơi về gọi mạng. ` +
            `Kiểm tra JWT_SECRET (phải khớp JWT Secret của Supabase).`,
        );
      }
      return null;
    }
  }

  /**
   * Lấy public key theo `kid` từ JWKS của Supabase (có cache).
   * Chỉ tải lại khi gặp kid chưa biết, và không tải quá dày để tránh spam.
   */
  private async jwksKey(kid?: string): Promise<crypto.KeyObject | null> {
    if (!kid) return null;
    const cached = this.jwks.get(kid);
    if (cached) return cached;
    if (Date.now() - this.jwksFetchedAt < JWKS_MIN_REFETCH_MS) return null;
    this.jwksFetchedAt = Date.now();
    try {
      const res = await axios.get(
        `${this.supabaseUrl}/auth/v1/.well-known/jwks.json`,
        { timeout: 5000 },
      );
      const keys: any[] = res.data?.keys || [];
      this.jwks.clear();
      for (const k of keys) {
        if (!k?.kid) continue;
        try {
          this.jwks.set(
            k.kid,
            crypto.createPublicKey({ key: k, format: 'jwk' }),
          );
        } catch {
          // khoá lạ -> bỏ qua, các khoá còn lại vẫn dùng được
        }
      }
      this.logger.log(`Đã nạp ${this.jwks.size} khoá công khai từ JWKS.`);
    } catch (e: any) {
      this.logger.warn(`Không tải được JWKS (${e?.message}) -> rơi về gọi mạng.`);
    }
    return this.jwks.get(kid) || null;
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
