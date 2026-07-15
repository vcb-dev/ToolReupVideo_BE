import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InternalTokenGuard } from './internal.guard';
import { StorageService } from './storage.service';

/**
 * Route nội bộ (service-to-service) — chỉ AI service gọi, không phải trình duyệt.
 * Bảo vệ bằng INTERNAL_API_TOKEN (không dùng đăng nhập user).
 */
@UseGuards(InternalTokenGuard)
@Controller('internal/storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post('sign-upload')
  @HttpCode(HttpStatus.OK)
  async signUpload(@Body() body: { key: string }) {
    const uploadUrl = await this.storage.signUpload(body.key);
    return { ok: true, uploadUrl };
  }

  @Post('sign-download')
  @HttpCode(HttpStatus.OK)
  async signDownload(@Body() body: { key: string; expiresIn?: number }) {
    const downloadUrl = await this.storage.signDownload(
      body.key,
      body.expiresIn,
    );
    return { ok: true, downloadUrl };
  }

  @Post('delete')
  @HttpCode(HttpStatus.OK)
  async delete(@Body() body: { key: string }) {
    await this.storage.remove(body.key);
    return { ok: true };
  }
}
