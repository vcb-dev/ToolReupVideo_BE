import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Decimal } from '@prisma/client/runtime/library';
import helmet from 'helmet';
import { AppModule } from './app.module';

// Prisma trả BigInt (đếm) và Decimal (số tiền/tỉ lệ) — JSON.stringify không xử lý
// được mặc định. Ép về Number để response giữ nguyên kiểu số cho FE.
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};
(Decimal.prototype as any).toJSON = function () {
  return this.toNumber();
};

// Trần body JSON. Express mặc định 100kb — QUÁ NHỎ cho app này: đo thật
// 2026-08-21, mỗi video trong danh sách quét nặng ~1 KB (desc + link ảnh bìa đã
// ký), nên chọn 100 video để lưu đã là ~102 KB và BE ném PayloadTooLargeError.
// Chọn 200-500 video là chuyện bình thường -> 200-510 KB.
//
// Nâng lên đây KHÔNG mở đường cho upload file: video đi qua PUT stream vào
// /files/*, còn nhạc/khung đi multipart (FileInterceptor tự chặn ở 60 MB).
// Không có luồng hợp lệ nào gửi file dưới dạng JSON.
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '10mb';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableShutdownHooks();

  const express = await import('express');
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ limit: JSON_BODY_LIMIT, extended: true }));

  // Security headers cơ bản (X-Frame-Options, HSTS, X-Content-Type-Options, ...)
  app.use(helmet());

  // Chạy sau reverse proxy (Railway/Vercel) — tin X-Forwarded-For để rate limit
  // đếm đúng IP thật của từng client, thay vì gộp chung IP của proxy.
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', 1);

  // CORS: chỉ cho phép các domain FE khai báo trong CORS_ORIGINS (ngăn cách bằng
  // dấu phẩy). Nếu chưa đặt -> chỉ mở cho localhost dev và CẢNH BÁO trên log.
  const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedOrigins.length === 0) {
    console.warn(
      '⚠️  CORS_ORIGINS chưa được đặt — chỉ cho phép localhost. ' +
        'Hãy đặt CORS_ORIGINS = https://<domain-fe> trên môi trường production.',
    );
  }
  const corsOrigins =
    allowedOrigins.length > 0
      ? allowedOrigins
      : ['http://localhost:3000', 'http://127.0.0.1:3000'];

  app.enableCors({
    origin: corsOrigins,
    methods: 'GET,POST,PUT,DELETE,OPTIONS,PATCH',
    allowedHeaders: 'Content-Type, Authorization',
  });

  const PORT = process.env.PORT || 5001;
  const SELF = `http://localhost:${PORT}`;

  app.use((req: any, res: any, next: () => void) => {
    console.log(`${new Date().toLocaleTimeString()}  ${req.method} ${req.url}`);
    next();
  });

  // Node mặc định requestTimeout = 300s tính cho TOÀN BỘ request KỂ CẢ body —
  // một video 400 MB trên đường truyền chậm sẽ chết đúng phút thứ 5 và để lại
  // file cụt. Tắt hẳn (0) vì upload có thể kéo dài; headersTimeout vẫn giữ để
  // chặn client mở kết nối rồi không gửi gì.
  const server = app.getHttpServer();
  server.requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 0);
  server.headersTimeout = 65_000;

  await app.listen(PORT);
  console.log(`🚀 Gateway API chạy tại ${SELF}`);
}
bootstrap();
