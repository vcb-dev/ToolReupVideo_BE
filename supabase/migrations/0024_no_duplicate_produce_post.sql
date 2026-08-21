-- 0024_no_duplicate_produce_post.sql
-- CHỐNG TRÙNG: (a) sản xuất ra hai bản thành phẩm y hệt nhau, (b) đăng cùng một
-- video lên page nhiều lần.
--
-- Nguyên nhân đo được ngày 2026-08-21: có 2-3 tiến trình BE cùng chạy trên một
-- DB (2 tiến trình `node dist/main` ở máy + bản deploy). Mọi cron vì thế chạy
-- 2-3 lần mỗi khung giờ (xem automation_run_logs: cùng slot_at, 3 dòng cách nhau
-- vài giây). Các chốt chống trùng cũ đều là "đọc rồi mới ghi" trong RAM của một
-- tiến trình nên không chặn được tiến trình khác. Bản vá gồm 2 phần: khoá thật ở
-- DB (file này) + claim nguyên tử trong code (schedule.service / automation.service).

-- 1) Gộp thành phẩm trùng: cùng video nguồn + cùng file đầu ra = một thứ.
--    Giữ bản CŨ NHẤT, kéo mọi tham chiếu về bản đó rồi xoá bản thừa.
with ranked as (
  select id,
         first_value(id) over w as keep_id,
         row_number()   over w as rn
  from processed_videos
  window w as (
    partition by source_video_id, coalesce(final_drive_id, final_path, '')
    order by created_at, id
  )
)
update schedules s
   set processed_video_id = r.keep_id
  from ranked r
 where s.processed_video_id = r.id and r.rn > 1;

with ranked as (
  select id,
         first_value(id) over w as keep_id,
         row_number()   over w as rn
  from processed_videos
  window w as (
    partition by source_video_id, coalesce(final_drive_id, final_path, '')
    order by created_at, id
  )
)
update metrics m
   set processed_video_id = r.keep_id
  from ranked r
 where m.processed_video_id = r.id and r.rn > 1;

with ranked as (
  select id,
         row_number() over (
           partition by source_video_id, coalesce(final_drive_id, final_path, '')
           order by created_at, id
         ) as rn
  from processed_videos
)
delete from processed_videos pv
 using ranked r
 where pv.id = r.id and r.rn > 1;

-- 2) Hàng rào THẬT: một video nguồn + một file đầu ra chỉ được có 1 dòng.
--    Tên file đầu ra là tất định ('<id>_vi.mp4') nên sản xuất lại sẽ trúng đúng
--    dòng cũ -> code chuyển sang CẬP NHẬT dòng đó thay vì đẻ thêm bản mới.
create unique index if not exists processed_videos_source_file_uidx
  on processed_videos (source_video_id, coalesce(final_drive_id, final_path, ''));

-- 3) Chỉ mục phục vụ claim lịch đăng nguyên tử (status='pending' -> 'publishing').
create index if not exists schedules_due_idx
  on schedules (status, publish_at);

-- Hết migration 0024.
