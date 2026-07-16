import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly aiUrl = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';

  constructor(private readonly prisma: PrismaService) {}

  async getState() {
    try {
      const response = await axios.get(`${this.aiUrl}/api/state`);
      return response.data;
    } catch (error) {
      this.logger.error(`Error fetching state from AI Service: ${error.message}`);
      return {
        job: { running: false, kind: null, current: null, done: false, error: 'Không thể kết nối dịch vụ AI' },
        log: [`Lỗi: ${error.message}`],
        videos: [],
        default_platforms: ['facebook'],
        config_ok: false,
        config_error: `Dịch vụ AI (Python) chưa chạy hoặc lỗi: ${error.message}`,
      };
    }
  }

  async ingest(user: string, max: number, platform = 'douyin') {
    try {
      const response = await axios.post(`${this.aiUrl}/api/ingest`, {
        user,
        max,
        platform,
      });
      return response.data;
    } catch (error) {
      this.logger.error(`Error calling ingest on AI Service: ${error.message}`);
      return {
        ok: false,
        error: error.response?.data?.error || `Không thể kết nối dịch vụ AI: ${error.message}`,
      };
    }
  }

  async scan(user: string, max: number, platform = 'douyin') {
    try {
      const response = await axios.post(`${this.aiUrl}/api/scan`, {
        user,
        max,
        platform,
      });
      return response.data;
    } catch (error) {
      this.logger.error(`Error calling scan on AI Service: ${error.message}`);
      return {
        ok: false,
        error:
          error.response?.data?.error ||
          `Không thể kết nối dịch vụ AI: ${error.message}`,
      };
    }
  }

  /**
   * Lưu video đã chọn: bắn sang AI job NỀN (tải+upload) rồi TRẢ VỀ NGAY để nút
   * không bị treo. AI xong sẽ gọi ngược /internal/source-videos ghi DB (kèm
   * owner_id). Truyền owner_id xuống AI để job nền biết ghi cho user nào.
   */
  async save(platform: string, videos: any[], ownerId: string, topic?: string) {
    try {
      const response = await axios.post(`${this.aiUrl}/api/save`, {
        platform,
        videos,
        owner_id: ownerId,
        topic: topic ?? null,
      });
      return response.data;
    } catch (error) {
      this.logger.error(`Error calling save on AI Service: ${error.message}`);
      return {
        ok: false,
        error:
          error.response?.data?.error ||
          `Không thể kết nối dịch vụ AI: ${error.message}`,
      };
    }
  }

  /**
   * Xoá 1 video khỏi kho — dọn CẢ 3 nơi trong 1 thao tác:
   *   1) AI: xoá file trên storage (R2/Supabase qua gateway) + bỏ khỏi manifest
   *   2) DB: xoá dòng source_videos của user (theo platform_video_id)
   * File/manifest là best-effort (đã xoá tay cũng không lỗi); DB xoá theo owner.
   */
  async deleteVideo(awemeId: string, ownerId: string) {
    if (!awemeId) {
      return { ok: false, error: 'Thiếu aweme_id.' };
    }
    // Tra drive_id từ DB trước — video cron cào chỉ có trong DB (không có trong
    // manifest AI), nên phải truyền drive_id để AI dọn đúng file storage.
    let driveId: string | null = null;
    if (this.prisma.enabled) {
      try {
        const sv = await this.prisma.source_videos.findFirst({
          where: { owner_id: ownerId, platform_video_id: awemeId },
          select: { drive_id: true },
        });
        driveId = sv?.drive_id ?? null;
      } catch (error) {
        this.logger.warn(`Tra drive_id lỗi (bỏ qua): ${error.message}`);
      }
    }
    let aiOk = false;
    try {
      const res = await axios.post(
        `${this.aiUrl}/api/delete`,
        { aweme_id: awemeId, drive_id: driveId },
        { timeout: 60000 },
      );
      aiOk = !!res.data?.ok;
    } catch (error) {
      this.logger.warn(`AI xoá video lỗi (bỏ qua): ${error.message}`);
    }

    let deletedRows = 0;
    if (this.prisma.enabled) {
      try {
        const res = await this.prisma.source_videos.deleteMany({
          where: { owner_id: ownerId, platform_video_id: awemeId },
        });
        deletedRows = res.count;
      } catch (error) {
        this.logger.error(`Xoá source_videos lỗi: ${error.message}`);
        return { ok: false, error: `Xoá DB lỗi: ${error.message}` };
      }
    }
    return { ok: true, aiOk, deletedRows };
  }

  async select(aweme_id: string, selected: boolean) {
    try {
      const response = await axios.post(`${this.aiUrl}/api/select`, { aweme_id, selected });
      return response.data;
    } catch (error) {
      this.logger.error(`Error calling select on AI Service: ${error.message}`);
      return {
        ok: false,
        error: error.response?.data?.error || `Không thể kết nối dịch vụ AI: ${error.message}`,
      };
    }
  }

  async process(
    platforms: string[],
    upload: boolean,
    opts: { auto_grammar?: boolean; remove_sensitive?: boolean } = {},
  ) {
    try {
      const response = await axios.post(`${this.aiUrl}/api/process`, {
        platforms,
        upload,
        auto_grammar: opts.auto_grammar ?? false,
        remove_sensitive: opts.remove_sensitive ?? false,
      });
      return response.data;
    } catch (error) {
      this.logger.error(`Error calling process on AI Service: ${error.message}`);
      return {
        ok: false,
        error: error.response?.data?.error || `Không thể kết nối dịch vụ AI: ${error.message}`,
      };
    }
  }
}
