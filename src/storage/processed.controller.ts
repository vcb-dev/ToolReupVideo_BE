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
 * Route nội bộ (service-to-service): AI service gọi ngược để ghi video ĐÃ SẢN
 * XUẤT (produce mẻ) vào processed_videos + đặt source status=done. AI KHÔNG giữ
 * Supabase key -> BE là nơi duy nhất chạm DB. Bảo vệ bằng INTERNAL_API_TOKEN.
 */
@UseGuards(InternalTokenGuard)
@Controller('internal/processed-videos')
export class ProcessedInternalController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async create(@Body() body: { owner_id: string; items: any[] }) {
    const ownerId = body.owner_id;
    const items = body.items || [];
    if (!ownerId || items.length === 0) {
      return { ok: true, inserted: 0 };
    }
    if (!this.prisma.enabled) {
      return { ok: false, error: 'DB chưa cấu hình (thiếu DATABASE_URL).' };
    }

    let inserted = 0;
    for (const it of items) {
      if (!it.source_id) continue;
      // Chỉ ghi cho source video thuộc đúng user (chống ghi nhầm owner).
      const sv = await this.prisma.source_videos.findFirst({
        where: { id: it.source_id, owner_id: ownerId },
      });
      if (!sv) continue;
      await this.prisma.processed_videos.create({
        data: {
          owner_id: ownerId,
          source_video_id: sv.id,
          final_path: it.final_path ?? null,
          final_drive_id: it.final_drive_id ?? null,
          target_lang: it.target_lang ?? 'vi',
          voice_id: it.voice_id ?? null,
          has_subtitle: !!it.has_subtitle,
          status: 'done',
          produced_at: new Date(),
        },
      });
      await this.prisma.source_videos.update({
        where: { id: sv.id },
        data: { status: 'done' },
      });
      inserted += 1;
    }
    return { ok: true, inserted };
  }
}
