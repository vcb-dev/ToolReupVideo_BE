import { Controller, Get, Logger, Query, Req, UseGuards } from '@nestjs/common';
import axios from 'axios';
import { AdminGuard } from '../auth/admin.guard';
import { SupabaseAuthGuard } from '../auth/auth.guard';
import { PrismaService } from '../prisma/prisma.service';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';
const PROVIDERS = ['tikhub', 'gemini', 'deepseek'] as const;

/** Khoá ngày theo giờ máy chủ (cùng cách chia ngày với overview()). */
const keyOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;

/**
 * Thống kê tổng hợp cho Dashboard (khối 8 — Đo lường).
 * Gom nhóm theo ngày ở tầng Node để bar chart FE dùng số thật.
 * Prisma không có RLS -> lọc owner_id = user hiện tại.
 */
@UseGuards(SupabaseAuthGuard)
@Controller('api/stats')
export class StatsController {
  private readonly logger = new Logger(StatsController.name);

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

  /**
   * Chi phí API (TikHub / Gemini / DeepSeek) cho khối "Chi phí API" ở trang
   * Tổng quan — CHỈ ADMIN. Tính cho CẢ HỆ THỐNG (không lọc owner): tiền trả
   * chung một bộ key API.
   *
   * Số tiền là số AI đã tính lúc gọi theo bảng giá `usage:` trong config.yaml
   * (Gemini là ước tính — Google không có API số dư). `balances` là số dư
   * THẬT hỏi thẳng TikHub/DeepSeek qua AI; AI không trả lời thì để null chứ
   * không làm hỏng cả khối.
   */
  @Get('usage')
  @UseGuards(AdminGuard)
  async usage(@Query('days') daysRaw: string | undefined) {
    const days = Math.min(Math.max(parseInt(daysRaw ?? '7', 10) || 7, 1), 90);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));

    const [rows, first, balances] = await Promise.all([
      this.prisma.api_usage.findMany({
        where: { created_at: { gte: start } },
        select: {
          created_at: true,
          provider: true,
          op: true,
          label: true,
          requests: true,
          input_tokens: true,
          output_tokens: true,
          images: true,
          cost_usd: true,
        },
      }),
      this.prisma.api_usage.aggregate({ _min: { created_at: true } }),
      axios
        .get(`${AI_URL}/api/usage/balances`, { timeout: 20_000 })
        .then((r) => r.data)
        .catch((e) => {
          this.logger.warn(`Không lấy được số dư API từ AI: ${e?.message}`);
          return null;
        }),
    ]);

    // Chi phí/video: chỉ đếm video làm ra TỪ LÚC có số liệu chi phí — tuần đầu
    // triển khai, chia cho cả 7 ngày video thì ra con số thấp giả.
    const since = first._min.created_at;
    const from = since && since > start ? since : start;
    const videos = await this.prisma.processed_videos.count({
      where: { created_at: { gte: from } },
    });

    type Bucket = Record<string, number>;
    const order: string[] = [];
    const byDay = new Map<string, Bucket>();
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const k = keyOf(d);
      order.push(k);
      byDay.set(k, { tikhub: 0, gemini: 0, deepseek: 0, other: 0 });
    }

    const prov: Record<string, { requests: number; cost_usd: number }> = {};
    for (const p of PROVIDERS) prov[p] = { requests: 0, cost_usd: 0 };
    const ops = new Map<string, any>();
    let unpriced = 0;

    for (const r of rows) {
      const cost = r.cost_usd == null ? null : Number(r.cost_usd);
      const p = (PROVIDERS as readonly string[]).includes(r.provider) ? r.provider : 'other';
      prov[p] ??= { requests: 0, cost_usd: 0 };
      prov[p].requests += r.requests;
      prov[p].cost_usd += cost ?? 0;
      const day = byDay.get(keyOf(new Date(r.created_at)));
      if (day) day[p] = (day[p] ?? 0) + (cost ?? 0);
      if (cost == null) unpriced += r.requests;

      const key = `${r.provider}|${r.op}`;
      const o =
        ops.get(key) ??
        ops
          .set(key, {
            provider: r.provider,
            op: r.op,
            label: r.label,
            requests: 0,
            input_tokens: 0,
            output_tokens: 0,
            images: 0,
            cost_usd: 0,
            unpriced: 0,
          })
          .get(key);
      o.label = r.label; // nhãn mới nhất
      o.requests += r.requests;
      o.input_tokens += r.input_tokens;
      o.output_tokens += r.output_tokens;
      o.images += r.images;
      o.cost_usd += cost ?? 0;
      if (cost == null) o.unpriced += r.requests;
    }

    const total = Object.values(prov).reduce((a, p) => a + p.cost_usd, 0);
    const requests = Object.values(prov).reduce((a, p) => a + p.requests, 0);
    return {
      days: order.map((date) => {
        const b = byDay.get(date)!;
        return { date, ...b, total: b.tikhub + b.gemini + b.deepseek + b.other };
      }),
      totals: { cost_usd: total, requests, by_provider: prov },
      ops: [...ops.values()]
        .map((o) => ({ ...o, share: total > 0 ? o.cost_usd / total : 0 }))
        .sort((a, b) => b.cost_usd - a.cost_usd || b.requests - a.requests),
      per_video: { videos, cost_usd: videos > 0 ? total / videos : null },
      unpriced_requests: unpriced,
      since,
      balances,
      usd_vnd: Number(balances?.usd_vnd) || 26000,
    };
  }
}
