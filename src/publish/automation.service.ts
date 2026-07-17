import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { vnParts, vnTimeToUtc } from './vn-time';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';

/**
 * Cron của tab "Tự động": dựng sẵn video cho các khung giờ SẮP tới rồi tạo dòng
 * `schedules` — ScheduleService lo việc đăng đúng phút.
 *
 * Vì sao dựng trước: sản xuất mất vài phút (Gemini + TTS + ffmpeg). Nếu tới giờ
 * mới làm thì bài luôn lên trễ. Dựng trước `lead_minutes` phút -> tới giờ chỉ
 * việc phát, và lịch hiện sớm ở tab Lịch đăng để user xem/sửa/huỷ kịp.
 *
 * Chống trùng: unique index (rule_id, page_id, publish_at) ở DB. Cron chạy lại
 * cùng khung giờ sẽ đụng unique -> bỏ qua, không cần nhớ trạng thái.
 */
@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);
  /** Khoá mềm: sản xuất lâu, không để lần cron sau chồng lên lần đang chạy. */
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'automation-build-ahead' })
  async buildAhead(): Promise<void> {
    if (!this.prisma.enabled || this.running) return;
    this.running = true;
    try {
      const rules = await this.prisma.automation_rules.findMany({
        where: { is_active: true },
      });
      for (const rule of rules) {
        try {
          await this.runRule(rule);
        } catch (e: any) {
          this.logger.error(`Quy tắc "${rule.name}" lỗi: ${e.message}`);
          await this.prisma.automation_rules
            .update({
              where: { id: rule.id },
              data: { last_error: e.message, last_run_at: new Date() },
            })
            .catch(() => undefined);
        }
      }
    } catch (e: any) {
      this.logger.error(`Đọc quy tắc tự động lỗi: ${e.message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Các khung giờ của quy tắc rơi vào cửa sổ [now, now+lead] — tức là sắp tới
   * giờ đăng và cần có video sẵn. Quét cả hôm nay lẫn ngày mai vì cửa sổ có thể
   * vắt qua nửa đêm giờ VN.
   */
  private dueSlots(rule: any, now: Date): Date[] {
    const horizon = new Date(now.getTime() + rule.lead_minutes * 60 * 1000);
    const out: Date[] = [];
    for (const dayOffset of [0, 1]) {
      for (const hhmm of rule.times as string[]) {
        const at = vnTimeToUtc(now, hhmm, dayOffset);
        if (!at) continue;
        // Thứ phải khớp theo lịch VN của CHÍNH mốc đăng, không phải của hôm nay.
        if (!rule.weekdays.includes(vnParts(at).weekday)) continue;
        if (at > now && at <= horizon) out.push(at);
      }
    }
    return out.sort((a, b) => a.getTime() - b.getTime());
  }

  private async runRule(rule: any): Promise<void> {
    const now = new Date();
    const slots = this.dueSlots(rule, now);
    if (!slots.length) return;

    // Page còn sống tại thời điểm chạy (user có thể đã xoá/tạm dừng page).
    const pages = await this.prisma.pages.findMany({
      where: { id: { in: rule.page_ids }, owner_id: rule.owner_id, is_active: true },
    });
    if (!pages.length) {
      throw new Error('Quy tắc không còn page đích nào đang hoạt động.');
    }

    for (const at of slots) {
      for (const page of pages) {
        const exists = await this.prisma.schedules.findFirst({
          where: { rule_id: rule.id, page_id: page.id, publish_at: at },
        });
        if (exists) continue;
        await this.buildOne(rule, page.id, at);
      }
    }
    await this.prisma.automation_rules.update({
      where: { id: rule.id },
      data: { last_run_at: new Date(), last_error: null },
    });
  }

  /** Sản xuất 1 video cho 1 (page, khung giờ) rồi ghi lịch pending. */
  private async buildOne(rule: any, pageId: string, at: Date): Promise<void> {
    const sv = await this.pickSourceVideo(rule);
    if (!sv) {
      // Hết video nguồn là chuyện thường (nguồn cạn) -> ghi cảnh báo, không ném
      // lỗi để các quy tắc khác vẫn chạy.
      this.logger.warn(
        `Quy tắc "${rule.name}": hết video nguồn, bỏ khung ${at.toISOString()}.`,
      );
      await this.prisma.automation_rules.update({
        where: { id: rule.id },
        data: { last_error: this.emptyMsg(rule) },
      });
      return;
    }

    this.logger.log(
      `Quy tắc "${rule.name}": sản xuất ${sv.platform_video_id} cho khung ${at.toISOString()}...`,
    );
    const res = await axios.post(
      `${AI_URL}/api/produce`,
      {
        video_id: sv.platform_video_id,
        drive_id: sv.drive_id,
        desc: sv.descr,
        config: rule.video_config || {},
      },
      { timeout: 1000 * 60 * 30 },
    );
    if (!res.data?.ok) throw new Error(res.data?.error || 'AI produce thất bại');

    const pv = await this.prisma.processed_videos.create({
      data: {
        owner_id: rule.owner_id,
        source_video_id: sv.id,
        final_path: res.data.final_path,
        final_drive_id: res.data.final_drive_id,
        target_lang: res.data.target_lang,
        voice_id: res.data.voice_id,
        has_subtitle: res.data.has_subtitle,
        status: 'done',
        produced_at: new Date(),
      },
    });

    await this.prisma.schedules.create({
      data: {
        owner_id: rule.owner_id,
        processed_video_id: pv.id,
        page_id: pageId,
        caption: await this.caption(rule, sv.descr),
        publish_at: at,
        status: 'pending',
        rule_id: rule.id,
      },
    });
    this.logger.log(`Quy tắc "${rule.name}": đã đặt lịch ${at.toISOString()}.`);
  }

  /**
   * Video nguồn cho lượt kế tiếp: CŨ NHẤT trước (cào về trước dùng trước) và
   * chưa có bản thành phẩm nào (`processed: { none: {} }`) — nhờ vậy nguồn tự
   * cạn dần, không bao giờ đăng lại cùng một video.
   *
   * Phạm vi tuỳ `pick_mode`: cụm chủ đề, đúng danh sách đã tick, hoặc cả Kho.
   */
  private async pickSourceVideo(rule: any) {
    const scope: Record<string, any> = {};
    if (rule.pick_mode === 'topics') {
      // Chuỗi rỗng trong `topics` = nhóm "chưa phân loại"; trong DB topic có thể
      // là '' HOẶC null nên phải bắt cả hai, không thì nhóm đó không khớp gì.
      const topics: string[] = rule.topics || [];
      const named = topics.filter((t) => t !== '');
      const wantsUnclassified = topics.includes('');
      const or: any[] = [];
      if (named.length) or.push({ topic: { in: named } });
      if (wantsUnclassified) or.push({ topic: null }, { topic: '' });
      scope.OR = or;
    } else if (rule.pick_mode === 'videos') {
      scope.id = { in: rule.source_video_ids || [] };
    }

    return this.prisma.source_videos.findFirst({
      where: {
        owner_id: rule.owner_id,
        drive_id: { not: null },
        processed: { none: {} },
        ...scope,
      },
      orderBy: { crawled_at: 'asc' },
    });
  }

  /** Nguồn cạn thì nói rõ cạn ở đâu, không để user đoán. */
  private emptyMsg(rule: any): string {
    if (rule.pick_mode === 'topics') {
      return `Hết video chưa sản xuất trong chủ đề đã chọn (${(rule.topics || []).join(', ')}).`;
    }
    if (rule.pick_mode === 'videos') {
      return 'Đã dùng hết các video đã tick — chọn thêm video cho quy tắc này.';
    }
    return 'Hết video nguồn chưa sản xuất trong Kho.';
  }

  /**
   * Caption = mô tả gốc + hashtag + link affiliate của quy tắc.
   *
   * Phải nối ĐỦ ở đây: lịch đăng đi qua AI `/api/post` (đăng 1 video), khác
   * `/api/post_batch` của luồng thủ công — chỗ đó AI mới tự nối hashtag +
   * affiliate. Chốt caption ngay lúc tạo lịch cũng có cái lợi: user xem/sửa
   * được ở tab Lịch đăng trước khi bài lên.
   */
  private async caption(rule: any, descr: string | null): Promise<string> {
    let affiliateUrl = '';
    if (rule.affiliate_id) {
      const link = await this.prisma.affiliate_links.findFirst({
        where: { id: rule.affiliate_id, owner_id: rule.owner_id },
        select: { url: true },
      });
      affiliateUrl = link?.url || '';
    }
    return [descr?.trim() || '', (rule.hashtags || '').trim(), affiliateUrl]
      .filter(Boolean)
      .join('\n');
  }
}
