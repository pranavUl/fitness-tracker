-- Fitness Tracker: Initial Schema
-- All tables include user_id for RLS enforcement

-- Tracking mode enum
CREATE TYPE tracking_mode AS ENUM (
  'reps_weight',
  'time_weight',
  'time_only',
  'reps_only',
  'reps_assisted',
  'presence'
);

-- ============================================================
-- GYMS
-- ============================================================
CREATE TABLE gyms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  location   text,
  notes      text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_gyms_user ON gyms(user_id);

-- ============================================================
-- EXERCISE POOLS (categories / muscle groups)
-- ============================================================
CREATE TABLE exercise_pools (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name           text NOT NULL,
  parent_pool_id uuid REFERENCES exercise_pools(id) ON DELETE SET NULL,
  sort_order     int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_exercise_pools_user ON exercise_pools(user_id);

-- ============================================================
-- EXERCISE DEFINITIONS
-- ============================================================
CREATE TABLE exercise_definitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  pool_id         uuid REFERENCES exercise_pools(id) ON DELETE SET NULL,
  supports_modes  tracking_mode[] NOT NULL DEFAULT ARRAY['reps_weight']::tracking_mode[],
  default_mode    tracking_mode NOT NULL DEFAULT 'reps_weight',
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_exercise_definitions_user ON exercise_definitions(user_id);
CREATE INDEX idx_exercise_definitions_pool ON exercise_definitions(pool_id);

-- ============================================================
-- GYM EXERCISE PROFILES (weight normalization per gym)
-- ============================================================
CREATE TABLE gym_exercise_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exercise_id     uuid NOT NULL REFERENCES exercise_definitions(id) ON DELETE CASCADE,
  gym_id          uuid NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  weight_multiplier float NOT NULL DEFAULT 1.0,
  machine_notes   text,
  default_weight  float,
  weight_unit     text NOT NULL DEFAULT 'lb',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(exercise_id, gym_id)
);

CREATE INDEX idx_gym_exercise_profiles_exercise ON gym_exercise_profiles(exercise_id);
CREATE INDEX idx_gym_exercise_profiles_gym ON gym_exercise_profiles(gym_id);

-- ============================================================
-- WORKOUTS
-- ============================================================
CREATE TABLE workouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gym_id       uuid REFERENCES gyms(id) ON DELETE SET NULL,
  title        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  notes        text,
  workout_type text NOT NULL DEFAULT 'lifting',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_workouts_user ON workouts(user_id);
CREATE INDEX idx_workouts_started ON workouts(started_at DESC);
CREATE INDEX idx_workouts_gym ON workouts(gym_id);

-- ============================================================
-- WORKOUT EXERCISES (exercises within a workout)
-- ============================================================
CREATE TABLE workout_exercises (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workout_id      uuid NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  exercise_id     uuid NOT NULL REFERENCES exercise_definitions(id) ON DELETE CASCADE,
  sort_order      int NOT NULL DEFAULT 0,
  mode            tracking_mode NOT NULL DEFAULT 'reps_weight',
  is_warmup_group boolean NOT NULL DEFAULT false,
  notes           text,
  started_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_workout_exercises_workout ON workout_exercises(workout_id);
CREATE INDEX idx_workout_exercises_exercise ON workout_exercises(exercise_id);

-- ============================================================
-- SETS
-- ============================================================
CREATE TABLE sets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workout_exercise_id uuid NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
  set_number          int NOT NULL DEFAULT 1,
  reps                int,
  weight              float,
  weight_unit         text NOT NULL DEFAULT 'lb',
  duration_seconds    int,
  is_warmup           boolean NOT NULL DEFAULT false,
  is_assisted         boolean NOT NULL DEFAULT false,
  note                text,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sets_workout_exercise ON sets(workout_exercise_id);
CREATE INDEX idx_sets_completed ON sets(completed_at DESC);

-- ============================================================
-- DAILY TRACKING (protein, weight, journal)
-- ============================================================
CREATE TABLE daily_tracking (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date          date NOT NULL,
  protein_grams float,
  morning_weight float,
  journal       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, date)
);

CREATE INDEX idx_daily_tracking_user_date ON daily_tracking(user_id, date DESC);

-- ============================================================
-- RUN SESSIONS (synced from Strava — Phase 2)
-- ============================================================
CREATE TABLE run_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  strava_id        bigint UNIQUE,
  name             text,
  run_pool         text,
  run_workout      text,
  distance_meters  float,
  duration_seconds int,
  avg_pace         float,
  avg_heart_rate   int,
  started_at       timestamptz,
  polyline         text,
  raw_data         jsonb,
  synced_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_run_sessions_user ON run_sessions(user_id);
CREATE INDEX idx_run_sessions_started ON run_sessions(started_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE gyms ENABLE ROW LEVEL SECURITY;
ALTER TABLE exercise_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE exercise_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gym_exercise_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE workouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_exercises ENABLE ROW LEVEL SECURITY;
ALTER TABLE sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_sessions ENABLE ROW LEVEL SECURITY;

-- RLS policies: users can only access their own data
CREATE POLICY "Users manage own gyms" ON gyms
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own pools" ON exercise_pools
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own exercises" ON exercise_definitions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own gym profiles" ON gym_exercise_profiles
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own workouts" ON workouts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own workout exercises" ON workout_exercises
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own sets" ON sets
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own daily tracking" ON daily_tracking
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own run sessions" ON run_sessions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
