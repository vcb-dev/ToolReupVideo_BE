/**
 * Công tắc CRON cho từng tiến trình BE.
 *
 * Nguyên nhân gốc của việc đăng/tạo video trùng (đo 2026-08-21): có 2-3 tiến
 * trình BE cùng trỏ về MỘT database (2 bản `node dist/main` chạy ở máy + bản
 * deploy), nên mọi cron nổ 2-3 lần mỗi khung giờ. Code nay đã claim nguyên tử
 * nên trùng không còn lọt xuống DB, nhưng chạy nhiều bản vẫn tốn CPU/quota AI
 * và làm nhật ký khó đọc.
 *
 * Quy ước: MỘT tiến trình chạy cron. Các tiến trình còn lại (mở thêm để test,
 * bản deploy phụ) đặt `CRON_ENABLED=false` trong .env — vẫn phục vụ API bình
 * thường, chỉ không chạy việc nền.
 */
export const CRON_ENABLED = !/^(0|false|no|off)$/i.test(
  (process.env.CRON_ENABLED || '').trim(),
);
