-- ============================================================
--  0012 — Meta kênh nguồn (thẻ kênh giàu thông tin)
--  Thay vì chỉ hiện link, tab "Nguồn theo dõi" hiển thị avatar, tên,
--  số người theo dõi, số video, mô tả. Meta được làm giàu mỗi lần cào
--  (BE ghi từ dữ liệu AI trả về). Dán vào Supabase SQL Editor rồi chạy.
--  Chạy lại nhiều lần vẫn an toàn (idempotent).
-- ============================================================

alter table channels add column if not exists avatar_url     text;
alter table channels add column if not exists follower_count integer;
alter table channels add column if not exists video_count    integer;
alter table channels add column if not exists bio            text;
