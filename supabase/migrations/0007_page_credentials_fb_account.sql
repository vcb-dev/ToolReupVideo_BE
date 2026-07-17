-- ============================================================
--  0007 — Nick Facebook sinh ra token của từng page.
--  Trước đây chỉ lưu external_id (id PAGE) + token, không lưu nick nào cấp
--  token -> UI Quản lý Page không nói được page thuộc nick nào. Nối nhiều nick
--  cùng lúc thì danh sách thành một mớ không phân biệt được.
--
--  Page nối TRƯỚC migration này để trống: không truy ngược nick từ Page token
--  đã lưu được, chỉ điền khi user nối lại page đó.
--  Dán vào Supabase SQL Editor.
-- ============================================================

alter table page_credentials
  add column if not exists fb_user_id text;

alter table page_credentials
  add column if not exists fb_user_name text;

-- Lọc/gom theo nick trong phạm vi 1 owner.
create index if not exists page_credentials_owner_fb_user_idx
  on page_credentials (owner_id, fb_user_id);

-- Hết migration 0007.
