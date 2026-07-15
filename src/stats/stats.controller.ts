import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/auth.guard';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Thống kê tổng hợp cho Dashboard (khối 8 — Đo lường).
 * Gom nhóm theo ngày ở tầng Node để bar chart FE dùng số thật.
 * Prisma không có RLS -> lọc owner_id = user hiện tại.
 */
@UseGuards(SupabaseAuthGuard)
@Controller('api/stats')
export class StatsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('overview')
  async overview(@Query('days') daysRaw: string | undefined, @Req() req: any) {
    const days = Math.min(Math.max(parseInt(daysRaw ?? '7', 10) || 7, 1), 30);
    const ownerId = req.user.id;

    // Mốc bắt đầu = 00:00 của (days-1) ngày trước, theo giờ máy chủ.
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));

    const [processed, schedules] = await Promise.all([
      this.prisma.processed_videos.findMany({
        where: { owner_id: ownerId, created_at: { gte: start } },
        select: { created_at: true, produced_at: true },
      }),
      this.prisma.schedules.findMany({
        where: {
          owner_id: ownerId,
          status: 'posted',
          posted_at: { gte: start },
        },
        select: { posted_at: true },
      }),
    ]);

    // Khởi tạo khung ngày (đủ N ngày, ngày trống = 0).
    const keyOf = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`;
    const buckets = new Map<string, { processed: number; posted: number }>();
    const order: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const k = keyOf(d);
      buckets.set(k, { processed: 0, posted: 0 });
      order.push(k);
    }

    const bump = (
      dt: Date | null | undefined,
      field: 'processed' | 'posted',
    ) => {
      if (!dt) return;
      const b = buckets.get(keyOf(new Date(dt)));
      if (b) b[field] += 1;
    };

    for (const p of processed) bump(p.produced_at ?? p.created_at, 'processed');
    for (const s of schedules) bump(s.posted_at, 'posted');

    const daysOut = order.map((k) => ({ date: k, ...buckets.get(k)! }));
    const totals = daysOut.reduce(
      (a, d) => ({
        processed: a.processed + d.processed,
        posted: a.posted + d.posted,
      }),
      { processed: 0, posted: 0 },
    );

    return { days: daysOut, totals };
  }
}
