-- ============================================================
--  0005 — Cấu hình hệ thống (key/value). Dùng cho mã PIN khoá xoá.
--  Không theo user. Truy cập qua Prisma (bỏ qua RLS); RLS bật + KHÔNG policy
--  để PostgREST/nhân viên không đọc được. Dán vào Supabase SQL Editor.
-- ============================================================

create table if not exists app_config (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

alter table app_config enable row level security;
-- Cố ý KHÔNG tạo policy nào -> PostgREST (REST) chặn mọi truy cập.
-- Prisma kết nối bằng vai trò owner nên vẫn đọc/ghi được.

-- Hết migration 0005.
