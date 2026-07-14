import {
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
import { SupabaseRestService } from '../data/supabase-rest.service';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';

/**
 * Sản xuất 1 source video -> ghi processed_videos.
 * Gọi AI /api/produce (dịch + lồng tiếng + ghép), có thể chạy lâu.
 */
@UseGuards(SupabaseAuthGuard)
@Controller('api/produce')
export class ProduceController {
  constructor(private readonly rest: SupabaseRestService) {}

  @Post(':sourceVideoId')
  @HttpCode(HttpStatus.OK)
  async produce(@Param('sourceVideoId') id: string, @Req() req: any) {
    const found = await this.rest.list(
      req.accessToken,
      'source_videos',
      `id=eq.${id}&select=*`,
    );
    const sv = Array.isArray(found) ? found[0] : null;
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

      const pv = await this.rest.create(req.accessToken, 'processed_videos', {
        owner_id: sv.owner_id,
        source_video_id: sv.id,
        final_path: res.data.final_path,
        final_drive_id: res.data.final_drive_id,
        target_lang: res.data.target_lang,
        voice_id: res.data.voice_id,
        has_subtitle: res.data.has_subtitle,
        status: 'done',
        produced_at: new Date().toISOString(),
      });
      await this.rest.update(req.accessToken, 'source_videos', sv.id, {
        status: 'done',
      });
      return { ok: true, processed_video: pv };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
}
