const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env.local") });
const http = require("http");
const express = require("express");
const multer = require("multer");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");
const {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// ── Supabase ──────────────────────────────────────────────────────────────────
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasSupabaseConfig = Boolean(supabaseUrl && serviceKey);
if (!hasSupabaseConfig) console.error("Missing Supabase server configuration. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
const supabase = createClient(supabaseUrl || "https://missing-project.supabase.co", serviceKey || "missing-supabase-key", { auth: { persistSession: false, autoRefreshToken: false } });
const userClient = token => createClient(supabaseUrl || "https://missing-project.supabase.co", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "missing-anon-key", { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });

// ── Cloudflare R2 — free tier: 10 GB storage, zero egress fees ────────────────
// Setup guide (5 min):
//   1. cloudflare.com → R2 Object Storage → Create bucket
//   2. Bucket Settings → Public Access → "Allow Access" → copy the r2.dev URL
//   3. R2 → API Tokens → Create token with "Edit" permission → copy keys
//   4. Bucket Settings → CORS → add: AllowedOrigins=*, Methods=GET,PUT, ExposeHeaders=ETag
//   5. Add these to .env.local / Render env vars:
//      R2_ACCOUNT_ID   R2_ACCESS_KEY_ID   R2_SECRET_ACCESS_KEY   R2_BUCKET   R2_PUBLIC_URL
//      (R2_PUBLIC_URL looks like https://pub-abc123def456.r2.dev)
const r2AccountId = process.env.R2_ACCOUNT_ID;
const r2 = r2AccountId
  ? new S3Client({
      region: "auto",
      endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
      },
    })
  : null;
const r2Bucket = process.env.R2_BUCKET || "exam-prep-files";
const r2PubUrl = (process.env.R2_PUBLIC_URL || "").replace(/\/$/, "");
const hasR2 = Boolean(r2 && r2PubUrl);
if (hasR2) console.log(`✓ Cloudflare R2 enabled — bucket: ${r2Bucket} — public: ${r2PubUrl}`);
else console.warn("R2 not configured — uploads fall back to Supabase Storage (1 GB free limit). Add R2_* env vars to unlock GB-scale uploads.");

// ── Express setup ─────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const personalBucket = process.env.SUPABASE_PERSONAL_BUCKET || "personal-files";
const groupBucket = process.env.SUPABASE_GROUP_BUCKET || "group-files";
const fallbackBucket = process.env.SUPABASE_STORAGE_BUCKET || "uploads";
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024, files: 50 } });

// Wrap every route handler with asyncRoute automatically
for (const method of ["get", "post", "put", "patch", "delete"]) {
  const register = app[method].bind(app);
  app[method] = (route, ...handlers) => register(route, ...handlers.map(h => (h.length < 4 ? asyncRoute(h) : h)));
}

// ── DB helpers ────────────────────────────────────────────────────────────────
const q = table => supabase.from(table);
async function select(table, opts = {}) {
  let query = q(table).select(opts.columns || "*");
  for (const [col, val] of Object.entries(opts.eq || {})) query = query.eq(col, val);
  if (opts.is) for (const [col, val] of Object.entries(opts.is)) query = query.is(col, val);
  if (opts.order) query = query.order(opts.order.column, { ascending: opts.order.ascending !== false });
  if (opts.limit) query = query.limit(opts.limit);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}
async function one(table, opts = {}) { const rows = await select(table, { ...opts, limit: 1 }); return rows[0] || null; }
async function insert(table, values, single = true) { const { data, error } = await q(table).insert(values).select(); if (error) throw error; return single ? data?.[0] : data; }
async function update(table, values, eq) { const { data, error } = await q(table).update(values).match(eq).select(); if (error) throw error; return data?.[0] || null; }
async function remove(table, eq) { const { error } = await q(table).delete().match(eq); if (error) throw error; }

