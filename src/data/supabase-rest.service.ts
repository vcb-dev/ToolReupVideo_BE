import {
  BadGatewayException,
  Injectable,
  Logger,
} from '@nestjs/common';
import axios from 'axios';

/**
 * Gọi Supabase PostgREST (`/rest/v1`) dưới danh nghĩa user đang đăng nhập.
 * Vì đính JWT của user nên Row Level Security tự lọc theo owner_id — không cần
 * service_role key ở tầng này.
 */
@Injectable()
export class SupabaseRestService {
  private readonly logger = new Logger(SupabaseRestService.name);
  private readonly url = process.env.SUPABASE_URL;
  private readonly anonKey = process.env.SUPABASE_ANON_KEY;

  private base() {
    if (!this.url || !this.anonKey) {
      throw new BadGatewayException(
        'Thiếu SUPABASE_URL hoặc SUPABASE_ANON_KEY trong .env của Backend',
      );
    }
    return `${this.url}/rest/v1`;
  }

  private headers(token: string, extra: Record<string, string> = {}) {
    return {
      apikey: this.anonKey as string,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  private fail(err: any): never {
    const detail =
      err?.response?.data?.message ||
      err?.response?.data?.hint ||
      err?.message ||
      'Lỗi không rõ';
    this.logger.warn(`Supabase REST lỗi: ${JSON.stringify(err?.response?.data ?? detail)}`);
    throw new BadGatewayException(`Truy vấn Supabase thất bại: ${detail}`);
  }

  /** Danh sách, mặc định sắp xếp mới nhất trước. */
  async list(token: string, table: string, query = 'order=created_at.desc') {
    try {
      const res = await axios.get(`${this.base()}/${table}?${query}`, {
        headers: this.headers(token),
      });
      return res.data;
    } catch (err) {
      this.fail(err);
    }
  }

  /** Tạo mới; trả về bản ghi vừa tạo. */
  async create(token: string, table: string, body: Record<string, unknown>) {
    try {
      const res = await axios.post(`${this.base()}/${table}`, body, {
        headers: this.headers(token, { Prefer: 'return=representation' }),
      });
      return Array.isArray(res.data) ? res.data[0] : res.data;
    } catch (err) {
      this.fail(err);
    }
  }

  /** Chèn nhiều dòng, bỏ qua dòng trùng theo `onConflict` (unique constraint). */
  async insertIgnore(
    token: string,
    table: string,
    rows: Record<string, unknown>[],
    onConflict: string,
  ) {
    if (!rows.length) return [];
    try {
      const res = await axios.post(
        `${this.base()}/${table}?on_conflict=${onConflict}`,
        rows,
        {
          headers: this.headers(token, {
            Prefer: 'resolution=ignore-duplicates,return=representation',
          }),
        },
      );
      return res.data;
    } catch (err) {
      this.fail(err);
    }
  }

  /** Cập nhật theo id; trả về bản ghi sau cập nhật. */
  async update(
    token: string,
    table: string,
    id: string,
    body: Record<string, unknown>,
  ) {
    try {
      const res = await axios.patch(
        `${this.base()}/${table}?id=eq.${id}`,
        body,
        { headers: this.headers(token, { Prefer: 'return=representation' }) },
      );
      return Array.isArray(res.data) ? res.data[0] : res.data;
    } catch (err) {
      this.fail(err);
    }
  }

  /** Xóa theo id. */
  async remove(token: string, table: string, id: string) {
    try {
      await axios.delete(`${this.base()}/${table}?id=eq.${id}`, {
        headers: this.headers(token),
      });
      return { ok: true };
    } catch (err) {
      this.fail(err);
    }
  }
}
