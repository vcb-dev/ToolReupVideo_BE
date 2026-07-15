import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
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

  app.enableCors({
    origin: '*',
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
