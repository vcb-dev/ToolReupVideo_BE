-- ============================================================
--  0022 — Quy tắc ĐĂNG BÀI chọn nguồn như quy tắc sản xuất
--  Trước đây quy tắc đăng chỉ lọc được theo chủ đề (cột topics), pick_mode luôn
--  để 'any'. Nay dùng chung 4 cách chọn nguồn: any | channel | topics | videos
--  (tick tay từng video).
--
--  Quy tắc đăng CŨ đang có topics nhưng pick_mode='any' -> phải đổi sang
--  'topics', nếu không sau khi cập nhật code chúng sẽ hiểu thành "đăng mọi
--  video" và đăng cả những chủ đề user không chọn.
--  Dán vào Supabase SQL Editor rồi chạy.
-- ============================================================

update automation_rules
   set pick_mode = 'topics'
 where kind = 'post'
   and pick_mode = 'any'
   and coalesce(array_length(topics, 1), 0) > 0;

-- Hết migration 0022.
