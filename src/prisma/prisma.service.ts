import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Kết nối Postgres (Supabase) qua Prisma bằng DATABASE_URL.
 * ⚠️ Prisma dùng kết nối trực tiếp -> KHÔNG có RLS. Mọi truy vấn theo user
 *    PHẢI tự lọc owner_id trong code (xem DataController/StatsController...).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  /** Có cấu hình DATABASE_URL không (cron sẽ no-op nếu thiếu). */
  get enabled(): boolean {
    return !!process.env.DATABASE_URL;
  }

  async onModuleInit() {
    // Không chặn boot nếu DB chưa sẵn sàng — để request tự báo lỗi như trước.
    try {
      await this.$connect();
      this.logger.log('Đã kết nối Postgres qua Prisma.');
    } catch (e: any) {
      this.logger.error(
        `Chưa kết nối được Postgres (Prisma): ${e.message}. ` +
          'Kiểm tra DATABASE_URL trong .env.',
      );
    }
  }

  /**
   * Lỗi KẾT NỐI CHẾT (không phải lỗi truy vấn): pooler Supabase đóng kết nối
   * nhàn rỗi, máy ngủ dậy, mạng rớt... Prisma vẫn giữ kết nối cũ trong pool nên
   * query kế tiếp văng ngay, còn query sau đó lại chạy được.
   */
  private static readonly DEAD_CONN =
    /closed the connection|Connection reset|ECONNRESET|Can't reach database server|Timed out fetching a new connection|Socket|kind: Closed/i;

  /**
   * Chạy truy vấn có THỬ LẠI 1 lần khi kết nối chết. Dành cho các CRON — chúng
   * nằm im giữa 2 lần chạy nên hay là kẻ đầu tiên vấp phải kết nối đã bị đóng;
   * không có nó thì cứ ~15-20 phút lại lỡ nguyên một nhịp quét.
   * Lỗi truy vấn thật (sai cột, vi phạm ràng buộc...) KHÔNG thử lại.
   */
  async withRetry<T>(fn: () => Promise<T>, label = 'truy vấn'): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      if (!PrismaService.DEAD_CONN.test(String(e?.message || ''))) throw e;
      this.logger.warn(`Kết nối DB đã đóng (${label}) — kết nối lại & thử lại.`);
      await this.$connect().catch(() => undefined);
      return await fn();
    }
  }
}
