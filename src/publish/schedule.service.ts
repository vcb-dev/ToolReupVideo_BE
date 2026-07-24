import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { PostTargetService } from './post-target.service';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';

/**
 * Cron quét các lịch đến hạn (status=pending, publish_at<=now) và đăng bài.
 * Chạy nền qua Prisma (không có phiên user). Thiếu DATABASE_URL -> no-op.
 */
@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly postTarget: PostTargetService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'post-due-schedules' })
  async postDueSchedules(): Promise<void> {
    if (!this.prisma.enabled) return; // im lặng khi chưa cấu hình DB

    let due: any[] = [];
    try {
      due = await this.prisma.withRetry(
        () =>
          this.prisma.schedules.findMany({
            where: { status: 'pending', publish_at: { lte: new Date() } },
          }),
        'đọc lịch đến hạn',
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
    if (!pv) throw new Error('Thiếu processed_video');

    // Đăng theo PAGE (kèm token nếu page nối API FB). Trước đây chỉ gửi
    // `platforms` -> AI luôn đi upload-post và bỏ qua Page token.
    const target = await this.postTarget.build(schedule.page_id, schedule.owner_id);
    if (!target) throw new Error('Thiếu page');

    const res = await axios.post(
      `${AI_URL}/api/post`,
      {
        final_drive_id: pv.final_drive_id,
        final_path: pv.final_path,
        post_target: target,
        title: schedule.caption || '',
        description: schedule.caption || '',
      },
      { timeout: 1000 * 60 * 30 },
    );
    if (!res.data?.ok) {
      throw new Error(res.data?.error || 'AI đăng thất bại');
    }

    const postId: string | null = res.data.post_id || null;
    await this.prisma.schedules.update({
      where: { id: schedule.id },
      data: {
        status: 'posted',
        posted_at: new Date(),
        // Giữ ID bài để còn bình luận vào đúng bài (và tra lại sau này).
        post_ref: postId || JSON.stringify(res.data.result).slice(0, 300),
        error: null,
      },
    });
    this.logger.log(`Đã đăng lịch ${schedule.id} lên ${target.platform}.`);

    // Bài đã lên rồi -> bình luận affiliate là việc PHỤ, hỏng cũng không được
    // làm lịch thành 'failed'.
    await this.commentAffiliate(schedule, target, postId).catch((e) =>
      this.logger.warn(`Bình luận affiliate lỗi (bỏ qua): ${e.message}`),
    );
  }

  /**
   * Đăng link affiliate thành BÌNH LUẬN dưới bài vừa đăng, rồi ghi kết quả vào
   * `post_comments`. Chỉ làm được với page nối API Facebook và cần quyền
   * `pages_manage_engagement` — chưa được duyệt thì ghi nhận 'failed' để user
   * biết, KHÔNG ảnh hưởng bài đã đăng.
   */
  private async commentAffiliate(
    schedule: any,
    target: any,
    postId: string | null,
  ): Promise<void> {
    if (!schedule.affiliate_id) return;

    const link = await this.prisma.affiliate_links.findFirst({
      where: { id: schedule.affiliate_id, owner_id: schedule.owner_id },
      select: { url: true, name: true },
    });
    if (!link?.url) return;

    const record = async (status: 'commented' | 'failed', error?: string) => {
      await this.prisma.post_comments
        .create({
          data: {
            owner_id: schedule.owner_id,
            schedule_id: schedule.id,
            affiliate_link_id: schedule.affiliate_id,
            comment_text: link.url,
            status,
            commented_at: status === 'commented' ? new Date() : null,
            error: error?.slice(0, 500) ?? null,
          },
        })
        .catch(() => undefined);
    };

    if (!postId || target.provider !== 'facebook_graph' || !target.page_token) {
      await record(
        'failed',
        'Chỉ bình luận được trên page nối API Facebook (và cần ID bài đăng).',
      );
      return;
    }

    const res = await axios.post(
      `${AI_URL}/api/comment`,
      { post_id: postId, page_token: target.page_token, message: link.url },
      { timeout: 1000 * 60 },
    );
    if (res.data?.ok) {
      await record('commented');
      this.logger.log(`Đã bình luận affiliate vào bài ${postId}.`);
    } else {
      await record('failed', res.data?.error || 'AI bình luận thất bại');
      this.logger.warn(`Bình luận affiliate thất bại: ${res.data?.error}`);
    }
  }
}
