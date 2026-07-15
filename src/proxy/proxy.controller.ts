import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ProxyService } from './proxy.service';
import { SupabaseAuthGuard } from '../auth/auth.guard';

// Toàn bộ route xử lý video yêu cầu đăng nhập
@UseGuards(SupabaseAuthGuard)
@Controller('api')
export class ProxyController {
  constructor(private readonly proxyService: ProxyService) {}

  @Get('state')
  async getState() {
    return this.proxyService.getState();
  }

  @Post('ingest')
  @HttpCode(HttpStatus.OK)
  async ingest(
    @Body() body: { user: string; max?: number; platform?: string },
  ) {
    return this.proxyService.ingest(
      body.user,
      body.max ?? 30,
      body.platform ?? 'douyin',
    );
  }

  // Quét preview (chỉ metadata, không tải)
  @Post('scan')
  @HttpCode(HttpStatus.OK)
  async scan(
    @Body() body: { user: string; max?: number; platform?: string },
  ) {
    return this.proxyService.scan(
      body.user,
      body.max ?? 30,
      body.platform ?? 'douyin',
    );
  }

  // Lưu các video đã chọn (tải + upload)
  @Post('save')
  @HttpCode(HttpStatus.OK)
  async save(@Body() body: { platform?: string; videos: any[] }) {
    return this.proxyService.save(body.platform ?? 'douyin', body.videos ?? []);
  }

  @Post('select')
  @HttpCode(HttpStatus.OK)
  async select(@Body() body: { aweme_id: string; selected: boolean }) {
    return this.proxyService.select(body.aweme_id, body.selected);
  }

  @Post('process')
  @HttpCode(HttpStatus.OK)
  async process(
    @Body()
    body: {
      platforms: string[];
      upload: boolean;
      auto_grammar?: boolean;
      remove_sensitive?: boolean;
    },
  ) {
    return this.proxyService.process(body.platforms, body.upload, {
      auto_grammar: body.auto_grammar,
      remove_sensitive: body.remove_sensitive,
    });
  }
}
