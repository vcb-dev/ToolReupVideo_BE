import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { SupabaseRestService } from '../data/supabase-rest.service';
import { SupabaseAdminService } from './supabase-admin.service';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';
const DEFAULT_MAX = Number(process.env.CRAWL_MAX_PER_CHANNEL || 10);
const CONFLICT = 'owner_id,platform,platform_video_id';

type Channel = {
  id: string;
  owner_id: string;
  platform: string;
  channel_ref: string;
};

@Injectable()
export class CrawlService {
  private readonly logger = new Logger(CrawlService.name);

  constructor(
    private readonly rest: SupabaseRestService,
    private readonly admin: SupabaseAdminService,
  ) {}

  /** Gọi AI service cào 1 kênh -> trả về bản ghi source_videos (chưa có owner/channel). */
  private async crawlFromAi(channel: Channel, max: number): Promise<any[]> {
    const res = await axios.post(
      `${AI_URL}/api/crawl`,
      { platform: channel.platform, user: channel.channel_ref, max },
      { timeout: 1000 * 60 * 30 },
    );
    if (!res.data?.ok) {
      throw new Error(res.data?.error || 'AI service cào thất bại');
    }
    return (res.data.videos || []).map((v: any) => ({
      ...v,
      owner_id: channel.owner_id,
      channel_id: channel.id,
      status: 'new',
    }));
  }

  /**
   * Cào 1 kênh và lưu vào source_videos.
   * - token có: đường user (RLS áp theo user) — dùng cho nút "Cào ngay".
   * - token trống: đường admin (service role) — dùng cho cron.
   */
  async crawlChannel(
    channel: Channel,
    token?: string,
    max = DEFAULT_MAX,
  ): Promise<{ inserted: number }> {
    const rows = await this.crawlFromAi(channel, max);
    let inserted: any[] = [];
    if (token) {
      inserted = await this.rest.insertIgnore(
        token,
        'source_videos',
        rows,
        CONFLICT,
      );
      await this.rest.update(token, 'channels', channel.id, {
        last_crawled_at: new Date().toISOString(),
      });
    } else {
      inserted = await this.admin.insertSourceVideos(rows);
      await this.admin.touchChannel(channel.id);
    }
    return { inserted: inserted?.length ?? 0 };
  }

  /** Cron: mỗi ngày cào toàn bộ kênh đang theo dõi (mọi user). */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'daily-crawl' })
  async runDailyCrawl(): Promise<void> {
    if (!this.admin.enabled) {
      this.logger.warn(
        'Bỏ qua cron: thiếu SUPABASE_SERVICE_ROLE_KEY trong .env (cron cần key này để chạy nền).',
      );
      return;
    }
    let channels: Channel[] = [];
    try {
      channels = await this.admin.listMonitoredChannels();
    } catch (e: any) {
      this.logger.error(`Không đọc được danh sách kênh: ${e.message}`);
      return;
    }
    this.logger.log(`Cron cào hằng ngày: ${channels.length} kênh theo dõi.`);
    for (const ch of channels) {
      try {
        const { inserted } = await this.crawlChannel(ch);
        this.logger.log(
          `[${ch.platform}] ${ch.channel_ref}: +${inserted} video mới.`,
        );
      } catch (e: any) {
        this.logger.error(
          `Cào lỗi kênh ${ch.channel_ref}: ${e.message}`,
        );
      }
    }
  }
}
