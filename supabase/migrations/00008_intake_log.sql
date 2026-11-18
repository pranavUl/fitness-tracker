-- Running protein/carbs totals stamped with the time they were entered,
-- so Home can show "usually by now" pacing. Append-mostly; one row per entry.
CREATE TABLE IF NOT EXISTS intake_log (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date          date NOT NULL,
  logged_at     timestamptz NOT NULL,
  protein_grams float,
  carbs_grams   float,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intake_log_user_date ON intake_log(user_id, date DESC);

ALTER TABLE intake_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own intake log" ON intake_log
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- New tables in this project aren't exposed to signed-in users by default
GRANT ALL ON intake_log TO authenticated;
