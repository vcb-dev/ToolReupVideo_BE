import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { SupabaseAdminService } from '../data/supabase-admin.service';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';

/**
 * Cron quét các lịch đến hạn (status=pending, publish_at<=now) và đăng bài.
 * Chạy nền qua service-role key (bỏ qua RLS). Thiếu key -> no-op.
 */
@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(private readonly admin: SupabaseAdminService) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'post-due-schedules' })
  async postDueSchedules(): Promise<void> {
    if (!this.admin.enabled) return; // im lặng khi chưa cấu hình service key

    const nowIso = new Date().toISOString();
    let due: any[] = [];
    try {
      due = await this.admin.select(
        'schedules',
        `status=eq.pending&publish_at=lte.${nowIso}&select=*`,
      );
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
        await this.admin
          .patch('schedules', s.id, { status: 'failed', error: e.message })
          .catch(() => undefined);
      }
    }
  }

  private async postOne(schedule: any): Promise<void> {
    // đánh dấu đang đăng để cron phút sau không lấy trùng
    await this.admin.patch('schedules', schedule.id, { status: 'publishing' });

    const [pv] = await this.admin.select(
      'processed_videos',
      `id=eq.${schedule.processed_video_id}&select=*`,
    );
    const [page] = await this.admin.select(
      'pages',
      `id=eq.${schedule.page_id}&select=*`,
    );
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

    await this.admin.patch('schedules', schedule.id, {
      status: 'posted',
      posted_at: new Date().toISOString(),
      post_ref: JSON.stringify(res.data.result).slice(0, 300),
      error: null,
    });
    this.logger.log(`Đã đăng lịch ${schedule.id} lên ${page.platform}.`);
  }
}
