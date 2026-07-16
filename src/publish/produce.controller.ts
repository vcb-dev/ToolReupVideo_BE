import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import axios from 'axios';
import { SupabaseAuthGuard } from '../auth/auth.guard';
import { PrismaService } from '../prisma/prisma.service';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';

/**
 * Sản xuất 1 source video -> ghi processed_videos.
 * Gọi AI /api/produce (dịch + lồng tiếng + ghép), có thể chạy lâu.
 */
@UseGuards(SupabaseAuthGuard)
@Controller('api/produce')
export class ProduceController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sản xuất MẺ video đã chọn (từ Xưởng video) -> ghi processed_videos, tùy
   * chọn đăng luôn. Chạy NỀN trên AI (không bị proxy cắt): forward danh sách +
   * owner_id sang AI /api/produce_batch rồi trả ngay. Tiến độ xem qua /api/state.
   */
  @Post('batch')
  @HttpCode(HttpStatus.OK)
  async batch(
    @Body()
    body: {
      source_video_ids?: string[];
      platforms?: string[];
      upload?: boolean;
      auto_grammar?: boolean;
      remove_sensitive?: boolean;
    },
    @Req() req: any,
  ) {
    const ids = body.source_video_ids || [];
    if (ids.length === 0) {
      throw new BadRequestException('Chưa chọn video nào.');
    }
    // Chỉ lấy source video của chính user (thay cho RLS).
    const svs = await this.prisma.source_videos.findMany({
      where: { id: { in: ids }, owner_id: req.user.id },
    });
    if (svs.length === 0) {
      throw new NotFoundException('Không tìm thấy source video hợp lệ');
    }
    const items = svs.map((sv) => ({
      source_id: sv.id,
      video_id: sv.platform_video_id,
      drive_id: sv.drive_id,
      desc: sv.descr,
    }));
    try {
      const res = await axios.post(
        `${AI_URL}/api/produce_batch`,
        {
          owner_id: req.user.id,
          items,
          platforms: body.platforms ?? [],
          upload: body.upload ?? false,
          auto_grammar: body.auto_grammar ?? false,
          remove_sensitive: body.remove_sensitive ?? false,
        },
        { timeout: 1000 * 30 },
      );
      if (!res.data?.ok) {
        return { ok: false, error: res.data?.error || 'AI produce_batch thất bại' };
      }
      return { ok: true, queued: items.length };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  @Post(':sourceVideoId')
  @HttpCode(HttpStatus.OK)
  async produce(@Param('sourceVideoId') id: string, @Req() req: any) {
    // Chỉ lấy source video của chính user (thay cho RLS).
    const sv = await this.prisma.source_videos.findFirst({
      where: { id, owner_id: req.user.id },
    });
    if (!sv) throw new NotFoundException('Không tìm thấy source video');

    try {
      const res = await axios.post(
        `${AI_URL}/api/produce`,
        {
          video_id: sv.platform_video_id,
          drive_id: sv.drive_id,
          desc: sv.descr,
        },
        { timeout: 1000 * 60 * 30 },
      );
      if (!res.data?.ok) {
        return { ok: false, error: res.data?.error || 'AI produce thất bại' };
      }

      const pv = await this.prisma.processed_videos.create({
        data: {
          owner_id: sv.owner_id,
          source_video_id: sv.id,
          final_path: res.data.final_path,
          final_drive_id: res.data.final_drive_id,
          target_lang: res.data.target_lang,
          voice_id: res.data.voice_id,
          has_subtitle: res.data.has_subtitle,
          status: 'done',
          produced_at: new Date(),
        },
      });
      await this.prisma.source_videos.update({
        where: { id: sv.id },
        data: { status: 'done' },
      });
      return { ok: true, processed_video: pv };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
}
