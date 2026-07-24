-- ============================================================
--  0018 — Tab "Tự động": hạn mức "đăng N video mỗi NGÀY" (post + reup).
--
--  Trước đây số video đăng mỗi ngày bị suy ra tự động: post đặt 1 video/page/
--  khung giờ; reup 1 video/khung giờ. Người dùng không kiểm soát được TỔNG số
--  video đăng trong ngày ngoài việc thêm/bớt khung giờ.
--
--  Thêm cột `daily_limit`: hạn mức TỔNG số video PHÂN BIỆT được đăng mỗi NGÀY
--  (giờ VN) cho một quy tắc post/reup. Hệ tự rải theo `times[]` và DỪNG khi đã
--  đủ N video trong ngày. NULL/0 = KHÔNG giới hạn (giữ nguyên hành vi cũ) nên
--  các quy tắc hiện có không bị ảnh hưởng.
--
--  Dán vào Supabase SQL Editor (hoặc psql -f).
-- ============================================================

alter table automation_rules add column if not exists daily_limit int;

-- Hết migration 0018.
