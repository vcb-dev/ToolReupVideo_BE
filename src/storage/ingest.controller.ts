import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InternalTokenGuard } from './internal.guard';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Route nội bộ (service-to-service): AI service gọi ngược để ghi các video đã
 * tải+upload vào source_videos. AI KHÔNG giữ Supabase key -> BE là nơi duy nhất
 * chạm DB. Bảo vệ bằng INTERNAL_API_TOKEN (không phải đăng nhập user).
 */
@UseGuards(InternalTokenGuard)
@Controller('internal/source-videos')
export class IngestInternalController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async create(@Body() body: { owner_id: string; videos: any[] }) {
    const ownerId = body.owner_id;
    const videos = body.videos || [];
    if (!ownerId || videos.length === 0) {
      return { ok: true, inserted: 0 };
    }
    if (!this.prisma.enabled) {
      return { ok: false, error: 'DB chưa cấu hình (thiếu DATABASE_URL).' };
    }
    const rows: any[] = videos.map((v) => ({
      platform: v.platform,
      platform_video_id: v.platform_video_id,
      descr: v.descr,
      cover_url: v.cover_url,
      original_url: v.original_url,
      drive_id: v.drive_id,
      topic: v.topic ?? null,
      owner_id: ownerId,
      status: 'new',
    }));
    const res = await this.prisma.source_videos.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return { ok: true, inserted: res.count };
  }
}
