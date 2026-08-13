import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/auth.guard';
import { DeletePinService } from '../auth/delete-pin.service';
import { PrismaService } from '../prisma/prisma.service';

const MAX_LEN = 80;

/**
 * Thư mục chủ đề của kho video.
 *
 * Khoá theo TÊN chứ không theo id: cột source_videos.topic lưu tên, và vẫn có
 * thư mục "mồ côi" (video mang topic nhưng chưa có dòng trong bảng topics —
 * video cào bằng cron/automation trước khi có bảng này). Làm theo tên thì hai
 * nguồn đó gộp lại thành một danh sách duy nhất, xoá/đổi tên đều trúng cả hai.
 */
@UseGuards(SupabaseAuthGuard)
@Controller('api/topics')
export class TopicsController {
  private readonly logger = new Logger(TopicsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deletePin: DeletePinService,
  ) {}

  /** Chuẩn hoá tên thư mục; ném 400 nếu rỗng hoặc quá dài. */
  private clean(name: unknown): string {
    const s = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!s) throw new BadRequestException('Tên thư mục không được để trống.');
    if (s.length > MAX_LEN) {
      throw new BadRequestException(`Tên thư mục tối đa ${MAX_LEN} ký tự.`);
    }
    return s;
  }

  /**
   * Danh sách thư mục = bảng topics HỢP với các chủ đề đang gắn trên video.
   * Trả kèm số video để FE khỏi tự đếm khi chưa tải hết kho.
   */
  @Get()
  async list(@Req() req: any) {
    if (!this.prisma.enabled) return { ok: true, topics: [] };
    const ownerId = req.user.id;
    const [rows, used] = await Promise.all([
      // Chưa chạy 0020_topics.sql thì bảng chưa tồn tại -> vẫn trả về danh sách
      // suy từ video, để Kho video không trắng trơn chỉ vì thiếu migration.
      this.prisma.topics
        .findMany({
          where: { owner_id: ownerId },
          select: { name: true, created_at: true },
        })
        .catch((e: any) => {
          this.logger.warn(`Đọc bảng topics lỗi: ${e.message}`);
          return [] as { name: string }[];
        }),
      this.prisma.source_videos.groupBy({
        by: ['topic'],
        where: { owner_id: ownerId, topic: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const counts = new Map<string, number>();
    for (const u of used as any[]) {
      const name = (u.topic ?? '').trim();
      if (name) counts.set(name, (counts.get(name) ?? 0) + u._count._all);
    }
    const names = new Set<string>([
      ...rows.map((r) => r.name),
      ...counts.keys(),
    ]);
    const topics = Array.from(names)
      .map((name) => ({ name, video_count: counts.get(name) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    return { ok: true, topics };
  }

  /** Tạo thư mục RỖNG. Trùng tên -> trả về chính nó (bấm 2 lần không lỗi). */
  @Post()
  async create(@Body() body: { name: string }, @Req() req: any) {
    const name = this.clean(body?.name);
    if (!this.prisma.enabled) {
      throw new BadRequestException('Chưa cấu hình DATABASE_URL.');
    }
    const owner_id = req.user.id;
    const existed = await this.prisma.topics.findFirst({
      where: { owner_id, name },
    });
    if (existed) return { ok: true, name, created: false };
    await this.prisma.topics.create({ data: { owner_id, name } });
    return { ok: true, name, created: true };
  }

  /**
   * Xoá thư mục. KHÔNG xoá video: video bên trong rơi về "Chưa phân loại"
   * (topic = null) — xoá nhầm thư mục thì chỉ mất cách sắp xếp, không mất kho.
   */
  @Delete()
  async remove(@Body() body: { name: string }, @Req() req: any) {
    await this.deletePin.assertDeleteAllowed(
      req.user,
      req.headers['x-delete-pin'],
    );
    const name = this.clean(body?.name);
    const owner_id = req.user.id;
    const moved = await this.prisma.source_videos.updateMany({
      where: { owner_id, topic: name },
      data: { topic: null },
    });
    // Thư mục "mồ côi" (chỉ tồn tại qua topic trên video) không có dòng để xoá,
    // và bảng có thể chưa được tạo -> lỗi ở đây không làm hỏng thao tác.
    await this.prisma.topics
      .deleteMany({ where: { owner_id, name } })
      .catch((e: any) => this.logger.warn(`Xoá dòng topics lỗi: ${e.message}`));
    return { ok: true, name, moved: moved.count };
  }
}
