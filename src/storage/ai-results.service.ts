import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import axios from 'axios';
import { CRON_ENABLED } from '../cron-guard';
import { PrismaService } from '../prisma/prisma.service';
import { upsertProcessed } from '../publish/processed-upsert';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';
/** Nhịp lấy kết quả từ AI. Đủ nhanh để UI thấy gần như tức thì, đủ thưa để không spam. */
const DRAIN_MS = 3_000;

/**
 * Lấy kết quả job từ AI về ghi DB.
 *
 * Luồng dữ liệu là MỘT CHIỀU: FE -> BE -> AI. AI không gọi ngược BE nữa; job
 * nền của AI xong thì xếp kết quả vào hàng đợi, BE ở đây chủ động poll
 * GET /api/pending, ghi DB, rồi POST /api/pending/ack để AI xoá mẻ đã ghi.
 *
 * Chỉ ack sau khi ghi DB THÀNH CÔNG -> BE chết giữa chừng thì lần sau lấy lại,
 * không mất dữ liệu. Đổi lại có thể ghi lặp, nên cả hai hàm ghi đều idempotent.
 */
@Injectable()
export class AiResultsService {
  private readonly logger = new Logger(AiResultsService.name);
  /** Chặn 2 lượt drain chồng nhau khi một lượt chạy lâu hơn DRAIN_MS. */
  private draining = false;
  /** Chỉ cảnh báo 1 lần khi AI không gọi được, tránh spam log mỗi 10 giây. */
  private warnedUnreachable = false;

  constructor(private readonly prisma: PrismaService) {}

  @Interval('drain-ai-results', DRAIN_MS)
  async drain(): Promise<void> {
    if (!CRON_ENABLED || this.draining || !this.prisma.enabled) return;
    this.draining = true;
    try {
      const { data } = await axios.get(`${AI_URL}/api/pending`, {
        timeout: 15_000,
      });
      this.warnedUnreachable = false;
      const batches: any[] = data?.batches || [];
      if (batches.length === 0) return;

      const acked: string[] = [];
      for (const b of batches) {
        try {
          if (b.kind === 'source') {
            const n = await this.saveSourceVideos(b.owner_id, b.records);
            this.logger.log(`Ghi ${n} source_videos từ AI.`);
          } else if (b.kind === 'processed') {
            const n = await this.saveProcessedVideos(b.owner_id, b.records);
            this.logger.log(`Ghi ${n} processed_videos từ AI.`);
          } else {
            // kind lạ -> vẫn ack để hàng đợi không bị kẹt mãi.
            this.logger.warn(`Bỏ qua mẻ kind lạ: ${b.kind}`);
          }
          acked.push(b.id);
        } catch (e: any) {
          // KHÔNG ack -> lần drain sau thử lại mẻ này.
          this.logger.error(`Ghi DB mẻ ${b.id} lỗi: ${e?.message}`);
        }
      }

      if (acked.length > 0) {
        await axios.post(
          `${AI_URL}/api/pending/ack`,
          { ids: acked },
          { timeout: 15_000 },
        );
      }
    } catch (e: any) {
      if (!this.warnedUnreachable) {
        this.warnedUnreachable = true;
        this.logger.warn(
          `Không lấy được kết quả từ AI (${e?.message}) — sẽ thử lại mỗi ${DRAIN_MS / 1000}s.`,
        );
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Ghi video đã tải+upload vào source_videos.
   * Idempotent nhờ unique (owner_id, platform, platform_video_id) + skipDuplicates.
   */
  async saveSourceVideos(ownerId: string, videos: any[]): Promise<number> {
    if (!ownerId || !videos?.length) return 0;
    const rows = videos.map((v) => ({
      platform: v.platform,
      platform_video_id: v.platform_video_id,
      descr: v.descr,
      cover_url: v.cover_url,
      original_url: v.original_url,
      drive_id: v.drive_id,
      topic: v.topic ?? null,
      owner_id: ownerId,
      status: 'new' as const,
    }));
    const res = await this.prisma.source_videos.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return res.count;
  }

  /**
   * Ghi video đã sản xuất vào processed_videos + đặt source status=done.
   *
   * Chống trùng bằng khoá (source_video_id, file đầu ra) — nay có unique index
   * thật ở DB (migration 0024) và `upsertProcessed` cập nhật dòng cũ thay vì
   * chèn thêm. Cần vậy vì NHIỀU tiến trình BE cùng poll AI /api/pending: bản cũ
   * "tìm trước, chèn sau" để lọt hai dòng y hệt nhau khi hai tiến trình chạy
   * song song (đo được 2026-08-21, created_at trùng tới mili giây).
   */
  async saveProcessedVideos(ownerId: string, items: any[]): Promise<number> {
    if (!ownerId || !items?.length) return 0;
    let inserted = 0;
    for (const it of items) {
      if (!it.source_id) continue;
      // Chỉ ghi cho source video thuộc đúng user (chống ghi nhầm owner).
      const sv = await this.prisma.source_videos.findFirst({
        where: { id: it.source_id, owner_id: ownerId },
      });
      if (!sv) continue;

      await upsertProcessed(this.prisma, {
        owner_id: ownerId,
        source_video_id: sv.id,
        final_path: it.final_path ?? null,
        final_drive_id: it.final_drive_id ?? null,
        target_lang: it.target_lang ?? 'vi',
        voice_id: it.voice_id ?? null,
        has_subtitle: !!it.has_subtitle,
        ai_caption: it.ai_caption ?? null,
      });
      await this.prisma.source_videos.update({
        where: { id: sv.id },
        data: { status: 'done' },
      });
      inserted += 1;
    }
    return inserted;
  }
}
