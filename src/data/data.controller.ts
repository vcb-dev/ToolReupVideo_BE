import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/auth.guard';
import { DeletePinService } from '../auth/delete-pin.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

// Tên tài nguyên trên URL -> tên model Prisma (đồng thời là delegate prisma.<model>).
// Whitelist chống truy cập bảng ngoài ý muốn.
const RESOURCE_MODEL = {
  channels: 'channels',
  pages: 'pages',
  'affiliate-links': 'affiliate_links',
  schedules: 'schedules',
  'source-videos': 'source_videos',
  'processed-videos': 'processed_videos',
  metrics: 'metrics',
  templates: 'templates',
  'media-assets': 'media_assets',
} as const;

type ResourceKey = keyof typeof RESOURCE_MODEL;

// Cột chứa key file trên kho (R2/Supabase). Xoá bản ghi thì xoá luôn file gốc,
// nếu không file nằm lại vĩnh viễn và vẫn tính dung lượng dù web không còn thấy.
const FILE_KEY_FIELDS: Record<string, string[]> = {
  source_videos: ['drive_id'],
  processed_videos: ['final_drive_id'],
  media_assets: ['drive_id'],
};

// Cột sắp xếp mặc định theo model (metrics không có created_at -> dùng collected_at).
const ORDER_FIELD: Record<string, string> = {
  metrics: 'collected_at',
};

// Cột kiểu bigint: Prisma cần BigInt, FE gửi number -> ép kiểu khi ghi.
const BIGINT_FIELDS: Record<string, string[]> = {
  metrics: ['views', 'likes', 'shares', 'comments'],
};

/** Ép các cột bigint (nếu có) từ number/string sang BigInt cho đúng kiểu Prisma. */
function coerceBigInt(model: string, data: Record<string, any>) {
  for (const f of BIGINT_FIELDS[model] ?? []) {
    if (data[f] !== undefined && data[f] !== null && typeof data[f] !== 'bigint') {
      try {
        data[f] = BigInt(data[f]);
      } catch {
        // giá trị không hợp lệ -> bỏ qua, để Prisma báo lỗi rõ ràng
      }
    }
  }
  return data;
}

/**
 * CRUD generic cho các bảng nghiệp vụ dưới /api/data/*.
 * Prisma KHÔNG có RLS -> mọi truy vấn tự lọc owner_id = user hiện tại.
 */
@UseGuards(SupabaseAuthGuard)
@Controller('api/data')
export class DataController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deletePin: DeletePinService,
    private readonly storage: StorageService,
  ) {}

  /** Lấy delegate Prisma theo resource; ném 404 nếu không hợp lệ. */
  private delegate(resource: string): any {
    const model = RESOURCE_MODEL[resource as ResourceKey];
    if (!model) {
      throw new NotFoundException(`Tài nguyên không hợp lệ: ${resource}`);
    }
    return (this.prisma as any)[model];
  }

  @Get(':resource')
  async list(@Param('resource') resource: string, @Req() req: any) {
    const d = this.delegate(resource);
    const orderField = ORDER_FIELD[RESOURCE_MODEL[resource as ResourceKey]] ?? 'created_at';
    return d.findMany({
      where: { owner_id: req.user.id },
      orderBy: { [orderField]: 'desc' },
    });
  }

  @Post(':resource')
  async create(
    @Param('resource') resource: string,
    @Body() body: Record<string, unknown>,
    @Req() req: any,
  ) {
    const d = this.delegate(resource);
    const model = RESOURCE_MODEL[resource as ResourceKey];
    // Không cho client tự đặt owner_id — luôn gắn = user hiện tại (RLS thay thế).
    const { owner_id, id, created_at, updated_at, ...data } = body as any;
    return d.create({
      data: coerceBigInt(model, { ...data, owner_id: req.user.id }),
    });
  }

  @Patch(':resource/:id')
  async update(
    @Param('resource') resource: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: any,
  ) {
    const d = this.delegate(resource);
    const model = RESOURCE_MODEL[resource as ResourceKey];
    const { owner_id, id: _id, created_at, updated_at, ...data } = body as any;
    // updateMany + điều kiện owner_id: chỉ sửa được bản ghi của chính mình.
    const res = await d.updateMany({
      where: { id, owner_id: req.user.id },
      data: coerceBigInt(model, data),
    });
    if (res.count === 0) {
      throw new NotFoundException('Không tìm thấy bản ghi hoặc không có quyền');
    }
    return d.findUnique({ where: { id } });
  }

  @Delete(':resource/:id')
  async remove(
    @Param('resource') resource: string,
    @Param('id') id: string,
    @Req() req: any,
  ) {
    await this.deletePin.assertDeleteAllowed(req.user, req.headers['x-delete-pin']);
    const d = this.delegate(resource);
    const model = RESOURCE_MODEL[resource as ResourceKey];
    const fileFields = FILE_KEY_FIELDS[model] ?? [];

    // Phải đọc key TRƯỚC khi xoá row, sau đó thì không còn chỗ nào biết file nằm đâu.
    const row = fileFields.length
      ? await d.findFirst({ where: { id, owner_id: req.user.id } })
      : null;

    const res = await d.deleteMany({ where: { id, owner_id: req.user.id } });
    if (res.count === 0) {
      throw new NotFoundException('Không tìm thấy bản ghi hoặc không có quyền');
    }

    // Xoá file SAU khi row đã đi: row xoá hụt thì file còn nguyên (khôi phục
    // được), còn file xoá hụt thì chỉ đọng rác. Hướng này an toàn hơn.
    // Cùng lý do: lỗi kho không được làm hỏng cả request khi row đã mất rồi.
    const failed: string[] = [];
    for (const f of fileFields) {
      const key = row?.[f];
      if (!key) continue;
      try {
        await this.storage.remove(key);
      } catch {
        failed.push(key); // file có thể đã xoá tay từ trước
      }
    }
    return { ok: true, storage_failed: failed.length ? failed : undefined };
  }
}
