import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseAuthGuard } from '../auth/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { FacebookService, FbAccount, FbPage, FbSession } from './facebook.service';
import { PENDING_TTL_MS, pendingKey } from './pending';

// Origin FE để giới hạn postMessage sau OAuth. Ưu tiên FRONTEND_URL nếu có,
// nếu không thì lấy domain đầu tiên trong CORS_ORIGINS (thường là FE chính) —
// nhờ vậy trên production chỉ cần khai báo CORS_ORIGINS, khỏi set thêm biến.
const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  (process.env.CORS_ORIGINS || '').split(',')[0].trim() ||
  '';

/**
 * Kết nối Facebook cho tab "Quản lý Page".
 *
 * Callback là redirect từ trình duyệt FB -> KHÔNG có header Authorization,
 * nên guard gắn theo từng route (không gắn cả class); danh tính user đi kèm
 * trong `state` đã ký HMAC.
 */
@Controller('api/facebook')
export class FacebookController {
  constructor(
    private readonly fb: FacebookService,
    private readonly prisma: PrismaService,
  ) {}

  /** FE hỏi đã cấu hình app chưa để ẩn/hiện nút kết nối. */
  @UseGuards(SupabaseAuthGuard)
  @Get('status')
  async status(@Req() req: any) {
    const connected = await this.prisma.page_credentials.count({
      where: { owner_id: req.user.id, provider: 'facebook_graph' },
    });
    return { ok: true, configured: this.fb.isConfigured(), connected };
  }

  @UseGuards(SupabaseAuthGuard)
  @Get('login-url')
  loginUrl(@Req() req: any) {
    return { ok: true, url: this.fb.loginUrl(req.user.id) };
  }

