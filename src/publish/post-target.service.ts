import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Page đích gửi sang AI. Page nối API FB đi kèm token -> AI đăng thẳng Graph. */
export type PostTarget = {
  page_id: string;
  platform: string;
  provider: string;
  user?: string | null;
  page_token?: string;
};

/**
 * Dựng `post_target` cho AI từ 1 page trong DB.
 *
 * Tách ra vì cả cron lịch (schedule.service) lẫn cron tự động (automation)
 * đều cần, và trước đây chúng đăng bằng `platforms` -> luôn rơi vào upload-post,
 * bỏ qua Page token của page đã nối API Facebook (đăng sẽ hỏng).
 */
@Injectable()
export class PostTargetService {
  constructor(private readonly prisma: PrismaService) {}

  async build(pageId: string, ownerId: string): Promise<PostTarget | null> {
    const page = await this.prisma.pages.findFirst({
      where: { id: pageId, owner_id: ownerId },
    });
    if (!page) return null;

    const target: PostTarget = {
      page_id: page.id,
      platform: page.platform,
      provider: page.provider,
      user: page.credential_ref,
    };
    if (page.provider === 'facebook_graph') {
      const cred = await this.prisma.page_credentials.findUnique({
        where: { page_id: page.id },
      });
      if (cred?.access_token) {
        // AI cần id PAGE trên Facebook (external_id), không phải id dòng DB.
        target.page_id = cred.external_id || page.id;
        target.page_token = cred.access_token;
      }
    }
    return target;
  }
}
