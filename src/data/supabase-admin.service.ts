import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * Truy cập Supabase bằng SERVICE ROLE KEY — bỏ qua RLS. Chỉ dùng cho tác vụ nền
 * (cron) chạy không có phiên user, cần đọc/ghi dữ liệu của nhiều user.
 * ⚠️ Tuyệt đối không để lộ key này ra FE.
 */
@Injectable()
export class SupabaseAdminService {
  private readonly logger = new Logger(SupabaseAdminService.name);
  private readonly url = process.env.SUPABASE_URL;
  private readonly serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  /** Có cấu hình service key hay không (cron sẽ no-op nếu thiếu). */
  get enabled(): boolean {
    return !!this.url && !!this.serviceKey;
  }

  private headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.serviceKey as string,
      Authorization: `Bearer ${this.serviceKey}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  private base() {
    return `${this.url}/rest/v1`;
  }

  /** Mọi kênh đang bật theo dõi tự động (tất cả user). */
  async listMonitoredChannels(): Promise<any[]> {
    const res = await axios.get(
      `${this.base()}/channels?is_monitored=eq.true&select=*`,
      { headers: this.headers() },
    );
    return res.data || [];
  }

  /** Chèn video nguồn, bỏ qua trùng (owner_id, platform, platform_video_id). */
  async insertSourceVideos(rows: Record<string, unknown>[]): Promise<any[]> {
    if (!rows.length) return [];
    const res = await axios.post(
      `${this.base()}/source_videos?on_conflict=owner_id,platform,platform_video_id`,
      rows,
      {
        headers: this.headers({
          Prefer: 'resolution=ignore-duplicates,return=representation',
        }),
      },
    );
    return res.data || [];
  }

  /** Đánh dấu kênh vừa được cào. */
  async touchChannel(id: string): Promise<void> {
    await axios.patch(
      `${this.base()}/channels?id=eq.${id}`,
      { last_crawled_at: new Date().toISOString() },
      { headers: this.headers() },
    );
  }

  /** SELECT generic (bỏ qua RLS) — dùng cho cron lịch đăng. */
  async select(table: string, query: string): Promise<any[]> {
    const res = await axios.get(`${this.base()}/${table}?${query}`, {
      headers: this.headers(),
    });
    return res.data || [];
  }

  /** UPDATE generic theo id (bỏ qua RLS). */
  async patch(
    table: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await axios.patch(`${this.base()}/${table}?id=eq.${id}`, body, {
      headers: this.headers(),
    });
  }
}
