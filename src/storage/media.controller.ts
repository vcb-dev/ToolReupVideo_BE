import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { SupabaseAuthGuard } from '../auth/auth.guard';
import { DeletePinService } from '../auth/delete-pin.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage.service';

// Đủ dùng thay cho @types/multer (tránh thêm phụ thuộc kiểu).
interface UploadFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

/**
 * Kho media (nhạc / khung / voice). Upload QUA BE: trình duyệt gửi multipart,
 * BE đẩy file nhạc/khung lên R2; với voice thì forward sang AI để MiniMax clone.
 */
@UseGuards(SupabaseAuthGuard)
@Controller('api/media')
export class MediaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly deletePin: DeletePinService,
  ) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 60 * 1024 * 1024 } }),
  )
  async upload(
    @UploadedFile() file: UploadFile,
    @Req() req: any,
  ) {
    const ownerId = req.user.id;
    const kind = (req.body?.kind || '').trim();
    const name = (req.body?.name || file?.originalname || 'Không tên').trim();
    if (!file) throw new BadRequestException('Thiếu file.');
    if (!['music', 'frame', 'voice', 'logo'].includes(kind)) {
      throw new BadRequestException('kind phải là music | frame | voice | logo.');
    }

    // Mọi loại (kể cả voice) -> chỉ LƯU file lên R2. Voice sẽ được clone ở lần
    // sản xuất đầu tiên (khi user chọn voice), rồi cache voice_id lại.
    const ext = extname(file.originalname) || '';
    const key = `media/${kind}/${ownerId}/${randomUUID()}${ext}`;
    try {
      await this.storage.putBuffer(key, file.buffer, file.mimetype);
    } catch (e: any) {
      return { ok: false, error: `Lưu kho lỗi: ${e.message}` };
    }
    const asset = await this.prisma.media_assets.create({
      data: {
        owner_id: ownerId,
        kind,
        name,
        drive_id: key,
        ...(kind === 'frame' ? { chroma_color: '0x00FF00' } : {}),
      },
    });
    return { ok: true, asset };
  }

  @Get(':id/url')
  async url(@Param('id') id: string, @Req() req: any) {
    const asset = await this.prisma.media_assets.findFirst({
      where: { id, owner_id: req.user.id },
    });
    if (!asset) throw new NotFoundException('Không tìm thấy media');
    if (!asset.drive_id) return { ok: false, error: 'Media không có file.' };
    const ct =
      asset.kind === 'music' || asset.kind === 'voice'
        ? 'audio/mpeg'
        : undefined;
    const url = await this.storage.signDownload(asset.drive_id, 3600, ct);
    return { ok: true, url };
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: any) {
    await this.deletePin.assertDeleteAllowed(req.user, req.headers['x-delete-pin']);
    const asset = await this.prisma.media_assets.findFirst({
      where: { id, owner_id: req.user.id },
    });
    if (!asset) throw new NotFoundException('Không tìm thấy media');
    if (asset.drive_id) {
      try {
        await this.storage.remove(asset.drive_id);
      } catch (e: any) {
        // best-effort: file có thể đã xoá tay
      }
    }
    await this.prisma.media_assets.delete({ where: { id: asset.id } });
    return { ok: true };
  }
}
