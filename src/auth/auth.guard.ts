import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * KHO DÙNG CHUNG — đọc WORKSPACE_OWNER_ID trong .env.
 *
 * Bỏ trống  = mỗi tài khoản một kho riêng (mặc định cũ).
 * Điền UUID = MỌI tài khoản dùng chung kho của UUID đó: thấy hết, sửa hết,
 *             xoá hết của nhau.
 *
 * CÁCH LÀM: toàn bộ 100 chỗ lọc `owner_id` trong BE đều lấy giá trị từ
 * `req.user.id` (đã rà: không chỗ nào dùng nó làm DANH TÍNH). Nên chỉ cần đổi
 * đúng một giá trị ở đây là cả hệ thống trỏ chung một kho — không phải sửa
 * từng truy vấn, và tắt đi là về nguyên trạng.
 *
 * `email` và `is_admin` GIỮ NGUYÊN của người thật (is_admin suy từ email, xem
 * AuthService.isAdmin) nên AdminGuard vẫn phân biệt đúng ai là quản trị viên.
 * Danh tính thật vẫn còn ở `req.user.auth_id` nếu sau này cần ghi nhật ký.
 *
 * ⚠️ UUID này phải là một tài khoản CÓ THẬT trong auth.users: mọi bảng khai
 * `owner_id references auth.users(id) on delete cascade`, nên XOÁ tài khoản đó
 * là mất sạch dữ liệu của tất cả mọi người.
 */
const WORKSPACE_OWNER_ID = (process.env.WORKSPACE_OWNER_ID || '').trim();

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

    if (WORKSPACE_OWNER_ID) {
      // Sai định dạng thì DỪNG, đừng đoán: id rác sẽ làm mọi lệnh ghi chết vì
      // vi phạm khoá ngoại, mà lỗi hiện ra lại không nhắc gì tới biến này.
      if (!UUID_RE.test(WORKSPACE_OWNER_ID)) {
        throw new UnauthorizedException(
          'WORKSPACE_OWNER_ID trong .env không phải UUID hợp lệ.',
        );
      }
      req.user.auth_id = req.user.id; // danh tính thật, giữ để tra cứu
      req.user.id = WORKSPACE_OWNER_ID; // mọi truy vấn trỏ về kho chung
    }

    // Giữ lại token để tầng data gọi Supabase REST dưới danh nghĩa user (RLS).
    req.accessToken = token;
    return true;
  }
}
