const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const multer = require("multer");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const dataDir = path.join(__dirname, "data");
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const db = new Database(path.join(dataDir, "tracker.db"));
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
 password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS subjects (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, description TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'not-started',
 progress INTEGER NOT NULL DEFAULT 0, exam_date TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS syllabus_topics (
 id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
 parent_id INTEGER REFERENCES syllabus_topics(id) ON DELETE CASCADE, name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'not-started', progress INTEGER NOT NULL DEFAULT 0,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS study_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL, minutes INTEGER NOT NULL, note TEXT DEFAULT '', timer_session_id INTEGER,
 logged_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS timer_sessions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL, started_at TEXT DEFAULT CURRENT_TIMESTAMP,
 ended_at TEXT, seconds INTEGER DEFAULT 0, heartbeat_at TEXT
);
CREATE TABLE IF NOT EXISTS groups (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '', owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS group_members (
 group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL DEFAULT 'member', joined_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(group_id,user_id)
);
CREATE TABLE IF NOT EXISTS messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
 body TEXT NOT NULL, file_id INTEGER REFERENCES files(id) ON DELETE SET NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS files (
 id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
 original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT, size INTEGER, folder TEXT DEFAULT 'General', display_name TEXT,
 subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE, topic_id INTEGER REFERENCES syllabus_topics(id) ON DELETE SET NULL,
 caption_stored_name TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tasks (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL,
 due_date TEXT, done INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS goals (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL,
 target TEXT DEFAULT '', done INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS warrants (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, reason TEXT NOT NULL,
 status TEXT DEFAULT 'open', created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
 sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires_at INTEGER NOT NULL
);
`);
try { db.exec("ALTER TABLE messages ADD COLUMN file_id INTEGER REFERENCES files(id) ON DELETE SET NULL"); } catch (err) {
  if (!String(err.message).includes("duplicate column name")) throw err;
}
try { db.exec("ALTER TABLE study_logs ADD COLUMN timer_session_id INTEGER"); } catch (err) {
  if (!String(err.message).includes("duplicate column name")) throw err;
}
// Keep existing installations compatible with invite links added after first launch.
try { db.exec("ALTER TABLE groups ADD COLUMN invite_code TEXT"); } catch (err) {
  if (!String(err.message).includes("duplicate column name")) throw err;
}
for (const column of ["subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE", "topic_id INTEGER REFERENCES syllabus_topics(id) ON DELETE SET NULL"]) {
  try { db.exec(`ALTER TABLE files ADD COLUMN ${column}`); } catch (err) {
    if (!String(err.message).includes("duplicate column name")) throw err;
  }
  try { db.exec("ALTER TABLE files ADD COLUMN caption_stored_name TEXT"); } catch (err) {
    if (!String(err.message).includes("duplicate column name")) throw err;
  }
  try { db.exec("ALTER TABLE files ADD COLUMN display_name TEXT"); } catch (err) {
    if (!String(err.message).includes("duplicate column name")) throw err;
  }
}
db.prepare("UPDATE groups SET invite_code = upper(hex(randomblob(4))) WHERE invite_code IS NULL").run();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
class SqliteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.database = database;
    this.getStatement = database.prepare("SELECT sess FROM sessions WHERE sid=? AND expires_at > ?");
    this.setStatement = database.prepare("INSERT INTO sessions(sid,sess,expires_at) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,expires_at=excluded.expires_at");
    this.destroyStatement = database.prepare("DELETE FROM sessions WHERE sid=?");
    this.touchStatement = database.prepare("UPDATE sessions SET sess=?,expires_at=? WHERE sid=?");
  }
  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid, Date.now());
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (error) { callback(error); }
  }
  set(sid, sess, callback) {
    try {
      const expiresAt = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      this.setStatement.run(sid, JSON.stringify(sess), expiresAt);
      callback?.(null);
    } catch (error) { callback?.(error); }
  }
  destroy(sid, callback) {
    try { this.destroyStatement.run(sid); callback?.(null); }
    catch (error) { callback?.(error); }
  }
  touch(sid, sess, callback) {
    try {
      const expiresAt = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      this.touchStatement.run(JSON.stringify(sess), expiresAt, sid);
      callback?.(null);
    } catch (error) { callback?.(error); }
  }
}
const sessionStore = new SqliteSessionStore(db);
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "exam-prep-development-secret",
  resave: false, saveUninitialized: false,
  store: sessionStore,
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 * 14 }
});
app.use(sessionMiddleware);
app.use("/uploads", express.static(uploadDir));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`)
  })
});
const uploadSingle = (req, res, next) => upload.single("file")(req, res, err => {
  if (err) return res.status(400).json({ error: err.message });
  next();
});
const uploadVideoFields = (req, res, next) => upload.fields([{ name: "file", maxCount: 1 }, { name: "captions", maxCount: 1 }])(req, res, err => {
  if (err) return res.status(400).json({ error: err.message });
  next();
});

