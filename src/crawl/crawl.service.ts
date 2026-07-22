import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';
// Số video tối đa lấy mỗi kênh khi cào tự động. Chỉ là mặc định, không phải
// secret nên để hằng số trong code thay vì biến môi trường.
const DEFAULT_MAX = 10;

type Channel = {
  id: string;
  owner_id: string;
  platform: string;
  channel_ref: string;
};

@Injectable()
export class CrawlService {
  private readonly logger = new Logger(CrawlService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Gọi AI service cào 1 kênh -> bản ghi source_videos (gắn owner/channel) +
   * meta kênh (avatar/tên/follow/số video/bio) để làm giàu bảng channels.
   */
  private async crawlFromAi(
    channel: Channel,
    max: number,
  ): Promise<{ rows: any[]; meta: any }> {
    const res = await axios.post(
      `${AI_URL}/api/crawl`,
      { platform: channel.platform, user: channel.channel_ref, max },
      { timeout: 1000 * 60 * 30 },
    );
    if (!res.data?.ok) {
      throw new Error(res.data?.error || 'AI service cào thất bại');
    }
    const rows = (res.data.videos || []).map((v: any) => ({
      platform: v.platform,
      platform_video_id: v.platform_video_id,
      descr: v.descr,
      cover_url: v.cover_url,
      original_url: v.original_url,
      drive_id: v.drive_id,
      // Ngày đăng gốc (ISO từ AI). Null nếu nguồn không có -> reup không xét.
      published_at: v.published_at ?? null,
      owner_id: channel.owner_id,
      channel_id: channel.id,
      status: 'new',
    }));
    return { rows, meta: res.data.channel || {} };
  }

  /** Chỉ giữ các khoá meta có giá trị -> không ghi đè dữ liệu cũ bằng rỗng/0. */
  private channelMetaUpdate(meta: any): Record<string, any> {
    const data: Record<string, any> = {};
    if (meta?.display_name) data.display_name = meta.display_name;
    if (meta?.avatar_url) data.avatar_url = meta.avatar_url;
    if (meta?.follower_count) data.follower_count = Number(meta.follower_count);
    if (meta?.video_count) data.video_count = Number(meta.video_count);
    if (meta?.bio) data.bio = meta.bio;
    if (meta?.topic) data.topic = meta.topic;
    return data;
  }

  /**
   * Cào 1 kênh và lưu vào source_videos (bỏ qua trùng theo unique
   * owner_id/platform/platform_video_id). Dùng chung cho nút "Cào ngay" & cron.
   */
  async crawlChannel(
    channel: Channel,
    max = DEFAULT_MAX,
  ): Promise<{ inserted: number }> {
    const { rows, meta } = await this.crawlFromAi(channel, max);
    const res = await this.prisma.source_videos.createMany({
      data: rows,
      skipDuplicates: true,
    });
    await this.prisma.channels.update({
      where: { id: channel.id },
      data: { last_crawled_at: new Date(), ...this.channelMetaUpdate(meta) },
    });
    return { inserted: res.count };
  }

  /** Cron: mỗi ngày cào toàn bộ kênh đang theo dõi (mọi user). */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'daily-crawl' })
  async runDailyCrawl(): Promise<void> {
    if (!this.prisma.enabled) {
      this.logger.warn(
        'Bỏ qua cron: thiếu DATABASE_URL trong .env (cron cần kết nối DB để chạy nền).',
      );
      return;
    }
    let channels: Channel[] = [];
    try {
      channels = (await this.prisma.channels.findMany({
        where: { is_monitored: true },
      })) as unknown as Channel[];
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
        this.logger.error(`Cào lỗi kênh ${ch.channel_ref}: ${e.message}`);
      }
    }
  }
}
