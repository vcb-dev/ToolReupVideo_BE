-- ============================================================
--  0006 — Kết nối Facebook: provider của page + kho token đăng bài.
--  Token KHÔNG để trong bảng `pages` vì /api/data/pages trả mọi cột về FE.
--  Bảng page_credentials bật RLS + KHÔNG policy -> chỉ Prisma đọc được.
--  Dán vào Supabase SQL Editor.
-- ============================================================

-- Cách đăng của page: upload_post (mặc định, như cũ) | facebook_graph (API FB).
alter table pages
  add column if not exists provider text not null default 'upload_post';

alter table pages
  drop constraint if exists pages_provider_check;
alter table pages
  add constraint pages_provider_check
  check (provider in ('upload_post', 'facebook_graph'));

create table if not exists page_credentials (
  page_id      uuid primary key references pages(id) on delete cascade,
  owner_id     uuid not null references auth.users(id) on delete cascade,
  provider     text not null default 'facebook_graph',
  external_id  text,          -- id page trên Facebook
  access_token text not null, -- Page access token (long-lived, không hết hạn)
  updated_at   timestamptz not null default now()
);

create index if not exists page_credentials_owner_idx
  on page_credentials (owner_id);

alter table page_credentials enable row level security;
-- Cố ý KHÔNG tạo policy nào -> PostgREST/FE không đọc được token.
-- Prisma kết nối bằng vai trò owner nên vẫn đọc/ghi được.

-- Hết migration 0006.
