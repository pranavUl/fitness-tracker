-- Run pool workouts reference table + run_sessions column additions

-- ============================================================
-- RUN POOL WORKOUTS (reference / workout library)
-- ============================================================
CREATE TABLE run_pool_workouts (
  id              text PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  pool            text NOT NULL,
  surface         text NOT NULL DEFAULT 'road',
  footwear        text NOT NULL DEFAULT 'running_shoes',
  description     text,
  duration_est    text,
  difficulty      text,
  strava_tracked  boolean NOT NULL DEFAULT true,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_run_pool_workouts_user ON run_pool_workouts(user_id);
CREATE INDEX idx_run_pool_workouts_pool ON run_pool_workouts(pool);

ALTER TABLE run_pool_workouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own run pool workouts" ON run_pool_workouts
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- ADD MISSING COLUMNS TO run_sessions
-- ============================================================
ALTER TABLE run_sessions ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE run_sessions ADD COLUMN IF NOT EXISTS completed boolean NOT NULL DEFAULT true;
ALTER TABLE run_sessions ADD COLUMN IF NOT EXISTS notes text;

-- ============================================================
-- STRAVA TOKENS (OAuth token storage)
-- ============================================================
CREATE TABLE strava_tokens (
  athlete_id    bigint PRIMARY KEY,
  access_token  text NOT NULL,
  refresh_token text NOT NULL,
  expires_at    bigint NOT NULL,
  athlete_data  jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
