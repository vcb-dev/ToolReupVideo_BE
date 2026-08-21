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
import { jobOwner } from '../auth/job-owner';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { MediaResolveService } from './media-resolve.service';
import { upsertProcessed } from './processed-upsert';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';

/**
 * Các khoá được phép ghi đè RIÊNG cho từng video (thanh "Đang chỉnh" ở Xưởng).
 * Cố ý hẹp: config per-item KHÔNG đi qua resolveMediaConfig nên không nhận
 * asset id / page đích; không lọc thì FE gửi được cả post_targets, music_url…
 * vào từng video, vượt mặt phần resolve + kiểm quyền sở hữu.
 */
const OVERRIDE_KEYS = [
  'subtitle_enabled',
  'subtitle_lang',
  'orientation',
  'speed',
  'cover_boxes',
  'cover_feather',
  'cover_blur',
] as const;

/** Lọc trắng ghi đè của 1 video. Trả undefined khi không còn khoá hợp lệ. */
export function pickOverride(
  o: Record<string, any> | undefined,
): Record<string, any> | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const out: Record<string, any> = {};
  for (const k of OVERRIDE_KEYS) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Sản xuất 1 source video -> ghi processed_videos.
 * Gọi AI /api/produce (dịch + lồng tiếng + ghép), có thể chạy lâu.
 */
