import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import helmet from 'helmet';
import { AppModule } from './app.module';

// Prisma trả BigInt (đếm) và Decimal (số tiền/tỉ lệ) — JSON.stringify không xử lý
// được mặc định. Ép về Number để response giữ nguyên kiểu số cho FE.
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};
(Prisma.Decimal.prototype as any).toJSON = function () {
  return this.toNumber();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

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

  await app.listen(PORT);
  console.log(`🚀 Gateway API chạy tại ${SELF}`);
}
bootstrap();
