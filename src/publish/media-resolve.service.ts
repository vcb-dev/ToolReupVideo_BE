import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

const AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';

/**
 * Resolve các ASSET trong Kho ra dạng AI dùng được — dùng chung cho Xưởng video
 * (produce.controller) và cron tự động (automation.service):
 *
 *  - voice_asset_id -> voice_id MiniMax (clone 1 lần, cache vào media_assets).
 *  - frame_asset_id / music_asset_id -> URL ký sẵn R2 (frame_url / music_url).
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
    return c;
  }

  /** Trả voice_id (cache hoặc clone mới) — null nếu asset không hợp lệ/clone lỗi. */
  async resolveVoiceId(
    ownerId: string,
    voiceAssetId: string,
  ): Promise<string | null> {
    const va = await this.prisma.media_assets.findFirst({
      where: { id: voiceAssetId, owner_id: ownerId, kind: 'voice' },
    });
    if (!va) return null;
    let vid = va.voice_id;
    if (!vid && va.drive_id) {
      vid = await this.cloneFromAsset(va);
      if (vid) {
        await this.prisma.media_assets.update({
          where: { id: va.id },
          data: { voice_id: vid },
        });
      }
    }
    return vid || null;
  }

  /**
   * Clone giọng từ mẫu đã lưu (R2) qua AI /api/voice/clone. Trả voice_id hoặc
   * null nếu lỗi. Tên voice ổn định theo asset để idempotent.
   */
  private async cloneFromAsset(asset: any): Promise<string | null> {
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
}
