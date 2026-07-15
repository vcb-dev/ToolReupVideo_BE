-- ============================================================
--  ToolReup Video — Migration 0002: Mẫu xử lý (templates)
--  Preset cấu hình xử lý video: ngôn ngữ, phong cách dịch, phụ đề,
--  prompt, và 2 cờ hậu xử lý (sửa ngữ pháp / lọc từ nhạy cảm).
--  Cùng khuôn với 0001: owner_id + RLS owner_all + trigger updated_at.
--  Chạy: dán vào Supabase SQL Editor, hoặc `supabase db push`.
-- ============================================================

create table if not exists templates (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users(id) on delete cascade,
  name             text not null,
  description      text,
  target_lang      text not null default 'vi',
  translate_style  text,                         -- tự nhiên / review / storytelling / hài hước
  subtitle_style   text,                         -- highlight / 2 dòng / tối giản
  prompt           text,
  auto_grammar     boolean not null default true,
  remove_sensitive boolean not null default true,
  cover_gradient   text,                         -- gradient hiển thị thẻ trên UI
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_templates_owner on templates(owner_id);

-- Trigger tự cập nhật updated_at (hàm set_updated_at đã tạo ở 0001).
drop trigger if exists trg_templates_updated on templates;
create trigger trg_templates_updated before update on templates
  for each row execute function set_updated_at();

-- Row Level Security: mỗi user chỉ thao tác trên mẫu của mình.
alter table templates enable row level security;
drop policy if exists owner_all on templates;
create policy owner_all on templates
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Hết migration 0002.
