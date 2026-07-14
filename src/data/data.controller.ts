import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/auth.guard';
import { SupabaseRestService } from './supabase-rest.service';

// Tên tài nguyên trên URL -> tên bảng trong Postgres.
// Chỉ những bảng có ở đây mới được truy cập (whitelist chống SQL/route injection).
const RESOURCE_TABLE: Record<string, string> = {
  channels: 'channels',
  pages: 'pages',
  'affiliate-links': 'affiliate_links',
  schedules: 'schedules',
  'source-videos': 'source_videos',
  'processed-videos': 'processed_videos',
};

/**
 * CRUD generic cho các bảng nghiệp vụ, đặt dưới /api/data/* để không đụng
 * các route xử lý video của ProxyController (/api/state, /api/ingest, ...).
 * Mọi thao tác chạy dưới danh nghĩa user -> RLS tự lọc theo owner_id.
 */
@UseGuards(SupabaseAuthGuard)
@Controller('api/data')
export class DataController {
  constructor(private readonly rest: SupabaseRestService) {}

  private tableOf(resource: string): string {
    const table = RESOURCE_TABLE[resource];
    if (!table) {
      throw new NotFoundException(`Tài nguyên không hợp lệ: ${resource}`);
    }
    return table;
  }

  @Get(':resource')
  async list(
    @Param('resource') resource: string,
    @Query('q') q: string | undefined,
    @Req() req: any,
  ) {
    const table = this.tableOf(resource);
    // Cho phép truyền query PostgREST tùy biến (vd: platform=eq.tiktok), mặc định sort mới nhất.
    const query = q && q.length ? q : 'order=created_at.desc';
    return this.rest.list(req.accessToken, table, query);
  }

  @Post(':resource')
  async create(
    @Param('resource') resource: string,
    @Body() body: Record<string, unknown>,
    @Req() req: any,
  ) {
    const table = this.tableOf(resource);
    // Gắn chủ sở hữu = user hiện tại để thỏa RLS `with check (owner_id = auth.uid())`.
    const payload = { ...body, owner_id: req.user.id };
    return this.rest.create(req.accessToken, table, payload);
  }

  @Patch(':resource/:id')
  async update(
    @Param('resource') resource: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: any,
  ) {
    const table = this.tableOf(resource);
    // Không cho đổi owner_id qua update.
    const { owner_id, ...rest } = body as any;
    return this.rest.update(req.accessToken, table, id, rest);
  }

  @Delete(':resource/:id')
  async remove(
    @Param('resource') resource: string,
    @Param('id') id: string,
    @Req() req: any,
  ) {
    const table = this.tableOf(resource);
    return this.rest.remove(req.accessToken, table, id);
  }
}
