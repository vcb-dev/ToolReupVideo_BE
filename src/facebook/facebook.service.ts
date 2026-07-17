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
];

export type FbPage = { id: string; name: string; access_token: string };

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
   * `auth_type=rerequest` BẮT Facebook hiện lại màn "Chọn Trang".
   *
   * Không có nó, FB im lặng dùng lại tập page đã cấp ở lần đầu -> page tạo sau
   * (hoặc page không tick lần đó) KHÔNG BAO GIỜ xuất hiện dù đăng nhập lại,
   * và /me/accounts cứ trả về y hệt một con số.
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

  /** Toàn bộ chuỗi callback: code -> danh sách page kèm token. */
  async pagesFromCode(code: string): Promise<FbPage[]> {
    this.assertConfigured();
    const shortToken = await this.exchangeCode(code);
    const longToken = await this.toLongLived(shortToken);
    return this.listPages(longToken);
  }
}