// ── Auth helpers ──────────────────────────────────────────────────────────────
async function profile(authUser) {
  let u = authUser.email ? await one("users", { eq: { email: authUser.email } }) : null;
  if (!u) {
    const values = { id: authUser.id, name: authUser.user_metadata?.name || authUser.email?.split("@")[0] || "Student", email: authUser.email, role: "student" };
    try { u = await insert("users", values); } catch (error) {
      const msg = String(error.message || error).toLowerCase();
      if (msg.includes("column") && msg.includes("id")) delete values.id;
      else if (!msg.includes("password")) throw error;
      try { u = await insert("users", values); } catch (e2) {
        if (!String(e2.message || e2).toLowerCase().includes("password")) throw e2;
        u = await insert("users", { ...values, password: "" });
      }
    }
  }
  return { id: u.id, name: u.name, email: u.email, role: u.role || "student", created_at: u.created_at };
}
async function auth(req, res, next) {
  if (!hasSupabaseConfig) return res.status(503).json({ error: "Server Supabase configuration is missing. Add SUPABASE_SERVICE_ROLE_KEY in Render." });
  const token = req.headers.authorization?.startsWith("Bearer ") && req.headers.authorization.slice(7);
  if (!token) return res.status(401).json({ error: "Bearer token required" });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Session expired" });
  try { req.user = await profile(data.user); req.userSupabase = userClient(token); next(); } catch (e) { res.status(500).json({ error: e.message }); }
}
const admin = (req, res, next) => req.user.role === "admin" ? next() : res.status(403).json({ error: "Admin access required" });
async function member(req, res, next) {
  const m = await one("group_members", { eq: { group_id: req.params.id, user_id: req.user.id } });
  if (!m) return res.status(403).json({ error: "Join this group first" });
  req.groupRole = m.role; next();
}

// ── Storage helpers (R2 + Supabase fallback) ──────────────────────────────────
function fileUrl(file) {
  if (!file) return null;
  const filePath = file.storage_path || file.stored_name;
  if (file.storage_bucket === "r2" && hasR2) return `${r2PubUrl}/${filePath}`;
  const bucket = file.storage_bucket || fallbackBucket;
  return supabase.storage.from(bucket).getPublicUrl(filePath).data.publicUrl;
}
async function removeStorageFile(file) {
  if (!file?.storage_bucket) return;
  const key = file.storage_path || file.stored_name;
  if (!key) return;
  if (file.storage_bucket === "r2" && r2) {
    try { await r2.send(new DeleteObjectCommand({ Bucket: r2Bucket, Key: key })); } catch (e) { console.error("R2 delete error:", e.message); }
    return;
  }
  const { error } = await supabase.storage.from(file.storage_bucket).remove([key]);
  if (error) console.error("Supabase storage delete error:", error.message);
}
async function storageUpload(bucket, objectPath, file) {
  let result = await supabase.storage.from(bucket).upload(objectPath, file.buffer, { contentType: file.mimetype || "application/octet-stream", upsert: false });
  if (result.error && bucket !== fallbackBucket) {
    objectPath = `${bucket}/${objectPath}`;
    result = await supabase.storage.from(fallbackBucket).upload(objectPath, file.buffer, { contentType: file.mimetype || "application/octet-stream", upsert: false });
    bucket = fallbackBucket;
  }
  if (result.error) throw result.error;
  return { bucket, path: objectPath };
}
async function parseUpload(req, res, next) {
  upload.any()(req, res, async e => {
    if (e) return res.status(400).json({ error: e.message });
    if ((req.files || []).length > 50) return res.status(400).json({ error: "You can upload up to 50 files at a time" });
    try {
      const isGroup = req.params.id && req.path.includes("/groups/");
      const bucket = isGroup ? groupBucket : personalBucket;
      const owner = isGroup ? `groups/${req.params.id}` : `users/${req.user.id}`;
      await Promise.all((req.files || []).map(async (f, index) => {
        const stored = await storageUpload(bucket, `${owner}/${Date.now()}-${index}-${Math.random().toString(36).slice(2)}${path.extname(f.originalname)}`, f);
        f.storage_bucket = stored.bucket; f.storage_path = stored.path; f.filename = stored.path;
      }));
      next();
    } catch (err) { res.status(502).json({ error: `Storage upload failed: ${err.message}` }); }
  });
}
const fileRecord = (f, extra = {}) => ({ ...extra, original_name: f.originalname, stored_name: f.storage_path, storage_path: f.storage_path, storage_bucket: f.storage_bucket, mime: f.mimetype, size: f.size });

