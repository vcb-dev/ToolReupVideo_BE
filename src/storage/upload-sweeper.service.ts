import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { readdir, stat, unlink } from 'fs/promises';
import { join, relative, resolve, sep } from 'path';
import { PrismaService } from '../prisma/prisma.service';

/** File mới hơn ngưỡng này được tha — có thể là một upload đang chạy dở. */
const GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Dọn file trong `uploads/` không còn dòng nào trong DB trỏ tới.
 *
 * Mọi nhánh hỏng khác đã tự dọn (commit xoá khi lỗi, FE gọi /abort khi huỷ).
 * Còn đúng một lỗ không ai bịt được từ bên trong: người dùng ĐÓNG TAB giữa
 * chừng — file nằm đó, không có dòng DB, không có gì chạy để dọn.
 *
 * Đặt DRY_RUN=1 (mặc định) để chỉ ghi log trong vài ngày đầu, xem nó định xoá
 * những gì rồi hãy bật xoá thật bằng UPLOAD_SWEEP_DELETE=1.
 */
@Injectable()
export class UploadSweeperService {
  private readonly logger = new Logger(UploadSweeperService.name);
  private readonly root = resolve(
    process.env.LOCAL_STORAGE_DIR || './storage/videos',
  );
  private readonly reallyDelete = process.env.UPLOAD_SWEEP_DELETE === '1';

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async sweep() {
    if ((process.env.STORAGE_PROVIDER || '').toLowerCase() !== 'local') return;

    const base = join(this.root, 'uploads');
    let files: string[];
    try {
      files = await this.walk(base);
    } catch {
      return; // chưa ai tải lên -> chưa có thư mục, không phải lỗi
    }
    if (files.length === 0) return;

    // Tập key đang được tham chiếu = drive_id + ảnh bìa suy ra từ drive_id.
    const rows = await this.prisma.source_videos.findMany({
      where: { platform: 'upload', drive_id: { not: null } },
      select: { drive_id: true },
    });
    const keep = new Set<string>();
    for (const r of rows) {
      const k = r.drive_id as string;
      keep.add(k);
      keep.add(k.replace(/\.[^./]+$/, '') + '.jpg');
    }

    const cutoff = Date.now() - GRACE_MS;
    let removed = 0;
    for (const path of files) {
      const key = relative(this.root, path).split(sep).join('/');
      if (keep.has(key)) continue;
      const st = await stat(path).catch(() => null);
      if (!st || st.mtimeMs > cutoff) continue; // có thể đang tải dở -> tha
      if (this.reallyDelete) {
        await unlink(path).catch(() => undefined);
        removed++;
      } else {
        this.logger.log(`[thử] sẽ xoá file mồ côi: ${key}`);
      }
    }
    if (removed) this.logger.log(`Đã dọn ${removed} file mồ côi trong uploads/.`);
  }

  private async walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await this.walk(p)));
      else if (e.isFile()) out.push(p);
    }
    return out;
  }
}
