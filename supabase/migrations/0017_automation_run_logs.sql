-- ============================================================
--  0017 — Nhật ký hoạt động của quy tắc tự động.
--
--  Trước đây mỗi quy tắc chỉ giữ TRẠNG THÁI GẦN NHẤT (last_run_at/last_error)
--  nên không xem lại được lịch sử. Nay mỗi LƯỢT xử lý khung giờ ghi 1 dòng:
--  đã sản xuất/đăng gì, bỏ lượt vì sao, hay lỗi gì — tab "Tự động" hiện danh
--  sách này để user theo dõi mà không cần đọc log server.
--
--  rule_name lưu SNAPSHOT để nhật ký còn đọc được sau khi quy tắc bị xoá
--  (rule_id lúc đó về null).
--  Dán vào Supabase SQL Editor.
-- ============================================================

create table if not exists automation_run_logs (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  rule_id    uuid references automation_rules(id) on delete set null,
  rule_name  text not null,
  kind       text not null,            -- produce | post | reup
  slot_at    timestamptz,              -- khung giờ được xử lý (null = lỗi ngoài khung)
  status     text not null,            -- ok | warn (bỏ lượt/cạn nguồn) | error
  message    text,
  created_at timestamptz not null default now()
);

create index if not exists automation_run_logs_owner_idx
  on automation_run_logs (owner_id, created_at desc);
create index if not exists automation_run_logs_rule_idx
  on automation_run_logs (rule_id);

-- Hết migration 0017.