// ── Health + config ───────────────────────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  if (!hasSupabaseConfig) return res.status(503).json({ ok: false, error: "Supabase server configuration is missing" });
  const { error } = await q("users").select("id").limit(1);
  if (error) return res.status(503).json({ ok: false, error: "Database is unavailable" });
  res.json({ ok: true });
});
app.get("/api/config", (req, res) => {
  const configuredRedirect = process.env.NEXT_PUBLIC_SUPABASE_REDIRECT_URL;
  const redirectUrl = configuredRedirect && !/localhost|127\.0\.0\.1/.test(configuredRedirect)
    ? configuredRedirect
    : `${req.protocol}://${req.get("host")}/`;
  res.json({
    supabaseUrl,
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    redirectUrl,
    hasR2,
    maxFileSizeMb: hasR2 ? 5000 : 250,
  });
});

// ── R2 presigned upload endpoints ─────────────────────────────────────────────
// Browser uploads DIRECTLY to R2 — no file data passes through this server.
// Flow: browser → POST /api/upload/... (get presigned URL) → PUT directly to R2 → POST metadata to record in DB
app.post("/api/upload/presign", auth, async (req, res) => {
  if (!hasR2) return res.status(503).json({ error: "R2 not configured. Add R2_* env vars. See README for setup guide." });
  const { key, contentType } = req.body;
  if (!key || !contentType) return res.status(400).json({ error: "key and contentType are required" });
  const cmd = new PutObjectCommand({ Bucket: r2Bucket, Key: key, ContentType: contentType });
  const url = await getSignedUrl(r2, cmd, { expiresIn: 3600 });
  res.json({ url, key });
});
app.post("/api/upload/multipart/init", auth, async (req, res) => {
  if (!hasR2) return res.status(503).json({ error: "R2 not configured" });
  const { key, contentType } = req.body;
  if (!key || !contentType) return res.status(400).json({ error: "key and contentType are required" });
  const result = await r2.send(new CreateMultipartUploadCommand({ Bucket: r2Bucket, Key: key, ContentType: contentType }));
  res.json({ uploadId: result.UploadId, key });
});
app.post("/api/upload/multipart/part", auth, async (req, res) => {
  if (!hasR2) return res.status(503).json({ error: "R2 not configured" });
  const { uploadId, key, partNumber } = req.body;
  if (!uploadId || !key || !partNumber) return res.status(400).json({ error: "uploadId, key, partNumber are required" });
  const cmd = new UploadPartCommand({ Bucket: r2Bucket, Key: key, UploadId: uploadId, PartNumber: Number(partNumber) });
  const url = await getSignedUrl(r2, cmd, { expiresIn: 3600 });
  res.json({ url });
});
app.post("/api/upload/multipart/complete", auth, async (req, res) => {
  if (!hasR2) return res.status(503).json({ error: "R2 not configured" });
  const { uploadId, key, parts } = req.body;
  if (!uploadId || !key || !Array.isArray(parts) || !parts.length) return res.status(400).json({ error: "uploadId, key, and parts[] are required" });
  await r2.send(new CompleteMultipartUploadCommand({
    Bucket: r2Bucket, Key: key, UploadId: uploadId,
    MultipartUpload: { Parts: parts.map(p => ({ PartNumber: Number(p.partNumber), ETag: p.etag })) },
  }));
  res.json({ ok: true, key, url: `${r2PubUrl}/${key}` });
});
app.delete("/api/upload/multipart", auth, async (req, res) => {
  if (!hasR2) return res.status(503).json({ error: "R2 not configured" });
  const { uploadId, key } = req.body;
  if (!uploadId || !key) return res.status(400).json({ error: "uploadId and key are required" });
  try { await r2.send(new AbortMultipartUploadCommand({ Bucket: r2Bucket, Key: key, UploadId: uploadId })); } catch (_) { /* already aborted */ }
  res.json({ ok: true });
});

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 6) return res.status(400).json({ error: "Name, email and a 6+ character password are required" });
  const { data, error } = await supabase.auth.admin.createUser({ email: email.toLowerCase(), password, email_confirm: true, user_metadata: { name } });
  if (error) return res.status(400).json({ error: error.message });
  const login = await supabase.auth.signInWithPassword({ email, password });
  if (login.error) return res.status(400).json({ error: login.error.message });
  res.json({ user: await profile(data.user), token: login.data.session.access_token });
});
app.post("/api/auth/login", async (req, res) => {
  const { data, error } = await supabase.auth.signInWithPassword({ email: String(req.body.email || "").toLowerCase(), password: req.body.password || "" });
  if (error || !data.user) return res.status(401).json({ error: error?.message || "Invalid email or password" });
  res.json({ user: await profile(data.user), token: data.session.access_token });
});
app.post("/api/auth/logout", (_req, res) => res.json({ ok: true }));
app.get("/api/me", auth, (req, res) => res.json({ user: req.user }));
app.get("/api/socket-token", auth, (req, res) => res.json({ token: req.headers.authorization.slice(7) }));

