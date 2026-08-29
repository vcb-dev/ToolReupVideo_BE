import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { CRON_ENABLED } from '../cron-guard';
import { PrismaService } from '../prisma/prisma.service';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';

// Đợi ít nhất chừng này sau khi claim rồi mới xét — batch vừa gửi cho AI có
// thể mất vài giây job mới hiện "running" trong AI, xét quá sớm dễ bắt nhầm
// video ĐANG xử lý thật thành kẹt.
const GRACE_MS = 3 * 60 * 1000;

/**
 * Tự giải phóng video kẹt ở status=processing khi AI đã chết/khởi động lại
 * giữa chừng (mất job trong RAM, không job nào biết để hoàn tất hay báo lỗi).
 * Đo được 2 lần trong 2 ngày (2026-08-24: 44 video, 2026-08-25: 14 video) —
 * cả 2 lần đều chặn người dùng chọn lại đúng những video đó (produce.controller
 * lọc bỏ status=processing/queued khỏi mẻ mới).
 *
 * KHÔNG dùng ngưỡng thời gian đơn thuần (mẻ lớn có thể chạy thật nhiều giờ,
 * xét theo giờ dễ đá nhầm 1 job đang chạy thật) — hỏi thẳng AI "job của owner
 * này có đang chạy không" mới đáng tin. AI không trả lời được (mất kết nối)
 * thì BỎ QUA, không đoán — thà chờ vòng sau còn hơn giải phóng nhầm.
 */
@Injectable()
export class StuckProcessingSweeperService {
  private readonly logger = new Logger(StuckProcessingSweeperService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'sweep-stuck-processing' })
  async sweep() {
    if (!CRON_ENABLED || !this.prisma.enabled) return;

    const cutoff = new Date(Date.now() - GRACE_MS);
    const stuck = await this.prisma.source_videos.findMany({
      where: { status: 'processing', updated_at: { lt: cutoff } },
      select: { id: true, owner_id: true },
    });
    if (stuck.length === 0) return;

    const byOwner = new Map<string, string[]>();
    for (const sv of stuck) {
      const arr = byOwner.get(sv.owner_id) ?? [];
      arr.push(sv.id);
      byOwner.set(sv.owner_id, arr);
    }

    let released = 0;
    for (const [ownerId, ids] of byOwner) {
      let running: boolean;
      try {
        const res = await axios.get(`${AI_URL}/api/state`, {
          params: { owner: ownerId },
          timeout: 10_000,
        });
        running = !!res.data?.job?.running;
      } catch (error: any) {
        // Không hỏi được AI -> không biết chắc, bỏ qua owner này vòng này.
        this.logger.warn(`Không hỏi được AI cho owner ${ownerId} (bỏ qua): ${error.message}`);
        continue;
      }
      if (running) continue; // job thật đang chạy -> để yên

      const res = await this.prisma.source_videos.updateMany({
        where: { id: { in: ids }, status: 'processing' }, // status lại 1 lần cho chắc, phòng đua với batch mới
        data: { status: 'new' },
      });
      released += res.count;
    }
    if (released) {
      this.logger.log(`Tự giải phóng ${released} video kẹt ở processing (AI không còn job đứng sau).`);
    }
  }
}
