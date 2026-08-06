import {
  Controller,
  Get,
  Put,
  Query,
  Req,
  Res,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createReadStream, createWriteStream } from 'fs';
import { stat, mkdir, unlink } from 'fs/promises';
import { dirname } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { FileOp, StorageService } from './storage.service';

/** Trần dung lượng mỗi file PUT lên. Dùng chung với SourceUploadController. */
export const MAX_UPLOAD_BYTES =
  Number(process.env.MAX_UPLOAD_VIDEO_MB || 500) * 1024 * 1024;

/**
 * Phục vụ file của kho LOCAL (STORAGE_PROVIDER=local).
 *
 * KHÔNG gắn SupabaseAuthGuard: thẻ <video> của trình duyệt không gửi được header
 * Authorization. Thay vào đó mỗi URL mang chữ ký HMAC có hạn do StorageService
 * cấp — đúng vai trò của presigned URL bên R2/Supabase.
 *
 * Hỗ trợ HTTP Range (206) để tua video; thiếu nó thì video phát được nhưng
 * kéo thanh thời gian sẽ không nhảy.
 */
@Controller('files')
export class LocalFilesController {
  constructor(private readonly storage: StorageService) {}

  /** Lấy key từ phần đuôi URL (key có thư mục con: media/frame/<owner>/<uuid>.png). */
  private keyOf(req: Request): string {
    const raw = (req.params as any)[0] || '';
    return decodeURIComponent(raw);
  }

  private verify(key: string, exp: string, sig: string, op: FileOp) {
    if (!this.storage.verifyFileToken(key, exp, sig, op)) {
      throw new ForbiddenException('Link không hợp lệ hoặc đã hết hạn.');
    }
  }

  @Get('*')
  async download(
    @Req() req: Request,
    @Res() res: Response,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Query('ct') ct?: string,
  ) {
    const key = this.keyOf(req);
    this.verify(key, exp, sig, 'get');

    const path = this.storage.localPath(key);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new NotFoundException('Không thấy file trong kho local.');
    }

    const type = ct || 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', 'inline');
    // helmet đặt mặc định Cross-Origin-Resource-Policy: same-origin, sẽ chặn
    // thẻ <video>/<audio> của FE (khác origin với BE) tải file này. Link đã có
    // chữ ký hết hạn nên mở cross-origin ở đây là an toàn.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // Link đã có hạn trong chữ ký; cache riêng theo trình duyệt là an toàn.
    res.setHeader('Cache-Control', 'private, max-age=3600');

    const range = req.headers.range;
    if (range) {
      // Chỉ xử lý dạng đơn giản "bytes=start-end" — đủ cho trình duyệt phát video.
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : size - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
          res.status(416).setHeader('Content-Range', `bytes */${size}`);
          return res.end();
        }
        if (end >= size) end = size - 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', String(end - start + 1));
        return pipeline(createReadStream(path, { start, end }), res).catch(
          () => undefined, // client tua/đóng tab giữa chừng -> bỏ qua
        );
      }
    }

    res.status(200);
    res.setHeader('Content-Length', String(size));
    return pipeline(createReadStream(path), res).catch(() => undefined);
  }

  /**
   * Nhận file PUT lên (tương ứng presigned PUT của R2). Client là AI service
   * HOẶC trình duyệt của người dùng đang tải video lên — link ký sẵn (op=put)
   * là toàn bộ cơ chế xác thực, nên phải tự giới hạn dung lượng ở đây.
   */
  @Put('*')
  async upload(
    @Req() req: Request,
    @Res() res: Response,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
  ) {
    const key = this.keyOf(req);
    this.verify(key, exp, sig, 'put');
    if (!key) throw new BadRequestException('Thiếu key.');

    // Nếu body parser của Nest đã nuốt stream (client gửi Content-Type kiểu
    // json/urlencoded) thì ghi tiếp sẽ ra FILE RỖNG mà vẫn báo ok — báo lỗi rõ
    // ràng còn hơn âm thầm mất dữ liệu. File nhị phân phải gửi octet-stream.
    if (req.readableEnded) {
      throw new BadRequestException(
        'Body đã bị đọc trước — hãy gửi với Content-Type: application/octet-stream.',
      );
    }

    // Chặn sớm theo dung lượng khai báo, đỡ phải ghi ra đĩa rồi mới huỷ.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      throw new PayloadTooLargeException(
        `File vượt quá ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
      );
    }

    const path = this.storage.localPath(key);
    await mkdir(dirname(path), { recursive: true });

    // Content-Length chỉ là lời khai (chunked encoding còn không có), nên phải
    // đếm byte thật trong lúc chảy. Vượt ngưỡng -> huỷ và xoá file dở.
    let seen = 0;
    const cap = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > MAX_UPLOAD_BYTES) {
          return cb(
            new PayloadTooLargeException(
              `File vượt quá ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
            ),
          );
        }
        cb(null, chunk);
      },
    });

    try {
      await pipeline(req, cap, createWriteStream(path));
    } catch (e) {
      await unlink(path).catch(() => undefined); // không để lại file cụt
      throw e;
    }
    return res.json({ ok: true, size: seen });
  }
}
