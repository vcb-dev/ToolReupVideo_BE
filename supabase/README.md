# Supabase — Schema ToolReup Video

## Cách chạy migration

**Cách 1 — SQL Editor (nhanh nhất):**
1. Mở Supabase project → **SQL Editor** → **New query**.
2. Dán toàn bộ nội dung `migrations/0001_init.sql` → **Run**.
3. Xong. Chạy lại nhiều lần vẫn an toàn (idempotent).

**Cách 2 — Supabase CLI:**
```bash
supabase db push          # hoặc:
supabase db execute --file supabase/migrations/0001_init.sql
```

## Có gì trong migration này

| Bảng | Khối sơ đồ | Vai trò |
|------|-----------|---------|
| `channels` | 1,2,7 | Kênh **nguồn** để cào (Douyin/TikTok/YT/XHS/FB), cờ theo dõi tự động |
| `pages` | 7 | Page/kênh **đích** để đăng lên |
| `source_videos` | 2 | Video cào về (thay `manifest.json`) |
| `processed_videos` | 3,4 | Video thành phẩm chờ đăng |
| `jobs` | 9 | Hàng đợi tác vụ (ingest/process/upload/comment) |
| `schedules` | 5 | Lịch đăng bài |
| `affiliate_links` | 6 | Kho link affiliate |
| `post_comments` | 6 | Comment gắn link sau khi đăng |
| `metrics` | 8 | View/like/CTR/doanh số |

## Bảo mật

- Mọi bảng bật **Row Level Security**, policy `owner_all`: user chỉ thao tác được trên dòng có `owner_id = auth.uid()`.
- FE gọi qua NestJS Gateway (đã đính JWT Supabase). Nếu sau này gọi Supabase trực tiếp bằng anon key, RLS vẫn chặn đúng.

## Bước tiếp theo (chưa làm)

- [ ] BE (NestJS): module CRUD cho `channels`, `pages`, `affiliate_links`, `schedules`.
- [ ] AI service: ghi `source_videos` vào DB thay cho `manifest.json`.
- [ ] Cron cào hằng ngày → tạo `jobs`.
- [ ] FE: các trang module bám vào bảng mới.