const userById = id => db.prepare("SELECT id,name,email,role,created_at FROM users WHERE id=?").get(id);
const auth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: "Sign in required" });
  req.user = userById(req.session.userId);
  if (!req.user) return res.status(401).json({ error: "Session expired" });
  next();
};
const admin = (req, res, next) => req.user?.role === "admin" ? next() : res.status(403).json({ error: "Admin access required" });
const member = (req, res, next) => {
  const row = db.prepare("SELECT role FROM group_members WHERE group_id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!row) return res.status(403).json({ error: "Join this group first" });
  req.groupRole = row.role;
  next();
};
const safeInt = (value, fallback = 0) => Math.max(0, parseInt(value, 10) || fallback);

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 6) return res.status(400).json({ error: "Name, email and a 6+ character password are required" });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare("INSERT INTO users(name,email,password) VALUES(?,?,?)").run(name.trim(), email.trim().toLowerCase(), hash);
    req.session.userId = result.lastInsertRowid;
    res.json({ user: userById(req.session.userId) });
  } catch (err) { res.status(400).json({ error: err.code === "SQLITE_CONSTRAINT_UNIQUE" ? "Email is already registered" : "Unable to register" }); }
});
app.post("/api/auth/login", async (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(String(req.body.email || "").trim().toLowerCase());
  if (!user || !(await bcrypt.compare(req.body.password || "", user.password))) return res.status(401).json({ error: "Invalid email or password" });
  req.session.userId = user.id;
  res.json({ user: userById(user.id) });
});
app.post("/api/auth/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/me", auth, (req, res) => res.json({ user: req.user }));
app.get("/api/socket-token", auth, (req, res) => res.json({ sessionId: req.sessionID }));

app.get("/api/dashboard", auth, (req, res) => {
  const subjects = db.prepare("SELECT * FROM subjects WHERE user_id=? ORDER BY exam_date IS NULL, exam_date").all(req.user.id);
  const totalMinutes = db.prepare("SELECT COALESCE(SUM(minutes),0) total FROM study_logs WHERE user_id=?").get(req.user.id).total;
  const todayMinutes = db.prepare("SELECT COALESCE(SUM(minutes),0) total FROM study_logs WHERE user_id=? AND date(logged_at,'localtime')=date('now','localtime')").get(req.user.id).total;
  const weekMinutes = db.prepare("SELECT COALESCE(SUM(minutes),0) total FROM study_logs WHERE user_id=? AND logged_at >= datetime('now','-7 days')").get(req.user.id).total;
  const activeTimer = db.prepare("SELECT * FROM timer_sessions WHERE user_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1").get(req.user.id);
  res.json({ subjects, totalMinutes, todayMinutes, weekMinutes, activeTimer, user: req.user });
});

