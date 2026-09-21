-- ============================================================
--  0025 — Nhật ký lượt gọi API TÍNH TIỀN (TikHub, Gemini, DeepSeek).
--
--  AI ghi mỗi lượt gọi thành công (src/usage.py) kèm chi phí đã tính theo
--  bảng giá `usage:` trong config.yaml của AI; BE hút về qua /api/pending
--  (kind "usage") rồi ghi vào đây. Khối "Chi phí API" ở trang Tổng quan (chỉ
--  admin) gom nhóm bảng này theo ngày / dịch vụ / việc.
--
--  id do AI sinh -> hai tiến trình BE cùng hút một mẻ cũng không ghi trùng.
--  cost_usd NULL = model chưa có trong bảng giá (vẫn đếm lượt).
--  owner_id là text, không ràng buộc auth.users: chủ job phía AI chỉ biết
--  được lúc có lúc không (luồng phụ trong thread pool thì trống).
--  label lưu SNAPSHOT nhãn tiếng Việt để đổi nhãn sau này không hỏng bản cũ.
--  Dán vào Supabase SQL Editor, hoặc: npm run db:migrate:deploy
-- ============================================================

create table if not exists api_usage (
  id            uuid primary key,
  created_at    timestamptz not null default now(),
  provider      text not null,          -- tikhub | gemini | deepseek | ...
  op            text not null,          -- mã việc: tikhub.douyin_posts, thumb.draw...
  label         text not null,          -- nhãn hiển thị lúc ghi
  model         text,                   -- model / endpoint thật đã phục vụ
  owner_id      text,
  requests      integer not null default 1,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  images        integer not null default 0,
  cost_usd      numeric(12, 6)
);

create index if not exists api_usage_created_idx
  on api_usage (created_at desc);
create index if not exists api_usage_provider_idx
  on api_usage (provider, created_at desc);
