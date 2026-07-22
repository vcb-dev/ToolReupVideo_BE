import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/auth.guard';
import { DeletePinService } from '../auth/delete-pin.service';
import { PrismaService } from '../prisma/prisma.service';
import { isValidHhmm } from './vn-time';

type RuleBody = {
  name?: string;
  kind?: string; // 'produce' | 'post' | 'reup'
  batch_size?: number;
  stock_target?: number;
  recency_days?: number; // reup: chỉ lấy video đăng trong N ngày gần nhất
  weekdays?: number[];
  times?: string[];
  page_ids?: string[];
  pick_mode?: string;
  topics?: string[];
  source_video_ids?: string[];
  source_channel_id?: string | null; // pick_mode='channel': kênh nguồn đã theo dõi
  video_config?: Record<string, any>;
  hashtags?: string;
  ai_hashtags?: boolean;
  affiliate_id?: string | null;
  lead_minutes?: number;
  is_active?: boolean;
};

/**
 * CRUD quy tắc tự động (tab "Tự động"). Không dùng /api/data generic vì cần
 * kiểm tra kỹ: giờ phải là HH:MM, thứ phải 1-7, page phải của chính user —
 * quy tắc sai giờ thì cron im lặng không chạy, rất khó hiểu chuyện gì xảy ra.
 */