app.get("/api/subjects", auth, (req, res) => res.json(db.prepare("SELECT * FROM subjects WHERE user_id=? ORDER BY created_at DESC").all(req.user.id)));
app.post("/api/subjects", auth, (req, res) => {
  const { name, description = "", status = "not-started", exam_date = null } = req.body;
  if (!name) return res.status(400).json({ error: "Subject name is required" });
  const result = db.prepare("INSERT INTO subjects(user_id,name,description,status,progress,exam_date) VALUES(?,?,?,?,?,?)")
    .run(req.user.id, name, description, status, safeInt(req.body.progress), exam_date || null);
  res.json(db.prepare("SELECT * FROM subjects WHERE id=?").get(result.lastInsertRowid));
});
app.put("/api/subjects/:id", auth, (req, res) => {
  const existing = db.prepare("SELECT * FROM subjects WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: "Subject not found" });
  const next = { ...existing, ...req.body };
  db.prepare("UPDATE subjects SET name=?,description=?,status=?,progress=?,exam_date=? WHERE id=? AND user_id=?")
    .run(next.name, next.description || "", next.status || "not-started", Math.min(100, safeInt(next.progress)), next.exam_date || null, existing.id, req.user.id);
  res.json(db.prepare("SELECT * FROM subjects WHERE id=?").get(existing.id));
});
app.delete("/api/subjects/:id", auth, (req, res) => {
  db.prepare("DELETE FROM subjects WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});
app.get("/api/subjects/:id/topics", auth, (req, res) => {
  const subject = db.prepare("SELECT id FROM subjects WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "Subject not found" });
  const topics = db.prepare("SELECT * FROM syllabus_topics WHERE subject_id=? ORDER BY parent_id IS NOT NULL, created_at").all(subject.id);
  const notes = db.prepare("SELECT files.*, syllabus_topics.name topic_name FROM files LEFT JOIN syllabus_topics ON syllabus_topics.id=files.topic_id WHERE files.subject_id=? ORDER BY files.created_at DESC").all(subject.id);
  res.json({ topics, notes });
});
app.post("/api/subjects/:id/topics", auth, (req, res) => {
  const subject = db.prepare("SELECT id FROM subjects WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!subject || !String(req.body.name || "").trim()) return res.status(400).json({ error: "A topic name is required" });
  const parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
  if (parentId && !db.prepare("SELECT id FROM syllabus_topics WHERE id=? AND subject_id=?").get(parentId, subject.id)) return res.status(400).json({ error: "Invalid parent topic" });
  const result = db.prepare("INSERT INTO syllabus_topics(subject_id,parent_id,name,status,progress) VALUES(?,?,?,?,?)")
    .run(subject.id, parentId, String(req.body.name).trim(), req.body.status || "not-started", Math.min(100, safeInt(req.body.progress)));
  res.json(db.prepare("SELECT * FROM syllabus_topics WHERE id=?").get(result.lastInsertRowid));
});
app.patch("/api/subjects/:id/topics/:topicId", auth, (req, res) => {
  const topic = db.prepare("SELECT syllabus_topics.* FROM syllabus_topics JOIN subjects ON subjects.id=syllabus_topics.subject_id WHERE syllabus_topics.id=? AND subjects.id=? AND subjects.user_id=?").get(req.params.topicId, req.params.id, req.user.id);
  if (!topic) return res.status(404).json({ error: "Topic not found" });
  db.prepare("UPDATE syllabus_topics SET name=?,status=?,progress=? WHERE id=?").run(String(req.body.name || topic.name).trim(), req.body.status || topic.status, Math.min(100, safeInt(req.body.progress, topic.progress)), topic.id);
  res.json(db.prepare("SELECT * FROM syllabus_topics WHERE id=?").get(topic.id));
});
app.delete("/api/subjects/:id/topics/:topicId", auth, (req, res) => {
  const result = db.prepare("DELETE FROM syllabus_topics WHERE id=? AND subject_id=? AND EXISTS (SELECT 1 FROM subjects WHERE id=? AND user_id=?)").run(req.params.topicId, req.params.id, req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: "Topic not found" });
  res.json({ ok: true });
});
app.post("/api/subjects/:id/notes", auth, uploadSingle, (req, res) => {
  const subject = db.prepare("SELECT id FROM subjects WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "Subject not found" });
  if (!req.file) return res.status(400).json({ error: "Choose a note file first" });
  const topicId = req.body.topic_id ? Number(req.body.topic_id) : null;
  if (topicId && !db.prepare("SELECT id FROM syllabus_topics WHERE id=? AND subject_id=?").get(topicId, subject.id)) return res.status(400).json({ error: "Invalid topic" });
  const result = db.prepare("INSERT INTO files(user_id,original_name,stored_name,mime,size,folder,subject_id,topic_id) VALUES(?,?,?,?,?,?,?,?)")
    .run(req.user.id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.body.folder || "Notes", subject.id, topicId);
  res.json(db.prepare("SELECT files.*, syllabus_topics.name topic_name FROM files LEFT JOIN syllabus_topics ON syllabus_topics.id=files.topic_id WHERE files.id=?").get(result.lastInsertRowid));
});
app.get("/api/personal-files", auth, (req, res) => res.json(db.prepare(`
  SELECT files.*, subjects.name subject_name, syllabus_topics.name topic_name
  FROM files LEFT JOIN subjects ON subjects.id=files.subject_id
  LEFT JOIN syllabus_topics ON syllabus_topics.id=files.topic_id
  WHERE files.user_id=? AND files.group_id IS NULL ORDER BY files.created_at DESC
`).all(req.user.id)));
app.post("/api/personal-files", auth, uploadVideoFields, (req, res) => {
  const file = req.files?.file?.[0];
  if (!file) return res.status(400).json({ error: "Choose a video or notes file first" });
  const subjectId = req.body.subject_id ? Number(req.body.subject_id) : null;
  const topicId = req.body.topic_id ? Number(req.body.topic_id) : null;
  if (subjectId && !db.prepare("SELECT id FROM subjects WHERE id=? AND user_id=?").get(subjectId, req.user.id)) return res.status(400).json({ error: "Invalid subject" });
  if (topicId && !db.prepare("SELECT id FROM syllabus_topics WHERE id=? AND subject_id=?").get(topicId, subjectId)) return res.status(400).json({ error: "Topic must belong to the selected subject" });
  const caption = req.files?.captions?.[0];
  if (caption && caption.mimetype !== "text/vtt" && !caption.originalname.toLowerCase().endsWith(".vtt")) return res.status(400).json({ error: "Captions must be a .vtt file" });
  const displayName = String(req.body.display_name || file.originalname).trim().slice(0, 240) || file.originalname;
  const result = db.prepare("INSERT INTO files(user_id,original_name,stored_name,mime,size,folder,subject_id,topic_id,caption_stored_name,display_name) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(req.user.id, file.originalname, file.filename, file.mimetype, file.size, "Personal", subjectId, topicId, caption?.filename || null, displayName);
  res.json(db.prepare("SELECT files.*, subjects.name subject_name, syllabus_topics.name topic_name FROM files LEFT JOIN subjects ON subjects.id=files.subject_id LEFT JOIN syllabus_topics ON syllabus_topics.id=files.topic_id WHERE files.id=?").get(result.lastInsertRowid));
});
app.patch("/api/personal-files/:id", auth, (req, res) => {
  const file = db.prepare("SELECT * FROM files WHERE id=? AND user_id=? AND group_id IS NULL").get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: "Personal file not found" });
  const subjectId = req.body.subject_id ? Number(req.body.subject_id) : null;
  const topicId = req.body.topic_id ? Number(req.body.topic_id) : null;
  if (subjectId && !db.prepare("SELECT id FROM subjects WHERE id=? AND user_id=?").get(subjectId, req.user.id)) return res.status(400).json({ error: "Invalid subject" });
  if (topicId && !db.prepare("SELECT id FROM syllabus_topics WHERE id=? AND subject_id=?").get(topicId, subjectId)) return res.status(400).json({ error: "Topic must belong to the selected subject" });
  const displayName = String(req.body.display_name || file.display_name || file.original_name).trim().slice(0, 240) || file.original_name;
  db.prepare("UPDATE files SET display_name=?,subject_id=?,topic_id=? WHERE id=?").run(displayName, subjectId, topicId, file.id);
  res.json(db.prepare("SELECT files.*, subjects.name subject_name, syllabus_topics.name topic_name FROM files LEFT JOIN subjects ON subjects.id=files.subject_id LEFT JOIN syllabus_topics ON syllabus_topics.id=files.topic_id WHERE files.id=?").get(file.id));
});

app.get("/api/study-logs", auth, (req, res) => res.json(db.prepare(`
  SELECT study_logs.*, subjects.name subject_name FROM study_logs LEFT JOIN subjects ON subjects.id=study_logs.subject_id
  WHERE study_logs.user_id=? ORDER BY logged_at DESC LIMIT 100`).all(req.user.id)));
app.post("/api/study-logs", auth, (req, res) => {
  const minutes = safeInt(req.body.minutes);
  if (!minutes) return res.status(400).json({ error: "Minutes must be greater than zero" });
  const subject = req.body.subject_id ? db.prepare("SELECT id FROM subjects WHERE id=? AND user_id=?").get(req.body.subject_id, req.user.id) : null;
  const result = db.prepare("INSERT INTO study_logs(user_id,subject_id,minutes,note) VALUES(?,?,?,?)").run(req.user.id, subject?.id || null, minutes, req.body.note || "");
  res.json(db.prepare("SELECT * FROM study_logs WHERE id=?").get(result.lastInsertRowid));
});
app.delete("/api/study-logs/:id", auth, (req, res) => { db.prepare("DELETE FROM study_logs WHERE id=? AND user_id=?").run(req.params.id, req.user.id); res.json({ ok: true }); });
app.get("/api/tasks", auth, (req, res) => res.json(db.prepare("SELECT * FROM tasks WHERE user_id=? ORDER BY done,due_date IS NULL,due_date,created_at DESC").all(req.user.id)));
app.post("/api/tasks", auth, (req, res) => {
  const title = String(req.body.title || "").trim();
  if (!title) return res.status(400).json({ error: "Task title is required" });
  const result = db.prepare("INSERT INTO tasks(user_id,title,due_date) VALUES(?,?,?)").run(req.user.id, title, req.body.due_date || null);
  res.json(db.prepare("SELECT * FROM tasks WHERE id=?").get(result.lastInsertRowid));
});
app.patch("/api/tasks/:id", auth, (req, res) => {
  const task = db.prepare("SELECT id FROM tasks WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  db.prepare("UPDATE tasks SET done=? WHERE id=?").run(req.body.done ? 1 : 0, task.id);
  res.json({ ok: true });
});
app.delete("/api/tasks/:id", auth, (req, res) => {
  const result = db.prepare("DELETE FROM tasks WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: "Task not found" });
  res.json({ ok: true });
});

app.post("/api/timer/start", auth, (req, res) => {
  db.prepare("UPDATE timer_sessions SET ended_at=datetime('now') WHERE user_id=? AND ended_at IS NULL").run(req.user.id);
  const subject = req.body.subject_id ? db.prepare("SELECT id FROM subjects WHERE id=? AND user_id=?").get(req.body.subject_id, req.user.id) : null;
  const result = db.prepare("INSERT INTO timer_sessions(user_id,subject_id,heartbeat_at) VALUES(?,?,datetime('now'))").run(req.user.id, subject?.id || null);
  res.json(db.prepare("SELECT * FROM timer_sessions WHERE id=?").get(result.lastInsertRowid));
});
function timerSeconds(timer, requestedSeconds) {
  const requested = Math.max(0, safeInt(requestedSeconds));
  const started = Date.parse(`${timer.started_at.replace(" ", "T")}Z`);
  const elapsed = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : requested;
  return Math.max(timer.seconds || 0, requested, elapsed);
}
function finalizeTimer(timer, seconds, note) {
  const endedAt = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  db.prepare("UPDATE timer_sessions SET seconds=?,ended_at=?,heartbeat_at=? WHERE id=? AND ended_at IS NULL").run(seconds, endedAt, endedAt, timer.id);
  if (seconds >= 60 && !db.prepare("SELECT id FROM study_logs WHERE timer_session_id=?").get(timer.id)) {
    db.prepare("INSERT INTO study_logs(user_id,subject_id,minutes,note,timer_session_id,logged_at) VALUES(?,?,?,?,?,?)")
      .run(timer.user_id, timer.subject_id, Math.round(seconds / 60), note, timer.id, timer.started_at);
  }
}
app.post("/api/timer/heartbeat", auth, (req, res) => {
  const timer = db.prepare("SELECT * FROM timer_sessions WHERE id=? AND user_id=? AND ended_at IS NULL").get(req.body.id, req.user.id);
  if (!timer) return res.status(404).json({ error: "Timer not found" });
  const seconds = timerSeconds(timer, req.body.seconds);
  db.prepare("UPDATE timer_sessions SET seconds=?,heartbeat_at=datetime('now') WHERE id=?").run(seconds, timer.id);
  res.json({ ok: true, seconds });
});
app.post("/api/timer/stop", auth, (req, res) => {
  const timer = db.prepare("SELECT * FROM timer_sessions WHERE id=? AND user_id=? AND ended_at IS NULL").get(req.body.id, req.user.id);
  if (!timer) return res.status(404).json({ error: "Timer not found" });
  finalizeTimer(timer, timerSeconds(timer, req.body.seconds), "Focus timer");
  res.json({ ok: true });
});
app.post("/api/timer/close", auth, (req, res) => {
  const timer = db.prepare("SELECT * FROM timer_sessions WHERE id=? AND user_id=? AND ended_at IS NULL").get(req.body.id, req.user.id);
  if (!timer) return res.status(404).json({ error: "Timer not found" });
  finalizeTimer(timer, timerSeconds(timer, req.body.seconds), "Session timer");
  res.json({ ok: true });
});
app.get("/api/analytics", auth, (req, res) => {
  const today = db.prepare("SELECT COALESCE(SUM(minutes),0) minutes FROM study_logs WHERE user_id=? AND date(logged_at,'localtime')=date('now','localtime')").get(req.user.id).minutes;
  const weekDaily = db.prepare(`SELECT date(logged_at,'localtime') day, SUM(minutes) minutes FROM study_logs WHERE user_id=? AND date(logged_at,'localtime') >= date('now','localtime','-6 days') GROUP BY day ORDER BY day`).all(req.user.id);
  const monthDaily = db.prepare(`SELECT date(logged_at,'localtime') day, SUM(minutes) minutes FROM study_logs WHERE user_id=? AND strftime('%Y-%m',logged_at,'localtime')=strftime('%Y-%m','now','localtime') GROUP BY day ORDER BY day`).all(req.user.id);
  const yearMonthly = db.prepare(`SELECT strftime('%Y-%m',logged_at,'localtime') month, SUM(minutes) minutes FROM study_logs WHERE user_id=? AND strftime('%Y',logged_at,'localtime')=strftime('%Y','now','localtime') GROUP BY month ORDER BY month`).all(req.user.id);
  const allTime = db.prepare("SELECT COALESCE(SUM(minutes),0) minutes FROM study_logs WHERE user_id=?").get(req.user.id).minutes;
  const bySubject = db.prepare(`SELECT COALESCE(subjects.name,'Unassigned') name,SUM(study_logs.minutes) minutes FROM study_logs LEFT JOIN subjects ON subjects.id=study_logs.subject_id WHERE study_logs.user_id=? GROUP BY subject_id ORDER BY minutes DESC`).all(req.user.id);
  res.json({ today, weekDaily, monthDaily, yearMonthly, allTime, bySubject });
});

app.get("/api/groups", auth, (req, res) => res.json(db.prepare(`
  SELECT g.*, u.name owner_name, (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id) member_count,
  EXISTS(SELECT 1 FROM group_members m2 WHERE m2.group_id=g.id AND m2.user_id=?) joined
  FROM groups g JOIN users u ON u.id=g.owner_id ORDER BY g.created_at DESC`).all(req.user.id)));
app.post("/api/groups", auth, (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: "Group name is required" });
  const tx = db.transaction(() => {
    const inviteCode = require("crypto").randomBytes(4).toString("hex").toUpperCase();
    const g = db.prepare("INSERT INTO groups(name,description,owner_id,invite_code) VALUES(?,?,?,?)").run(req.body.name, req.body.description || "", req.user.id, inviteCode);
    db.prepare("INSERT INTO group_members(group_id,user_id,role) VALUES(?,?, 'admin')").run(g.lastInsertRowid, req.user.id);
    return g.lastInsertRowid;
  });
  res.json(db.prepare("SELECT * FROM groups WHERE id=?").get(tx()));
});
app.post("/api/groups/join-by-code", auth, (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  const group = db.prepare("SELECT id FROM groups WHERE invite_code=?").get(code);
  if (!group) return res.status(404).json({ error: "Invite code not found" });
  try {
    db.prepare("INSERT INTO group_members(group_id,user_id) VALUES(?,?)").run(group.id, req.user.id);
  } catch (err) {
    if (err.code !== "SQLITE_CONSTRAINT_PRIMARYKEY") throw err;
  }
  res.json({ groupId: group.id });
});
app.post("/api/groups/:id/join", auth, (req, res) => {
  try { db.prepare("INSERT INTO group_members(group_id,user_id) VALUES(?,?)").run(req.params.id, req.user.id); res.json({ ok: true }); }
  catch (_e) { res.status(400).json({ error: "Already a member or group does not exist" }); }
});
app.post("/api/groups/:id/leave", auth, (req, res) => { db.prepare("DELETE FROM group_members WHERE group_id=? AND user_id=?").run(req.params.id, req.user.id); res.json({ ok: true }); });
app.delete("/api/groups/:id", auth, (req, res) => {
  const group = db.prepare("SELECT id,owner_id FROM groups WHERE id=?").get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  if (group.owner_id !== req.user.id) return res.status(403).json({ error: "Only the group owner can delete it" });
  const storedFiles = db.prepare("SELECT stored_name FROM files WHERE group_id=?").all(group.id);
  db.prepare("DELETE FROM groups WHERE id=?").run(group.id);
  storedFiles.forEach(file => fs.rm(path.join(uploadDir, file.stored_name), () => {}));
  res.json({ ok: true });
});
app.get("/api/groups/:id", auth, member, (req, res) => {
  const group = db.prepare("SELECT g.*,u.name owner_name FROM groups g JOIN users u ON u.id=g.owner_id WHERE g.id=?").get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const members = db.prepare("SELECT u.id,u.name,u.email,m.role,m.joined_at FROM group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=? ORDER BY m.role DESC,u.name").all(req.params.id);
  const messages = db.prepare("SELECT messages.*,users.name,files.original_name file_name,files.stored_name file_stored_name,files.mime file_mime,files.size file_size FROM messages JOIN users ON users.id=messages.user_id LEFT JOIN files ON files.id=messages.file_id WHERE messages.group_id=? ORDER BY messages.id DESC LIMIT 100").all(req.params.id).reverse();
  const files = db.prepare("SELECT files.*,users.name uploader FROM files JOIN users ON users.id=files.user_id WHERE group_id=? ORDER BY files.created_at DESC").all(req.params.id);
  res.json({ group, members, messages, files, role: req.groupRole });
});
app.delete("/api/groups/:id/members/:userId", auth, member, (req, res) => {
  if (req.groupRole !== "admin") return res.status(403).json({ error: "Group admin required" });
  db.prepare("DELETE FROM group_members WHERE group_id=? AND user_id=?").run(req.params.id, req.params.userId); res.json({ ok: true });
});
app.post("/api/groups/:id/files", auth, member, uploadSingle, (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a file" });
  const result = db.prepare("INSERT INTO files(group_id,user_id,original_name,stored_name,mime,size,folder) VALUES(?,?,?,?,?,?,?)")
    .run(req.params.id, req.user.id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.body.folder || "General");
  res.json(db.prepare("SELECT * FROM files WHERE id=?").get(result.lastInsertRowid));
});
app.post("/api/groups/:id/messages", auth, member, uploadSingle, (req, res) => {
  const body = String(req.body.body || "").trim().slice(0, 2000);
  if (!body && !req.file) return res.status(400).json({ error: "Write a message or attach a file" });
  let fileId = null;
  if (req.file) {
    fileId = db.prepare("INSERT INTO files(group_id,user_id,original_name,stored_name,mime,size,folder) VALUES(?,?,?,?,?,?,?)")
      .run(req.params.id, req.user.id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.body.folder || "Chat").lastInsertRowid;
  }
  const result = db.prepare("INSERT INTO messages(group_id,user_id,body,file_id) VALUES(?,?,?,?)").run(req.params.id, req.user.id, body, fileId);
  const message = db.prepare("SELECT messages.*,users.name,files.original_name file_name,files.stored_name file_stored_name,files.mime file_mime,files.size file_size FROM messages JOIN users ON users.id=messages.user_id LEFT JOIN files ON files.id=messages.file_id WHERE messages.id=?").get(result.lastInsertRowid);
  io.to(`group:${req.params.id}`).emit("chat:message", message);
  res.json(message);
});
app.delete("/api/groups/:id/files/:fileId", auth, member, (req, res) => {
  const file = db.prepare("SELECT * FROM files WHERE id=? AND group_id=?").get(req.params.fileId, req.params.id);
  if (!file || (file.user_id !== req.user.id && req.groupRole !== "admin")) return res.status(403).json({ error: "Not allowed" });
  fs.rm(path.join(uploadDir, file.stored_name), () => {});
  db.prepare("DELETE FROM files WHERE id=?").run(file.id); res.json({ ok: true });
});

app.get("/api/admin", auth, admin, (req, res) => res.json({
  users: db.prepare("SELECT id,name,email,role,created_at FROM users ORDER BY created_at DESC").all(),
  tasks: db.prepare("SELECT tasks.*,users.name user_name FROM tasks LEFT JOIN users ON users.id=tasks.user_id ORDER BY done,due_date").all(),
  goals: db.prepare("SELECT goals.*,users.name user_name FROM goals LEFT JOIN users ON users.id=goals.user_id ORDER BY done,created_at DESC").all(),
  warrants: db.prepare("SELECT warrants.*,users.name user_name FROM warrants JOIN users ON users.id=warrants.user_id ORDER BY status,created_at DESC").all()
}));
app.post("/api/admin/tasks", auth, admin, (req, res) => { const r = db.prepare("INSERT INTO tasks(user_id,title,due_date) VALUES(?,?,?)").run(req.body.user_id || null, req.body.title, req.body.due_date || null); res.json({ id: r.lastInsertRowid }); });
app.patch("/api/admin/tasks/:id", auth, admin, (req, res) => { db.prepare("UPDATE tasks SET done=? WHERE id=?").run(req.body.done ? 1 : 0, req.params.id); res.json({ ok: true }); });
app.post("/api/admin/goals", auth, admin, (req, res) => { const r = db.prepare("INSERT INTO goals(user_id,title,target) VALUES(?,?,?)").run(req.body.user_id || null, req.body.title, req.body.target || ""); res.json({ id: r.lastInsertRowid }); });
app.patch("/api/admin/goals/:id", auth, admin, (req, res) => { db.prepare("UPDATE goals SET done=? WHERE id=?").run(req.body.done ? 1 : 0, req.params.id); res.json({ ok: true }); });
app.post("/api/admin/warrants", auth, admin, (req, res) => { const r = db.prepare("INSERT INTO warrants(user_id,reason) VALUES(?,?)").run(req.body.user_id, req.body.reason); res.json({ id: r.lastInsertRowid }); });
app.patch("/api/admin/warrants/:id", auth, admin, (req, res) => { db.prepare("UPDATE warrants SET status=? WHERE id=?").run(req.body.status || "resolved", req.params.id); res.json({ ok: true }); });
app.patch("/api/admin/users/:id", auth, admin, (req, res) => { db.prepare("UPDATE users SET role=? WHERE id=?").run(req.body.role === "admin" ? "admin" : "student", req.params.id); res.json({ ok: true }); });

io.use((socket, next) => {
  const sid = socket.handshake.auth?.sessionId;
  if (!sid) return next(new Error("Authentication required"));
  sessionStore.get(sid, (err, sess) => {
    if (err || !sess?.userId || !userById(sess.userId)) return next(new Error("Authentication required"));
    socket.user = userById(sess.userId); next();
  });
});

io.on("connection", socket => {
  const joined = new Set();
  socket.on("group:join", groupId => {
    const isMember = db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").get(groupId, socket.user.id);
    if (!isMember) return;
    socket.join(`group:${groupId}`);
    joined.add(String(groupId));
    socket.to(`group:${groupId}`).emit("presence", { user: socket.user, online: true });
  });
  socket.on("group:leave", groupId => { socket.leave(`group:${groupId}`); joined.delete(String(groupId)); });
  socket.on("typing", ({ groupId, typing }) => {
    if (joined.has(String(groupId))) socket.to(`group:${groupId}`).emit("typing", { user: socket.user.name, typing: !!typing });
  });
  socket.on("chat:message", ({ groupId, body }, acknowledge) => {
    const reply = typeof acknowledge === "function" ? acknowledge : () => {};
    if (!joined.has(String(groupId))) return reply("Join the group chat before sending messages");
    if (!String(body || "").trim()) return reply("Message cannot be empty");
    const result = db.prepare("INSERT INTO messages(group_id,user_id,body) VALUES(?,?,?)").run(groupId, socket.user.id, String(body).trim().slice(0, 2000));
    const message = db.prepare("SELECT messages.*,users.name FROM messages JOIN users ON users.id=messages.user_id WHERE messages.id=?").get(result.lastInsertRowid);
    io.to(`group:${groupId}`).emit("chat:message", message);
    reply();
  });
  socket.on("disconnect", () => joined.forEach(groupId => socket.to(`group:${groupId}`).emit("presence", { user: socket.user, online: false })));
});

app.get("*", (req, res, next) => req.path.startsWith("/api/") ? res.status(404).json({ error: "Not found" }) : res.sendFile(path.join(__dirname, "public", "index.html"), next));
server.listen(PORT, () => console.log(`Exam Prep Tracker running at http://localhost:${PORT}`));
