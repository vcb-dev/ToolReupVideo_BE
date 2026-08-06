import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import { createHmac, timingSafeEqual } from 'crypto';
import { mkdir, stat, unlink, writeFile } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';

/** Thao tác mà một link ký sẵn cho phép — đọc và ghi KHÔNG dùng chung chữ ký. */
export type FileOp = 'get' | 'put';

/**
 * Cấp "URL ký sẵn" (signed URL) để AI service PUT/GET file trực tiếp lên kho —
 * BE là NƠI DUY NHẤT giữ secret, AI không cần biết. Hỗ trợ 2 nhà cung cấp qua
 * env `STORAGE_PROVIDER`:
 *   • local               — ổ đĩa của chính máy chạy BE (self-host)
 *   • supabase            — Supabase Storage REST
 * Đổi provider KHÔNG cần sửa AI/FE (vẫn chỉ PUT/GET lên URL nhận được).
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly provider = (
    process.env.STORAGE_PROVIDER || 'supabase'
  ).toLowerCase();

  // ---- Supabase ----
  private readonly sbUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  private readonly sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  private readonly sbBucket = process.env.SUPABASE_STORAGE_BUCKET || 'videos';

  // ---- Local (ổ đĩa) ----
  // Thư mục kho: PHẢI trỏ đúng thư mục mà AI service ghi vào
  // (config.yaml -> storage.local_dir), vì hai bên dùng chung ổ đĩa.
  private readonly localDir = resolve(
    process.env.LOCAL_STORAGE_DIR || './storage/videos',
  );
  // Gốc URL cho link file mà AI SERVICE tải (nhạc/khung/logo). AI chạy cùng máy
  // nên đi thẳng nội bộ, không vòng qua Internet.
  // Link cho TRÌNH DUYỆT thì không dùng base này — xem `forBrowser` ở signDownload.
  private readonly internalBase = (
    process.env.INTERNAL_FILE_BASE_URL ||
    `http://127.0.0.1:${process.env.PORT || 5001}`
  ).replace(/\/$/, '');

  constructor() {
    this.logger.log(
      `Kho lưu video: STORAGE_PROVIDER=${this.provider}` +
        (this.provider === 'local' ? ` (dir=${this.localDir})` : ''),
    );
    if (this.provider === 'local') {
      this.fileSecret(); // chết sớm lúc khởi động nếu thiếu secret, thay vì lúc user bấm xem
    }
  }

  // ---------------- Local: đường dẫn + chữ ký ----------------

  private fileSecret(): string {
    const s =
      process.env.FILE_URL_SECRET ||
      process.env.INTERNAL_API_TOKEN ||
      process.env.JWT_SECRET ||
      '';
    if (!s) {
      throw new InternalServerErrorException(
        'Kho local cần FILE_URL_SECRET (hoặc INTERNAL_API_TOKEN / JWT_SECRET) trong .env của Gateway.',
      );
    }
    return s;
  }

  /**
   * Đổi key -> đường dẫn tuyệt đối, CHẶN path traversal: key kiểu
   * "../../etc/passwd" phải bị từ chối, không được đọc ra ngoài thư mục kho.
   */
  localPath(key: string): string {
    const p = resolve(join(this.localDir, key));
    if (p !== this.localDir && !p.startsWith(this.localDir + sep)) {
      throw new InternalServerErrorException('Key không hợp lệ.');
    }
    return p;
  }

  /**
   * Chữ ký GẮN VỚI THAO TÁC (`op`). Nếu ký chung cho cả đọc lẫn ghi thì một link
   * xem video phát cho trình duyệt có thể bị dùng lại làm lệnh PUT ghi đè chính
   * file đó — link đọc phải không bao giờ mở được đường ghi.
   */
  private sign(key: string, exp: string, op: FileOp = 'get'): string {
    return createHmac('sha256', this.fileSecret())
      .update(`${op}\n${key}\n${exp}`)
      .digest('hex');
  }

  /** Kiểm tra chữ ký + hạn dùng của link file local, đúng thao tác yêu cầu. */
  verifyFileToken(
    key: string,
    exp: string,
    sig: string,
    op: FileOp = 'get',
  ): boolean {
    if (!key || !exp || !sig) return false;
    const deadline = Number(exp);
    if (!Number.isFinite(deadline) || Date.now() > deadline) return false;
    const want = Buffer.from(this.sign(key, exp, op));
    const got = Buffer.from(sig);
    // So sánh chống timing attack; độ dài lệch thì timingSafeEqual ném lỗi.
    return want.length === got.length && timingSafeEqual(want, got);
  }

  // ---------------- Quy ước đặt key cho video người dùng tải lên ----------------
  // Một nguồn sự thật cho init / commit / abort / xoá — không nơi nào tự ghép key.

  /** Key video tải lên: gắn owner để không ai ghi đè được file của người khác. */
  static uploadVideoKey(ownerId: string, pvid: string, ext: string): string {
    return `uploads/${ownerId}/${pvid}${ext}`;
  }

  /** Ảnh bìa suy ra từ key video -> khỏi phải lưu thêm cột trong DB. */
  static coverKeyFor(driveId: string): string {
    return driveId.replace(/\.[^./]+$/, '') + '.jpg';
  }

  /**
   * Dựng link ký sẵn cho file local.
   * `forBrowser` = true -> trả ĐƯỜNG DẪN TƯƠNG ĐỐI ("/files/..."): trình duyệt tự
   * ghép với origin đang mở, nên chạy đúng cả khi vào bằng localhost lẫn khi vào
   * bằng domain tunnel, không cần khai báo domain ở đâu cả.
   * `forBrowser` = false -> URL tuyệt đối trỏ nội bộ, cho AI service tải.
   */
  private localUrl(
    key: string,
    expiresIn: number,
    ct?: string,
    forBrowser = false,
    op: FileOp = 'get',
  ): string {
    const exp = String(Date.now() + expiresIn * 1000);
    const sig = this.sign(key, exp, op);
    const path = key
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    const q = new URLSearchParams({ exp, sig });
    if (ct) q.set('ct', ct);
    const base = forBrowser ? '' : this.internalBase;
    return `${base}/files/${path}?${q.toString()}`;
  }

  private sbHeaders() {
    return { apikey: this.sbKey, Authorization: `Bearer ${this.sbKey}` };
  }

  private ensureSupabase() {
    if (!this.sbUrl || !this.sbKey) {
      throw new InternalServerErrorException(
        'Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY trong .env của Gateway.',
      );
    }
  }

  /** URL ký sẵn để AI PUT file lên kho. */
  async signUpload(
    key: string,
    expiresIn = 3600,
    forBrowser = false,
  ): Promise<string> {
    this.logger.log(`Ký upload (provider=${this.provider}): ${key}`);
    if (this.provider === 'local') {
      return this.localUrl(key, expiresIn, undefined, forBrowser, 'put');
    }
    this.ensureSupabase();
    const res = await axios.post(
      `${this.sbUrl}/storage/v1/object/upload/sign/${this.sbBucket}/${encodeURI(key)}`,
      {},
      { headers: this.sbHeaders() },
    );
    return `${this.sbUrl}/storage/v1${res.data.url}`;
  }

  /**
   * URL ký sẵn để GET file (hết hạn sau expiresIn giây). `responseContentType`
   * ép Content-Type khi trả về — để trình duyệt PHÁT inline (video/mp4) dù file
   * lưu không có content-type đúng. Đường tải nội bộ của AI bỏ trống.
   */
  async signDownload(
    key: string,
    expiresIn = 3600,
    responseContentType?: string,
    forBrowser = false,
  ): Promise<string> {
    if (this.provider === 'local') {
      return this.localUrl(key, expiresIn, responseContentType, forBrowser);
    }
    this.ensureSupabase();
    const res = await axios.post(
      `${this.sbUrl}/storage/v1/object/sign/${this.sbBucket}/${encodeURI(key)}`,
      { expiresIn },
      { headers: { ...this.sbHeaders(), 'Content-Type': 'application/json' } },
    );
    return `${this.sbUrl}/storage/v1${res.data.signedURL}`;
  }

  /**
   * Kiểm tra object có thật + lấy dung lượng. Dùng ở bước commit để xác nhận
   * client đã PUT xong và không bị cụt giữa chừng. `null` = chưa có.
   */
  async statObject(key: string): Promise<{ size: number } | null> {
    if (this.provider === 'local') {
      try {
        return { size: (await stat(this.localPath(key))).size };
      } catch {
        return null;
      }
    }
    this.ensureSupabase();
    try {
      const r = await axios.head(
        `${this.sbUrl}/storage/v1/object/authenticated/${this.sbBucket}/${encodeURI(key)}`,
        { headers: this.sbHeaders() },
      );
      return { size: Number(r.headers['content-length'] ?? -1) };
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    if (this.provider === 'local') {
      // Xoá tay rồi thì coi như xong (giống best-effort của các provider khác).
      await unlink(this.localPath(key)).catch(() => undefined);
      return;
    }
    this.ensureSupabase();
    await axios.delete(
      `${this.sbUrl}/storage/v1/object/${this.sbBucket}/${encodeURI(key)}`,
      { headers: this.sbHeaders() },
    );
  }

  /** PUT trực tiếp 1 buffer lên kho (dùng cho upload media qua BE, file nhỏ/vừa). */
  async putBuffer(
    key: string,
    body: Buffer,
    contentType?: string,
  ): Promise<void> {
    if (this.provider === 'local') {
      const path = this.localPath(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      return;
    }
    this.ensureSupabase();
    await axios.post(
      `${this.sbUrl}/storage/v1/object/${this.sbBucket}/${encodeURI(key)}`,
      body,
      {
        headers: {
          ...this.sbHeaders(),
          'Content-Type': contentType || 'application/octet-stream',
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      },
    );
  }
}
