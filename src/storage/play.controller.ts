import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage.service';

/**
 * Cấp link PHÁT video (presigned GET, R2/Supabase) cho trình duyệt xem trước.
 * Có xác thực user + kiểm tra video thuộc đúng owner (thay RLS). Khác với
 * internal/storage/sign-download (chỉ service-to-service).
 */
@UseGuards(SupabaseAuthGuard)
@Controller('api/storage')
export class StoragePlayController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  @Get('play-url/:sourceVideoId')
  async playUrl(@Param('sourceVideoId') id: string, @Req() req: any) {
    const sv = await this.prisma.source_videos.findFirst({
      where: { id, owner_id: req.user.id },
      select: { drive_id: true },
    });
    if (!sv) throw new NotFoundException('Không tìm thấy video');
    if (!sv.drive_id) {
      return { ok: false, error: 'Video chưa có file lưu trữ.' };
    }
    // Link phát có hạn (1 giờ) — đủ để xem, không lộ vĩnh viễn. Ép video/mp4
    // để trình duyệt phát inline dù object R2 lưu không có content-type đúng.
    const url = await this.storage.signDownload(sv.drive_id, 3600, 'video/mp4');
    return { ok: true, url };
  }
}
