import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
