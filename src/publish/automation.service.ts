import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { MediaResolveService } from './media-resolve.service';
import { vnParts, vnTimeToUtc } from './vn-time';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';

/** Bỏ qua khung giờ lỡ quá lâu (server tắt/khởi động lại) thay vì chạy bù dồn. */
const SLOT_GRACE_MS = 10 * 60 * 1000;

/**
 * Cron của tab "Tự động" — hai LOẠI quy tắc chạy độc lập:
 *
 *  - kind='produce': tới khung giờ thì lấy video nguồn trong Kho đem sản xuất
 *    (dịch/lồng tiếng/chỉnh sub) để sẵn thành KHO THÀNH PHẨM. Kho đã đủ
 *    `stock_target` thì BỎ LƯỢT — không chất đống.
 *
 *  - kind='post': tới khung giờ thì lấy thành phẩm CÓ SẴN (lọc theo chủ đề) tạo
 *    dòng `schedules` → ScheduleService lo việc đăng.
 *
 * Nhờ tách, đăng không phải chờ dựng video và nhiều page chủ đề khác nhau dùng
 * chung một kho. Mọi khung giờ tính theo GIỜ VIỆT NAM.
 */
@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);
  /** Khoá mềm: sản xuất lâu, không để lần cron sau chồng lên lần đang chạy. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaResolveService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'automation-tick' })
  async tick(): Promise<void> {
    if (!this.prisma.enabled || this.running) return;
    this.running = true;
    try {
      const rules = await this.prisma.withRetry(
        () =>
          this.prisma.automation_rules.findMany({ where: { is_active: true } }),
        'đọc quy tắc tự động',
      );
      for (const rule of rules) {
        try {
          if (rule.kind === 'post') await this.runPostRule(rule);
          else if (rule.kind === 'reup') await this.runReupRule(rule);
          else await this.runProduceRule(rule);
        } catch (e: any) {
          this.logger.error(`Quy tắc "${rule.name}" lỗi: ${e.message}`);
          await this.prisma.automation_rules
            .update({
              where: { id: rule.id },
              data: { last_error: e.message, last_run_at: new Date() },
            })
            .catch(() => undefined);
          await this.logRun(rule, null, 'error', e.message);
        }
      }
    } catch (e: any) {
      this.logger.error(`Đọc quy tắc tự động lỗi: ${e.message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Khung giờ VỪA TỚI cần xử lý, hoặc null.
   *
   * Lấy khung MỚI NHẤT đã qua trong vòng `SLOT_GRACE_MS`, và bỏ nếu đã xử lý
   * (`last_slot_at`) — cron chạy mỗi phút nên phải chống lặp. Quét cả hôm qua vì
   * khung giờ khuya theo lịch VN có thể rơi sang ngày khác theo UTC.
   */
  private dueSlot(rule: any, now: Date): Date | null {
    let best: Date | null = null;
    for (const dayOffset of [-1, 0]) {
      for (const hhmm of rule.times as string[]) {
        const at = vnTimeToUtc(now, hhmm, dayOffset);
        if (!at) continue;
        // Thứ xét theo lịch VN của CHÍNH khung giờ đó, không phải của hôm nay.
        if (!rule.weekdays.includes(vnParts(at).weekday)) continue;
        if (at > now) continue; // chưa tới giờ
        if (now.getTime() - at.getTime() > SLOT_GRACE_MS) continue; // lỡ quá lâu
        if (!best || at > best) best = at;
      }
    }
    if (best && rule.last_slot_at && best <= rule.last_slot_at) return null;
    return best;
  }

  /** Mốc UTC của [00:00 hôm nay VN, 00:00 ngày mai VN) — cửa sổ "hôm nay" giờ VN. */
  private vnDayRange(now: Date): { start: Date; end: Date } {
    return {
      start: vnTimeToUtc(now, '00:00', 0)!,
      end: vnTimeToUtc(now, '00:00', 1)!,
    };
  }

  /**
   * Số video PHÂN BIỆT đã đặt lịch/đăng HÔM NAY (giờ VN) cho quy tắc này. Dùng
   * làm hạn mức "đăng N video/ngày": reup 1 video -> nhiều page vẫn tính 1.
   */
  private async postedTodayDistinct(rule: any, now: Date): Promise<number> {
    const { start, end } = this.vnDayRange(now);
    const rows = await this.prisma.schedules.findMany({
      where: { rule_id: rule.id, publish_at: { gte: start, lt: end } },
      select: { processed_video_id: true },
      distinct: ['processed_video_id'],
    });
    return rows.length;
  }

  /** Điều kiện lọc source_videos theo phạm vi user chọn (kênh / chủ đề / tick tay). */
  private sourceScope(rule: any): Record<string, any> {
    if (rule.pick_mode === 'channel') {
      // Kênh không còn (bị xoá -> null) thì không khớp video nào -> quy tắc im.
      return rule.source_channel_id ? { channel_id: rule.source_channel_id } : { id: null };
    }
    if (rule.pick_mode === 'topics') {
      // '' = nhóm "chưa phân loại"; trong DB topic có thể là '' HOẶC null.
      const topics: string[] = rule.topics || [];
      const named = topics.filter((t) => t !== '');
      const or: any[] = [];
      if (named.length) or.push({ topic: { in: named } });
      if (topics.includes('')) or.push({ topic: null }, { topic: '' });
      return or.length ? { OR: or } : {};
    }
    if (rule.pick_mode === 'videos') {
      return { id: { in: rule.source_video_ids || [] } };
    }
    return {};
  }

  // ---------------- SẢN XUẤT ----------------

  private async runProduceRule(rule: any): Promise<void> {
    const now = new Date();
    const slot = this.dueSlot(rule, now);
    if (!slot) return;

    // Trần kho: đếm thành phẩm CHƯA đăng trong đúng phạm vi của quy tắc này.
    const stock = await this.prisma.processed_videos.count({
      where: {
        owner_id: rule.owner_id,
        final_drive_id: { not: null },
        schedules: { none: { status: 'posted' } },
        source: this.sourceScope(rule),
      },
    });
    const room = rule.stock_target - stock;
    if (room <= 0) {
      this.logger.log(
        `Quy tắc "${rule.name}": kho đủ ${stock}/${rule.stock_target}, bỏ lượt.`,
      );
      await this.finish(rule, slot, `Kho đã đủ ${stock}/${rule.stock_target} video — bỏ lượt này.`);
      return;
    }

    const want = Math.min(rule.batch_size, room);
    let made = 0;
    for (let i = 0; i < want; i++) {
      const sv = await this.pickSourceVideo(rule);
      if (!sv) break; // hết video nguồn
      await this.produceOne(rule, sv);
      made++;
    }
    this.logger.log(`Quy tắc "${rule.name}": sản xuất ${made}/${want} video.`);
    await this.finish(
      rule,
      slot,
      made < want ? this.emptyMsg(rule) : null,
      made > 0 ? `Sản xuất ${made}/${want} video.` : null,
    );
  }

  /** Sản xuất 1 video nguồn -> ghi processed_videos. Trả về bản ghi thành phẩm
   *  (reup cần để đặt lịch đăng ngay; produce bỏ qua giá trị trả về). */
  private async produceOne(rule: any, sv: any): Promise<any> {
    this.logger.log(`Quy tắc "${rule.name}": đang sản xuất ${sv.platform_video_id}...`);
    // Tự động không có người vẽ khung che -> mặc định để Gemini TỰ DÒ khung chữ
    // gốc + ghi phụ đề Việt. Đặt trước rule.video_config nên nếu sau này UI quy
    // tắc cho chỉnh các cờ này thì giá trị của rule vẫn thắng.
    // Khung viền + nhạc từ Kho -> URL ký sẵn (logic chung với Xưởng video).
    const config: Record<string, any> = await this.media.resolveFrameMusic(
      rule.owner_id,
      {
        cover_text: true,
        cover_detect: true,
        subtitle_enabled: true,
        ...(rule.video_config || {}),
      },
    );
    // voice_asset_id (giọng Kho) đã được resolveFrameMusic đổi thành
    // voice_id "asset:<uuid>" + voice_ref_url. Giọng sẵn của VieNeu thì FE gửi
    // thẳng voice_id "preset:<tên>".
    if (!config.voice_id) {
      throw new Error(
        'Quy tắc chưa có giọng lồng — sửa quy tắc và chọn giọng trong Kho.',
      );
    }
    const res = await axios.post(
      `${AI_URL}/api/produce`,
      {
        video_id: sv.platform_video_id,
        drive_id: sv.drive_id,
        desc: sv.descr,
        config,
      },
      { timeout: 1000 * 60 * 30 },
    );
    if (!res.data?.ok) throw new Error(res.data?.error || 'AI produce thất bại');

    return this.prisma.processed_videos.create({
      data: {
        owner_id: rule.owner_id,
        source_video_id: sv.id,
        final_path: res.data.final_path,
        final_drive_id: res.data.final_drive_id,
        target_lang: res.data.target_lang,
        voice_id: res.data.voice_id,
        has_subtitle: res.data.has_subtitle,
        ai_caption: res.data.ai_caption ?? null,
        status: 'done',
        produced_at: new Date(),
      },
    });
  }

  /**
   * Video nguồn cho lượt kế tiếp: CŨ NHẤT trước và chưa có bản thành phẩm nào
   * -> nguồn tự cạn dần, không bao giờ sản xuất lại cùng một video.
   */
  private async pickSourceVideo(rule: any) {
    return this.prisma.source_videos.findFirst({
      where: {
        owner_id: rule.owner_id,
        drive_id: { not: null },
        processed: { none: {} },
        ...this.sourceScope(rule),
      },
      orderBy: { crawled_at: 'asc' },
    });
  }

  /** Nguồn cạn thì nói rõ cạn ở đâu, không để user đoán. */
  private emptyMsg(rule: any): string {
    if (rule.pick_mode === 'channel') {
      return 'Hết video chưa sản xuất của kênh nguồn đã chọn (kênh cần bật Theo dõi để tự cào).';
    }
    if (rule.pick_mode === 'topics') {
      return `Hết video chưa sản xuất trong chủ đề đã chọn (${(rule.topics || []).join(', ')}).`;
    }
    if (rule.pick_mode === 'videos') {
      return 'Đã dùng hết các video đã tick — chọn thêm video cho quy tắc này.';
    }
    return 'Hết video nguồn chưa sản xuất trong Kho.';
  }

  // ---------------- ĐĂNG BÀI ----------------

  private async runPostRule(rule: any): Promise<void> {
    const now = new Date();
    const slot = this.dueSlot(rule, now);
    if (!slot) return;

    const pages = await this.prisma.pages.findMany({
      where: { id: { in: rule.page_ids }, owner_id: rule.owner_id, is_active: true },
    });
    if (!pages.length) {
      throw new Error('Quy tắc không còn page đích nào đang hoạt động.');
    }

    // Hạn mức "đăng N video/ngày": chỉ rải thêm tối đa `room` video phân biệt.
    let room = Infinity;
    const limit = rule.daily_limit;
    if (limit && limit > 0) {
      const used = await this.postedTodayDistinct(rule, now);
      room = limit - used;
      if (room <= 0) {
        await this.finish(
          rule,
          slot,
          null,
          `Đã đủ hạn mức ${used}/${limit} video hôm nay — bỏ lượt.`,
        );
        return;
      }
    }

    let queued = 0;
    let ranOut = false;
    let hitLimit = false;
    for (const page of pages) {
      const exists = await this.prisma.schedules.findFirst({
        where: { rule_id: rule.id, page_id: page.id, publish_at: slot },
      });
      if (exists) continue;
      if (queued >= room) {
        hitLimit = true;
        break; // đủ hạn mức ngày -> dừng rải thêm page
      }

      const pv = await this.pickReadyVideo(rule);
      if (!pv) {
        ranOut = true;
        break; // hết thành phẩm, các page sau cũng vậy
      }
      await this.queuePost(rule, pv, page, slot);
      queued++;
    }
    if (queued) {
      this.logger.log(`Quy tắc "${rule.name}": đặt ${queued} lịch đăng lúc ${slot.toISOString()}.`);
    }
    await this.finish(
      rule,
      slot,
      ranOut ? 'Hết video thành phẩm chưa đăng — cần quy tắc sản xuất bù.' : null,
      queued > 0
        ? `Đặt ${queued} lịch đăng.${hitLimit ? ' (đã đủ hạn mức ngày)' : ''}`
        : null,
    );
  }

  /** Tạo 1 dòng schedules (pending) cho 1 thành phẩm + 1 page ở khung giờ slot.
   *  Dùng chung cho quy tắc post lẫn reup. Link affiliate KHÔNG vào caption —
   *  ScheduleService đăng thành bình luận dưới bài sau khi đăng xong. */
  private async queuePost(rule: any, pv: any, page: any, slot: Date): Promise<void> {
    const sv = await this.prisma.source_videos.findUnique({
      where: { id: pv.source_video_id },
      select: { descr: true },
    });
    // Ưu tiên AI caption tóm tắt từ transcript nếu quy tắc bật ai_caption và pv có ai_caption
    let baseDescr = sv?.descr ?? null;
    if (rule.ai_caption) {
      baseDescr = pv.ai_caption?.trim() || baseDescr;
    }
    // Sinh hashtag per-video bằng Gemini nếu quy tắc bật ai_hashtags.
    const aiHashtags = rule.ai_hashtags
      ? await this.fetchAiHashtags(baseDescr)
      : '';
    await this.prisma.schedules.create({
      data: {
        owner_id: rule.owner_id,
        processed_video_id: pv.id,
        page_id: page.id,
        caption: this.caption(rule, baseDescr, aiHashtags),
        publish_at: slot,
        status: 'pending',
        rule_id: rule.id,
        affiliate_id: rule.affiliate_id || null,
      },
    });
  }

  // ---------------- REUP TRỌN GÓI (sản xuất + đăng ngay) ----------------

  /**
   * Reup: tới khung giờ, lấy VIDEO MỚI NHẤT do kênh nguồn đăng trong
   * `recency_days` ngày gần nhất, chưa sản xuất -> dựng ngay -> đặt lịch đăng lên
   * mọi page đích ở chính khung giờ đó (đăng luôn, không tích kho). Khung sau tự
   * lấy video mới kế tiếp -> cuốn dần theo thứ tự mới nhất, không đăng trùng.
   */
  private async runReupRule(rule: any): Promise<void> {
    const now = new Date();
    const slot = this.dueSlot(rule, now);
    if (!slot) return;

    const pages = await this.prisma.pages.findMany({
      where: { id: { in: rule.page_ids }, owner_id: rule.owner_id, is_active: true },
    });
    if (!pages.length) {
      throw new Error('Quy tắc không còn page đích nào đang hoạt động.');
    }

    // Hạn mức "đăng N video/ngày" — chặn TRƯỚC khi produceOne (gọi AI tốn kém).
    // Reup = 1 video/khung nên chỉ cần: đủ hạn mức thì bỏ lượt.
    const limit = rule.daily_limit;
    if (limit && limit > 0) {
      const used = await this.postedTodayDistinct(rule, now);
      if (used >= limit) {
        await this.finish(
          rule,
          slot,
          null,
          `Đã đủ hạn mức ${used}/${limit} video hôm nay — bỏ lượt.`,
        );
        return;
      }
    }

    const sv = await this.pickRecentSourceVideo(rule, now);
    if (!sv) {
      await this.finish(rule, slot, this.reupEmptyMsg(rule));
      return;
    }
    const pv = await this.produceOne(rule, sv);

    let queued = 0;
    for (const page of pages) {
      // Chống trùng khi cron chạy lại cùng khung (hàng rào cứng là unique index).
      const exists = await this.prisma.schedules.findFirst({
        where: { rule_id: rule.id, page_id: page.id, publish_at: slot },
      });
      if (exists) continue;
      await this.queuePost(rule, pv, page, slot);
      queued++;
    }
    this.logger.log(
      `Quy tắc "${rule.name}" (reup): đăng "${sv.platform_video_id}" lên ${queued} page lúc ${slot.toISOString()}.`,
    );
    await this.finish(
      rule,
      slot,
      null,
      `Reup video "${sv.platform_video_id}" lên ${queued} page.`,
    );
  }

  /**
   * Video nguồn cho reup: MỚI NHẤT (published_at desc) do kênh đăng trong
   * `recency_days` ngày gần nhất, có file, chưa sản xuất, đúng phạm vi nguồn.
   * `gte cutoff` tự loại video thiếu published_at (cào trước khi có tính năng).
   */
  private async pickRecentSourceVideo(rule: any, now: Date) {
    const days = rule.recency_days ?? 1;
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return this.prisma.source_videos.findFirst({
      where: {
        owner_id: rule.owner_id,
        drive_id: { not: null },
        processed: { none: {} },
        published_at: { gte: cutoff },
        ...this.sourceScope(rule),
      },
      orderBy: { published_at: 'desc' },
    });
  }

  /** Không còn video mới trong cửa sổ -> nói rõ để user biết vì sao im. */
  private reupEmptyMsg(rule: any): string {
    const days = rule.recency_days ?? 1;
    const scope =
      rule.pick_mode === 'channel'
        ? ' của kênh nguồn đã chọn (kênh cần bật Theo dõi để tự cào hằng ngày)'
        : rule.pick_mode === 'topics'
        ? ` trong chủ đề đã chọn (${(rule.topics || []).join(', ')})`
        : rule.pick_mode === 'videos'
        ? ' trong các video đã tick'
        : '';
    return `Không còn video mới (đăng trong ${days} ngày) chưa reup${scope}.`;
  }

  /**
   * Thành phẩm sẵn sàng đăng: có file, CHƯA từng lên lịch lần nào (tránh đăng
   * trùng, kể cả khi chạy nhiều page trong cùng một lượt), lọc theo chủ đề của
   * video nguồn, cũ nhất trước.
   */
  private async pickReadyVideo(rule: any) {
    const topics: string[] = rule.topics || [];
    const scope: Record<string, any> = {};
    if (topics.length) {
      const named = topics.filter((t) => t !== '');
      const or: any[] = [];
      if (named.length) or.push({ topic: { in: named } });
      if (topics.includes('')) or.push({ topic: null }, { topic: '' });
      if (or.length) scope.OR = or;
    }
    return this.prisma.processed_videos.findFirst({
      where: {
        owner_id: rule.owner_id,
        final_drive_id: { not: null },
        schedules: { none: {} },
        ...(Object.keys(scope).length ? { source: scope } : {}),
      },
      orderBy: { produced_at: 'asc' },
    });
  }

  /**
   * Caption = mô tả gốc + hashtag. KHÔNG có link affiliate — link đi vào BÌNH
   * LUẬN dưới bài (ScheduleService lo sau khi đăng xong), tốt hơn cho tiếp cận.
   *
   * Phải nối hashtag ngay ở đây: lịch đăng đi qua AI `/api/post` (đăng 1 video),
   * khác `/api/post_batch` của luồng thủ công — chỗ đó AI mới tự nối. Chốt
   * caption lúc tạo lịch cũng có lợi: user xem/sửa được ở tab Lịch đăng.
   */
  private caption(rule: any, descr: string | null, aiHashtags = ''): string {
    // Ưu tiên hashtag do AI sinh (per-video), rồi mới fallback rule.hashtags (cố định)
    const hashtagStr = aiHashtags.trim() || (rule.hashtags || '').trim();
    return [descr?.trim() || '', hashtagStr]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Gọi AI service sinh hashtag từ mô tả video.
   * Fallback về '' nếu lỗi hoặc descr rỗng — không được cản luồng đăng bài.
   */
  private async fetchAiHashtags(descr: string | null, lang = 'vi'): Promise<string> {
    if (!descr?.trim()) return '';
    try {
      const res = await axios.post(
        `${AI_URL}/api/hashtags`,
        { descr: descr.trim(), lang, count: 7 },
        { timeout: 30_000 },
      );
      return (res.data?.hashtags || '').trim();
    } catch (e: any) {
      this.logger.warn(`Sinh AI hashtag lỗi (fallback về hashtag quy tắc): ${e.message}`);
      return '';
    }
  }

  /**
   * Ghi nhận đã xử lý xong khung giờ này (chống cron chạy lại cùng khung) +
   * ghi 1 dòng nhật ký. `summary` = việc đã làm ("Sản xuất 2/3 video."),
   * `note` = lý do bỏ lượt/cạn nguồn -> status 'warn'.
   */
  private async finish(
    rule: any,
    slot: Date,
    note: string | null,
    summary: string | null = null,
  ): Promise<void> {
    await this.prisma.automation_rules.update({
      where: { id: rule.id },
      data: { last_slot_at: slot, last_run_at: new Date(), last_error: note },
    });
    const message = [summary, note].filter(Boolean).join(' — ') || 'Chạy xong.';
    await this.logRun(rule, slot, note ? 'warn' : 'ok', message);
  }

  /** Ghi 1 dòng nhật ký lượt chạy — best-effort, lỗi log KHÔNG được cản quy tắc. */
  private async logRun(
    rule: any,
    slot: Date | null,
    status: 'ok' | 'warn' | 'error',
    message: string,
  ): Promise<void> {
    await this.prisma.automation_run_logs
      .create({
        data: {
          owner_id: rule.owner_id,
          rule_id: rule.id,
          rule_name: rule.name,
          kind: rule.kind || 'produce',
          slot_at: slot,
          status,
          message,
        },
      })
      .catch(() => undefined);
  }
}
