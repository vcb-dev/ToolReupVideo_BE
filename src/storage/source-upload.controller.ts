import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { extname } from 'path';
import { SupabaseAuthGuard } from '../auth/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_UPLOAD_BYTES } from './local-files.controller';
import { StorageService } from './storage.service';

const ALLOWED_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];

/**
 * `platform_video_id` do SERVER sinh, không bao giờ lấy từ tên file người dùng.
 * Bên AI dùng giá trị này làm TÊN THƯ MỤC làm việc (batch.py: `vdir = work / vid`)
 * và TÊN FILE kết quả (mix.py: `f"{work_dir.name}_vi.mp4"`), nên nó phải an toàn
 * với hệ thống file: không khoảng trắng, không dấu chấm, không unicode, không
 * dấu gạch đầu dòng (ffmpeg sẽ hiểu nhầm là cờ dòng lệnh).
 */
const PVID_RE = /^up_[0-9a-f]{24}$/;

/** Link ảnh bìa nằm thẳng trong cột cover_url và được render bằng <img src>, nên phải sống lâu. */
const COVER_TTL_SEC = Number(process.env.COVER_URL_TTL_SEC || 10 * 365 * 24 * 3600);
const UPLOAD_TTL_SEC = Number(process.env.UPLOAD_URL_TTL_SEC || 6 * 3600);

/**
 * Tải video của chính người dùng lên Kho, theo 3 nhịp:
 *
 *   init   -> server sinh id + key, trả URL PUT ký sẵn (tương đối)
 *   PUT    -> trình duyệt đẩy thẳng file vào /files/* (stream ra đĩa, không qua RAM của BE)
 *   commit -> server kiểm tra file có thật rồi mới tạo dòng trong source_videos
 *
 * Vì sao không dùng multipart như /api/media/upload: route đó nạp TOÀN BỘ file
 * vào bộ nhớ (FileInterceptor + putBuffer) và chặn ở 60 MB — không hợp với video.
 *
 * Vì sao client không được truyền key vào: nếu nhận key tuỳ ý thì bất kỳ ai đã
 * đăng nhập cũng ký được quyền GHI ĐÈ lên file của người dùng khác. Key luôn
 * được dựng lại từ req.user.id ở phía server.
 */
