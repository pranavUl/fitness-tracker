-- Rest time between sets: seconds since the previous completed set in the
-- same workout, stamped at completion time. Passive data, user-editable.
ALTER TABLE sets ADD COLUMN IF NOT EXISTS rest_seconds int;
