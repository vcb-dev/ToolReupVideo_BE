-- ============================================================
--  0021 — Đăng thẳng VIDEO GỐC trong kho (không qua sản xuất)
--  Quy tắc "Đăng bài" trước đây chỉ lấy được processed_videos (thành phẩm đã
--  lồng tiếng). Thêm lựa chọn đăng nguyên bản video nguồn: lịch đăng giờ trỏ
--  tới MỘT trong hai — thành phẩm hoặc video gốc.
--  Dán vào Supabase SQL Editor rồi chạy.
-- ============================================================

-- Lịch đăng trỏ tới video gốc thì không có thành phẩm -> cột phải cho phép null.
alter table schedules alter column processed_video_id drop not null;

alter table schedules add column if not exists source_video_id uuid
  references source_videos(id) on delete cascade;

create index if not exists schedules_source_video_idx
  on schedules (source_video_id);

-- Phải có đúng một đích để đăng, không thì cron không biết lấy file ở đâu.
alter table schedules drop constraint if exists schedules_video_target_chk;
alter table schedules add constraint schedules_video_target_chk
  check (processed_video_id is not null or source_video_id is not null);

-- 'processed' = đăng thành phẩm (mặc định, giữ nguyên hành vi cũ)
-- 'raw'       = đăng thẳng video gốc trong kho
alter table automation_rules add column if not exists post_source text not null
  default 'processed';

-- Hết migration 0021.
