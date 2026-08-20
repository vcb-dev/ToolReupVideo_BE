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
import { PrismaService } from '../prisma/prisma.service';
import { CrawlService } from './crawl.service';

@UseGuards(SupabaseAuthGuard)
@Controller('api/crawl')
export class CrawlController {
  constructor(
    private readonly crawl: CrawlService,
    private readonly prisma: PrismaService,
  ) {}

  /** "Cào ngay" 1 kênh theo yêu cầu user (không chờ cron). */
  @Post('channel/:id')
  @HttpCode(HttpStatus.OK)
  async crawlNow(
    @Param('id') id: string,
    @Query('max') max: string | undefined,
    @Req() req: any,
  ) {
    // Chỉ cào kênh của chính user (thay cho RLS).
    const channel = await this.prisma.channels.findFirst({
      where: { id, owner_id: req.user.id },
    });
    if (!channel) {
      throw new NotFoundException('Không tìm thấy kênh');
    }
    try {
      const { inserted, crawled, duplicates } = await this.crawl.crawlChannel(
        channel as any,
        max ? Number(max) : undefined,
      );
      return { ok: true, inserted, crawled, duplicates };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
}
