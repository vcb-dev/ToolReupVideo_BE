import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * Chỉ cho phép email nằm trong ADMIN_EMAILS. Dùng SAU SupabaseAuthGuard
 * (guard đó đã gán req.user với cờ is_admin).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (!req.user?.is_admin) {
      throw new ForbiddenException('Chỉ quản trị viên mới được thao tác này.');
    }
    return true;
  }
}
