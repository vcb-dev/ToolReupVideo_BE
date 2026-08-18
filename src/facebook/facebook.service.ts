import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';

const GRAPH_VERSION = process.env.FB_GRAPH_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DIALOG = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;

// Quyền tối thiểu để liệt kê page + đăng bài + đọc chỉ số.
const SCOPES = [
  'pages_show_list',
  'pages_manage_posts',
  'pages_read_engagement',
  // Cần để ĐĂNG BÌNH LUẬN dưới bài (gắn link affiliate). Quyền này phải được
  // Facebook duyệt qua App Review; chưa duyệt thì bài vẫn đăng, chỉ bình luận
  // thất bại và được ghi lại trong post_comments.
  'pages_manage_engagement',
];

export type FbPage = { id: string; name: string; access_token: string };

/** Tài khoản FB đã đăng nhập ở phiên đó (để user biết list là của nick nào). */
export type FbAccount = { id: string; name: string };

export type FbSession = { account: FbAccount; pages: FbPage[] };

/**
 * OAuth Facebook + lấy Page access token.
 *
 * App Secret CHỈ ở BE: bước đổi code -> token bắt buộc chạy server-side.
 * Luồng: login-url -> user đăng nhập trên FB -> callback (?code&state) ->
 * đổi code lấy user token ngắn hạn -> đổi tiếp thành long-lived -> /me/accounts
 * trả Page token (long-lived, không hết hạn).
 */
@Injectable()
export class FacebookService {
  private readonly log = new Logger(FacebookService.name);

  private get appId() {
    return process.env.FB_APP_ID || '';
  }
  private get appSecret() {
    return process.env.FB_APP_SECRET || '';
  }
  private get redirectUri() {
    return process.env.FB_REDIRECT_URI || '';
  }

  isConfigured(): boolean {
    return !!(this.appId && this.appSecret && this.redirectUri);
  }

  private assertConfigured() {
    if (!this.isConfigured()) {
      throw new BadRequestException(
        'Chưa cấu hình Facebook: đặt FB_APP_ID, FB_APP_SECRET, FB_REDIRECT_URI trong .env của BE.',
      );
    }
  }

  /**
   * `state` chống CSRF + mang owner_id qua callback (callback là redirect từ
   * trình duyệt nên không có header Authorization). Ký HMAC bằng App Secret,
   * hạn 10 phút.
   */
  signState(ownerId: string): string {
    const payload = `${ownerId}.${Date.now()}`;
    const sig = crypto
      .createHmac('sha256', this.appSecret)
      .update(payload)
      .digest('hex');
    return Buffer.from(`${payload}.${sig}`).toString('base64url');
  }

  /** Trả owner_id nếu state hợp lệ và chưa quá hạn; ném lỗi nếu không. */
  verifyState(state: string): string {
    let decoded = '';
    try {
      decoded = Buffer.from(state || '', 'base64url').toString('utf8');
    } catch {
      throw new BadRequestException('State không hợp lệ.');
    }
    const [ownerId, ts, sig] = decoded.split('.');
    if (!ownerId || !ts || !sig) {
      throw new BadRequestException('State không hợp lệ.');
    }
    const expect = crypto
      .createHmac('sha256', this.appSecret)
      .update(`${ownerId}.${ts}`)
      .digest('hex');
    // timingSafeEqual ném lỗi nếu khác độ dài -> bọc try.
    const ok =
      sig.length === expect.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
    if (!ok) throw new BadRequestException('State sai chữ ký.');
    if (Date.now() - Number(ts) > 10 * 60 * 1000) {
      throw new BadRequestException('Phiên kết nối đã hết hạn, thử lại.');
    }
    return ownerId;
  }

