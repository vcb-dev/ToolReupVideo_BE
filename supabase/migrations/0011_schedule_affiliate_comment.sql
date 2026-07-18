-- ============================================================
--  0011 — Link affiliate chuyển từ CAPTION sang BÌNH LUẬN.
--
--  Trước đây link affiliate được nối thẳng vào caption bài đăng. Nay bài đăng
--  giữ caption sạch, link được đăng thành 1 BÌNH LUẬN ngay dưới bài (tốt hơn cho
--  tiếp cận của Facebook).
--
--  Lịch cần nhớ dùng link nào -> thêm `affiliate_id`. Kết quả bình luận ghi vào
--  bảng `post_comments` đã có sẵn từ 0001 (schedule_id, affiliate_link_id,
--  comment_text, status pending|commented|failed, error).
--
--  LƯU Ý: đăng bình luận cần quyền Facebook `pages_manage_engagement` — phải
--  thêm vào app và gửi App Review. Chưa được duyệt thì bài vẫn đăng bình thường,
--  chỉ phần bình luận ghi nhận thất bại trong post_comments.
--  Dán vào Supabase SQL Editor.
-- ============================================================

alter table schedules
  add column if not exists affiliate_id uuid
  references affiliate_links(id) on delete set null;

-- Tra nhanh các bình luận còn nợ / lỗi để thử lại.
create index if not exists post_comments_status_idx
  on post_comments (owner_id, status);

-- Hết migration 0011.
