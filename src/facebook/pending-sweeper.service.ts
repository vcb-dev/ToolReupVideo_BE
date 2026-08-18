import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PENDING_PREFIX, PENDING_TTL_MS } from './pending';

/**
 * Dọn bản tạm OAuth Facebook đã quá hạn trong app_config.
 *
 * Controller đã xoá bản tạm ở hai nhánh chạy đúng luồng: user bấm lưu page, và
 * user gọi /pending sau khi hết hạn. Còn một nhánh không ai bịt được từ bên
 * trong: đăng nhập FB xong rồi ĐÓNG TAB — không còn request nào chạm tới bản
 * ghi, mà bản ghi đó chứa Page access token của mọi page nick ấy quản lý.
 *
 * Cùng khung giờ với UploadSweeperService (4h sáng, lúc rảnh nhất).
 */
@Injectable()
export class PendingSweeperService {
  private readonly logger = new Logger(PendingSweeperService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async sweep() {
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    const { count } = await this.prisma.app_config.deleteMany({
      where: {
        key: { startsWith: PENDING_PREFIX },
        updated_at: { lt: cutoff },
      },
    });
    if (count) {
      this.logger.log(`Đã dọn ${count} bản tạm kết nối Facebook quá hạn.`);
    }
  }
}