@UseGuards(SupabaseAuthGuard)
@Controller('api/automation')
export class AutomationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deletePin: DeletePinService,
  ) {}

  @Get('rules')
  async list(@Req() req: any) {
    const rules = await this.prisma.automation_rules.findMany({
      where: { owner_id: req.user.id },
      orderBy: { created_at: 'desc' },
    });
    return { ok: true, rules };
  }

  /**
   * Các cụm chủ đề trong Kho kèm số video CHƯA sản xuất — form chọn nguồn cần
   * con số này để user biết chủ đề nào còn hàng mà lên lịch.
   */
  @Get('topics')
  async topics(@Req() req: any) {
    const rows = await this.prisma.source_videos.findMany({
      where: {
        owner_id: req.user.id,
        drive_id: { not: null },
        processed: { none: {} },
      },
      select: { topic: true },
    });
    const count = new Map<string, number>();
    for (const r of rows) {
      const key = r.topic?.trim() || ''; // '' = chưa phân loại
      count.set(key, (count.get(key) || 0) + 1);
    }
    const topics = [...count.entries()]
      .map(([topic, available]) => ({ topic, available }))
      .sort((a, b) => a.topic.localeCompare(b.topic));
    return { ok: true, topics };
  }

  @Post('rules')
  @HttpCode(HttpStatus.OK)
  async create(@Body() body: RuleBody, @Req() req: any) {
    const data = await this.validate(body, req.user.id, true, null);
    const rule = await this.prisma.automation_rules.create({
      data: { ...data, owner_id: req.user.id } as any,
    });
    return { ok: true, rule };
  }

  @Patch('rules/:id')
  async update(
    @Param('id') id: string,
    @Body() body: RuleBody,
    @Req() req: any,
  ) {
    const current = await this.prisma.automation_rules.findFirst({
      where: { id, owner_id: req.user.id },
    });
    if (!current) throw new NotFoundException('Không tìm thấy quy tắc');

    const data = await this.validate(body, req.user.id, false, current);
    await this.prisma.automation_rules.update({
      where: { id: current.id },
      data: { ...data, updated_at: new Date() } as any,
    });
    return { ok: true };
  }

  @Delete('rules/:id')
  async remove(@Param('id') id: string, @Req() req: any) {
    await this.deletePin.assertDeleteAllowed(req.user, req.headers['x-delete-pin']);
    const res = await this.prisma.automation_rules.deleteMany({
      where: { id, owner_id: req.user.id },
    });
    if (res.count === 0) throw new NotFoundException('Không tìm thấy quy tắc');
    // Lịch đã sinh KHÔNG bị xoá theo (rule_id -> null): video đã sản xuất rồi,
    // xoá quy tắc không có nghĩa là huỷ các bài đang chờ đăng.
    return { ok: true };
  }

  /**
   * Kiểm tra dữ liệu quy tắc. `full` = tạo mới (bắt buộc đủ tên/thứ/giờ/page);
   * sửa thì chỉ kiểm các trường được gửi lên, `current` là bản đang lưu để gộp.
   */
  private async validate(
    b: RuleBody,
    ownerId: string,
    full: boolean,
    current: any,
  ): Promise<Record<string, any>> {
    const out: Record<string, any> = {};

    if (b.name !== undefined || full) {
      const name = (b.name || '').trim();
      if (!name) throw new BadRequestException('Thiếu tên quy tắc.');
      out.name = name;
    }
    if (b.weekdays !== undefined || full) {
      const wd = b.weekdays || [];
      if (!wd.length) throw new BadRequestException('Chọn ít nhất 1 thứ trong tuần.');
      if (wd.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
        throw new BadRequestException('Thứ không hợp lệ (1=T2 ... 7=CN).');
      }
      out.weekdays = [...new Set(wd)].sort();
    }
    if (b.times !== undefined || full) {
      const ts = (b.times || []).map((t) => (t || '').trim());
      if (!ts.length) throw new BadRequestException('Thêm ít nhất 1 khung giờ.');
      const bad = ts.find((t) => !isValidHhmm(t));
      if (bad !== undefined) {
        throw new BadRequestException(`Giờ không hợp lệ: "${bad}" (cần dạng HH:MM).`);
      }
      out.times = [...new Set(ts)].sort();
    }
    // LOẠI quy tắc quyết định trường nào bắt buộc. Gộp với bản đang lưu để sửa
    // quy tắc mà không gửi lại `kind` vẫn soi đúng luật.
    const kind = b.kind ?? current?.kind ?? 'produce';
    if (!['produce', 'post', 'reup'].includes(kind)) {
      throw new BadRequestException(
        'Loại quy tắc không hợp lệ (produce | post | reup).',
      );
    }
    if (b.kind !== undefined || full) out.kind = kind;

    if (kind === 'post') {
      // ĐĂNG BÀI: bắt buộc page đích. `topics` là BỘ LỌC thành phẩm (rỗng = mọi
      // chủ đề), không phải nguồn sản xuất -> không đụng pick_mode.
      if (b.page_ids !== undefined || full) {
        const ids = b.page_ids || [];
        if (!ids.length) throw new BadRequestException('Chọn ít nhất 1 page đích.');
        const owned = await this.prisma.pages.findMany({
          where: { id: { in: ids }, owner_id: ownerId },
          select: { id: true },
        });
        if (owned.length !== ids.length) {
          throw new BadRequestException('Có page không tồn tại hoặc không thuộc bạn.');
        }
        out.page_ids = ids;
      }
      if (b.topics !== undefined || full) {
        out.topics = [...new Set(b.topics || [])];
      }
      if (full) {
        out.pick_mode = 'any';
        out.source_video_ids = [];
      }
      if (b.hashtags !== undefined) out.hashtags = (b.hashtags || '').trim() || null;
      if (b.ai_hashtags !== undefined) out.ai_hashtags = !!b.ai_hashtags;
      if (b.affiliate_id !== undefined) out.affiliate_id = b.affiliate_id || null;
      if (b.is_active !== undefined) out.is_active = !!b.is_active;
      return out;
    }

    if (kind === 'reup') {
      // REUP TRỌN GÓI: nguồn + cấu hình sản xuất (như produce) + page đích +
      // hashtag/affiliate (như post) + cửa sổ recency_days. Đăng ngay nên KHÔNG
      // dùng stock_target.
      // -- Page đích (bắt buộc) --
      if (b.page_ids !== undefined || full) {
        const ids = b.page_ids || [];
        if (!ids.length) throw new BadRequestException('Chọn ít nhất 1 page đích.');
        const owned = await this.prisma.pages.findMany({
          where: { id: { in: ids }, owner_id: ownerId },
          select: { id: true },
        });
        if (owned.length !== ids.length) {
          throw new BadRequestException('Có page không tồn tại hoặc không thuộc bạn.');
        }
        out.page_ids = ids;
      }
      // -- Cửa sổ "video mới nhất trong N ngày" (bắt buộc) --
      if (b.recency_days !== undefined || full) {
        const n = Number(b.recency_days ?? current?.recency_days ?? NaN);
        if (!Number.isInteger(n) || n < 1 || n > 3650) {
          throw new BadRequestException('Số ngày phải từ 1 đến 3650.');
        }
        out.recency_days = n;
      }
      // -- Nguồn video (any/topics/videos/channel như produce) --
      await this.applySourceScope(b, current, ownerId, full, out);
      // -- Số video mỗi lượt (tuỳ chọn) --
      if (b.batch_size !== undefined || full) {
        const n = Number(b.batch_size ?? 1);
        if (!Number.isInteger(n) || n < 1 || n > 20) {
          throw new BadRequestException('Số video mỗi lượt phải từ 1 đến 20.');
        }
        out.batch_size = n;
      }
      // -- Cấu hình sản xuất + meta đăng --
      if (b.video_config !== undefined) out.video_config = b.video_config ?? {};
      if (b.hashtags !== undefined) out.hashtags = (b.hashtags || '').trim() || null;
      if (b.ai_hashtags !== undefined) out.ai_hashtags = !!b.ai_hashtags;
      if (b.affiliate_id !== undefined) out.affiliate_id = b.affiliate_id || null;
      if (b.is_active !== undefined) out.is_active = !!b.is_active;
      return out;
    }

    // ---- SẢN XUẤT: không cần page, nhưng phải biết lấy video nguồn từ đâu ----
    if (full) out.page_ids = [];
    if (b.batch_size !== undefined || full) {
      const n = Number(b.batch_size ?? 1);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        throw new BadRequestException('Số video mỗi lượt phải từ 1 đến 20.');
      }
      out.batch_size = n;
    }
    if (b.stock_target !== undefined || full) {
      const n = Number(b.stock_target ?? 10);
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        throw new BadRequestException('Trần kho phải từ 1 đến 500 video.');
      }
      out.stock_target = n;
    }
    // Nguồn video (any/topics/videos/channel). Kiểm theo pick_mode SAU KHI gộp
    // với giá trị đang lưu: sửa quy tắc mà chỉ gửi mỗi `topics` vẫn soi đúng mode.
    await this.applySourceScope(b, current, ownerId, full, out);

    if (b.video_config !== undefined) out.video_config = b.video_config ?? {};
    if (b.is_active !== undefined) out.is_active = !!b.is_active;

    return out;
  }

  /**
   * Kiểm & chuẩn hoá NGUỒN video (dùng chung cho produce & reup). Bốn cách:
   *   any     — bất kỳ video chưa sản xuất
   *   topics  — theo cụm chủ đề (≥1 chủ đề)
   *   videos  — đúng những video đã tick (≥1, phải thuộc user)
   *   channel — đúng 1 kênh nguồn đã theo dõi (phải thuộc user)
   * Đổi mode thì dọn sạch phạm vi của mode khác -> không để dữ liệu mồ côi.
   */
  private async applySourceScope(
    b: RuleBody,
    current: any,
    ownerId: string,
    full: boolean,
    out: Record<string, any>,
  ): Promise<void> {
    if (
      b.pick_mode === undefined &&
      b.topics === undefined &&
      b.source_video_ids === undefined &&
      b.source_channel_id === undefined &&
      !full
    ) {
      return;
    }
    const mode = b.pick_mode ?? current?.pick_mode ?? 'any';
    if (!['any', 'topics', 'videos', 'channel'].includes(mode)) {
      throw new BadRequestException('Nguồn video không hợp lệ.');
    }
    out.pick_mode = mode;

    if (mode === 'topics') {
      const topics = b.topics ?? current?.topics ?? [];
      if (!topics.length) throw new BadRequestException('Chọn ít nhất 1 chủ đề.');
      out.topics = [...new Set(topics)];
      out.source_video_ids = [];
      out.source_channel_id = null;
    } else if (mode === 'videos') {
      const ids = b.source_video_ids ?? current?.source_video_ids ?? [];
      if (!ids.length) throw new BadRequestException('Tick ít nhất 1 video.');
      const owned = await this.prisma.source_videos.findMany({
        where: { id: { in: ids }, owner_id: ownerId },
        select: { id: true },
      });
      if (owned.length !== ids.length) {
        throw new BadRequestException('Có video không tồn tại hoặc không thuộc bạn.');
      }
      out.source_video_ids = ids;
      out.topics = [];
      out.source_channel_id = null;
    } else if (mode === 'channel') {
      const chId = b.source_channel_id ?? current?.source_channel_id ?? null;
      if (!chId) throw new BadRequestException('Chọn 1 kênh nguồn đã theo dõi.');
      const ch = await this.prisma.channels.findFirst({
        where: { id: chId, owner_id: ownerId },
        select: { id: true },
      });
      if (!ch) {
        throw new BadRequestException('Kênh nguồn không tồn tại hoặc không thuộc bạn.');
      }
      out.source_channel_id = chId;
      out.topics = [];
      out.source_video_ids = [];
    } else {
      // any: dọn sạch mọi phạm vi cũ.
      out.topics = [];
      out.source_video_ids = [];
      out.source_channel_id = null;
    }
  }
}
