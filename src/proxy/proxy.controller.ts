import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ProxyService } from './proxy.service';
import { SupabaseAuthGuard } from '../auth/auth.guard';
import { DeletePinService } from '../auth/delete-pin.service';

// Toàn bộ route xử lý video yêu cầu đăng nhập
@UseGuards(SupabaseAuthGuard)
@Controller('api')
export class ProxyController {
  constructor(
    private readonly proxyService: ProxyService,
    private readonly deletePin: DeletePinService,
  ) {}

  // Truyền owner xuống AI để mỗi người chỉ nhận tiến độ + log của JOB CỦA MÌNH.
  @Get('state')
  async getState(@Req() req: any) {
    return this.proxyService.getState(req.user.id);
  }

  @Post('ingest')
  @HttpCode(HttpStatus.OK)
  async ingest(
    @Body() body: { user: string; max?: number; platform?: string },
    @Req() req: any,
  ) {
    return this.proxyService.ingest(
      body.user,
      body.max ?? 30,
      body.platform ?? 'douyin',
      req.user.id,
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

  // Lưu các video đã chọn (tải + upload + ghi source_videos của user)
  @Post('save')
  @HttpCode(HttpStatus.OK)
  async save(
    @Body() body: { platform?: string; videos: any[]; topic?: string },
    @Req() req: any,
  ) {
    return this.proxyService.save(
      body.platform ?? 'douyin',
      body.videos ?? [],
      req.user.id,
      body.topic,
    );
  }

  @Post('select')
  @HttpCode(HttpStatus.OK)
  async select(@Body() body: { aweme_id: string; selected: boolean }) {
    return this.proxyService.select(body.aweme_id, body.selected);
  }

  // Xoá 1 video khỏi kho (file trên storage + manifest + dòng source_videos)
  @Post('videos/delete')
  @HttpCode(HttpStatus.OK)
  async deleteVideo(@Body() body: { aweme_id: string }, @Req() req: any) {
    await this.deletePin.assertDeleteAllowed(req.user, req.headers['x-delete-pin']);
    return this.proxyService.deleteVideo(body.aweme_id, req.user.id);
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
    @Req() req: any,
  ) {
    return this.proxyService.process(
      body.platforms,
      body.upload,
      {
        auto_grammar: body.auto_grammar,
        remove_sensitive: body.remove_sensitive,
      },
      req.user.id,
    );
  }
}
