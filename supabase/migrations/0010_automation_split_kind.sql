-- ============================================================
--  0010 — Tách quy tắc tự động thành 2 LOẠI riêng biệt.
--
--  Trước đây 1 quy tắc ôm cả sản xuất lẫn đăng: tới giờ đăng mới dựng video,
--  nên nhịp làm nội dung bị buộc chặt vào nhịp phát nội dung. Nay tách:
--
--    kind='produce' — TỰ SẢN XUẤT: lấy video nguồn trong Kho, dịch/lồng tiếng/
--      chỉnh sub rồi để sẵn thành KHO THÀNH PHẨM. Chạy theo lịch (thứ+giờ) NHƯNG
--      bỏ lượt nếu kho đã đủ `stock_target` (không chất đống).
--
--    kind='post' — TỰ ĐĂNG: tới giờ thì lấy thành phẩm CÓ SẴN (lọc theo chủ đề
--      trong `topics`) đem đăng lên `page_ids`, kèm hashtags + link affiliate.
--
--  Nhờ tách, đăng không phải chờ dựng video (kho có sẵn) và có thể nuôi nhiều
--  page với chủ đề khác nhau từ cùng một kho.
--  Dán vào Supabase SQL Editor.
-- ============================================================

alter table automation_rules
  add column if not exists kind text not null default 'produce';

alter table automation_rules
  drop constraint if exists automation_rules_kind_check;
alter table automation_rules
  add constraint automation_rules_kind_check check (kind in ('produce', 'post'));

-- Chỉ dùng cho kind='produce'
alter table automation_rules
  add column if not exists batch_size int not null default 1;      -- số video mỗi lượt
alter table automation_rules
  add column if not exists stock_target int not null default 10;   -- trần kho thành phẩm

-- Mốc KHUNG GIỜ đã chạy gần nhất (khác last_run_at là giờ thực tế chạy) — để
-- cron chạy mỗi phút không xử lý trùng cùng một khung giờ.
alter table automation_rules
  add column if not exists last_slot_at timestamptz;

create index if not exists automation_rules_owner_kind_idx
  on automation_rules (owner_id, kind);

-- Hết migration 0010.
