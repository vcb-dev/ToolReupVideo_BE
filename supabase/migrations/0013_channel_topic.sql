-- ============================================================
--  0013 — Chủ đề kênh nguồn (kênh này làm về nội dung gì)
--  Gemini tóm tắt bằng tiếng Việt từ bio + caption vài video khi cào.
--  Khác `bio` (mô tả gốc của kênh, thường tiếng Trung). Dán vào Supabase
--  SQL Editor rồi chạy. Chạy lại nhiều lần vẫn an toàn (idempotent).
-- ============================================================

alter table channels add column if not exists topic text;