@UseGuards(SupabaseAuthGuard)
@Controller('api/source-videos/upload')
export class SourceUploadController {
  private readonly logger = new Logger(SourceUploadController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Chuẩn hoá + kiểm tra đuôi file. Trả về dạng có dấu chấm, viết thường. */
  private safeExt(filename: string, contentType?: string): string {
    const ext = extname(filename || '').toLowerCase();
    if (ALLOWED_EXT.includes(ext)) return ext;
    // Windows đôi khi không gắn đuôi; chấp nhận nếu trình duyệt khai là video.
    if (!ext && (contentType || '').startsWith('video/')) return '.mp4';
    throw new BadRequestException(
      `Chỉ nhận file ${ALLOWED_EXT.join(', ')}.`,
    );
  }

  /** Dựng lại cặp key từ dữ liệu client gửi lên, sau khi đã kiểm tra chặt. */
  private keysFor(ownerId: string, pvid: string, ext: string) {
    if (!PVID_RE.test(pvid || '')) {
      throw new BadRequestException('Mã video không hợp lệ.');
    }
    if (!ALLOWED_EXT.includes(ext)) {
      throw new BadRequestException('Đuôi file không hợp lệ.');
    }
    const videoKey = StorageService.uploadVideoKey(ownerId, pvid, ext);
    return { videoKey, coverKey: StorageService.coverKeyFor(videoKey) };
  }

  @Post('init')
  @HttpCode(HttpStatus.OK)
  async init(
    @Body() body: { filename?: string; size?: number; content_type?: string },
    @Req() req: any,
  ) {
    const size = Number(body?.size);
    if (!Number.isFinite(size) || size <= 0) {
      throw new BadRequestException('Thiếu dung lượng file.');
    }
    if (size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(
        `File vượt quá ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
      );
    }
    if (body?.content_type && !body.content_type.startsWith('video/')) {
      throw new BadRequestException('File không phải video.');
    }

    const ownerId = req.user.id;
    const ext = this.safeExt(body?.filename || '', body?.content_type);
    const pvid = 'up_' + randomBytes(12).toString('hex');
    const { videoKey, coverKey } = this.keysFor(ownerId, pvid, ext);

    return {
      ok: true,
      platform_video_id: pvid,
      ext,
      max_bytes: MAX_UPLOAD_BYTES,
      video_upload_url: await this.storage.signUpload(
        videoKey,
        UPLOAD_TTL_SEC,
        true,
      ),
      cover_upload_url: await this.storage.signUpload(
        coverKey,
        UPLOAD_TTL_SEC,
        true,
      ),
    };
  }

  @Post('commit')
  @HttpCode(HttpStatus.CREATED)
  async commit(
    @Body()
    body: {
      platform_video_id?: string;
      ext?: string;
      size?: number;
      topic?: string;
      descr?: string;
      duration?: number;
      has_cover?: boolean;
    },
    @Req() req: any,
  ) {
    const ownerId = req.user.id;
    const pvid = (body?.platform_video_id || '').trim();
    const ext = (body?.ext || '').toLowerCase();
    const { videoKey, coverKey } = this.keysFor(ownerId, pvid, ext);

    const st = await this.storage.statObject(videoKey);
    if (!st) throw new NotFoundException('Chưa thấy file đã tải lên.');
    if (st.size === 0) {
      await this.cleanup(videoKey, coverKey);
      throw new BadRequestException('File tải lên rỗng.');
    }
    // Lệch dung lượng = PUT bị đứt giữa chừng. Thà báo lỗi còn hơn để lại một
    // video hỏng nằm trong Kho mà tới lúc sản xuất mới phát hiện.
    const declared = Number(body?.size);
    if (Number.isFinite(declared) && declared > 0 && st.size !== declared) {
      await this.cleanup(videoKey, coverKey);
      throw new BadRequestException('File tải lên bị thiếu, vui lòng thử lại.');
    }

    let coverUrl: string | null = null;
    if (body?.has_cover && (await this.storage.statObject(coverKey))) {
      coverUrl = await this.storage.signDownload(
        coverKey,
        COVER_TTL_SEC,
        'image/jpeg',
        true, // link tương đối, dùng được cả ở localhost lẫn domain tunnel
      );
    }

    const duration = Number(body?.duration);
    try {
      const video = await this.prisma.source_videos.create({
        data: {
          owner_id: ownerId,
          channel_id: null,
          platform: 'upload',
          platform_video_id: pvid,
          drive_id: videoKey,
          descr: (body?.descr || '').trim() || null,
          topic: (body?.topic || '').trim() || null,
          cover_url: coverUrl,
          duration:
            Number.isFinite(duration) && duration > 0
              ? new Prisma.Decimal(duration)
              : null,
          original_url: null,
          status: 'new',
          selected: false,
          // Đặt = giờ hiện tại để video tải lên được các quy tắc tự động đăng
          // đối xử như video cào (automation lọc reup theo published_at >= cutoff).
          published_at: new Date(),
        },
      });
      this.logger.log(`Nhận video tải lên: ${videoKey} (${st.size} bytes)`);
      return { ok: true, video };
    } catch (e: any) {
      // Hỏng DB thì phải dọn file, nếu không sẽ thành file mồ côi không ai xoá.
      await this.cleanup(videoKey, coverKey);
      if (e?.code === 'P2002') {
        throw new ConflictException('Video này đã có trong kho.');
      }
      throw e;
    }
  }

  /** Người dùng huỷ hoặc gặp lỗi giữa chừng -> dọn file đã đẩy lên. */
  @Post('abort')
  @HttpCode(HttpStatus.OK)
  async abort(
    @Body() body: { platform_video_id?: string; ext?: string },
    @Req() req: any,
  ) {
    const { videoKey, coverKey } = this.keysFor(
      req.user.id,
      (body?.platform_video_id || '').trim(),
      (body?.ext || '').toLowerCase(),
    );
    await this.cleanup(videoKey, coverKey);
    return { ok: true };
  }

  private async cleanup(videoKey: string, coverKey: string) {
    await this.storage.remove(videoKey).catch(() => undefined);
    await this.storage.remove(coverKey).catch(() => undefined);
  }
}
