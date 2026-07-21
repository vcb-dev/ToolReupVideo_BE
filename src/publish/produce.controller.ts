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
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';

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
  ) {}

  /**
   * Đổi frame_asset_id / music_asset_id trong config thành URL ký sẵn (R2) để
   * AI tải về. Verify asset thuộc đúng owner. Giữ nguyên các field config khác.
   */
  private async resolveMediaConfig(
    config: Record<string, any>,
    ownerId: string,
  ): Promise<Record<string, any>> {
    const c = { ...(config || {}) };
    if (c.frame_asset_id) {
      const fa = await this.prisma.media_assets.findFirst({
        where: { id: c.frame_asset_id, owner_id: ownerId, kind: 'frame' },
      });
      if (fa?.drive_id) {
        c.frame_url = await this.storage.signDownload(fa.drive_id, 3600);
        c.frame_chroma = fa.chroma_color || '0x00FF00';
        delete c.frame; // ưu tiên khung upload hơn viền màu built-in
      }
      delete c.frame_asset_id;
    }
    if (c.music_asset_id) {
      const ma = await this.prisma.media_assets.findFirst({
        where: { id: c.music_asset_id, owner_id: ownerId, kind: 'music' },
      });
      if (ma?.drive_id) c.music_url = await this.storage.signDownload(ma.drive_id, 3600);
      delete c.music_asset_id;
    }
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
    if (c.voice_asset_id) {
      const va = await this.prisma.media_assets.findFirst({
        where: { id: c.voice_asset_id, owner_id: ownerId, kind: 'voice' },
      });
      if (va) {
        // Có voice_id cache -> dùng lại; chưa có -> clone từ mẫu (1 lần) rồi cache.
        let vid = va.voice_id;
        if (!vid && va.drive_id) {
          vid = await this.cloneVoiceFromAsset(va);
          if (vid) {
            await this.prisma.media_assets.update({
              where: { id: va.id },
              data: { voice_id: vid },
            });
          }
        }
        if (vid) c.voice_id = vid;
      }
      delete c.voice_asset_id;
    }
    return c;
  }

  /**
   * Clone giọng từ mẫu đã lưu (R2) qua AI /api/voice/clone. Trả voice_id hoặc
   * null nếu lỗi. Tên voice ổn định theo asset để idempotent.
   */
  private async cloneVoiceFromAsset(asset: any): Promise<string | null> {
    try {
      const url = await this.storage.signDownload(asset.drive_id, 600);
      const dl = await axios.get(url, { responseType: 'arraybuffer' });
      const buf = Buffer.from(dl.data);
      const voiceName = `voice_${String(asset.id).replace(/-/g, '').slice(0, 20)}`;
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(buf)]), 'sample.mp3');
      form.append('voice_id', voiceName);
      const res = await axios.post(`${AI_URL}/api/voice/clone`, form, {
        timeout: 1000 * 300,
      });
      if (res.data?.ok && res.data?.voice_id) return res.data.voice_id;
      return null;
    } catch {
      return null;
    }
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
        desc: edited ?? descById.get(pv.source_video_id) ?? '',
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
          items,
          post_targets: config.post_targets || [],
          platforms: body.platforms ?? [],
          hashtags: config.hashtags || '',
          affiliate_url: config.affiliate_url || '',
        },
        { timeout: 1000 * 30 },
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
    const items = svs.map((sv) => ({
      source_id: sv.id,
      video_id: sv.platform_video_id,
      drive_id: sv.drive_id,
      desc: sv.descr,
    }));
    const config = await this.resolveMediaConfig(body.config ?? {}, req.user.id);
    try {
      const res = await axios.post(
        `${AI_URL}/api/produce_batch`,
        {
          owner_id: req.user.id,
          items,
          platforms: body.platforms ?? [],
          upload: body.upload ?? false,
          auto_grammar: body.auto_grammar ?? false,
          remove_sensitive: body.remove_sensitive ?? false,
          config,
        },
        { timeout: 1000 * 30 },
      );
      if (!res.data?.ok) {
        return { ok: false, error: res.data?.error || 'AI produce_batch thất bại' };
      }
      return { ok: true, queued: items.length };
    } catch (e: any) {
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
  async cancel() {
    try {
      const res = await axios.post(
        `${AI_URL}/api/cancel`,
        {},
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

      const pv = await this.prisma.processed_videos.create({
        data: {
          owner_id: sv.owner_id,
          source_video_id: sv.id,
          final_path: res.data.final_path,
          final_drive_id: res.data.final_drive_id,
          target_lang: res.data.target_lang,
          voice_id: res.data.voice_id,
          has_subtitle: res.data.has_subtitle,
          status: 'done',
          produced_at: new Date(),
        },
      });
      await this.prisma.source_videos.update({
        where: { id: sv.id },
        data: { status: 'done' },
      });
      return { ok: true, processed_video: pv };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
}
