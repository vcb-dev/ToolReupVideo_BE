import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { readdir, rm } from 'fs/promises';
import { resolve } from 'path';
import { CRON_ENABLED } from '../cron-guard';

/** Giữ file đã xoá bao lâu trước khi dọn hẳn — đủ để phát hiện lỡ tay/xoá
 *  nhầm, nhưng không để thùng rác lại làm đầy ổ đĩa như trước (sự cố
 *  2026-08-24: ổ đĩa còn 11GB free vì rác chồng chất không ai dọn). */
const RETENTION_DAYS = Number(process.env.TRASH_RETENTION_DAYS || 7);

/**
 * Dọn thùng rác local (`storage/.trash/<ngày>/`) quá hạn giữ.
 *
 * StorageService.remove() không xoá cứng nữa mà CHUYỂN file vào đây (xem đó
 * để hiểu vì sao) — cron này là nửa còn lại: không dọn thì thùng rác phình
 * vô hạn, đúng vấn đề ban đầu nhưng dời sang một thư mục khác.
 */
@Injectable()
export class TrashSweeperService {
  private readonly logger = new Logger(TrashSweeperService.name);
  private readonly trashRoot = resolve(
    process.env.LOCAL_STORAGE_DIR || './storage/videos',
    '..',
    '.trash',
  );

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async sweep() {
    if (!CRON_ENABLED) return;
    if ((process.env.STORAGE_PROVIDER || '').toLowerCase() !== 'local') return;

    let days: string[];
    try {
      days = (await readdir(this.trashRoot, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return; // chưa ai xoá gì -> chưa có thùng rác, không phải lỗi
    }

    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const day of days) {
      // Tên thư mục LÀ ngày (YYYY-MM-DD, xem StorageService.trashPath) -> so
      // trực tiếp, không cần đọc mtime từng file bên trong.
      const t = Date.parse(`${day}T00:00:00Z`);
      if (!Number.isFinite(t) || t > cutoff) continue;
      await rm(resolve(this.trashRoot, day), { recursive: true, force: true }).catch(
        (e) => this.logger.warn(`Dọn thùng rác ngày ${day} lỗi (bỏ qua): ${e.message}`),
      );
      removed++;
    }
    if (removed) {
      this.logger.log(
        `Đã dọn hẳn ${removed} ngày rác quá ${RETENTION_DAYS} ngày.`,
      );
    }
  }
}
