-- ============================================================
--  0009 — Tab "Tự động": chọn NGUỒN video cho quy tắc.
--
--  Trước đây quy tắc luôn vơ bất kỳ video chưa sản xuất nào trong Kho. Nay có
--  3 cách, khai rõ bằng `pick_mode` thay vì đoán theo cột nào có dữ liệu:
--    any    — bất kỳ video chưa sản xuất (như cũ, mặc định)
--    topics — chỉ video thuộc cụm chủ đề đã chọn
--    videos — chỉ đúng những video đã tick
--
--  Cả 3 đều BỎ QUA video đã có bản thành phẩm -> danh sách tự cạn dần, không
--  đăng lại trùng.
--  Dán vào Supabase SQL Editor.
-- ============================================================

alter table automation_rules
  add column if not exists pick_mode text not null default 'any';

alter table automation_rules
  drop constraint if exists automation_rules_pick_mode_check;
alter table automation_rules
  add constraint automation_rules_pick_mode_check
  check (pick_mode in ('any', 'topics', 'videos'));

-- Cụm chủ đề (khớp source_videos.topic). Chuỗi rỗng = "chưa phân loại".
alter table automation_rules
  add column if not exists topics text[] not null default '{}';

-- Danh sách video tick tay. Không FK mảng được -> cron tự lọc video còn sống.
alter table automation_rules
  add column if not exists source_video_ids uuid[] not null default '{}';

-- Hết migration 0009.
