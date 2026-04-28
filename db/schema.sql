-- ═══════════════════════════════════════════════════════════
-- ProctorGuard v2 — Complete Database Schema
-- Run this in Railway PostgreSQL console
-- ═══════════════════════════════════════════════════════════

-- ── USERS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','faculty','moderator','proctor','student')),
  roll_number   TEXT UNIQUE,              -- students only
  department    TEXT,                     -- faculty only
  is_active     BOOLEAN DEFAULT TRUE,
  must_change_password BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── SUBJECTS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subjects (
  id          SERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  department  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Faculty ↔ Subject mapping
CREATE TABLE IF NOT EXISTS faculty_subjects (
  faculty_id  INT REFERENCES users(id) ON DELETE CASCADE,
  subject_id  INT REFERENCES subjects(id) ON DELETE CASCADE,
  PRIMARY KEY (faculty_id, subject_id)
);

-- Student ↔ Subject enrollment
CREATE TABLE IF NOT EXISTS student_subjects (
  student_id  INT REFERENCES users(id) ON DELETE CASCADE,
  subject_id  INT REFERENCES subjects(id) ON DELETE CASCADE,
  PRIMARY KEY (student_id, subject_id)
);

-- ── QUESTION PAPERS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS question_papers (
  id              SERIAL PRIMARY KEY,
  subject_id      INT REFERENCES subjects(id),
  faculty_id      INT REFERENCES users(id),
  moderator_id    INT REFERENCES users(id),
  title           TEXT NOT NULL,
  total_marks     INT NOT NULL DEFAULT 100,
  duration_mins   INT NOT NULL DEFAULT 90,
  instructions    TEXT,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','submitted','under_review','approved','rejected')),
  rejection_note  TEXT,
  submitted_at    TIMESTAMPTZ,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── QUESTIONS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS questions (
  id              SERIAL PRIMARY KEY,
  paper_id        INT REFERENCES question_papers(id) ON DELETE CASCADE,
  order_index     INT NOT NULL DEFAULT 0,
  type            TEXT NOT NULL CHECK (type IN ('mcq','essay')),
  question_text   TEXT NOT NULL,
  marks           INT NOT NULL DEFAULT 1,
  -- MCQ fields
  option_a        TEXT,
  option_b        TEXT,
  option_c        TEXT,
  option_d        TEXT,
  correct_option  TEXT CHECK (correct_option IN ('A','B','C','D')),
  explanation     TEXT,
  -- Moderation
  mod_status      TEXT DEFAULT 'pending'
                  CHECK (mod_status IN ('pending','approved','rejected')),
  mod_comment     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── EXAMS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS exams (
  id            SERIAL PRIMARY KEY,
  subject_id    INT REFERENCES subjects(id),
  paper_id      INT REFERENCES question_papers(id),
  title         TEXT NOT NULL,
  scheduled_at  TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled','live','completed','cancelled')),
  created_by    INT REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── EXAM ROOMS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS exam_rooms (
  id          SERIAL PRIMARY KEY,
  exam_id     INT REFERENCES exams(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  proctor_id  INT REFERENCES users(id),
  capacity    INT NOT NULL DEFAULT 30,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','live','closed')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── EXAM SEATS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS exam_seats (
  id            SERIAL PRIMARY KEY,
  exam_id       INT REFERENCES exams(id) ON DELETE CASCADE,
  room_id       INT REFERENCES exam_rooms(id) ON DELETE CASCADE,
  student_id    INT REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','active','submitted','terminated')),
  started_at    TIMESTAMPTZ,
  submitted_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (exam_id, student_id)
);

-- ── ANSWERS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS answers (
  id            SERIAL PRIMARY KEY,
  seat_id       INT REFERENCES exam_seats(id) ON DELETE CASCADE,
  question_id   INT REFERENCES questions(id),
  answer_text   TEXT,      -- essay answers
  answer_option TEXT,      -- MCQ: A, B, C or D
  is_correct    BOOLEAN,   -- auto-set for MCQ
  marks_awarded NUMERIC(5,2), -- set by faculty for essays
  faculty_note  TEXT,
  graded_at     TIMESTAMPTZ,
  graded_by     INT REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (seat_id, question_id)
);

-- ── VIOLATIONS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS violations (
  id          SERIAL PRIMARY KEY,
  seat_id     INT REFERENCES exam_seats(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'med'
              CHECK (severity IN ('high','med','low')),
  occurred_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── RESULTS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS results (
  id                SERIAL PRIMARY KEY,
  seat_id           INT REFERENCES exam_seats(id) ON DELETE CASCADE,
  exam_id           INT REFERENCES exams(id),
  student_id        INT REFERENCES users(id),
  subject_id        INT REFERENCES subjects(id),
  mcq_marks         NUMERIC(5,2) DEFAULT 0,
  essay_marks       NUMERIC(5,2) DEFAULT 0,
  total_marks       NUMERIC(5,2) DEFAULT 0,
  max_marks         INT,
  percentage        NUMERIC(5,2),
  grade             TEXT,
  violation_count   INT DEFAULT 0,
  is_published      BOOLEAN DEFAULT FALSE,
  faculty_remarks   TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (seat_id)
);

-- ── INDEXES ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role         ON users(role);
CREATE INDEX IF NOT EXISTS idx_questions_paper    ON questions(paper_id);
CREATE INDEX IF NOT EXISTS idx_exam_seats_exam    ON exam_seats(exam_id);
CREATE INDEX IF NOT EXISTS idx_exam_seats_student ON exam_seats(student_id);
CREATE INDEX IF NOT EXISTS idx_exam_seats_room    ON exam_seats(room_id);
CREATE INDEX IF NOT EXISTS idx_answers_seat       ON answers(seat_id);
CREATE INDEX IF NOT EXISTS idx_violations_seat    ON violations(seat_id);
CREATE INDEX IF NOT EXISTS idx_results_student    ON results(student_id);
CREATE INDEX IF NOT EXISTS idx_results_exam       ON results(exam_id);

-- ── DEFAULT ADMIN ───────────────────────────────────────────
-- Password: Admin@123 (bcrypt hash)
INSERT INTO users (name, email, password_hash, role, must_change_password)
VALUES (
  'Super Admin',
  'admin@proctorguard.com',
  '$2b$10$rOzJqVfX1J3j5K2mN8pHQeWvB4YgT6uI9sL7nM0dA3cE5hP2qR8wS',
  'admin',
  false
) ON CONFLICT (email) DO NOTHING;
