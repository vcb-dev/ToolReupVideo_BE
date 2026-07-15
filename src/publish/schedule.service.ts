import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';

/**
 * Cron quét các lịch đến hạn (status=pending, publish_at<=now) và đăng bài.
 * Chạy nền qua Prisma (không có phiên user). Thiếu DATABASE_URL -> no-op.
 */
@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'post-due-schedules' })
  async postDueSchedules(): Promise<void> {
    if (!this.prisma.enabled) return; // im lặng khi chưa cấu hình DB

    let due: any[] = [];
    try {
      due = await this.prisma.schedules.findMany({
        where: { status: 'pending', publish_at: { lte: new Date() } },
      });
    } catch (e: any) {
      this.logger.error(`Không đọc được lịch đến hạn: ${e.message}`);
      return;
    }
    if (!due.length) return;
    this.logger.log(`Có ${due.length} lịch đến hạn, bắt đầu đăng...`);

    for (const s of due) {
      try {
        await this.postOne(s);
      } catch (e: any) {
        this.logger.error(`Lịch ${s.id} lỗi: ${e.message}`);
        await this.prisma.schedules
          .update({
            where: { id: s.id },
            data: { status: 'failed', error: e.message },
          })
          .catch(() => undefined);
      }
    }
  }

  private async postOne(schedule: any): Promise<void> {
    // đánh dấu đang đăng để cron phút sau không lấy trùng
    await this.prisma.schedules.update({
      where: { id: schedule.id },
      data: { status: 'publishing' },
    });

    const pv = await this.prisma.processed_videos.findUnique({
      where: { id: schedule.processed_video_id },
    });
    const page = await this.prisma.pages.findUnique({
      where: { id: schedule.page_id },
    });
    if (!pv || !page) {
      throw new Error('Thiếu processed_video hoặc page');
    }

    const res = await axios.post(
      `${AI_URL}/api/post`,
      {
        final_drive_id: pv.final_drive_id,
        final_path: pv.final_path,
        platforms: [page.platform],
        title: schedule.caption || '',
        description: schedule.caption || '',
      },
      { timeout: 1000 * 60 * 30 },
    );
    if (!res.data?.ok) {
      throw new Error(res.data?.error || 'AI đăng thất bại');
    }

    await this.prisma.schedules.update({
      where: { id: schedule.id },
      data: {
        status: 'posted',
        posted_at: new Date(),
        post_ref: JSON.stringify(res.data.result).slice(0, 300),
        error: null,
      },
    });
    this.logger.log(`Đã đăng lịch ${schedule.id} lên ${page.platform}.`);
  }
}
