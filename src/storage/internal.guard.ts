import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Chặn các route nội bộ (service-to-service) bằng token bí mật dùng chung.
 * AI service gửi header `x-internal-token`; giá trị phải khớp INTERNAL_API_TOKEN
 * trong .env. KHÔNG dùng cho request từ trình duyệt/người dùng.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const token = req.headers['x-internal-token'];
    const expected = process.env.INTERNAL_API_TOKEN;

    if (!expected) {
      throw new ServiceUnavailableException(
        'Chưa cấu hình INTERNAL_API_TOKEN trên Gateway.',
      );
    }
    if (!token || token !== expected) {
      throw new UnauthorizedException('Token nội bộ không hợp lệ.');
    }
    return true;
  }
}