// ── Dashboard (includes stale-timer reaper) ───────────────────────────────────
// Fix: weekMinutes was previously using all-time totals. Now correctly filters last 7 days.
// Fix: stale sessions (tab crash, no beforeunload) are auto-closed if heartbeat > 2 min old.
app.get("/api/dashboard", auth, async (req, res) => {
  // Reap stale open sessions — heartbeat older than 2× the 15-second heartbeat interval
  try {
    const staleRows = await q("timer_sessions")
      .select("*")
      .eq("user_id", req.user.id)
      .is("ended_at", null)
      .lt("heartbeat_at", new Date(Date.now() - 2 * 60 * 1000).toISOString())
      .then(r => r.data || []);
    for (const t of staleRows) {
      const elapsed = Math.min(
        t.seconds || 0,
        Math.floor((new Date(t.heartbeat_at) - new Date(t.started_at)) / 1000)
      );
      await q("timer_sessions")
        .update({ ended_at: t.heartbeat_at, seconds: elapsed })
        .eq("id", t.id);
      if (elapsed >= 60) {
        await insert("study_logs", {
          user_id: t.user_id, subject_id: t.subject_id,
          minutes: Math.round(elapsed / 60), note: "Session timer (auto-closed after tab crash)",
          timer_session_id: t.id,
        }).catch(() => {});
      }
    }
  } catch (e) { console.error("Stale timer reaper error:", e.message); }

  const subjects = await select("subjects", { eq: { user_id: req.user.id }, order: { column: "exam_date" } });
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const weekLogs = await q("study_logs").select("*").eq("user_id", req.user.id).gte("logged_at", weekAgo).then(r => r.data || []);
  const todayMinutes = weekLogs.filter(x => String(x.logged_at).slice(0, 10) === today).reduce((a, x) => a + (x.minutes || 0), 0);
  const weekMinutes = weekLogs.reduce((a, x) => a + (x.minutes || 0), 0);
  const activeTimer = await one("timer_sessions", { eq: { user_id: req.user.id }, is: { ended_at: null } });
  res.json({ subjects, todayMinutes, weekMinutes, activeTimer, user: req.user });
});

