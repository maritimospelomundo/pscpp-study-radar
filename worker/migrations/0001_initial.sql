CREATE TABLE IF NOT EXISTS attempts (
  attempt_key TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  category TEXT,
  axis TEXT,
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  mastery INTEGER CHECK (mastery BETWEEN 0 AND 3),
  error_cause TEXT,
  next_review TEXT,
  answered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_next_review ON attempts(next_review);
CREATE INDEX IF NOT EXISTS idx_attempts_mastery ON attempts(mastery);
CREATE INDEX IF NOT EXISTS idx_attempts_axis_updated ON attempts(axis, updated_at);

CREATE TABLE IF NOT EXISTS reports (
  report_key TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_updated_at ON reports(updated_at);
PRAGMA optimize;
