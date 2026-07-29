-- Migration 0018: Thêm cột ai_caption cho processed_videos và automation_rules
ALTER TABLE processed_videos ADD COLUMN IF NOT EXISTS ai_caption TEXT;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS ai_caption BOOLEAN DEFAULT FALSE;
