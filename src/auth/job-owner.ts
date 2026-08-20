/**
 * Id tài khoản THẬT của người gửi request — dùng làm khoá JOB, không phải khoá
 * sở hữu dữ liệu.
 *
 * VÌ SAO CẦN TÁCH: khi bật kho dùng chung (WORKSPACE_OWNER_ID trong .env),
 * SupabaseAuthGuard ghi đè `req.user.id` bằng id kho chung để mọi truy vấn trỏ
 * chung một kho. Nếu AI service lấy đúng giá trị đó làm khoá job thì HAI NGƯỜI
 * DÙNG CHUNG MỘT BẢN GHI JOB — người thứ hai bấm Sản xuất sẽ bị chặn bằng
 * "Bạn đang có tác vụ chạy" dù máy vẫn còn slot trống, và log của hai người
 * trộn vào nhau.
 *
 * Guard giữ id thật ở `auth_id`. Không bật kho chung thì `auth_id` không tồn
 * tại và hàm này trả về đúng `id` như cũ.
 */
export function jobOwner(req: any): string | undefined {
  return req?.user?.auth_id ?? req?.user?.id;
}
