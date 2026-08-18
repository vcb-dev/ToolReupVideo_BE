-- ============================================================
--  0023 — Chốt chặn trùng page FB + dọn bản tạm OAuth còn sót.
--
--  (1) Nối page đang chống trùng bằng `findFirst` trong FacebookController
--      trước khi tạo dòng `pages` — tầng app, không phải tầng DB. Hai request
--      lưu song song (user bấm "Lưu" hai lần, hoặc bấm lại khi mạng chậm) cùng
--      thấy "chưa có" rồi cùng tạo -> 1 page Facebook thành 2 dòng `pages`,
--      2 token, tab Quản lý Page hiện trùng và lịch đăng có thể đăng đôi.
--      Unique index bịt hẳn ở DB; nhánh upsert sẵn có tự lo phần cập nhật.
--
--  (2) Bản tạm `fb_pending:<owner_id>` trong app_config CHỨA Page access token
--      của MỌI page nick đó quản lý. Nó chỉ bị xoá khi user bấm lưu, hoặc khi
--      /pending được gọi lúc đã quá hạn 30'. User đăng nhập FB xong đóng tab
--      thì không còn ai gọi /pending -> token nằm lại vô thời hạn. Xoá một lần
--      ở đây; từ nay PendingSweeperService quét hằng ngày.
--
--  Dán vào Supabase SQL Editor rồi chạy.
-- ============================================================

-- Kiểm tra trước khi tạo index — phải trả về 0 dòng, nếu không thì gộp tay
-- (giữ dòng token mới nhất) rồi mới chạy tiếp:
--   select owner_id, external_id, count(*)
--     from page_credentials where external_id is not null
--    group by 1, 2 having count(*) > 1;

-- Partial index: page nối trước 0006 có thể chưa có external_id, nhiều NULL
-- vẫn hợp lệ nên phải loại chúng khỏi ràng buộc.
create unique index if not exists page_credentials_owner_external_uidx
  on page_credentials (owner_id, external_id)
  where external_id is not null;

-- Dọn một lần các bản tạm đã quá hạn 30' (khớp PENDING_TTL_MS ở BE).
-- Phiên đang mở dở của user không bị đụng tới.
delete from app_config
 where key like 'fb_pending:%'
   and updated_at < now() - interval '30 minutes';

-- Hết migration 0023.