// ── Subjects & topics ─────────────────────────────────────────────────────────
app.get("/api/subjects", auth, async (req, res) => res.json(await select("subjects", { eq: { user_id: req.user.id }, order: { column: "created_at", ascending: false } })));
app.post("/api/subjects", auth, async (req, res) => {
  try {
    if (!req.body.name) return res.status(400).json({ error: "Subject name is required" });
    const values = { user_id: req.user.id, name: req.body.name, description: req.body.description || "", status: req.body.status || "not-started", progress: Math.min(100, Number(req.body.progress) || 0), exam_date: req.body.exam_date || null };
    const { data, error } = await req.userSupabase.from("subjects").insert(values).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put("/api/subjects/:id", auth, async (req, res) => {
  const subject = await one("subjects", { eq: { id: req.params.id, user_id: req.user.id } });
  if (!subject) return res.status(404).json({ error: "Subject not found" });
  res.json(await update("subjects", { name: req.body.name ?? subject.name, description: req.body.description || "", status: req.body.status || subject.status, progress: Math.min(100, Number(req.body.progress ?? subject.progress) || 0), exam_date: req.body.exam_date || null }, { id: subject.id }));
});
app.delete("/api/subjects/:id", auth, async (req, res) => {
  try { await remove("subjects", { id: req.params.id, user_id: req.user.id }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get("/api/subjects/:id/topics", auth, async (req, res) => {
  const subject = await one("subjects", { eq: { id: req.params.id, user_id: req.user.id } });
  if (!subject) return res.status(404).json({ error: "Subject not found" });
  const topics = await select("syllabus_topics", { eq: { subject_id: subject.id }, order: { column: "created_at" } });
  const notes = await select("files", { eq: { subject_id: subject.id }, order: { column: "created_at", ascending: false } });
  notes.forEach(x => { x.url = fileUrl(x); });
  res.json({ topics, notes });
});
app.post("/api/subjects/:id/topics", auth, async (req, res) => {
  const s = await one("subjects", { eq: { id: req.params.id, user_id: req.user.id } });
  if (!s || !String(req.body.name || "").trim()) return res.status(400).json({ error: "A topic name is required" });
  res.json(await insert("syllabus_topics", { subject_id: s.id, parent_id: req.body.parent_id || null, name: req.body.name.trim(), status: req.body.status || "not-started", progress: Number(req.body.progress) || 0 }));
});
app.patch("/api/subjects/:id/topics/:topicId", auth, async (req, res) => {
  const s = await one("subjects", { eq: { id: req.params.id, user_id: req.user.id } });
  const t = s && await one("syllabus_topics", { eq: { id: req.params.topicId, subject_id: s.id } });
  if (!t) return res.status(404).json({ error: "Topic not found" });
  res.json(await update("syllabus_topics", { name: req.body.name || t.name, status: req.body.status || t.status, progress: Number(req.body.progress ?? t.progress) }, { id: t.id }));
});
app.delete("/api/subjects/:id/topics/:topicId", auth, async (req, res) => {
  const s = await one("subjects", { eq: { id: req.params.id, user_id: req.user.id } });
  if (!s) return res.status(404).json({ error: "Subject not found" });
  await remove("syllabus_topics", { id: req.params.topicId, subject_id: s.id });
  res.json({ ok: true });
});
app.post("/api/subjects/:id/notes", auth, parseUpload, async (req, res) => {
  const f = req.files?.find(x => x.fieldname === "file");
  const s = await one("subjects", { eq: { id: req.params.id, user_id: req.user.id } });
  if (!s || !f) return res.status(400).json({ error: "Choose a note file first" });
  const row = await insert("files", fileRecord(f, { user_id: req.user.id, subject_id: s.id, topic_id: req.body.topic_id || null, folder: req.body.folder || "Notes" }));
  row.url = fileUrl(row); res.json(row);
});

// ── Personal files ────────────────────────────────────────────────────────────
app.get("/api/personal-files", auth, async (req, res) => {
  const rows = await select("files", { eq: { user_id: req.user.id }, is: { group_id: null }, order: { column: "created_at", ascending: false } });
  rows.forEach(x => x.url = fileUrl(x));
  res.json(rows);
});
// Metadata-only endpoint: browser uploads to R2, then POSTs here to record in DB
app.post("/api/personal-files/metadata", auth, async (req, res) => {
  const { file } = req.body;
  if (!file?.original_name || !file.storage_path || !file.storage_bucket) return res.status(400).json({ error: "File metadata is incomplete" });
  const row = await insert("files", {
    user_id: req.user.id, subject_id: file.subject_id || null, topic_id: file.topic_id || null,
    folder: file.folder || "Personal", display_name: file.display_name || file.original_name,
    original_name: file.original_name, stored_name: file.storage_path,
    storage_path: file.storage_path, storage_bucket: file.storage_bucket,
    mime: file.mime || "application/octet-stream", size: Number(file.size) || 0,
  });
  row.url = fileUrl(row); res.json(row);
});
// Legacy: multer-based upload (small files, no R2 configured)
app.post("/api/personal-files", auth, parseUpload, async (req, res) => {
  const files = req.files?.filter(x => x.fieldname === "file") || [];
  if (!files.length) return res.status(400).json({ error: "Choose at least one file" });
  const rows = await Promise.all(files.map(f => insert("files", fileRecord(f, { user_id: req.user.id, subject_id: req.body.subject_id || null, topic_id: req.body.topic_id || null, folder: "Personal", display_name: files.length === 1 ? (req.body.display_name || f.originalname) : f.originalname }))));
  rows.forEach(row => { row.url = fileUrl(row); });
  res.json(rows);
});
app.patch("/api/personal-files/:id", auth, async (req, res) => {
  const f = await one("files", { eq: { id: req.params.id, user_id: req.user.id }, is: { group_id: null } });
  if (!f) return res.status(404).json({ error: "Personal file not found" });
  res.json(await update("files", { display_name: req.body.display_name || f.display_name, subject_id: req.body.subject_id || null, topic_id: req.body.topic_id || null }, { id: f.id }));
});
app.delete("/api/personal-files/:id", auth, async (req, res) => {
  const f = await one("files", { eq: { id: req.params.id, user_id: req.user.id }, is: { group_id: null } });
  if (!f) return res.status(404).json({ error: "Personal file not found" });
  await removeStorageFile(f);
  await remove("files", { id: f.id, user_id: req.user.id });
  res.json({ ok: true });
});

// ── Study logs ────────────────────────────────────────────────────────────────
app.get("/api/study-logs", auth, async (req, res) => res.json(await select("study_logs", { eq: { user_id: req.user.id }, order: { column: "logged_at", ascending: false }, limit: 100 })));
app.post("/api/study-logs", auth, async (req, res) => {
  const minutes = Number(req.body.minutes);
  if (!minutes) return res.status(400).json({ error: "Minutes must be greater than zero" });
  res.json(await insert("study_logs", { user_id: req.user.id, subject_id: req.body.subject_id || null, minutes, note: req.body.note || "" }));
});
app.delete("/api/study-logs/:id", auth, async (req, res) => { await remove("study_logs", { id: req.params.id, user_id: req.user.id }); res.json({ ok: true }); });

// ── Tasks ─────────────────────────────────────────────────────────────────────
app.get("/api/tasks", auth, async (req, res) => res.json(await select("tasks", { eq: { user_id: req.user.id }, order: { column: "created_at", ascending: false } })));
app.post("/api/tasks", auth, async (req, res) => {
  if (!req.body.title?.trim()) return res.status(400).json({ error: "Task title is required" });
  res.json(await insert("tasks", { user_id: req.user.id, title: req.body.title.trim(), due_date: req.body.due_date || null }));
});
app.patch("/api/tasks/:id", auth, async (req, res) => { await update("tasks", { done: !!req.body.done }, { id: req.params.id, user_id: req.user.id }); res.json({ ok: true }); });
app.delete("/api/tasks/:id", auth, async (req, res) => { await remove("tasks", { id: req.params.id, user_id: req.user.id }); res.json({ ok: true }); });

// ── Timer ─────────────────────────────────────────────────────────────────────
app.post("/api/timer/start", auth, async (req, res) => {
  // Enforce one active session per user
  await q("timer_sessions").update({ ended_at: new Date().toISOString() }).match({ user_id: req.user.id }).is("ended_at", null);
  res.json(await insert("timer_sessions", { user_id: req.user.id, subject_id: req.body.subject_id || null, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), seconds: 0 }));
});
async function finishTimer(req, res, note) {
  const t = await one("timer_sessions", { eq: { id: req.body.id, user_id: req.user.id }, is: { ended_at: null } });
  if (!t) return res.status(404).json({ error: "Timer not found" });
  const seconds = Math.max(Number(req.body.seconds) || 0, Math.floor((Date.now() - Date.parse(t.started_at)) / 1000));
  await update("timer_sessions", { seconds, ended_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() }, { id: t.id });
  if (seconds >= 60) await insert("study_logs", { user_id: t.user_id, subject_id: t.subject_id, minutes: Math.round(seconds / 60), note, timer_session_id: t.id });
  res.json({ ok: true, seconds });
}
app.post("/api/timer/heartbeat", auth, async (req, res) => {
  const t = await one("timer_sessions", { eq: { id: req.body.id, user_id: req.user.id }, is: { ended_at: null } });
  if (!t) return res.status(404).json({ error: "Timer not found" });
  const seconds = Math.max(Number(req.body.seconds) || 0, Math.floor((Date.now() - Date.parse(t.started_at)) / 1000));
  await update("timer_sessions", { seconds, heartbeat_at: new Date().toISOString() }, { id: t.id });
  res.json({ ok: true, seconds });
});
app.post("/api/timer/stop", auth, (req, res) => finishTimer(req, res, "Focus timer"));
app.post("/api/timer/close", auth, (req, res) => finishTimer(req, res, "Session timer"));

// ── Analytics (fixed: now returns real month/year/bySubject breakdowns) ───────
app.get("/api/analytics", auth, async (req, res) => {
  const { data: rawLogs } = await supabase
    .from("study_logs")
    .select("*, subjects(name)")
    .eq("user_id", req.user.id)
    .order("logged_at", { ascending: false });
  const logs = (rawLogs || []).map(x => ({ ...x, subject_name: x.subjects?.name || x.subject_name || null }));
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dayOf = s => String(s).slice(0, 10);
  const monthOf = s => String(s).slice(0, 7);
  const weekDaily = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10);
    return { day: d, minutes: logs.filter(x => dayOf(x.logged_at) === d).reduce((a, x) => a + x.minutes, 0) };
  });
  const monthDaily = Array.from({ length: daysInMonth }, (_, i) => {
    const d = `${year}-${String(month + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
    return { day: d, minutes: logs.filter(x => dayOf(x.logged_at) === d).reduce((a, x) => a + x.minutes, 0) };
  });
  const yearMonthly = Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, "0")}`;
    return { month: key, minutes: logs.filter(x => monthOf(x.logged_at) === key).reduce((a, x) => a + x.minutes, 0) };
  });
  const yearLogs = logs.filter(x => String(x.logged_at).startsWith(String(year)));
  const subjectMap = {};
  logs.forEach(x => {
    if (x.subject_id && x.subject_name) {
      subjectMap[x.subject_id] = subjectMap[x.subject_id] || { name: x.subject_name, minutes: 0 };
      subjectMap[x.subject_id].minutes += x.minutes;
    }
  });
  const bySubject = Object.values(subjectMap).sort((a, b) => b.minutes - a.minutes);
  res.json({ today: weekDaily.at(-1)?.minutes || 0, weekDaily, monthDaily, yearMonthly, yearLogs, allTime: logs.reduce((a, x) => a + x.minutes, 0), bySubject });
});

// ── Groups ────────────────────────────────────────────────────────────────────
app.get("/api/groups", auth, async (req, res) => {
  const groups = await select("groups", { order: { column: "created_at", ascending: false } });
  const memberships = await select("group_members", { eq: { user_id: req.user.id } });
  groups.forEach(g => { g.joined = memberships.some(m => String(m.group_id) === String(g.id)); });
  res.json(groups);
});
app.post("/api/groups", auth, async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: "Group name is required" });
  const g = await insert("groups", { name: req.body.name, description: req.body.description || "", owner_id: req.user.id, invite_code: Math.random().toString(36).slice(2, 10).toUpperCase() });
  await insert("group_members", { group_id: g.id, user_id: req.user.id, role: "admin" });
  res.json(g);
});
app.post("/api/groups/join-by-code", auth, async (req, res) => {
  const g = await one("groups", { eq: { invite_code: String(req.body.code || "").toUpperCase() } });
  if (!g) return res.status(404).json({ error: "Invite code not found" });
  await insert("group_members", { group_id: g.id, user_id: req.user.id, role: "member" }).catch(() => {});
  res.json({ groupId: g.id });
});
app.post("/api/groups/:id/join", auth, async (req, res) => { await insert("group_members", { group_id: req.params.id, user_id: req.user.id, role: "member" }).catch(() => {}); res.json({ ok: true }); });
app.post("/api/groups/:id/leave", auth, async (req, res) => { await remove("group_members", { group_id: req.params.id, user_id: req.user.id }); res.json({ ok: true }); });
app.delete("/api/groups/:id", auth, async (req, res) => {
  const g = await one("groups", { eq: { id: req.params.id, owner_id: req.user.id } });
  if (!g) return res.status(403).json({ error: "Only the group owner can delete it" });
  await remove("groups", { id: g.id }); res.json({ ok: true });
});
app.get("/api/groups/:id", auth, member, async (req, res) => {
  const group = await one("groups", { eq: { id: req.params.id } });
  const members = await select("group_members", { eq: { group_id: req.params.id } });
  const messages = await select("messages", { eq: { group_id: req.params.id }, order: { column: "created_at" }, limit: 100 });
  const files = await select("files", { eq: { group_id: req.params.id }, order: { column: "created_at", ascending: false } });
  files.forEach(f => f.url = fileUrl(f));
  res.json({ group, members, messages, files, role: req.groupRole });
});
app.post("/api/groups/:id/files", auth, member, parseUpload, async (req, res) => {
  const files = req.files?.filter(x => x.fieldname === "file") || [];
  if (!files.length) return res.status(400).json({ error: "Choose at least one file" });
  const rows = await Promise.all(files.map(f => insert("files", fileRecord(f, { group_id: req.params.id, user_id: req.user.id, folder: req.body.folder || "General" }))));
  rows.forEach(r => r.url = fileUrl(r)); res.json(rows);
});
app.post("/api/groups/:id/files/metadata", auth, member, async (req, res) => {
  const { file } = req.body;
  if (!file?.original_name || !file.storage_path || !file.storage_bucket) return res.status(400).json({ error: "File metadata is incomplete" });
  const row = await insert("files", { group_id: req.params.id, user_id: req.user.id, folder: file.folder || "General", original_name: file.original_name, stored_name: file.storage_path, storage_path: file.storage_path, storage_bucket: file.storage_bucket, mime: file.mime || "application/octet-stream", size: Number(file.size) || 0 });
  row.url = fileUrl(row); res.json(row);
});
app.post("/api/groups/:id/messages", auth, member, parseUpload, async (req, res) => {
  const f = req.files?.find(x => x.fieldname === "file");
  const body = String(req.body.body || "").trim().slice(0, 2000);
  if (!body && !f) return res.status(400).json({ error: "Write a message or attach a file" });
  let file_id = null;
  if (f) file_id = (await insert("files", fileRecord(f, { group_id: req.params.id, user_id: req.user.id, folder: "Chat" }))).id;
  const m = await insert("messages", { group_id: req.params.id, user_id: req.user.id, body, file_id });
  io.to(`group:${req.params.id}`).emit("chat:message", m); res.json(m);
});
app.delete("/api/groups/:id/members/:userId", auth, member, async (req, res) => {
  if (req.groupRole !== "admin") return res.status(403).json({ error: "Group admin required" });
  await remove("group_members", { group_id: req.params.id, user_id: req.params.userId }); res.json({ ok: true });
});
app.delete("/api/groups/:id/files/:fileId", auth, member, async (req, res) => {
  const f = await one("files", { eq: { id: req.params.fileId, group_id: req.params.id } });
  if (!f) return res.status(404).json({ error: "Group file not found" });
  if (f.user_id !== req.user.id && req.groupRole !== "admin") return res.status(403).json({ error: "Only the uploader or group admin can delete this file" });
  await removeStorageFile(f); await remove("files", { id: f.id, group_id: req.params.id }); res.json({ ok: true });
});

