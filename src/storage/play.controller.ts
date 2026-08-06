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
    const url = await this.storage.signDownload(
      sv.drive_id,
      3600,
      'video/mp4',
      true, // link cho trình duyệt
    );
    return { ok: true, url };
  }

  // Phát VIDEO THÀNH PHẨM (đã sản xuất) — dùng để xem video thử ở Xưởng.
  @Get('play-processed/:processedVideoId')
  async playProcessed(@Param('processedVideoId') id: string, @Req() req: any) {
    const pv = await this.prisma.processed_videos.findFirst({
      where: { id, owner_id: req.user.id },
      select: { final_drive_id: true },
    });
    if (!pv) throw new NotFoundException('Không tìm thấy video thành phẩm');
    if (!pv.final_drive_id) {
      return { ok: false, error: 'Chưa có file thành phẩm.' };
    }
    const url = await this.storage.signDownload(
      pv.final_drive_id,
      3600,
      'video/mp4',
      true, // link cho trình duyệt
    );
    return { ok: true, url };
  }
}
