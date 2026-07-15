import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';

/**
 * Quản lý Supabase Storage — BE là NƠI DUY NHẤT giữ service_role key.
 * BE không tự đẩy/tải file video; nó cấp "URL ký sẵn" (signed URL) để AI service
 * PUT/GET trực tiếp lên Supabase mà không cần biết secret.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  private readonly key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  private readonly bucket = process.env.SUPABASE_STORAGE_BUCKET || 'videos';

  private headers() {
    return { apikey: this.key, Authorization: `Bearer ${this.key}` };
  }

  private ensure() {
    if (!this.url || !this.key) {
      throw new InternalServerErrorException(
        'Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY trong .env của Gateway.',
      );
    }
  }

  /** URL ký sẵn để AI PUT file lên (dùng x-upsert khi PUT để ghi đè nếu trùng). */
  async signUpload(key: string): Promise<string> {
    this.ensure();
    const res = await axios.post(
      `${this.url}/storage/v1/object/upload/sign/${this.bucket}/${encodeURI(key)}`,
      {},
      { headers: this.headers() },
    );
    return `${this.url}/storage/v1${res.data.url}`;
  }

  /** URL ký sẵn để AI GET file về (hết hạn sau expiresIn giây). */
  async signDownload(key: string, expiresIn = 3600): Promise<string> {
    this.ensure();
    const res = await axios.post(
      `${this.url}/storage/v1/object/sign/${this.bucket}/${encodeURI(key)}`,
      { expiresIn },
      { headers: { ...this.headers(), 'Content-Type': 'application/json' } },
    );
    return `${this.url}/storage/v1${res.data.signedURL}`;
  }

  async remove(key: string): Promise<void> {
    this.ensure();
    await axios.delete(
      `${this.url}/storage/v1/object/${this.bucket}/${encodeURI(key)}`,
      { headers: this.headers() },
    );
  }
}
