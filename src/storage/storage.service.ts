import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Cấp "URL ký sẵn" (signed URL) để AI service PUT/GET file trực tiếp lên kho —
 * BE là NƠI DUY NHẤT giữ secret, AI không cần biết. Hỗ trợ 2 nhà cung cấp qua
 * env `STORAGE_PROVIDER`:
 *   • supabase (mặc định) — Supabase Storage REST
 *   • r2                  — Cloudflare R2 (tương thích S3), presigned URL SigV4
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

  // ---- R2 (tương thích S3) ----
  private readonly r2Bucket = process.env.R2_BUCKET || 'videos';
  private _s3: S3Client | null = null;

  constructor() {
    this.logger.log(
      `Kho lưu video: STORAGE_PROVIDER=${this.provider}` +
        (this.provider === 'r2' ? ` (bucket=${this.r2Bucket})` : ''),
    );
  }

  private s3(): S3Client {
    if (this._s3) return this._s3;
    const account = process.env.R2_ACCOUNT_ID || '';
    const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
    if (!account || !accessKeyId || !secretAccessKey) {
      throw new InternalServerErrorException(
        'Thiếu R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY trong .env của Gateway.',
      );
    }
    this._s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${account}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
    return this._s3;
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
  async signUpload(key: string): Promise<string> {
    this.logger.log(`Ký upload (provider=${this.provider}): ${key}`);
    if (this.provider === 'r2') {
      return getSignedUrl(
        this.s3(),
        new PutObjectCommand({ Bucket: this.r2Bucket, Key: key }),
        { expiresIn: 3600 },
      );
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
   * (chỉ R2) ép Content-Type khi trả về — để trình duyệt PHÁT inline (video/mp4)
   * dù object lưu không có content-type đúng. Đường tải nội bộ của AI bỏ trống.
   */
  async signDownload(
    key: string,
    expiresIn = 3600,
    responseContentType?: string,
  ): Promise<string> {
    if (this.provider === 'r2') {
      return getSignedUrl(
        this.s3(),
        new GetObjectCommand({
          Bucket: this.r2Bucket,
          Key: key,
          ...(responseContentType
            ? {
                ResponseContentType: responseContentType,
                ResponseContentDisposition: 'inline',
              }
            : {}),
        }),
        { expiresIn },
      );
    }
    this.ensureSupabase();
    const res = await axios.post(
      `${this.sbUrl}/storage/v1/object/sign/${this.sbBucket}/${encodeURI(key)}`,
      { expiresIn },
      { headers: { ...this.sbHeaders(), 'Content-Type': 'application/json' } },
    );
    return `${this.sbUrl}/storage/v1${res.data.signedURL}`;
  }

  async remove(key: string): Promise<void> {
    if (this.provider === 'r2') {
      await this.s3().send(
        new DeleteObjectCommand({ Bucket: this.r2Bucket, Key: key }),
      );
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
    if (this.provider === 'r2') {
      await this.s3().send(
        new PutObjectCommand({
          Bucket: this.r2Bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
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
