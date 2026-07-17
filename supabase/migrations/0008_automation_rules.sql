-- ============================================================
--  0008 — Tab "Tự động": quy tắc tự sản xuất + tự đăng theo lịch lặp.
--
--  Mô hình: 1 quy tắc = các THỨ trong tuần + các KHUNG GIỜ. Cron dựng sẵn video
--  trước giờ đăng `lead_minutes` phút rồi tạo dòng `schedules` (pending) — cron
--  đăng sẵn có lo phần phát. Nhờ vậy lịch tự động hiện luôn ở tab Lịch đăng và
--  đăng ĐÚNG phút đã hẹn thay vì trễ vì chờ sản xuất.
--
--  GIỜ: `times` là giờ VIỆT NAM (Asia/Ho_Chi_Minh, UTC+7 cố định, không DST).
--  Cron quy ra UTC khi ghi `schedules.publish_at` (timestamptz).
--  Dán vào Supabase SQL Editor.
-- ============================================================

create table if not exists automation_rules (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  -- 1=Thứ 2 ... 7=Chủ nhật (theo ISO, khớp nhãn T2..CN trên UI).
  weekdays      smallint[] not null default '{}',
  -- Giờ VN dạng 'HH:MM'. Mỗi khung giờ = 1 video cho MỖI page đích.
  times         text[] not null default '{}',
  -- Page đích. Không dùng FK mảng được -> cron tự lọc page còn sống.
  page_ids      uuid[] not null default '{}',
  -- Cấu hình sản xuất (ngôn ngữ, voice, tỉ lệ, khung, nhạc...) như Xưởng video.
  video_config  jsonb not null default '{}'::jsonb,
  hashtags      text,
  affiliate_id  uuid,
  -- Sản xuất trước giờ đăng bao nhiêu phút.
  lead_minutes  int not null default 60,
  is_active     boolean not null default true,
  last_run_at   timestamptz,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists automation_rules_owner_idx
  on automation_rules (owner_id);

-- Lịch do quy tắc nào sinh ra (null = user tự thêm tay ở tab Lịch đăng).
alter table schedules
  add column if not exists rule_id uuid
  references automation_rules(id) on delete set null;

-- Chặn cron tạo trùng khi chạy lại cùng một khung giờ: mỗi (quy tắc, page, giờ
-- đăng) chỉ được có đúng 1 lịch. Là hàng rào THẬT ở DB, không dựa vào việc cron
-- nhớ đã chạy hay chưa.
create unique index if not exists schedules_rule_slot_uniq
  on schedules (rule_id, page_id, publish_at)
  where rule_id is not null;

create index if not exists schedules_rule_idx on schedules (rule_id);

-- Hết migration 0008.
