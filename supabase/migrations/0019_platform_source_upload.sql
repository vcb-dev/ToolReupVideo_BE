-- Thêm nguồn "upload": video do người dùng tự tải lên từ máy, không qua cào.
--
-- LƯU Ý: migrate-deploy.js bọc file này trong BEGIN/COMMIT. Postgres cho phép
-- ALTER TYPE ... ADD VALUE trong transaction MIỄN LÀ không dùng giá trị mới ở
-- cùng transaction — nên TUYỆT ĐỐI không thêm INSERT/UPDATE dùng 'upload' vào
-- file này. Postgres cũng không có DROP VALUE: đây là thay đổi một chiều.
alter type platform_source add value if not exists 'upload';
