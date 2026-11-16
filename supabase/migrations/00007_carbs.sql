-- Daily carbs, tracked alongside protein on the home screen
ALTER TABLE daily_tracking ADD COLUMN IF NOT EXISTS carbs_grams float;
