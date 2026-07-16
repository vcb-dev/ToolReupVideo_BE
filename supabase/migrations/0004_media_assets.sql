-- ============================================================
--  0004 — Kho media dùng chung: nhạc / khung / voice
--  Lưu trong "Kho" cùng video. Dán vào Supabase SQL Editor rồi chạy.
-- ============================================================

create table if not exists media_assets (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  kind         text not null,               -- 'music' | 'frame' | 'voice'
  name         text not null,
  drive_id     text,                         -- R2 key (file nhạc/khung; mẫu voice tuỳ chọn)
  voice_id     text,                         -- voice_id MiniMax đã clone (kind=voice)
  chroma_color text default '0x00FF00',      -- màu phông xanh khung (kind=frame)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists media_assets_owner_kind_idx
  on media_assets (owner_id, kind);

-- Trigger tự cập nhật updated_at (hàm set_updated_at đã tạo ở 0001).
drop trigger if exists trg_media_assets_updated on media_assets;
create trigger trg_media_assets_updated before update on media_assets
  for each row execute function set_updated_at();

-- RLS: mỗi user chỉ thao tác trên asset của mình.
alter table media_assets enable row level security;
drop policy if exists owner_all on media_assets;
create policy owner_all on media_assets
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Hết migration 0004.