@UseGuards(SupabaseAuthGuard)
@Controller('api/produce')
export class ProduceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly media: MediaResolveService,
  ) {}

  /**
   * Đổi frame_asset_id / music_asset_id trong config thành URL ký sẵn để
   * AI tải về. Verify asset thuộc đúng owner. Giữ nguyên các field config khác.
   */
  private async resolveMediaConfig(
    config: Record<string, any>,
    ownerId: string,
  ): Promise<Record<string, any>> {
    // Khung viền + nhạc từ Kho -> URL ký sẵn (logic chung với cron tự động).
    const c = await this.media.resolveFrameMusic(ownerId, config || {});
    if (Array.isArray(c.post_page_ids) && c.post_page_ids.length) {
      const pages = await this.prisma.pages.findMany({
        where: { id: { in: c.post_page_ids }, owner_id: ownerId },
      });
      // Page nối FB -> gửi kèm Page token để AI đăng thẳng qua Graph API.
      const creds = await this.prisma.page_credentials.findMany({
        where: { page_id: { in: pages.map((p) => p.id) }, owner_id: ownerId },
      });
      const credByPage = new Map<string, typeof creds[number]>(
        creds.map((cr) => [cr.page_id, cr]),
      );
      c.post_targets = pages.map((p) => {
        const cr = credByPage.get(p.id);
        if (p.provider === 'facebook_graph' && cr?.access_token) {
          return {
            platform: p.platform,
            provider: 'facebook_graph',
            page_id: cr.external_id,
            page_token: cr.access_token,
          };
        }
        // Chưa nối token -> giữ đường cũ qua upload-post.
        return {
          platform: p.platform,
          provider: 'upload_post',
          user: p.credential_ref || '',
        };
      });
      delete c.post_page_ids;
    }
    if (c.affiliate_id) {
      const aff = await this.prisma.affiliate_links.findFirst({
        where: { id: c.affiliate_id, owner_id: ownerId },
      });
      if (aff?.url) c.affiliate_url = aff.url;
      delete c.affiliate_id;
    }
    return c;
  }

  /**
   * Sản xuất MẺ video đã chọn (từ Xưởng video) -> ghi processed_videos, tùy
   * chọn đăng luôn. Chạy NỀN trên AI (không bị proxy cắt): forward danh sách +
   * owner_id sang AI /api/produce_batch rồi trả ngay. Tiến độ xem qua /api/state.
   */
  /**
   * ĐĂNG mẻ video ĐÃ SẢN XUẤT (không produce lại), resolve page/affiliate rồi
   * forward AI /api/post_batch. Hai cách chỉ định video:
   *   - `processed_video_ids`: đăng ĐÚNG bản thành phẩm đã chọn (Kho).
   *   - `source_video_ids`: mỗi source lấy bản thành phẩm mới nhất (Xưởng).
   *
   * `captions`: caption user tự sửa cho TỪNG video, key theo processed_video_id
   * HOẶC source_video_id (nhận cả hai để Kho và Xưởng dùng chung). Thiếu key ->
   * giữ mô tả gốc. AI vẫn nối hashtag + affiliate vào sau caption này.
   */
  @Post('publish')
  @HttpCode(HttpStatus.OK)
  async publish(
    @Body()
    body: {
      processed_video_ids?: string[];
      source_video_ids?: string[];
      platforms?: string[];
      captions?: Record<string, string>;
      config?: Record<string, any>;
    },
    @Req() req: any,
  ) {
    const pvIds = body.processed_video_ids || [];
    const srcIds = body.source_video_ids || [];
    if (pvIds.length === 0 && srcIds.length === 0) {
      throw new BadRequestException('Chưa chọn video nào.');
    }

    const pvs = await this.prisma.processed_videos.findMany({
      where: {
        owner_id: req.user.id,
        final_drive_id: { not: null },
        ...(pvIds.length
          ? { id: { in: pvIds } }
          : { source_video_id: { in: srcIds } }),
      },
      orderBy: { created_at: 'desc' },
    });

    const sources = await this.prisma.source_videos.findMany({
      where: {
        id: { in: pvs.map((p) => p.source_video_id) },
        owner_id: req.user.id,
      },
      select: { id: true, descr: true },
    });
    const descById = new Map(sources.map((s) => [s.id, s.descr || '']));

    // Chọn theo source thì mỗi source chỉ lấy bản mới nhất; chọn thẳng thành
    // phẩm thì đăng đúng những bản đó (user đã xem và quyết định).
    const seen = new Set<string>();
    const caps = body.captions || {};
    const items: any[] = [];
    for (const pv of pvs) {
      if (!pvIds.length) {
        if (seen.has(pv.source_video_id)) continue;
        seen.add(pv.source_video_id);
      }
      // Caption user sửa (key theo thành phẩm hoặc theo source) > mô tả gốc.
      // Dùng `??` chứ không `||`: giữ nguyên chuỗi user gõ, kể cả rỗng (AI sẽ
      // tự rơi về upload.caption mặc định nếu rỗng).
      const edited = caps[pv.id] ?? caps[pv.source_video_id];
      items.push({
        final_drive_id: pv.final_drive_id,
        final_path: pv.final_path,
        desc: edited ?? pv.ai_caption ?? descById.get(pv.source_video_id) ?? '',
      });
    }
    if (items.length === 0) {
      return { ok: false, error: 'Chưa có video thành phẩm để đăng (hãy xử lý trước).' };
    }

    const config = await this.resolveMediaConfig(body.config ?? {}, req.user.id);
    try {
      const res = await axios.post(
        `${AI_URL}/api/post_batch`,
        {
          owner_id: req.user.id,
          // Khoá hàng đợi theo NGƯỜI THẬT. owner_id có thể là id kho dùng chung
          // (giống nhau ở mọi tài khoản) -> lấy nó thì hai người chặn nhau.
          job_owner: jobOwner(req),
          items,
          post_targets: config.post_targets || [],
          platforms: body.platforms ?? [],
          hashtags: config.hashtags || '',
          affiliate_url: config.affiliate_url || '',
        },
        { timeout: 1000 * 120 },
      );
      if (!res.data?.ok) {
        return { ok: false, error: res.data?.error || 'AI post_batch thất bại' };
      }
      return { ok: true, queued: items.length };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

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
      config?: Record<string, any>;
      /** Ghi đè riêng từng video, key = source_video_id (xem OVERRIDE_KEYS). */
      overrides?: Record<string, Record<string, any>>;
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
    const overrides = body.overrides || {};
    const items = svs
      .filter((sv) => sv.status !== 'processing' && sv.status !== 'queued')
      .map((sv) => {
        const ov = pickOverride(overrides[sv.id]);
        return {
          source_id: sv.id,
          video_id: sv.platform_video_id,
          drive_id: sv.drive_id,
          desc: sv.descr,
          // AI áp chồng lên config chung cho RIÊNG video này (bỏ hẳn khi rỗng).
          ...(ov ? { config: ov } : {}),
        };
      });

    if (items.length === 0) {
      return { ok: false, error: 'Các video chọn đều đang được xử lý.' };
    }

    // Đánh dấu đang xử lý
    await this.prisma.source_videos.updateMany({
      where: { id: { in: items.map((it) => it.source_id) } },
      data: { status: 'processing' },
    });

    const config = await this.resolveMediaConfig(body.config ?? {}, req.user.id);
    try {
      const res = await axios.post(
        `${AI_URL}/api/produce_batch`,
        {
          owner_id: req.user.id,
          job_owner: jobOwner(req),
          items,
          platforms: body.platforms ?? [],
          upload: body.upload ?? false,
          auto_grammar: body.auto_grammar ?? false,
          remove_sensitive: body.remove_sensitive ?? false,
          config,
        },
        { timeout: 1000 * 120 },
      );
      if (!res.data?.ok) {
        await this.prisma.source_videos.updateMany({
          where: { id: { in: items.map((it) => it.source_id) } },
          data: { status: 'failed' },
        });
        return { ok: false, error: res.data?.error || 'AI produce_batch thất bại' };
      }
      return { ok: true, queued: items.length };
    } catch (e: any) {
      await this.prisma.source_videos.updateMany({
        where: { id: { in: items.map((it) => it.source_id) } },
        data: { status: 'failed' },
      });
      return { ok: false, error: e.message };
    }
  }

  /**
   * Huỷ tác vụ đang chạy ở AI (sản xuất/đăng). AI bật cờ cancel, job dừng êm ở
   * ranh giới bước. Khai báo TRƯỚC route ':sourceVideoId' để 'cancel' không bị
   * hiểu nhầm là id.
   */
  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Req() req: any) {
    try {
      // Chỉ huỷ job CỦA CHÍNH MÌNH — không đụng vào việc người khác đang chạy.
      const res = await axios.post(
        `${AI_URL}/api/cancel`,
        { owner_id: req.user.id },
        { timeout: 1000 * 15 },
      );
      return { ok: res.data?.ok !== false, note: res.data?.note };
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
    if (sv.status === 'processing' || sv.status === 'queued') {
      return { ok: false, error: 'Video đang được xử lý' };
    }

    await this.prisma.source_videos.update({
      where: { id: sv.id },
      data: { status: 'processing' },
    });

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
        await this.prisma.source_videos.update({
          where: { id: sv.id },
          data: { status: 'failed' },
        });
        return { ok: false, error: res.data?.error || 'AI produce thất bại' };
      }

      // upsert: bấm sản xuất lại video này thì CẬP NHẬT bản cũ trong kho,
      // không thêm bản thứ hai (kho hiện hai video y hệt -> đăng trùng).
      const pv = await upsertProcessed(this.prisma, {
        owner_id: sv.owner_id,
        source_video_id: sv.id,
        final_path: res.data.final_path,
        final_drive_id: res.data.final_drive_id,
        target_lang: res.data.target_lang,
        voice_id: res.data.voice_id,
        has_subtitle: res.data.has_subtitle,
        ai_caption: res.data.ai_caption ?? null,
      });
      await this.prisma.source_videos.update({
        where: { id: sv.id },
        data: { status: 'done' },
      });
      return { ok: true, processed_video: pv };
    } catch (e: any) {
      await this.prisma.source_videos.update({
        where: { id: sv.id },
        data: { status: 'failed' },
      });
      return { ok: false, error: e.message };
    }
  }
}
