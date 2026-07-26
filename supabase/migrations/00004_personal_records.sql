-- Add PR flags and estimated 1RM to sets table
ALTER TABLE sets ADD COLUMN IF NOT EXISTS e1rm float;
ALTER TABLE sets ADD COLUMN IF NOT EXISTS is_pr_weight boolean NOT NULL DEFAULT false;
ALTER TABLE sets ADD COLUMN IF NOT EXISTS is_pr_1rm boolean NOT NULL DEFAULT false;
ALTER TABLE sets ADD COLUMN IF NOT EXISTS is_pr_volume boolean NOT NULL DEFAULT false;
ALTER TABLE sets ADD COLUMN IF NOT EXISTS is_pr_reps boolean NOT NULL DEFAULT false;
ALTER TABLE sets ADD COLUMN IF NOT EXISTS is_pr_duration boolean NOT NULL DEFAULT false;

-- Personal records: current best per exercise + pr_type (fast lookup)
CREATE TABLE personal_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exercise_id   uuid NOT NULL REFERENCES exercise_definitions(id) ON DELETE CASCADE,
  pr_type       text NOT NULL,
  is_primary    boolean NOT NULL DEFAULT false,
  value         float NOT NULL,
  value_unit    text NOT NULL DEFAULT 'lb',
  previous_value float,
  set_id        uuid REFERENCES sets(id) ON DELETE SET NULL,
  workout_id    uuid REFERENCES workouts(id) ON DELETE SET NULL,
  gym_id        uuid REFERENCES gyms(id) ON DELETE SET NULL,
  pr_scope      text NOT NULL DEFAULT 'global',
  achieved_at   timestamptz NOT NULL DEFAULT now(),
  context_json  jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Partial unique indexes: one current-best per exercise+type, scoped correctly
CREATE UNIQUE INDEX idx_pr_global_unique
  ON personal_records (user_id, exercise_id, pr_type)
  WHERE pr_scope = 'global';

CREATE UNIQUE INDEX idx_pr_per_gym_unique
  ON personal_records (user_id, exercise_id, pr_type, gym_id)
  WHERE pr_scope = 'per_gym';

CREATE INDEX idx_personal_records_user_exercise ON personal_records(user_id, exercise_id);
CREATE INDEX idx_personal_records_workout ON personal_records(workout_id);

-- PR snapshots: full historical timeline of every PR ever achieved
CREATE TABLE pr_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exercise_id   uuid NOT NULL REFERENCES exercise_definitions(id) ON DELETE CASCADE,
  pr_type       text NOT NULL,
  is_primary    boolean NOT NULL DEFAULT false,
  value         float NOT NULL,
  value_unit    text NOT NULL DEFAULT 'lb',
  previous_value float,
  set_id        uuid REFERENCES sets(id) ON DELETE SET NULL,
  workout_id    uuid REFERENCES workouts(id) ON DELETE SET NULL,
  gym_id        uuid REFERENCES gyms(id) ON DELETE SET NULL,
  pr_scope      text NOT NULL DEFAULT 'global',
  achieved_at   timestamptz NOT NULL DEFAULT now(),
  context_json  jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pr_snapshots_user_exercise ON pr_snapshots(user_id, exercise_id);
CREATE INDEX idx_pr_snapshots_workout ON pr_snapshots(workout_id);
CREATE INDEX idx_pr_snapshots_achieved ON pr_snapshots(achieved_at DESC);

-- RLS
ALTER TABLE personal_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own PRs" ON personal_records
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own PR snapshots" ON pr_snapshots
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Grant table access to authenticated role
GRANT ALL ON personal_records TO authenticated;
GRANT ALL ON pr_snapshots TO authenticated;
