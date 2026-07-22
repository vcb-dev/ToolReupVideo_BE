-- ============================================================
--  0015 — Tab "Tự động": quy tắc REUP trọn gói.
--
--  Trước đây produce (sản xuất để sẵn kho) và post (đăng thành phẩm có sẵn) là
--  hai loại chạy nhịp độc lập. Nay thêm loại thứ ba:
--
--    kind='reup' — tới giờ thì CHỌN VIDEO MỚI NHẤT do kênh nguồn đăng trong
--      `recency_days` ngày gần nhất (theo source_videos.published_at), SẢN XUẤT
--      ngay rồi TỰ ĐẶT LỊCH ĐĂNG lên `page_ids`. Một quy tắc lo trọn A→Z, đăng
--      luôn không tích kho (bỏ qua stock_target).
--
--  Nguồn xét theo pick_mode/topics/source_video_ids như produce; caption/hashtag/
--  affiliate như post. Chỉ khác: lấy MỚI NHẤT trong cửa sổ thời gian thay vì cũ
--  nhất, và produce+post gộp một lượt.
--  Dán vào Supabase SQL Editor.
-- ============================================================

-- Cho phép loại quy tắc 'reup'.
alter table automation_rules drop constraint if exists automation_rules_kind_check;
alter table automation_rules
  add constraint automation_rules_kind_check
  check (kind in ('produce', 'post', 'reup'));

-- Cửa sổ "video mới nhất trong N ngày" (chỉ reup dùng; null với produce/post).
alter table automation_rules add column if not exists recency_days int;

-- Đồng bộ cột ai_hashtags (đã dùng cho post nhưng thiếu trong migration/schema).
-- `if not exists` -> an toàn khi prod đã có sẵn cột này.
alter table automation_rules
  add column if not exists ai_hashtags boolean not null default false;

-- Hết migration 0015.
