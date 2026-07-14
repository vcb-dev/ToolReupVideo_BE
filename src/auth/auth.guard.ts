import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';

// Chặn mọi request chưa có access_token hợp lệ.
// Gắn guard này lên controller/route cần đăng nhập.
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (!token) {
      throw new UnauthorizedException('Vui lòng đăng nhập');
    }

    // Xác minh với Supabase; ném 401 nếu token sai/hết hạn.
    req.user = await this.authService.getUser(token);
    // Giữ lại token để tầng data gọi Supabase REST dưới danh nghĩa user (RLS).
    req.accessToken = token;
    return true;
  }
}