  /**
   * `auth_type=rerequest` CHỈ bắt FB hỏi lại những quyền user đã TỪ CHỐI.
   *
   * Nó KHÔNG mở lại màn "Chọn Trang" — đừng trông vào đó để nối thêm page.
   * Meta áp granular page permissions: /me/accounts chỉ trả về đúng tập page
   * user tick ở lần cấp quyền ĐẦU TIÊN. Đăng nhập lại, FB thấy app đã được cấp
   * đủ quyền nên bỏ qua màn chọn trang và im lặng dùng lại tập cũ -> page tạo
   * sau (hoặc page không tick lần đó) không bao giờ tự xuất hiện, dù bấm "Nối
   * thêm page" bao nhiêu lần.
   *
   * Muốn thêm page: user phải tự sửa ở facebook.com -> Cài đặt -> Ứng dụng và
   * trang web -> app này -> "Xem và chỉnh sửa" -> tick thêm page. FE phát hiện
   * phiên không có page mới và chỉ đường sang đó (xem FacebookConnect.tsx).
   *
   * Cách duy nhất ép FB hiện lại màn chọn trang từ phía app là DELETE
   * /me/permissions để xoá sạch grant — nhưng làm vậy mọi Page token của nick
   * đó chết theo, các page đang nối ngừng đăng được. Cố ý KHÔNG làm ngầm.
   *
   * Vẫn giữ rerequest vì nó có ích ở nhánh khác: user bấm "Không cho phép" một
   * quyền (hay gặp với pages_manage_engagement chưa được duyệt) thì lần sau
   * còn hỏi lại được.
   */
  loginUrl(ownerId: string): string {
    this.assertConfigured();
    const q = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: this.redirectUri,
      state: this.signState(ownerId),
      scope: SCOPES.join(','),
      response_type: 'code',
      auth_type: 'rerequest',
    });
    return `${DIALOG}?${q.toString()}`;
  }

  /** code -> user token ngắn hạn (~1h). */
  private async exchangeCode(code: string): Promise<string> {
    const res = await axios.get(`${GRAPH}/oauth/access_token`, {
      params: {
        client_id: this.appId,
        client_secret: this.appSecret,
        redirect_uri: this.redirectUri,
        code,
      },
      timeout: 20000,
    });
    const token = res.data?.access_token;
    if (!token) throw new BadRequestException('Không đổi được code lấy token.');
    return token;
  }

  /** user token ngắn hạn -> long-lived (~60 ngày). */
  private async toLongLived(shortToken: string): Promise<string> {
    const res = await axios.get(`${GRAPH}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: this.appId,
        client_secret: this.appSecret,
        fb_exchange_token: shortToken,
      },
      timeout: 20000,
    });
    return res.data?.access_token || shortToken;
  }

  /**
   * Danh sách page user quản lý + Page token. Page token sinh từ user token
   * long-lived thì KHÔNG hết hạn -> lưu là dùng được mãi.
   *
   * PHẢI đi hết phân trang: Graph thường trả về ÍT hơn `limit` mà vẫn còn
   * `paging.next` (tài khoản của user có ~92+ page) -> chỉ đọc trang đầu là
   * thiếu page. `paging.next` là URL đầy đủ (đã kèm token + cursor).
   */
  private async listPages(userToken: string): Promise<FbPage[]> {
    const out: FbPage[] = [];
    let url: string | null = `${GRAPH}/me/accounts`;
    let params: Record<string, any> | undefined = {
      access_token: userToken,
      fields: 'id,name,access_token',
      limit: 100,
    };
    // Chặn trên phòng vòng lặp vô hạn nếu FB trả cursor lỗi.
    for (let i = 0; i < 30 && url; i++) {
      const res: any = await axios.get(url, { params, timeout: 20000 });
      const data = res.data?.data;
      if (!Array.isArray(data) || data.length === 0) break;
      out.push(...(data as FbPage[]));
      url = res.data?.paging?.next || null;
      params = undefined; // next đã chứa sẵn mọi tham số
    }
    this.log.log(`Lấy được ${out.length} page từ /me/accounts.`);
    return out;
  }

  /**
   * Gỡ app khỏi một nick Facebook: xoá sạch grant bên FB, kể cả TẬP PAGE đã tick.
   *
   * Đây là cách duy nhất bắt FB hiện lại màn "Chọn Trang" ở lần đăng nhập sau
   * (xem loginUrl): sau khi thu hồi, FB coi như user cấp quyền lần đầu.
   *
   * Dùng APP access token (`app_id|app_secret`) — endpoint này nhận app token
   * nên KHÔNG cần user token (BE không lưu user token, chỉ lưu Page token).
   *
   * Hệ quả: mọi Page token sinh ra từ grant này chết ngay. Page trong DB giữ
   * nguyên (lịch + quy tắc tự động còn sống), token tự lành khi user nối lại.
   * Vì vậy CHỈ gọi khi user bấm nút có xác nhận, không bao giờ chạy ngầm.
   */
  async revokeUser(fbUserId: string): Promise<void> {
    this.assertConfigured();
    try {
      const res = await axios.delete(
        `${GRAPH}/${encodeURIComponent(fbUserId)}/permissions`,
        {
          params: { access_token: `${this.appId}|${this.appSecret}` },
          timeout: 20000,
        },
      );
      // FB trả {"success": true}; khác đi coi như chưa thu hồi được.
      if (res.data?.success !== true) {
        throw new BadRequestException(
          'Facebook không xác nhận thu hồi. Thử lại, hoặc gỡ app tay trong ' +
            'Cài đặt > Ứng dụng và trang web.',
        );
      }
      this.log.log(`Đã thu hồi quyền app khỏi nick FB ${fbUserId}.`);
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      const msg = e?.response?.data?.error?.message || e?.message || 'lỗi không rõ';
      throw new BadRequestException(`Thu hồi quyền thất bại: ${msg}`);
    }
  }

  /** Nick FB ứng với user token — FE hiện lên để biết list là của tài khoản nào. */
  private async me(userToken: string): Promise<FbAccount> {
    const res = await axios.get(`${GRAPH}/me`, {
      params: { access_token: userToken, fields: 'id,name' },
      timeout: 20000,
    });
    return { id: res.data?.id || '', name: res.data?.name || '(không rõ tên)' };
  }

  /** Toàn bộ chuỗi callback: code -> nick + danh sách page kèm token. */
  async pagesFromCode(code: string): Promise<FbSession> {
    this.assertConfigured();
    const shortToken = await this.exchangeCode(code);
    const longToken = await this.toLongLived(shortToken);
    const [account, pages] = await Promise.all([
      this.me(longToken),
      this.listPages(longToken),
    ]);
    this.log.log(`Phiên FB của ${account.name} (${account.id}).`);
    return { account, pages };
  }
}
