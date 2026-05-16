// server.js — ProctorGuard v2 Complete Backend
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const cors     = require('cors');
const path     = require('path');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const { Pool } = require('pg');
const multer   = require('multer');
const XLSX     = require('xlsx');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// ── DB ──────────────────────────────────────────────────────


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SECRET = process.env.JWT_SECRET || 'proctorguard-secret-2024';
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── AUTH MIDDLEWARE ─────────────────────────────────────────
function auth(roles = []) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const user = jwt.verify(token, SECRET);
      // Support both single role (legacy) and roles array (multi-role)
      const userRoles = user.roles || (user.role ? [user.role] : []);
      if (roles.length && !roles.some(r => userRoles.includes(r)))
        return res.status(403).json({ error: 'Forbidden' });
      req.user = { ...user, roles: userRoles };
      next();
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  };
}

// ── PAGE ROUTES ─────────────────────────────────────────────
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/login',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/student',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
app.get('/proctor',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'proctor.html')));
app.get('/faculty',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'faculty.html')));
app.get('/moderator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'moderator.html')));
app.get('/admin',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/portal',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'portal.html')));

// ══════════════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════════════

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = true', [email.toLowerCase()]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    // Build roles array — use roles column if set, else fall back to single role
    const userRoles = (user.roles && user.roles.length > 0)
      ? user.roles
      : (user.role ? [user.role] : []);

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: userRoles[0], roles: userRoles },
      SECRET, { expiresIn: '8h' }
    );
    res.json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email,
        role: userRoles[0], roles: userRoles,
        must_change_password: user.must_change_password
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', auth(), async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (current_password) {
      const valid = await bcrypt.compare(current_password, user.password_hash);
      if (!valid) return res.status(400).json({ error: 'Current password incorrect' });
    }
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [hash, req.user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/me
app.get('/api/auth/me', auth(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, role, roll_number, department, must_change_password FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// ADMIN — BULK UPLOAD
// ══════════════════════════════════════════════════════════════

// POST /api/admin/bulk-upload
app.post('/api/admin/bulk-upload', auth(['admin']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const results = { students: [], faculty: [], moderators: [], proctors: [], errors: [] };

    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', range: 3 });
      const role = sheetName.toLowerCase().replace(/s$/, ''); // students→student etc

      if (!['student','faculty','moderator','proctor'].includes(role)) continue;

      for (const row of rows) {
        const name  = String(row['name'] || row['Name'] || '').trim();
        const email = String(row['email'] || row['Email'] || '').trim().toLowerCase();
        const pass  = String(row['password'] || row['Password'] || 'Welcome@123').trim();
        const roll  = String(row['roll_number'] || row['Roll Number'] || '').trim();
        const dept  = String(row['department'] || row['Department'] || '').trim();
        const subjectCodes = String(row['subject_codes'] || row['Subject Codes'] || '').trim();

        if (!name || !email) {
          results.errors.push(`${sheetName}: Missing name or email in row`);
          continue;
        }

        try {
          const hash = await bcrypt.hash(pass, 10);
          const { rows: inserted } = await pool.query(
            `INSERT INTO users (name, email, password_hash, role, roles, roll_number, department, must_change_password)
             VALUES ($1, $2, $3, $4, $5, $6, $7, false)
             ON CONFLICT (email) DO UPDATE SET
               name=$1,
               role=$4,
               roles=(SELECT ARRAY(SELECT DISTINCT unnest FROM unnest(users.roles || $5))),
               must_change_password=false
             RETURNING id, name, email, role`,
            [name, email, hash, role, [role], roll || null, dept || null]
          );
          const userId = inserted[0].id;

          // Link subjects — always use faculty_subjects table for all roles
          if (subjectCodes) {
            const codes = subjectCodes.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
            for (const code of codes) {
              const { rows: subj } = await pool.query('SELECT id FROM subjects WHERE code = $1', [code]);
              if (subj[0]) {
                await pool.query(
                  `INSERT INTO faculty_subjects (faculty_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                  [userId, subj[0].id]
                );
              } else {
                results.errors.push(`Subject code not found: ${code} (for ${email})`);
              }
            }
          }
          results[sheetName.toLowerCase()].push(inserted[0]);
        } catch (err) {
          results.errors.push(`${sheetName} — ${email}: ${err.message}`);
        }
      }
    }

    res.json({
      success: true,
      summary: {
        students:   results.students.length,
        faculty:    results.faculty.length,
        moderators: results.moderators.length,
        proctors:   results.proctors.length,
        errors:     results.errors.length
      },
      errors: results.errors
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── USERS (admin) ───────────────────────────────────────────
app.get('/api/users', auth(['admin']), async (req, res) => {
  const { role, subject_id } = req.query;
  try {
    let q, params = [];
    if (subject_id) {
      // Filter students by subject assignment
      q = `SELECT u.id, u.name, u.email, u.role, u.roll_number, u.department, u.is_active
           FROM users u
           JOIN faculty_subjects fs ON fs.faculty_id = u.id
           WHERE fs.subject_id = $1`;
      params.push(subject_id);
      if (role) { q += ' AND u.role = $2'; params.push(role); }
      q += ' ORDER BY u.name';
    } else {
      q = 'SELECT id, name, email, role, roll_number, department, is_active, created_at FROM users';
      if (role) { q += ' WHERE role = $1'; params.push(role); }
      q += ' ORDER BY name';
    }
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', auth(['admin']), async (req, res) => {
  const { name, email, password, role, roll_number, department } = req.body;
  if (!name || !email || !role) return res.status(400).json({ error: 'name, email, role required' });
  try {
    const hash = await bcrypt.hash(password || 'Welcome@123', 10);
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash, role, roll_number, department) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email, role',
      [name, email.toLowerCase(), hash, role, roll_number || null, department || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/users/:id', auth(['admin']), async (req, res) => {
  const { name, email, role, is_active, department, roll_number } = req.body;
  try {
    const { rows } = await pool.query(
      'UPDATE users SET name=COALESCE($1,name), email=COALESCE($2,email), role=COALESCE($3,role), is_active=COALESCE($4,is_active), department=COALESCE($5,department), roll_number=COALESCE($6,roll_number) WHERE id=$7 RETURNING id,name,email,role,is_active',
      [name, email, role, is_active, department, roll_number, req.params.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', auth(['admin']), async (req, res) => {
  const { id } = req.params;
  try {
    // Prevent deleting yourself
    if (parseInt(id) === req.user.id)
      return res.status(400).json({ error: 'Cannot delete your own account' });
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SUBJECTS ────────────────────────────────────────────────
app.get('/api/subjects', auth(), async (req, res) => {
  try {
    const userRoles = req.user.roles || [req.user.role];
    const isAdmin = userRoles.includes('admin');

    // Only admin gets all subjects
    if (isAdmin) {
      const { rows } = await pool.query('SELECT * FROM subjects ORDER BY code');
      return res.json(rows);
    }

    // Everyone else — only their assigned subjects via faculty_subjects
    const { rows } = await pool.query(
      `SELECT DISTINCT s.*
       FROM subjects s
       JOIN faculty_subjects fs ON fs.subject_id = s.id
       WHERE fs.faculty_id = $1
       ORDER BY s.code`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/subjects', auth(['admin']), async (req, res) => {
  const { code, name, department } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'code and name required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO subjects (code, name, department) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name=$2 RETURNING *',
      [code.toUpperCase(), name, department || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/subjects/:id', auth(['admin']), async (req, res) => {
  try {
    await pool.query('DELETE FROM subjects WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/subjects/bulk', auth(['admin']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames.find(n => n.toLowerCase() === 'subjects') || wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', range: 1 });
    const created = [], updated = [], errors = [];
    for (const row of rows) {
      const code = String(row['code'] || '').trim().toUpperCase();
      const name = String(row['name'] || '').trim();
      const dept = String(row['department'] || '').trim() || null;
      if (!code || !name) { errors.push(`Missing code or name in row`); continue; }
      try {
        const { rows: r } = await pool.query(
          `INSERT INTO subjects (code, name, department) VALUES ($1,$2,$3)
           ON CONFLICT (code) DO UPDATE SET name=$2, department=$3
           RETURNING *, (xmax=0) AS is_new`,
          [code, name, dept]
        );
        r[0].is_new ? created.push(r[0]) : updated.push(r[0]);
      } catch (err) { errors.push(`${code}: ${err.message}`); }
    }
    res.json({ success: true, summary: { created: created.length, updated: updated.length, errors: errors.length }, created, updated, errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// QUESTION PAPERS (Faculty)
// ══════════════════════════════════════════════════════════════

// GET /api/papers — faculty sees their own, moderator sees submitted
app.get('/api/papers', auth(['faculty','moderator','admin']), async (req, res) => {
  try {
    const userRoles = req.user.roles || [req.user.role];
    const asRole = req.query.role; // optional ?role=faculty or ?role=moderator
    const effectiveRole = (asRole && userRoles.includes(asRole)) ? asRole
      : userRoles.includes('admin') ? 'admin'
      : userRoles[0];

    let q, params = [];
    if (effectiveRole === 'faculty') {
      q = `SELECT qp.*, s.name as subject_name, s.code as subject_code
           FROM question_papers qp JOIN subjects s ON s.id = qp.subject_id
           WHERE qp.faculty_id = $1 ORDER BY qp.created_at DESC`;
      params = [req.user.id];
    } else if (effectiveRole === 'moderator') {
      q = `SELECT qp.*, s.name as subject_name, s.code as subject_code,
           u.name as faculty_name
           FROM question_papers qp JOIN subjects s ON s.id = qp.subject_id
           JOIN users u ON u.id = qp.faculty_id
           WHERE qp.status IN ('submitted','under_review','approved','rejected')
           ORDER BY qp.created_at DESC`;
      params = [];
    } else {
      q = `SELECT qp.*, s.name as subject_name, s.code as subject_code,
           u.name as faculty_name
           FROM question_papers qp JOIN subjects s ON s.id = qp.subject_id
           JOIN users u ON u.id = qp.faculty_id ORDER BY qp.created_at DESC`;
    }
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/papers
app.post('/api/papers', auth(['faculty','moderator','proctor']), async (req, res) => {
  const { subject_id, title, total_marks, duration_mins, instructions } = req.body;
  if (!subject_id || !title) return res.status(400).json({ error: 'subject_id and title required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO question_papers (subject_id, faculty_id, title, total_marks, duration_mins, instructions) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [subject_id, req.user.id, title, total_marks || 100, duration_mins || 90, instructions || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/papers/:id — save draft updates
app.patch('/api/papers/:id', auth(['faculty','moderator','proctor','admin']), async (req, res) => {
  const { title, total_marks, duration_mins, instructions } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE question_papers
       SET title = COALESCE($1, title),
           total_marks = COALESCE($2, total_marks),
           duration_mins = COALESCE($3, duration_mins),
           instructions = COALESCE($4, instructions)
       WHERE id = $5
       RETURNING *`,
      [title || null, total_marks || null, duration_mins || null, instructions || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Paper not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/papers/:id — with questions
app.get('/api/papers/:id', auth(), async (req, res) => {
  try {
    const { rows: papers } = await pool.query(
      `SELECT qp.*, s.name as subject_name, s.code as subject_code,
       u.name as faculty_name
       FROM question_papers qp
       JOIN subjects s ON s.id = qp.subject_id
       JOIN users u ON u.id = qp.faculty_id
       WHERE qp.id = $1`, [req.params.id]
    );
    if (!papers[0]) return res.status(404).json({ error: 'Paper not found' });
    const { rows: questions } = await pool.query(
      'SELECT * FROM questions WHERE paper_id = $1 ORDER BY order_index', [req.params.id]
    );
    res.json({ ...papers[0], questions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/papers/:id/submit — faculty submits for moderation
app.patch('/api/papers/:id/submit', auth(['faculty','moderator','proctor']), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE question_papers SET status='submitted', submitted_at=NOW()
       WHERE id=$1 AND faculty_id=$2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Paper not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/papers/:id/moderate — moderator approves/rejects
app.patch('/api/papers/:id/moderate', auth(['moderator','admin']), async (req, res) => {
  const { action, note } = req.body; // action: 'approve' | 'reject'
  if (!['approve','reject'].includes(action))
    return res.status(400).json({ error: 'action must be approve or reject' });
  try {
    const status = action === 'approve' ? 'approved' : 'rejected';
    const { rows } = await pool.query(
      `UPDATE question_papers
       SET status=$1, moderator_id=$2, rejection_note=$3,
       approved_at = CASE WHEN $1='approved' THEN NOW() ELSE NULL END
       WHERE id=$4 RETURNING *`,
      [status, req.user.id, note || null, req.params.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// QUESTIONS (Faculty + Moderator)
// ══════════════════════════════════════════════════════════════

// POST /api/questions
app.post('/api/questions', auth(['faculty','moderator','proctor']), async (req, res) => {
  const { paper_id, type, question_text, marks, option_a, option_b, option_c, option_d, correct_option, explanation } = req.body;
  if (!paper_id || !type || !question_text || !marks)
    return res.status(400).json({ error: 'paper_id, type, question_text, marks required' });
  if (type === 'mcq' && (!option_a || !option_b || !correct_option))
    return res.status(400).json({ error: 'MCQ needs option_a, option_b and correct_option' });
  try {
    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM questions WHERE paper_id=$1', [paper_id]);
    const order_index = parseInt(countRows[0].count);
    const { rows } = await pool.query(
      `INSERT INTO questions (paper_id, order_index, type, question_text, marks,
       option_a, option_b, option_c, option_d, correct_option, explanation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [paper_id, order_index, type, question_text, marks,
       option_a||null, option_b||null, option_c||null, option_d||null,
       correct_option||null, explanation||null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/questions/:id
app.put('/api/questions/:id', auth(['faculty','moderator']), async (req, res) => {
  const { question_text, marks, option_a, option_b, option_c, option_d, correct_option, explanation, mod_status, mod_comment } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE questions SET
       question_text=COALESCE($1,question_text),
       marks=COALESCE($2,marks),
       option_a=COALESCE($3,option_a), option_b=COALESCE($4,option_b),
       option_c=COALESCE($5,option_c), option_d=COALESCE($6,option_d),
       correct_option=COALESCE($7,correct_option),
       explanation=COALESCE($8,explanation),
       mod_status=COALESCE($9,mod_status),
       mod_comment=COALESCE($10,mod_comment)
       WHERE id=$11 RETURNING *`,
      [question_text, marks, option_a, option_b, option_c, option_d,
       correct_option, explanation, mod_status, mod_comment, req.params.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/questions/:id
app.delete('/api/questions/:id', auth(['faculty','moderator','proctor']), async (req, res) => {
  try {
    await pool.query('DELETE FROM questions WHERE id=$1', [req.params.id]);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// EXAMS (Admin)
// ══════════════════════════════════════════════════════════════

app.get('/api/exams', auth(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*, s.name as subject_name, s.code as subject_code,
       qp.title as paper_title, qp.duration_mins,
       COUNT(DISTINCT er.id) as room_count,
       COUNT(DISTINCT es.id) as student_count
       FROM exams e
       JOIN subjects s ON s.id = e.subject_id
       JOIN question_papers qp ON qp.id = e.paper_id
       LEFT JOIN exam_rooms er ON er.exam_id = e.id
       LEFT JOIN exam_seats es ON es.exam_id = e.id
       GROUP BY e.id, s.name, s.code, qp.title, qp.duration_mins
       ORDER BY e.scheduled_at DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/exams', auth(['admin']), async (req, res) => {
  const { subject_id, paper_id, title, scheduled_at, ends_at } = req.body;
  if (!subject_id || !paper_id || !title || !scheduled_at || !ends_at)
    return res.status(400).json({ error: 'All fields required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO exams (subject_id, paper_id, title, scheduled_at, ends_at, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [subject_id, paper_id, title, scheduled_at, ends_at, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/exams/bulk — bulk create exams from Excel
app.post('/api/exams/bulk', auth(['admin']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames.find(n => n.toLowerCase() === 'exams') || wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', range: 1 });

    const created_exams = [], errors = [];
    let skipped = 0;

    for (const row of rows) {
      const title        = String(row['title']        || '').trim();
      const subjectCode  = String(row['subject_code'] || '').trim().toUpperCase();
      const paperTitle   = String(row['paper_title']  || '').trim();
      const scheduledStr = String(row['scheduled_at'] || '').trim();
      const endsStr      = String(row['ends_at']      || '').trim();

      if (!title || !subjectCode || !paperTitle || !scheduledStr || !endsStr) {
        errors.push(`Missing required fields in row: ${title || '(no title)'}`);
        continue;
      }

      // Parse DD/MM/YYYY HH:MM
      const parseDate = (str) => {
        const [datePart, timePart] = str.split(' ');
        if (!datePart) return null;
        const [dd, mm, yyyy] = datePart.split('/');
        const [hh, min] = (timePart || '00:00').split(':');
        const d = new Date(yyyy, mm - 1, dd, hh || 0, min || 0);
        return isNaN(d.getTime()) ? null : d;
      };

      const scheduled_at = parseDate(scheduledStr);
      const ends_at      = parseDate(endsStr);

      if (!scheduled_at) { errors.push(`Invalid scheduled_at date for "${title}": ${scheduledStr}`); continue; }
      if (!ends_at)       { errors.push(`Invalid ends_at date for "${title}": ${endsStr}`); continue; }
      if (ends_at <= scheduled_at) { errors.push(`ends_at must be after scheduled_at for "${title}"`); continue; }

      // Look up subject
      const { rows: subRows } = await pool.query('SELECT id FROM subjects WHERE code=$1', [subjectCode]);
      if (!subRows[0]) { errors.push(`Subject not found: ${subjectCode}`); continue; }

      // Look up approved paper
      const { rows: paperRows } = await pool.query(
        `SELECT id FROM question_papers WHERE title ILIKE $1 AND subject_id=$2 AND status='approved' LIMIT 1`,
        [paperTitle, subRows[0].id]
      );
      if (!paperRows[0]) {
        errors.push(`No approved paper found: "${paperTitle}" for ${subjectCode}`);
        continue;
      }

      // Check for duplicate
      const { rows: dupRows } = await pool.query(
        'SELECT id FROM exams WHERE title=$1 AND subject_id=$2 AND scheduled_at=$3',
        [title, subRows[0].id, scheduled_at]
      );
      if (dupRows[0]) { skipped++; continue; }

      try {
        const { rows: examRows } = await pool.query(
          'INSERT INTO exams (subject_id, paper_id, title, scheduled_at, ends_at, created_by, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [subRows[0].id, paperRows[0].id, title, scheduled_at, ends_at, req.user.id, 'scheduled']
        );
        created_exams.push({ ...examRows[0], subject_code: subjectCode });
      } catch(e) {
        errors.push(`Failed to create "${title}": ${e.message}`);
      }
    }

    res.json({
      success: true,
      summary: { created: created_exams.length, skipped, errors: errors.length },
      created_exams,
      errors,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/exams/:id — full detail with rooms + seats
app.get('/api/exams/:id', auth(), async (req, res) => {
  try {
    const { rows: exams } = await pool.query(
      `SELECT e.*, s.name as subject_name, qp.title as paper_title, qp.duration_mins
       FROM exams e JOIN subjects s ON s.id=e.subject_id JOIN question_papers qp ON qp.id=e.paper_id
       WHERE e.id=$1`, [req.params.id]
    );
    if (!exams[0]) return res.status(404).json({ error: 'Exam not found' });
    const { rows: rooms } = await pool.query(
      `SELECT er.*, u.name as proctor_name,
       COUNT(es.id) as seat_count
       FROM exam_rooms er LEFT JOIN users u ON u.id=er.proctor_id
       LEFT JOIN exam_seats es ON es.room_id=er.id
       WHERE er.exam_id=$1 GROUP BY er.id, u.name ORDER BY er.name`, [req.params.id]
    );
    res.json({ ...exams[0], rooms });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/exams/:id
app.delete('/api/exams/:id', auth(['admin']), async (req, res) => {
  const { id } = req.params;
  try {
    // Cascade: delete answers → seats → rooms → exam
    await pool.query(`DELETE FROM answers WHERE seat_id IN (SELECT id FROM exam_seats WHERE exam_id=$1)`, [id]);
    await pool.query(`DELETE FROM violations WHERE exam_id=$1`, [id]);
    await pool.query(`DELETE FROM results WHERE exam_id=$1`, [id]);
    await pool.query(`DELETE FROM exam_seats WHERE exam_id=$1`, [id]);
    await pool.query(`DELETE FROM exam_rooms WHERE exam_id=$1`, [id]);
    await pool.query(`DELETE FROM exams WHERE id=$1`, [id]);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/exams/:id/rooms
app.post('/api/exams/:id/rooms', auth(['admin']), async (req, res) => {
  const { name, proctor_id, capacity } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO exam_rooms (exam_id, name, proctor_id, capacity) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.id, name, proctor_id || null, capacity || 30]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/exams/rooms/:id — delete a room and its seats
app.delete('/api/exams/rooms/:id', auth(['admin']), async (req, res) => {
  try {
    await pool.query('DELETE FROM answers WHERE seat_id IN (SELECT id FROM exam_seats WHERE room_id=$1)', [req.params.id]);
    await pool.query('DELETE FROM violations WHERE seat_id IN (SELECT id FROM exam_seats WHERE room_id=$1)', [req.params.id]);
    await pool.query('DELETE FROM exam_seats WHERE room_id=$1', [req.params.id]);
    await pool.query('DELETE FROM exam_rooms WHERE id=$1', [req.params.id]);
    res.json({ deleted: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/exams/:id/seats — get seats for an exam, optionally filtered by room
app.get('/api/exams/:id/seats', auth(['admin']), async (req, res) => {
  try {
    const { room_id } = req.query;
    const q = room_id
      ? `SELECT es.*, u.name as student_name, u.roll_number FROM exam_seats es JOIN users u ON u.id=es.student_id WHERE es.exam_id=$1 AND es.room_id=$2 ORDER BY u.name`
      : `SELECT es.*, u.name as student_name, u.roll_number FROM exam_seats es JOIN users u ON u.id=es.student_id WHERE es.exam_id=$1 ORDER BY u.name`;
    const params = room_id ? [req.params.id, room_id] : [req.params.id];
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/exams/:id/seats — bulk assign students to rooms
app.post('/api/exams/:id/seats', auth(['admin']), async (req, res) => {
  const assignments = req.body; // [{ student_id, room_id }]
  if (!Array.isArray(assignments)) return res.status(400).json({ error: 'Array required' });
  try {
    let count = 0;
    for (const { student_id, room_id } of assignments) {
      await pool.query(
        `INSERT INTO exam_seats (exam_id, room_id, student_id)
         VALUES ($1,$2,$3) ON CONFLICT (exam_id, student_id) DO UPDATE SET room_id=$2`,
        [req.params.id, room_id, student_id]
      );
      count++;
    }
    res.json({ assigned: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// STUDENT EXAM SESSION
// ══════════════════════════════════════════════════════════════

// GET /api/student/exams — all exams for logged in student
app.get('/api/student/exams', auth(['student']), async (req, res) => {
  try {
    // Auto-update exam statuses based on current time
    await pool.query(`
      UPDATE exams SET status='live'
      WHERE status='scheduled' AND scheduled_at <= NOW() AND ends_at >= NOW()`);
    await pool.query(`
      UPDATE exams SET status='completed'
      WHERE status IN ('scheduled','live') AND ends_at < NOW()`);

    const { rows } = await pool.query(
      `SELECT e.id as exam_id, e.title, e.scheduled_at, e.ends_at, e.status as exam_status,
       qp.duration_mins, qp.id as paper_id,
       s.name as subject_name, s.code as subject_code,
       es.id as seat_id, es.status as seat_status, es.room_id,
       er.name as room_name,
       (SELECT COUNT(*) FROM questions WHERE paper_id = qp.id) as question_count
       FROM exam_seats es
       JOIN exams e ON e.id = es.exam_id
       JOIN question_papers qp ON qp.id = e.paper_id
       JOIN subjects s ON s.id = e.subject_id
       LEFT JOIN exam_rooms er ON er.id = es.room_id
       WHERE es.student_id = $1
       ORDER BY e.scheduled_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/student/results — results for logged in student
app.get('/api/student/results', auth(['student']), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, e.title as exam_title, s.name as subject_name, s.code as subject_code
       FROM results r
       JOIN exams e ON e.id = r.exam_id
       JOIN subjects s ON s.id = r.subject_id
       WHERE r.student_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/student/essay-upload — upload scanned answer sheet
app.post('/api/student/essay-upload', auth(['student']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { seat_id } = req.body;
  try {
    // Store file info — in production you'd upload to S3/Supabase Storage
    // For now store the filename and mark essay as submitted
    await pool.query(
      `UPDATE exam_seats SET essay_file = $1, essay_uploaded_at = NOW() WHERE id = $2 AND student_id = $3`,
      [req.file.originalname, seat_id, req.user.id]
    );
    res.json({ uploaded: true, filename: req.file.originalname });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/student/exam — get active exam for logged in student
app.get('/api/student/exam', auth(['student']), async (req, res) => {
  try {
    const now = new Date();

    // Auto-activate exams that have reached their scheduled time
    await pool.query(
      `UPDATE exams SET status='live'
       WHERE status='scheduled' AND scheduled_at <= $1 AND ends_at >= $1`, [now]
    );

    const { rows } = await pool.query(
      `SELECT e.id as exam_id, e.title, e.scheduled_at, e.ends_at,
       qp.duration_mins, qp.total_marks, qp.instructions, qp.id as paper_id,
       s.name as subject_name, s.code as subject_code,
       es.id as seat_id, es.room_id, es.status as seat_status
       FROM exam_seats es
       JOIN exams e ON e.id = es.exam_id
       JOIN question_papers qp ON qp.id = e.paper_id
       JOIN subjects s ON s.id = e.subject_id
       WHERE es.student_id = $1
       AND e.scheduled_at <= $2 AND e.ends_at >= $2
       AND (es.status IS NULL OR es.status NOT IN ('submitted'))
       LIMIT 1`,
      [req.user.id, now]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No active exam found for you right now' });

    // Get questions — hide correct answers from student
    const { rows: questions } = await pool.query(
      `SELECT id, type, question_text, marks,
       option_a, option_b, option_c, option_d
       FROM questions WHERE paper_id=$1
       ORDER BY id`,
      [rows[0].paper_id]
    );

    // Mark seat as started
    await pool.query(
      `UPDATE exam_seats SET status='in_progress', started_at=COALESCE(started_at,NOW()) WHERE id=$1`,
      [rows[0].seat_id]
    );

    res.json({ ...rows[0], questions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/student/answer — save answer
app.post('/api/student/answer', auth(['student']), async (req, res) => {
  const { seat_id, question_id, answer_text, answer_option } = req.body;
  try {
    // Get question details — correct answer + marks + type
    const { rows: qRows } = await pool.query(
      'SELECT correct_option, marks, type FROM questions WHERE id=$1',
      [question_id]
    );
    if (!qRows[0]) return res.status(404).json({ error: 'Question not found' });
    const question = qRows[0];

    // For MCQ — check correctness and assign marks immediately
    let is_correct = null;
    let marks_scored = 0;
    if (answer_option && question.type === 'mcq') {
      is_correct = question.correct_option === answer_option;
      marks_scored = is_correct ? parseFloat(question.marks) : 0;
    }

    await pool.query(
      `INSERT INTO answers (seat_id, question_id, answer_text, answer_option, is_correct, marks_scored)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (seat_id, question_id) DO UPDATE
       SET answer_text=$3, answer_option=$4, is_correct=$5, marks_scored=$6`,
      [seat_id, question_id, answer_text||null, answer_option||null, is_correct, marks_scored]
    );
    res.json({ saved: true, is_correct, marks_scored });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/student/submit
app.post('/api/student/submit', auth(['student']), async (req, res) => {
  const { seat_id } = req.body;
  try {
    // Get seat info
    const { rows: seats } = await pool.query(
      `SELECT es.*, e.paper_id, e.id as exam_id, e.subject_id
       FROM exam_seats es JOIN exams e ON e.id=es.exam_id
       WHERE es.id=$1 AND es.student_id=$2`,
      [seat_id, req.user.id]
    );
    if (!seats[0]) return res.status(404).json({ error: 'Seat not found' });
    const seat = seats[0];

    // Get paper total marks
    const { rows: papers } = await pool.query('SELECT total_marks FROM question_papers WHERE id=$1', [seat.paper_id]);
    const maxMarks = papers[0]?.total_marks || 100;

    // Auto-grade MCQs — use pre-stored marks_scored from answers table
    const { rows: mcqAnswers } = await pool.query(
      `SELECT a.marks_scored FROM answers a
       JOIN questions q ON q.id = a.question_id
       WHERE a.seat_id=$1 AND q.type='mcq'`, [seat_id]
    );
    const mcqMarks = mcqAnswers.reduce((sum, a) => sum + (parseFloat(a.marks_scored) || 0), 0);

    // Get violation count
    const { rows: viol } = await pool.query('SELECT COUNT(*) FROM violations WHERE seat_id=$1', [seat_id]);
    const violCount = parseInt(viol[0].count);

    // Mark submitted
    await pool.query('UPDATE exam_seats SET status=$1, submitted_at=NOW() WHERE id=$2', ['submitted', seat_id]);

    // Save result
    const pct = maxMarks > 0 ? (mcqMarks / maxMarks * 100) : 0;
    const grade = pct >= 90 ? 'A+' : pct >= 80 ? 'A' : pct >= 70 ? 'B' : pct >= 60 ? 'C' : pct >= 50 ? 'D' : 'F';
    await pool.query(
      `INSERT INTO results (seat_id, exam_id, student_id, subject_id, mcq_marks, total_marks, max_marks, percentage, grade, violation_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (seat_id) DO UPDATE SET mcq_marks=$5, total_marks=$6, percentage=$8, grade=$9`,
      [seat_id, seat.exam_id, req.user.id, seat.subject_id, mcqMarks, mcqMarks, maxMarks, pct.toFixed(2), grade, violCount]
    );

    res.json({ submitted: true, mcq_marks: mcqMarks, grade });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// VIOLATIONS
// ══════════════════════════════════════════════════════════════

app.post('/api/violations', auth(['student']), async (req, res) => {
  const { seat_id, type, severity } = req.body;
  try {
    await pool.query('INSERT INTO violations (seat_id, type, severity) VALUES ($1,$2,$3)', [seat_id, type, severity || 'med']);
    res.json({ logged: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// PROCTOR ROUTES
// ══════════════════════════════════════════════════════════════

// GET /api/proctor/rooms — rooms assigned to this proctor
app.get('/api/proctor/rooms', auth(['proctor','admin']), async (req, res) => {
  try {
    const userRoles = req.user.roles || [req.user.role];
    const isAdmin = userRoles.includes('admin');
    const q = isAdmin
      ? `SELECT er.*, e.title as exam_title, e.scheduled_at, e.ends_at, e.status as exam_status,
           u.name as proctor_name,
           COUNT(es.id) as seat_count
         FROM exam_rooms er
         JOIN exams e ON e.id = er.exam_id
         LEFT JOIN users u ON u.id = er.proctor_id
         LEFT JOIN exam_seats es ON es.room_id = er.id
         GROUP BY er.id, e.title, e.scheduled_at, e.ends_at, e.status, u.name
         ORDER BY e.scheduled_at DESC`
      : `SELECT er.*, e.title as exam_title, e.scheduled_at, e.ends_at, e.status as exam_status,
           COUNT(es.id) as seat_count
         FROM exam_rooms er
         JOIN exams e ON e.id = er.exam_id
         LEFT JOIN exam_seats es ON es.room_id = er.id
         WHERE er.proctor_id = $1
         GROUP BY er.id, e.title, e.scheduled_at, e.ends_at, e.status
         ORDER BY e.scheduled_at DESC`;
    const params = isAdmin ? [] : [req.user.id];
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/proctor/rooms/:id/seats — all students in a room with status
app.get('/api/proctor/rooms/:id/seats', auth(['proctor','admin']), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT es.*, u.name as student_name, u.roll_number, u.email as student_email
       FROM exam_seats es
       JOIN users u ON u.id = es.student_id
       WHERE es.room_id = $1
       ORDER BY u.name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/proctor/rooms/:id/violations — all violations in a room
app.get('/api/proctor/rooms/:id/violations', auth(['proctor','admin']), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.*, u.name as student_name, u.roll_number, es.id as seat_id
       FROM violations v
       JOIN exam_seats es ON es.id = v.seat_id
       JOIN users u ON u.id = es.student_id
       WHERE es.room_id = $1
       ORDER BY v.created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/proctor/violations — log a violation
app.post('/api/proctor/violations', auth(['proctor','admin']), async (req, res) => {
  const { seat_id, type, description, snapshot_url } = req.body;
  if (!seat_id || !type) return res.status(400).json({ error: 'seat_id and type required' });
  try {
    // Get seat info for context
    const { rows: seatRows } = await pool.query(
      'SELECT exam_id, room_id, student_id FROM exam_seats WHERE id=$1', [seat_id]
    );
    if (!seatRows[0]) return res.status(404).json({ error: 'Seat not found' });
    const seat = seatRows[0];

    const { rows } = await pool.query(
      `INSERT INTO violations (seat_id, student_id, exam_id, room_id, proctor_id, type, description, snapshot_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [seat_id, seat.student_id, seat.exam_id, seat.room_id, req.user.id, type, description||null, snapshot_url||null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/proctor/force-submit — force submit a student's exam
app.post('/api/proctor/force-submit', auth(['proctor','admin']), async (req, res) => {
  const { seat_id } = req.body;
  if (!seat_id) return res.status(400).json({ error: 'seat_id required' });
  try {
    // Check seat exists and is not already submitted
    const { rows: seatRows } = await pool.query(
      'SELECT * FROM exam_seats WHERE id=$1', [seat_id]
    );
    if (!seatRows[0]) return res.status(404).json({ error: 'Seat not found' });
    if (seatRows[0].submitted_at) return res.status(400).json({ error: 'Already submitted' });

    // Mark as submitted
    await pool.query(
      `UPDATE exam_seats SET status='submitted', submitted_at=NOW() WHERE id=$1`,
      [seat_id]
    );

    // Calculate MCQ marks
    const { rows: answers } = await pool.query(
      `SELECT a.marks_scored FROM answers a
       JOIN questions q ON q.id = a.question_id
       WHERE a.seat_id=$1 AND q.type='mcq'`, [seat_id]
    );
    const mcqMarks = answers.reduce((s,a) => s + (parseFloat(a.marks_scored)||0), 0);

    // Get max marks
    const { rows: paperRows } = await pool.query(
      `SELECT qp.total_marks, e.subject_id FROM exam_seats es
       JOIN exams e ON e.id = es.exam_id
       JOIN question_papers qp ON qp.id = e.paper_id
       WHERE es.id = $1`, [seat_id]
    );
    const maxMarks = parseFloat(paperRows[0]?.total_marks || 100);
    const pct = (mcqMarks / maxMarks) * 100;
    const grade = pct >= 90 ? 'O' : pct >= 75 ? 'A+' : pct >= 60 ? 'A' : pct >= 50 ? 'B' : pct >= 40 ? 'C' : 'F';

    // Upsert result
    await pool.query(
      `INSERT INTO results (seat_id, exam_id, student_id, subject_id, mcq_marks, total_marks, max_marks, percentage, grade)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (seat_id) DO UPDATE SET mcq_marks=$5, total_marks=$6, percentage=$8, grade=$9`,
      [seat_id, seatRows[0].exam_id, seatRows[0].student_id, paperRows[0]?.subject_id, mcqMarks, mcqMarks, maxMarks, pct.toFixed(2), grade]
    );

    res.json({ submitted: true, forced_by: req.user.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// RESULTS (Faculty grading essays)
// ══════════════════════════════════════════════════════════════

app.get('/api/results', auth(['admin','faculty']), async (req, res) => {
  const { exam_id } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT r.*, u.name as student_name, u.roll_number,
       e.title as exam_title, s.name as subject_name
       FROM results r
       JOIN users u ON u.id=r.student_id
       JOIN exams e ON e.id=r.exam_id
       JOIN subjects s ON s.id=r.subject_id
       WHERE ($1::int IS NULL OR r.exam_id=$1)
       ORDER BY u.name`,
      [exam_id || null]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/answers/:id/grade — faculty grades essay
app.patch('/api/answers/:id/grade', auth(['faculty','admin']), async (req, res) => {
  const { marks_awarded, faculty_note } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE answers SET marks_awarded=$1, faculty_note=$2, graded_by=$3, graded_at=NOW()
       WHERE id=$4 RETURNING *`,
      [marks_awarded, faculty_note || null, req.user.id, req.params.id]
    );
    // Recalculate total
    const answer = rows[0];
    const { rows: allAnswers } = await pool.query(
      `SELECT a.marks_awarded, a.is_correct, q.marks, q.type
       FROM answers a JOIN questions q ON q.id=a.question_id
       WHERE a.seat_id=$1`, [answer.seat_id]
    );
    const mcq   = allAnswers.filter(a => a.type==='mcq').reduce((s,a) => s+(a.is_correct ? parseFloat(a.marks) : 0), 0);
    const essay = allAnswers.filter(a => a.type==='essay').reduce((s,a) => s+(parseFloat(a.marks_awarded)||0), 0);
    await pool.query(
      'UPDATE results SET essay_marks=$1, total_marks=$2 WHERE seat_id=$3',
      [essay, mcq+essay, answer.seat_id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// SOCKET.IO — LIVE PROCTORING
// ══════════════════════════════════════════════════════════════

const sessions = new Map();

io.on('connection', (socket) => {
  socket.on('student:join', ({ studentId, examId, roomId, name, roll }) => {
    sessions.set(studentId, { socketId: socket.id, examId, roomId, name, roll, progress: 0, violations: 0, status: 'active' });
    socket.join(`room:${roomId}`);
    io.to(`proctor:${roomId}`).emit('student:online', { studentId, name, roll, progress: 0, violations: 0, status: 'active' });
  });

  socket.on('proctor:join', ({ proctorId, roomId }) => {
    socket.join(`proctor:${roomId}`);
    const roomStudents = [];
    sessions.forEach((data, studentId) => {
      if (data.roomId === roomId) roomStudents.push({ studentId, ...data });
    });
    socket.emit('sessions:snapshot', roomStudents);
  });

  socket.on('violation:report', ({ studentId, roomId, type, severity, studentName }) => {
    if (sessions.has(studentId)) {
      sessions.get(studentId).violations++;
      if (sessions.get(studentId).violations >= 5) sessions.get(studentId).status = 'flagged';
      else if (sessions.get(studentId).violations >= 2) sessions.get(studentId).status = 'warn';
    }
    io.to(`proctor:${roomId}`).emit('violation:new', {
      studentId, studentName, type, severity,
      totalViolations: sessions.get(studentId)?.violations || 0,
      studentStatus: sessions.get(studentId)?.status || 'active'
    });
  });

  socket.on('progress:update', ({ studentId, roomId, progress }) => {
    if (sessions.has(studentId)) sessions.get(studentId).progress = progress;
    io.to(`proctor:${roomId}`).emit('student:progress', { studentId, progress });
  });

  socket.on('exam:submit', ({ studentId, roomId }) => {
    if (sessions.has(studentId)) sessions.get(studentId).status = 'submitted';
    io.to(`proctor:${roomId}`).emit('student:submitted', { studentId });
  });

  socket.on('proctor:warn', ({ studentId, message }) => {
    const session = sessions.get(studentId);
    if (session) io.to(session.socketId).emit('warning:received', { message });
  });

  socket.on('proctor:terminate', ({ studentId, roomId }) => {
    const session = sessions.get(studentId);
    if (session) {
      session.status = 'terminated';
      io.to(session.socketId).emit('exam:terminated', {});
      io.to(`proctor:${roomId}`).emit('student:terminated', { studentId });
    }
  });

  // WebRTC
  socket.on('webrtc:request', ({ studentId }) => {
    const session = sessions.get(studentId);
    if (session) io.to(session.socketId).emit('webrtc:request', { proctorSocketId: socket.id });
  });
  socket.on('webrtc:offer', ({ proctorSocketId, offer, studentId }) => {
    io.to(proctorSocketId).emit('webrtc:offer', { offer, studentId, studentSocketId: socket.id });
  });
  socket.on('webrtc:answer', ({ studentSocketId, answer }) => {
    io.to(studentSocketId).emit('webrtc:answer', { answer });
  });
  socket.on('webrtc:ice', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('webrtc:ice', { candidate, fromSocketId: socket.id });
  });

  socket.on('disconnect', () => {
    sessions.forEach((data, studentId) => {
      if (data.socketId === socket.id) {
        data.status = 'offline';
        io.to(`proctor:${data.roomId}`).emit('student:offline', { studentId });
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎓 ProctorGuard v2 running on port ${PORT}`);
  console.log(`   Login:    http://localhost:${PORT}/login`);
  console.log(`   Admin:    http://localhost:${PORT}/admin`);
  console.log(`   Faculty:  http://localhost:${PORT}/faculty`);
  console.log(`   Proctor:  http://localhost:${PORT}/proctor`);
  console.log(`   Student:  http://localhost:${PORT}/student\n`);
});