// ── Admin ─────────────────────────────────────────────────────────────────────
app.get("/api/admin", auth, admin, async (req, res) => res.json({ users: await select("users"), tasks: await select("tasks"), goals: await select("goals"), warrants: await select("warrants") }));
for (const [name, table] of [["tasks", "tasks"], ["goals", "goals"], ["warrants", "warrants"]]) {
  app.post(`/api/admin/${name}`, auth, admin, async (req, res) => res.json(await insert(table, { ...req.body, done: false })));
  app.patch(`/api/admin/${name}/:id`, auth, admin, async (req, res) => { await update(table, req.body, { id: req.params.id }); res.json({ ok: true }); });
}
app.patch("/api/admin/users/:id", auth, admin, async (req, res) => { await update("users", { role: req.body.role === "admin" ? "admin" : "student" }, { id: req.params.id }); res.json({ ok: true }); });

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  const { data, error } = token ? await supabase.auth.getUser(token) : {};
  if (error || !data?.user) return next(new Error("Authentication required"));
  try { socket.user = await profile(data.user); next(); } catch (_) { next(new Error("Authentication required")); }
});
io.on("connection", socket => {
  const joined = new Set();
  socket.on("group:join", async id => { if (await one("group_members", { eq: { group_id: id, user_id: socket.user.id } })) { socket.join(`group:${id}`); joined.add(String(id)); } });
  socket.on("group:leave", id => { socket.leave(`group:${id}`); joined.delete(String(id)); });
  socket.on("chat:message", async ({ groupId, body }, ack) => {
    if (!joined.has(String(groupId))) return ack?.("Join the group chat first");
    const m = await insert("messages", { group_id: groupId, user_id: socket.user.id, body: String(body || "").slice(0, 2000) });
    io.to(`group:${groupId}`).emit("chat:message", m); ack?.();
  });
});

// ── Error handling ────────────────────────────────────────────────────────────
app.get("*", (req, res, next) => req.path.startsWith("/api/") ? res.status(404).json({ error: "Not found" }) : res.sendFile(path.join(__dirname, "public", "index.html"), next));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error("Request failed:", error);
  res.status(500).json({ error: process.env.NODE_ENV === "production" ? (error.message || "The server could not complete that request. Please try again.") : String(error.message || error) });
});
server.listen(PORT, () => console.log(`Exam Prep Tracker running at http://localhost:${PORT}`));
