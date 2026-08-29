import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { CRON_ENABLED } from '../cron-guard';
import { PrismaService } from '../prisma/prisma.service';
import { PostTargetService } from './post-target.service';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';

/**
 * Cron quét các lịch đến hạn (status=pending, publish_at<=now) và đăng bài.
 * Chạy nền qua Prisma (không có phiên user). Thiếu DATABASE_URL -> no-op.
 *
 * CHỐNG ĐĂNG TRÙNG — đăng 1 video mất vài phút, trong khi cron nổ mỗi phút và
 * có thể có NHIỀU tiến trình BE cùng trỏ về một DB. Hai chốt:
 *
 *  1. `running`: một tiến trình không tự chồng lượt lên chính mình. Trước đây
 *     lượt lúc T đọc [s1, s2] rồi đăng s1 mất 2 phút; lượt T+60 đọc lại thấy s2
 *     VẪN pending nên đăng s2, xong lượt T quay lại cũng đăng s2 -> lên kênh 2 bài.
 *  2. `claim()`: đổi pending -> publishing bằng MỘT câu UPDATE có điều kiện.
 *     Chỉ tiến trình nào đổi được (count=1) mới đăng. Đây là chốt duy nhất chặn
 *     được tiến trình BE khác; đọc-rồi-ghi như bản cũ luôn có khe hở.
 */
@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);
  /** Khoá mềm: đăng lâu, không để lượt cron sau chồng lên lượt đang chạy. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly postTarget: PostTargetService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'post-due-schedules' })
  async postDueSchedules(): Promise<void> {
    // im lặng khi chưa cấu hình DB / tiến trình này tắt cron
    if (!CRON_ENABLED || !this.prisma.enabled || this.running) return;
    this.running = true;
    try {
      await this.drainDue();
    } finally {
      this.running = false;
    }
  }

  /** Quét và đăng các lịch đến hạn (đã nắm khoá `running`). */
  private async drainDue(): Promise<void> {
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
      // Nhận việc TRƯỚC khi làm: ai đổi được pending -> publishing thì người đó
      // đăng. Lịch đã bị tiến trình khác (hoặc lượt trước) nhận thì bỏ qua.
      if (!(await this.claim(s.id))) {
        this.logger.debug?.(`Lịch ${s.id} đã có nơi khác nhận — bỏ qua.`);
        continue;
      }
      try {
        await this.postOne(s);
      } catch (e: any) {
        // AI trả lỗi thật trong body JSON (vd. nguyên văn lỗi Facebook Graph),
        // nhưng axios coi status >= 400 là exception -> e.message chỉ còn
        // "Request failed with status code 500", mất sạch lý do thật. Đo được
        // 2026-08-27/28: 49 lịch đăng lỗi, TẤT CẢ đều chỉ ghi mỗi câu chung
        // chung đó, không tra được vì sao (hết hạn token? sai định dạng video?).
        const msg = e.response?.data?.error || e.message;
        this.logger.error(`Lịch ${s.id} lỗi: ${msg}`);
        await this.prisma.schedules
          .update({
            where: { id: s.id },
            data: { status: 'failed', error: String(msg).slice(0, 1000) },
          })
          .catch(() => undefined);
      }
    }
  }

  /**
   * Giành quyền đăng 1 lịch: pending -> publishing trong MỘT câu UPDATE có điều
   * kiện (Postgres tự khoá dòng). Trả về true nếu chính mình giành được.
   */
  private async claim(id: string): Promise<boolean> {
    try {
      const { count } = await this.prisma.schedules.updateMany({
        where: { id, status: 'pending' },
        data: { status: 'publishing' },
      });
      return count === 1;
    } catch (e: any) {
      this.logger.error(`Không nhận được lịch ${id}: ${e.message}`);
      return false;
    }
  }

  private async postOne(schedule: any): Promise<void> {
    // Trạng thái 'publishing' đã được claim() đặt trước khi vào đây.
    // Lịch trỏ tới thành phẩm, hoặc tới VIDEO GỐC trong kho (đăng nguyên bản).
    let driveId: string | null = null;
    let localPath: string | null = null;
    if (schedule.processed_video_id) {
      const pv = await this.prisma.processed_videos.findUnique({
        where: { id: schedule.processed_video_id },
      });
      if (!pv) throw new Error('Thiếu processed_video');
      driveId = pv.final_drive_id;
      localPath = pv.final_path;
    } else {
      const sv = await this.prisma.source_videos.findUnique({
        where: { id: schedule.source_video_id },
      });
      if (!sv) throw new Error('Thiếu source_video');
      driveId = sv.drive_id;
    }
    if (!driveId && !localPath) throw new Error('Video chưa có file trong kho');

    // Đăng theo PAGE (kèm token nếu page nối API FB). Trước đây chỉ gửi
    // `platforms` -> AI luôn đi upload-post và bỏ qua Page token.
    const target = await this.postTarget.build(schedule.page_id, schedule.owner_id);
    if (!target) throw new Error('Thiếu page');

    const res = await axios.post(
      `${AI_URL}/api/post`,
      {
        final_drive_id: driveId,
        final_path: localPath,
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
