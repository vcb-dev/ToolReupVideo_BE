/**
 * Bản tạm giữa hai bước "đăng nhập FB" và "chọn page để nối".
 *
 * Nằm trong app_config vì phiên phải sống qua nhiều request và qua cả việc BE
 * khởi động lại (callback về một instance, user chọn page ở instance khác).
 * Bảng bật RLS và KHÔNG có policy -> FE/PostgREST không đọc được.
 *
 * Khoá và hạn dùng chung cho controller (ghi/đọc) và sweeper (dọn) — để hai
 * bên lệch nhau thì sweeper sẽ xoá mất phiên user đang chọn dở.
 */

/** Khoá lưu tạm danh sách page vừa lấy được sau khi đăng nhập (kèm token). */
export const pendingKey = (ownerId: string) => `fb_pending:${ownerId}`;

/** Tiền tố để quét mọi bản tạm, không cần biết owner. */
export const PENDING_PREFIX = 'fb_pending:';

/**
 * Bản tạm sống tối đa 30': đủ rộng để chọn trong hàng trăm page, nhưng không
 * để token nằm lại vô hạn khi user đăng nhập xong rồi bỏ dở (bản tạm chứa token
 * của MỌI page, kể cả page không định nối).
 */
export const PENDING_TTL_MS = 30 * 60 * 1000;
