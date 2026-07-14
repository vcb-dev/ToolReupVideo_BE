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
  async ingest(@Body() body: { user: string; max?: number }) {
    return this.proxyService.ingest(body.user, body.max ?? 30);
  }

  @Post('select')
  @HttpCode(HttpStatus.OK)
  async select(@Body() body: { aweme_id: string; selected: boolean }) {
    return this.proxyService.select(body.aweme_id, body.selected);
  }

  @Post('process')
  @HttpCode(HttpStatus.OK)
  async process(@Body() body: { platforms: string[]; upload: boolean }) {
    return this.proxyService.process(body.platforms, body.upload);
  }
}
