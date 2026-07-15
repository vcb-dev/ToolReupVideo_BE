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
}