  /**
   * FB gọi về sau khi user đồng ý. Đổi code -> Page token, lưu TẠM vào
   * app_config rồi đóng popup (báo cho tab đang mở qua postMessage).
   * Chưa ghi vào `pages` — để user tự chọn page ở bước sau.
   */
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error_description') fbError: string,
    @Res() res: Response,
  ) {
    if (fbError) return res.send(this.closeHtml(fbError));
    if (!code || !state) return res.send(this.closeHtml('Thiếu code/state.'));

    try {
      const ownerId = this.fb.verifyState(state);
      const session = await this.fb.pagesFromCode(code);
      const value = JSON.stringify(session);
      await this.prisma.app_config.upsert({
        where: { key: pendingKey(ownerId) },
        create: { key: pendingKey(ownerId), value, updated_at: new Date() },
        update: { value, updated_at: new Date() },
      });
      return res.send(this.closeHtml(null));
    } catch (e: any) {
      return res.send(this.closeHtml(e?.message || 'Kết nối thất bại.'));
    }
  }

  /**
   * Trang báo kết quả cho cửa sổ đăng nhập.
   *
   * Facebook đặt Cross-Origin-Opener-Policy trên trang dialog -> sau khi đi qua
   * facebook.com thì `window.opener` bị CẮT: postMessage không tới được tab cha
   * và window.close() bị trình duyệt từ chối ("chỉ được đóng cửa sổ do chính
   * script mở"). Nên vẫn thử cả hai (khi may mắn còn opener thì tiện), nhưng FE
   * KHÔNG trông vào đó — nó tự hỏi /pending theo vòng. Ở đây chỉ cần báo cho
   * người dùng biết là xong và có thể đóng tay.
   */
  private closeHtml(error: string | null): string {
    const payload = JSON.stringify({ source: 'fb-connect', error });
    const target = FRONTEND_URL ? JSON.stringify(FRONTEND_URL) : '"*"';
    const msg = error
      ? `<b>Kết nối thất bại</b><br>${this.escape(error)}`
      : '<b>Đã kết nối Facebook thành công.</b><br>' +
        'Quay lại tab ToolReup để chọn page — danh sách sẽ tự hiện sau vài giây.<br>' +
        '<span style="color:#666">Có thể đóng cửa sổ này.</span>';
    return `<!doctype html><meta charset="utf-8">
<body style="font:14px/1.7 system-ui;padding:40px;text-align:center">${msg}
<script>
  try { window.opener && window.opener.postMessage(${payload}, ${target}); } catch (e) {}
  try { window.close(); } catch (e) {}
</script></body>`;
  }

  private escape(s: string): string {
    return s.replace(/[<>&"]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] as string,
    );
  }

  /**
   * Đọc bản tạm. Bản ghi trước đây chỉ là mảng page (chưa kèm nick) -> vẫn đọc
   * được để user đang chọn dở lúc deploy không mất phiên.
   */
  private parsePending(value: string): FbSession {
    const parsed = JSON.parse(value) as FbSession | FbPage[];
    if (Array.isArray(parsed)) {
      return { account: { id: '', name: '' } as FbAccount, pages: parsed };
    }
    return parsed;
  }

  /**
   * Danh sách page vừa đăng nhập được, để user chọn. KHÔNG trả access_token
   * về FE — chỉ id/tên + đã kết nối hay chưa.
   */
  @UseGuards(SupabaseAuthGuard)
  @Get('pending')
  async pending(@Req() req: any) {
    const row = await this.prisma.app_config.findUnique({
      where: { key: pendingKey(req.user.id) },
    });
    if (!row?.value) return { ok: true, pages: [] };

    // Quá hạn -> xoá luôn cho token khỏi nằm lại, coi như chưa đăng nhập.
    if (Date.now() - row.updated_at.getTime() > PENDING_TTL_MS) {
      await this.prisma.app_config.delete({ where: { key: row.key } });
      return { ok: true, pages: [] };
    }

    const { account, pages } = this.parsePending(row.value);
    const existing = await this.prisma.page_credentials.findMany({
      where: { owner_id: req.user.id, provider: 'facebook_graph' },
      select: { external_id: true },
    });
    const done = new Set(existing.map((e) => e.external_id));
    return {
      ok: true,
      // Thời điểm lấy danh sách -> FE hiện ra để user biết đang xem bản cũ hay mới.
      fetched_at: row.updated_at.toISOString(),
      // Nick FB của phiên này -> user thấy ngay khi FB trả về nhầm tài khoản cũ.
      account,
      pages: pages.map((p) => ({
        id: p.id,
        name: p.name,
        connected: done.has(p.id),
      })),
    };
  }

  /**
   * Nick FB của từng page đã nối, để UI Quản lý Page gom nhóm. Bảng
   * page_credentials chứa token nên KHÔNG cho FE đọc thẳng -> chỉ trả 3 cột này.
   */
  @UseGuards(SupabaseAuthGuard)
  @Get('accounts')
  async accounts(@Req() req: any) {
    const rows = await this.prisma.page_credentials.findMany({
      where: { owner_id: req.user.id, provider: 'facebook_graph' },
      select: { page_id: true, fb_user_id: true, fb_user_name: true },
    });
    return { ok: true, accounts: rows };
  }

  /**
   * Thu hồi quyền của MỘT nick FB để lần đăng nhập sau hiện lại màn "Chọn Trang".
   *
   * Cố ý KHÔNG xoá gì trong DB: `savePages` tra theo `external_id`, còn dòng cũ
   * thì nối lại sẽ update token tại chỗ và dùng lại đúng `pages.id` -> lịch đã
   * đăng và `automation_rules.page_ids` (mảng uuid, KHÔNG có khoá ngoại nên xoá
   * page là nó trỏ vào id chết) đều còn nguyên.
   */
  @UseGuards(SupabaseAuthGuard)
  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(@Body() body: { fb_user_id?: string }, @Req() req: any) {
    const fbUserId = (body.fb_user_id || '').trim();
    if (!fbUserId) throw new BadRequestException('Thiếu fb_user_id.');

    // Chặn đầu tiên: chỉ thu hồi được nick ĐANG NỐI VỚI TÀI KHOẢN NÀY. Thiếu
    // bước này thì ai đăng nhập vào tool cũng gửi được fb_user_id bất kỳ và gỡ
    // app khỏi tài khoản Facebook của người khác.
    const own = await this.prisma.page_credentials.findMany({
      where: {
        owner_id: req.user.id,
        provider: 'facebook_graph',
        fb_user_id: fbUserId,
      },
      select: { page_id: true },
    });
    if (own.length === 0) {
      throw new BadRequestException('Nick này không thuộc tài khoản của bạn.');
    }

    await this.fb.revokeUser(fbUserId);

    // Bản tạm cũ phải đi theo: để lại thì vòng hỏi /pending của FE phục vụ đúng
    // danh sách page cũ của nick vừa thu hồi, coi như chưa làm gì.
    await this.prisma.app_config.deleteMany({
      where: { key: pendingKey(req.user.id) },
    });
    return { ok: true, pages: own.length };
  }

  /**
   * Lưu các page user đã chọn: tạo/cập nhật `pages` + `page_credentials`.
   * Chạy xong xoá bản tạm (không giữ token thừa trong app_config).
   */
  @UseGuards(SupabaseAuthGuard)
  @Post('pages')
  @HttpCode(HttpStatus.OK)
  async savePages(
    @Body() body: { page_ids?: string[]; group_name?: string },
    @Req() req: any,
  ) {
    const ids = body.page_ids || [];
    if (ids.length === 0) throw new BadRequestException('Chưa chọn page nào.');

    const row = await this.prisma.app_config.findUnique({
      where: { key: pendingKey(req.user.id) },
    });
    if (!row?.value) {
      throw new BadRequestException('Phiên kết nối đã hết, đăng nhập lại.');
    }
    const { account, pages: all } = this.parsePending(row.value);
    const chosen = all.filter((p) => ids.includes(p.id));
    if (chosen.length === 0) {
      throw new BadRequestException('Page đã chọn không có trong phiên này.');
    }

    let saved = 0;
    for (const p of chosen) {
      try {
        await this.connectPage(req.user.id, p, account, body.group_name);
      } catch (e: any) {
        // Unique index (owner_id, external_id) của migration 0023: một request
        // song song vừa nối đúng page này xong. Dòng `pages` vừa tạo đã bị
        // transaction cuốn lại -> chỉ cần cập nhật token lên dòng của bên kia.
        if (e?.code !== 'P2002') throw e;
        await this.connectPage(req.user.id, p, account, body.group_name);
      }
      saved++;
    }

    await this.prisma.app_config.delete({
      where: { key: pendingKey(req.user.id) },
    });
    return { ok: true, saved };
  }

  /**
   * Nối MỘT page: tạo/cập nhật `pages` + ghi token vào `page_credentials`.
   *
   * Chạy trong transaction vì hai bảng phải cùng sống hoặc cùng chết: nếu bước
   * ghi token vấp unique index thì dòng `pages` vừa tạo cũng phải biến mất,
   * không thì tab Quản lý Page hiện một page rỗng vĩnh viễn không đăng được.
   */
  private async connectPage(
    ownerId: string,
    p: FbPage,
    account: FbAccount,
    groupName?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Đã kết nối page này trước đó -> cập nhật token, không tạo dòng trùng.
      const existing = await tx.page_credentials.findFirst({
        where: {
          owner_id: ownerId,
          provider: 'facebook_graph',
          external_id: p.id,
        },
      });
      let pageId = existing?.page_id;
      if (pageId) {
        await tx.pages.update({
          where: { id: pageId },
          data: { page_name: p.name, updated_at: new Date() },
        });
      } else {
        const created = await tx.pages.create({
          data: {
            owner_id: ownerId,
            platform: 'facebook',
            page_name: p.name,
            provider: 'facebook_graph',
            group_name: groupName?.trim() || null,
            is_active: true,
          },
        });
        pageId = created.id;
      }
      // Nick đi kèm token: nối lại page bằng nick khác thì token VÀ nick cùng đổi.
      await tx.page_credentials.upsert({
        where: { page_id: pageId },
        create: {
          page_id: pageId,
          owner_id: ownerId,
          provider: 'facebook_graph',
          external_id: p.id,
          access_token: p.access_token,
          fb_user_id: account.id || null,
          fb_user_name: account.name || null,
          updated_at: new Date(),
        },
        update: {
          external_id: p.id,
          access_token: p.access_token,
          fb_user_id: account.id || null,
          fb_user_name: account.name || null,
          updated_at: new Date(),
        },
      });
    });
  }
}
