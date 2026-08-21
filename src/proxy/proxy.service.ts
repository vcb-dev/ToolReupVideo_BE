import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly aiUrl = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async getState(ownerId?: string, jobOwner?: string) {
    try {
      const response = await axios.get(`${this.aiUrl}/api/state`, {
        // Trạng thái job theo NGƯỜI THẬT, không theo chủ kho (kho có thể dùng chung).
        params: (jobOwner ?? ownerId) ? { owner: jobOwner ?? ownerId } : undefined,
      });
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

  async ingest(user: string, max: number, platform = 'douyin', ownerId?: string, jobOwner?: string) {
    try {
      const response = await axios.post(`${this.aiUrl}/api/ingest`, {
        user,
        max,
        platform,
        owner_id: ownerId,
        job_owner: jobOwner ?? ownerId,
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

  async scan(user: string, max: number, platform = 'douyin', ownerId?: string, jobOwner?: string) {
    try {
      const response = await axios.post(`${this.aiUrl}/api/scan`, {
        user,
        max,
        platform,
        owner_id: ownerId,
        // Khoá job + định tuyến log theo NGƯỜI THẬT: owner_id có thể giống nhau
        // ở mọi tài khoản khi bật kho dùng chung -> hai người sẽ chặn nhau.
        job_owner: jobOwner ?? ownerId,
      });
      const data = response.data;
      if (data?.ok && Array.isArray(data.videos)) {
        data.videos = await this.markSaved(data.videos, ownerId);
      }
      return data;
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
   * Đặt lại cờ `saved` theo KHO THẬT của user (bảng source_videos), ghi đè cờ
   * mà AI suy ra từ manifest.json.
   *
   * Manifest là file cục bộ của AI, dùng chung mọi user và chỉ được dọn khi lời
   * gọi /api/delete tới được AI. Xoá video khỏi kho mà manifest còn sót thì lần
   * quét sau vẫn báo "Đã lưu" và không cho lưu lại — DB mới là nguồn sự thật.
   */
  private async markSaved(videos: any[], ownerId?: string) {
    if (!ownerId || !this.prisma.enabled || videos.length === 0) return videos;
    const ids = videos.map((v) => v?.aweme_id).filter(Boolean);
    if (ids.length === 0) return videos;
    try {
      const rows = await this.prisma.source_videos.findMany({
        // `drive_id: not null` — chỉ đánh dấu "đã lưu" khi THẬT SỰ có file trong
        // kho. Dòng DB mà mất file thì phải cho tải lại, không thì người dùng
        // thấy nó xám đi (không chọn được) mà bấm xem lại báo thiếu file.
        // Khớp với điều kiện known_ids bên CrawlService — hai luồng phải hiểu
        // "đã có" giống hệt nhau, lệch nhau là hành vi khó đoán.
        where: {
          owner_id: ownerId,
          platform_video_id: { in: ids },
          drive_id: { not: null },
        },
        select: { platform_video_id: true },
      });
      const saved = new Set(rows.map((r) => r.platform_video_id));
      return videos.map((v) => ({ ...v, saved: saved.has(v.aweme_id) }));
    } catch (error) {
      // Không tra được DB -> giữ nguyên cờ của AI, thà báo thừa còn hơn hỏng quét.
      this.logger.warn(`Tra kho để đánh dấu "đã lưu" lỗi: ${error.message}`);
      return videos;
    }
  }

  /**
   * Lưu video đã chọn: bắn sang AI job NỀN (tải+upload) rồi TRẢ VỀ NGAY để nút
   * không bị treo. AI xong sẽ gọi ngược /internal/source-videos ghi DB (kèm
   * owner_id). Truyền owner_id xuống AI để job nền biết ghi cho user nào.
   */
  async save(platform: string, videos: any[], ownerId: string, topic?: string, jobOwner?: string) {
    try {
      const response = await axios.post(`${this.aiUrl}/api/save`, {
        platform,
        videos,
        owner_id: ownerId,
        job_owner: jobOwner ?? ownerId,
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
   *   1) AI: xoá file trên storage + bỏ khỏi manifest
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
    let isUpload = false;
    if (this.prisma.enabled) {
      try {
        const sv = await this.prisma.source_videos.findFirst({
          where: { owner_id: ownerId, platform_video_id: awemeId },
          select: { drive_id: true, platform: true },
        });
        driveId = sv?.drive_id ?? null;
        isUpload = sv?.platform === 'upload';
      } catch (error) {
        this.logger.warn(`Tra drive_id lỗi (bỏ qua): ${error.message}`);
      }
    }

    // Video người dùng tự tải lên có kèm ảnh bìa nằm cạnh file — AI không biết
    // tới nó, không xoá ở đây thì thumbnail đọng lại vĩnh viễn.
    if (isUpload && driveId) {
      await this.storage
        .remove(StorageService.coverKeyFor(driveId))
        .catch(() => undefined);
    }
    let aiOk = false;
    try {
      const res = await axios.post(
        `${this.aiUrl}/api/delete`,
        { aweme_id: awemeId, drive_id: driveId, owner_id: ownerId },
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
    ownerId?: string,
    jobOwner?: string,
  ) {
    try {
      const response = await axios.post(`${this.aiUrl}/api/process`, {
        platforms,
        upload,
        auto_grammar: opts.auto_grammar ?? false,
        remove_sensitive: opts.remove_sensitive ?? false,
        owner_id: ownerId,
        job_owner: jobOwner ?? ownerId,
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
