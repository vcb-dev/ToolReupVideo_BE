import {
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/auth.guard';
import { SupabaseRestService } from '../data/supabase-rest.service';
import { CrawlService } from './crawl.service';

@UseGuards(SupabaseAuthGuard)
@Controller('api/crawl')
export class CrawlController {
  constructor(
    private readonly crawl: CrawlService,
    private readonly rest: SupabaseRestService,
  ) {}

  /** "Cào ngay" 1 kênh theo yêu cầu user (không chờ cron). */
  @Post('channel/:id')
  @HttpCode(HttpStatus.OK)
  async crawlNow(
    @Param('id') id: string,
    @Query('max') max: string | undefined,
    @Req() req: any,
  ) {
    const rowsFound = await this.rest.list(
      req.accessToken,
      'channels',
      `id=eq.${id}&select=*`,
    );
    const channel = Array.isArray(rowsFound) ? rowsFound[0] : null;
    if (!channel) {
      throw new NotFoundException('Không tìm thấy kênh');
    }
    try {
      const { inserted } = await this.crawl.crawlChannel(
        channel,
        req.accessToken,
        max ? Number(max) : undefined,
      );
      return { ok: true, inserted };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
}
