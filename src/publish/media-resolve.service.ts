import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

/**
 * Resolve các ASSET trong Kho ra dạng AI dùng được — dùng chung cho Xưởng video
 * (produce.controller) và cron tự động (automation.service). Tất cả đều thành
 * URL ký sẵn để AI tự tải:
 *
 *  - frame_asset_id / music_asset_id / logo_asset_id -> frame_url / music_url / logo_url
 *  - voice_asset_id -> voice_ref_url + voice_id "asset:<uuid>"
 *  - giọng phụ "asset:<uuid>" trong voice_pool/voice_male/voice_female -> voice_refs
 */
@Injectable()
export class MediaResolveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Đổi frame_asset_id / music_asset_id trong config thành URL ký sẵn để AI
   * tải về. Verify asset thuộc đúng owner. Trả về BẢN SAO config đã resolve.
   */
  async resolveFrameMusic(
    ownerId: string,
    config: Record<string, any>,
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
      if (ma?.drive_id) {
        c.music_url = await this.storage.signDownload(ma.drive_id, 3600);
      }
      delete c.music_asset_id;
    }
    if (c.logo_asset_id) {
      const la = await this.prisma.media_assets.findFirst({
        where: { id: c.logo_asset_id, owner_id: ownerId, kind: 'logo' },
      });
      if (la?.drive_id) {
        c.logo_url = await this.storage.signDownload(la.drive_id, 3600);
      }
      delete c.logo_asset_id;
    }
    if (c.voice_asset_id) {
      const va = await this.prisma.media_assets.findFirst({
        where: { id: c.voice_asset_id, owner_id: ownerId, kind: 'voice' },
      });
      if (va?.drive_id) {
        // VieNeu nhân bản giọng ngay trên máy từ mẫu 3-8s, KHÔNG cần clone trước
        // qua API bên thứ ba -> chỉ cần đưa AI đường tải file mẫu là đủ.
        c.voice_ref_url = await this.storage.signDownload(va.drive_id, 3600);
        c.voice_id = `asset:${va.id}`;
      }
      delete c.voice_asset_id;
    }
    // Giọng PHỤ (đa giọng) cũng có thể là clone trong Kho: "asset:<uuid>" nằm
    // trong voice_pool / voice_male / voice_female. Mỗi cái cần file mẫu riêng
    // như giọng chính, nếu không sidecar báo "chưa đăng ký" ở từng câu.
    // -> voice_refs { "asset:<uuid>": URL ký sẵn }. Id lạ/không thuộc owner thì
    // bỏ qua, AI tự loại giọng đó khỏi pool.
    const poolIds = [
      ...(Array.isArray(c.voice_pool) ? c.voice_pool : []),
      c.voice_male,
      c.voice_female,
    ]
      .map((v) => String(v || ''))
      .filter((v) => v.startsWith('asset:'))
      .map((v) => v.slice(6));
    if (poolIds.length > 0) {
      const assets = await this.prisma.media_assets.findMany({
        where: { id: { in: [...new Set(poolIds)] }, owner_id: ownerId, kind: 'voice' },
      });
      const refs: Record<string, string> = {};
      for (const a of assets) {
        if (a.drive_id) {
          refs[`asset:${a.id}`] = await this.storage.signDownload(a.drive_id, 3600);
        }
      }
      c.voice_refs = refs;
    }
    return c;
  }

}
