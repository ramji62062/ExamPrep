const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const state = { user: null, subjects: [], logs: [], topics: {}, notes: {}, groups: [], timer: null, elapsed: 0, timerHandle: null, socket: null, group: null, sessionStarted: false, quoteHandle: null, syncHandle: null, dashboardRequest: 0 };
const quotes = [["The secret of getting ahead is getting started.","Mark Twain"],["Great things are done by a series of small things brought together.","Vincent van Gogh"],["Success is the sum of small efforts, repeated day in and day out.","Robert Collier"],["You do not have to be extreme, just consistent.","Unknown"],["A little progress each day adds up to big results.","Unknown"]];
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const fmtDate = value => value ? new Date(value.replace(" ", "T") + (value.length === 10 ? "T00:00:00" : "")).toLocaleDateString(undefined, { month:"short", day:"numeric" }) : "—";
let supabaseClient;

// ── API helper with retry ─────────────────────────────────────────────────────
const api = async (url, options = {}, _retries = 2) => {
  const headers = options.body instanceof FormData ? {} : { "Content-Type":"application/json" };
  if (!localStorage.getItem("atlas:auth-token") && supabaseClient) {
    const { data } = await supabaseClient.auth.getSession();
    if (data.session?.access_token) localStorage.setItem("atlas:auth-token", data.session.access_token);
  }
  const token = localStorage.getItem("atlas:auth-token");
  if (token) headers.Authorization = "Bearer " + token;
  try {
    const response = await fetch(url, { headers, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  } catch (err) {
    if (_retries > 0 && (err.name === "TypeError" || err.message.includes("fetch"))) {
      await new Promise(r => setTimeout(r, (3 - _retries) * 1000 + 1000));
      return api(url, options, _retries - 1);
    }
    throw err;
  }
};

function toast(message, error = false) { const el = $("#toast"); el.textContent = message; el.style.background = error ? "#b34e40" : ""; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2600); }
function formData(form) { return Object.fromEntries(new FormData(form).entries()); }

function showPage(name) {
  const allowedPages = ["overview", "syllabus", "progress", "todo", "files", "focus", "groups", "admin", "subject-detail"];
  if (!allowedPages.includes(name) || (name === "admin" && state.user?.role !== "admin")) name = "overview";
  $$(".page").forEach(p => p.classList.toggle("hidden", p.id !== `page-${name}`));
  $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.page === name));
  if (state.user?.id && name !== "subject-detail") localStorage.setItem(`atlas:last-page:${state.user.id}`, name);
  const labels = { overview:["YOUR SPACE","Good morning"], syllabus:["YOUR PLAN","Syllabus"], "subject-detail":["YOUR PLAN","Subject"], progress:["YOUR MOMENTUM","Progress"], todo:["CLEAR THE DECK","To-do"], files:["YOUR LIBRARY","Lectures & notes"], focus:["DEEP WORK","Focus timer"], groups:["YOUR CIRCLE","Study groups"], admin:["COMMAND CENTER","Admin desk"] };
  $("#page-kicker").textContent = labels[name][0]; $("#page-title").firstChild.textContent = labels[name][1]; $("#page-title").lastChild.textContent = name === "overview" ? `, ${state.user.name.split(" ")[0]}` : "";
  if (name === "overview") loadDashboard();
  if (name === "syllabus") loadDashboard();
  if (name === "progress") loadProgress();
  if (name === "todo") loadTodos();
  if (name === "files") loadDashboard().then(loadPersonalFiles);
  if (name === "focus") loadDashboard().then(loadAnalytics);
  if (name === "groups") loadGroups();
  if (name === "admin") loadAdmin();
}

function rotateQuote() {
  const now = new Date();
  const minuteKey = Math.floor(Date.now() / 60000);
  const dayKey = Math.floor(Date.now() / 86400000);
  const quote = quotes[(dayKey + now.getHours() + now.getMinutes() + minuteKey) % quotes.length];
  if ($("#daily-quote")) { $("#daily-quote").textContent = `"${quote[0]}"`; $("#quote-author").textContent = `— ${quote[1]}`; }
  if ($("#sidebar-quote")) $("#sidebar-quote").textContent = `"${quote[0]}"`;
}

async function loadProgress() {
  const el = $("#progress-bars"); if (el) el.innerHTML = '<p class="muted tiny">Loading…</p>';
  try {
    const data = await api("/api/analytics");
    $("#progress-today").textContent = `${data.today} min`; $("#progress-week").textContent = `${data.weekDaily.reduce((sum, item) => sum + item.minutes, 0)} min`; $("#progress-all-time").textContent = `${data.allTime} min`;
    const max = Math.max(...data.weekDaily.map(item => item.minutes), 30);
    $("#progress-bars").innerHTML = Array.from({length:7}, (_, index) => { const date = new Date(Date.now() - (6-index) * 86400000); const key = date.toISOString().slice(0,10); const item = data.weekDaily.find(day => day.day === key); return `<div class="progress-bar-col"><div class="progress-bar-value">${item?.minutes || 0}</div><i style="height:${Math.max(5,(item?.minutes || 0) / max * 150)}px"></i><small>${date.toLocaleDateString(undefined,{weekday:"short"})}</small></div>`; }).join("");
  } catch (err) { toast("Could not load progress data", true); }
}

async function loadTodos() {
  const el = $("#todo-list"); if (el) el.innerHTML = '<p class="muted tiny">Loading…</p>';
  try {
    const todos = await api("/api/tasks");
    el.innerHTML = todos.map(task => `<div class="todo-item ${task.done ? "done" : ""}"><button class="todo-check" data-toggle-task="${task.id}" data-done="${task.done ? 0 : 1}">${task.done ? "✓" : ""}</button><div><b>${esc(task.title)}</b><small>${task.due_date ? `Due ${fmtDate(task.due_date)}` : "No due date"}</small></div><button class="text-btn" data-delete-task="${task.id}">×</button></div>`).join("") || `<p class="empty-state">Your list is clear. Add the next thing you want to accomplish.</p>`;
  } catch (err) { toast("Could not load tasks", true); }
}

function openSubjectDetail(id) {
  const subject = state.subjects.find(item => item.id == id);
  if (!subject) return;
  state.detailSubjectId = subject.id;
  $("#detail-kicker").textContent = `SUBJECT WORKSPACE / ${subject.status.replace("-", " ").toUpperCase()}`;
  $("#detail-title").textContent = subject.name;
  $("#detail-description").textContent = subject.description || "Build your plan and keep all related materials together.";
  renderSubjectDetail();
  showPage("subject-detail");
}

function renderSubjectDetail() {
  const subject = state.subjects.find(item => item.id === state.detailSubjectId);
  if (!subject) return;
  const topics = state.topics[subject.id] || [];
  const tree = (parentId = null) => topics.filter(topic => (topic.parent_id || null) === parentId).map(topic => `<div class="detail-topic"><div><b>${esc(topic.name)}</b><small>${topic.status.replace("-", " ")} · ${topic.progress}%</small></div><span><button class="text-btn" data-detail-add-topic="${topic.id}">＋ subtopic</button><button class="text-btn" data-detail-topic-progress="${topic.id}">Update</button></span>${tree(topic.id)}</div>`).join("");
  const progress = topics.length ? Math.round(topics.reduce((sum, topic) => sum + topic.progress, 0) / topics.length) : subject.progress;
  $("#detail-progress").textContent = `${progress}%`;
  $("#detail-progress-bar").style.width = `${progress}%`;
  $("#detail-topics").innerHTML = tree() || `<p class="empty-state">No topics yet. Add your first topic or subtopic.</p>`;
  const files = state.notes[subject.id] || [];
  $("#detail-files").innerHTML = files.map(file => {
    const url = file.url || fileUrl(file.stored_name);
    return isVideo(file) ? `<div class="detail-file"><b>${esc(file.display_name || file.original_name)}</b><small>${esc(file.topic_name || "Subject material")}</small><video controls preload="metadata" src="${url}"></video></div>` : `<div class="detail-file"><b>${esc(file.display_name || file.original_name)}</b><small>${esc(file.topic_name || "Subject material")}</small><a class="secondary file-link" href="${url}" target="_blank" rel="noopener">Open file</a></div>`;
  }).join("") || `<p class="empty-state">No files are attached to this subject yet. Upload them from Files and choose this subject.</p>`;
}

const isVideo = file => String(file.mime || "").startsWith("video/");
// fileUrl: local fallback for legacy Supabase-stored files (new files use file.url from API)
const fileUrl = storedName => `/uploads/${String(storedName || "").split("/").map(encodeURIComponent).join("/")}`;

const personalFileHtml = file => {
  const url = file.url || fileUrl(file.stored_name);
  if (!isVideo(file)) return `<article class="library-card"><div class="file-icon">▤</div><div><b>${esc(file.display_name || file.original_name)}</b><small>${esc(file.subject_name || "Uncategorized")}${file.topic_name ? ` · ${esc(file.topic_name)}` : ""}</small><a class="secondary file-link" href="${url}" target="_blank" rel="noopener">Open / download</a><button class="text-btn" data-edit-file="${file.id}">Rename / move</button><button class="danger-text" data-delete-personal-file="${file.id}">Delete</button></div></article>`;
  return `<article class="library-card video-card"><video controls preload="metadata" playsinline src="${url}"${file.caption_stored_name ? `><track kind="captions" src="${fileUrl(file.caption_stored_name)}" srclang="en" label="Captions" default></video>` : "></video>"}<div class="video-meta"><b>${esc(file.display_name || file.original_name)}</b><small>${esc(file.subject_name || "Uncategorized")}${file.topic_name ? ` · ${esc(file.topic_name)}` : ""} · Use the player menu for speed, volume, captions, and fullscreen.</small><button class="text-btn" data-edit-file="${file.id}">Rename / move</button><button class="danger-text" data-delete-personal-file="${file.id}">Delete</button></div></article>`;
};

async function loadPersonalFiles() {
  const el = $("#personal-files-list"); if (el) el.innerHTML = '<p class="muted tiny">Loading files…</p>';
  try {
    const files = await api("/api/personal-files");
    el.innerHTML = files.map(personalFileHtml).join("") || `<div class="empty-state">No lectures or notes yet. Upload your first file above.</div>`;
    const subject = $("#file-subject"); subject.innerHTML = `<option value="">Choose subject</option>${state.subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}`;
    updateFileTopics();
  } catch (err) { toast("Could not load files", true); }
}

// ── Upload to R2 using presigned URLs (browser → R2 directly, no server memory) ──
// R2 free tier: 10 GB storage, 1M write ops/month, ZERO egress fees — videos stream for free.
// Falls back to Supabase Storage (1 GB total) if R2 is not configured.
const _cancelRefs = {};

function uploadPartXHR(url, body, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = e => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.getResponseHeader("ETag") || xhr.getResponseHeader("etag") || "");
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error — check your connection"));
    xhr.onabort = () => reject(new Error("cancelled"));
    xhr.open("PUT", url);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    xhr.send(body);
    resolve._xhr = xhr; // expose for cancel
  });
}

async function uploadToR2(key, file, onProgress, cancelRef) {
  const PART_SIZE = 10 * 1024 * 1024; // 10 MB — R2 minimum part size is 5 MB
  const contentType = file.type || "application/octet-stream";
  let cancelled = false;
  let uploadId = null;

  if (cancelRef) {
    cancelRef.cancel = async () => {
      cancelled = true;
      if (uploadId) {
        api("/api/upload/multipart", { method: "DELETE", body: JSON.stringify({ uploadId, key }) }).catch(() => {});
      }
    };
  }

  if (file.size <= PART_SIZE) {
    // Single presigned PUT
    const { url } = await api("/api/upload/presign", { method: "POST", body: JSON.stringify({ key, contentType }) });
    const p = uploadPartXHR(url, file, contentType, bytes => onProgress(bytes));
    if (cancelRef) cancelRef._xhr = p._xhr;
    await p;
    onProgress(file.size);
    return { path: key, bucket: "r2" };
  }

  // Multipart upload for large files
  const init = await api("/api/upload/multipart/init", { method: "POST", body: JSON.stringify({ key, contentType }) });
  uploadId = init.uploadId;
  const totalParts = Math.ceil(file.size / PART_SIZE);
  const parts = [];
  let uploadedBytes = 0;

  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    if (cancelled) throw new Error("cancelled");
    const start = (partNumber - 1) * PART_SIZE;
    const chunk = file.slice(start, Math.min(start + PART_SIZE, file.size));
    const { url } = await api("/api/upload/multipart/part", { method: "POST", body: JSON.stringify({ uploadId, key, partNumber }) });
    const prevBytes = uploadedBytes;
    const p = uploadPartXHR(url, chunk, "application/octet-stream", loaded => onProgress(prevBytes + loaded));
    if (cancelRef) cancelRef._xhr = p._xhr;
    const etag = await p;
    if (cancelled) throw new Error("cancelled");
    parts.push({ partNumber, etag });
    uploadedBytes += chunk.size;
    onProgress(uploadedBytes);
  }

  await api("/api/upload/multipart/complete", { method: "POST", body: JSON.stringify({ uploadId, key, parts }) });
  uploadId = null;
  return { path: key, bucket: "r2" };
}

async function uploadToSupabase(bucket, objectPath, file, onProgress) {
  if (file.size <= 6 * 1024 * 1024) {
    const result = await supabaseClient.storage.from(bucket).upload(objectPath, file, { contentType: file.type || "application/octet-stream", upsert: false });
    if (result.error) throw result.error;
    onProgress(file.size);
    return { path: objectPath, bucket };
  }
  // TUS resumable for larger files (still limited by Supabase plan)
  const base = `${supabaseClient.supabaseUrl}/storage/v1/upload/resumable`;
  const token = (await supabaseClient.auth.getSession()).data.session?.access_token;
  if (!token) throw new Error("Your login session expired. Sign in again.");
  const metadata = [`bucketName ${btoa(bucket)}`, `objectName ${btoa(objectPath)}`, `contentType ${btoa(file.type || "application/octet-stream")}`].join(",");
  const create = await fetch(base, { method:"POST", headers:{ Authorization:`Bearer ${token}`, "x-upsert":"false", "Tus-Resumable":"1.0.0", "Upload-Length":String(file.size), "Upload-Metadata":metadata } });
  if (!create.ok) throw new Error(await create.text() || `Resumable upload failed (${create.status})`);
  let location = create.headers.get("Location");
  if (location?.startsWith("/")) location = `${supabaseClient.supabaseUrl}${location}`;
  if (!location) throw new Error("Storage did not return an upload session");
  const chunkSize = 6 * 1024 * 1024;
  let offset = 0;
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size));
    const response = await fetch(location, { method:"PATCH", headers:{ Authorization:`Bearer ${token}`, "Tus-Resumable":"1.0.0", "Upload-Offset":String(offset), "Content-Type":"application/offset+octet-stream" }, body:chunk });
    if (!response.ok) throw new Error(await response.text() || `Chunk upload failed (${response.status})`);
    offset = Number(response.headers.get("Upload-Offset")) || offset + chunk.size;
    onProgress(offset);
  }
  return { path: objectPath, bucket };
}

async function uploadFileToStorage(bucket, objectPath, file, onProgress, cancelRef) {
  const cfg = window._appConfig;
  if (cfg?.hasR2) return uploadToR2(objectPath, file, onProgress, cancelRef);
  return uploadToSupabase(bucket, objectPath, file, onProgress);
}

async function uploadWithStatus(url, form, statusElement, onSuccess) {
  const files = [...form.querySelector('input[name="file"]').files];
  if (!files.length || files.length > 50) {
    toast(files.length > 50 ? "Choose no more than 50 files" : "Choose at least one file", true);
    return;
  }
  const cfg = window._appConfig;
  const maxMb = cfg?.maxFileSizeMb || 250;
  const tooBig = files.filter(f => f.size > maxMb * 1024 * 1024);
  if (tooBig.length) {
    toast(`${tooBig[0].name} exceeds the ${maxMb} MB limit`, true);
    return;
  }

  statusElement.classList.remove("hidden");
  let isCancelled = false;
  const cancelRefs = {};

  statusElement.innerHTML = `<div class="upload-summary"><b>Uploading ${files.length} file${files.length === 1 ? "" : "s"}…</b><span class="upload-percent">0%</span><button type="button" class="cancel-upload secondary">✕ Cancel</button></div><div class="upload-progress"><i></i></div>${files.map((file, index) => `<div class="upload-file" data-upload-index="${index}"><span title="${esc(file.name)}">${esc(file.name.length > 42 ? file.name.slice(0, 39) + "…" : file.name)}</span><b>Queued</b></div>`).join("")}`;

  statusElement.querySelector(".cancel-upload").onclick = () => {
    isCancelled = true;
    Object.values(cancelRefs).forEach(ref => { ref._xhr?.abort(); ref.cancel?.(); });
    statusElement.querySelector(".upload-summary b").textContent = "Upload cancelled.";
    statusElement.querySelector(".cancel-upload").disabled = true;
  };

  const isGroup = url.includes("/groups/");
  const bucket = isGroup ? "group-files" : "personal-files";
  const owner = isGroup ? `groups/${url.split("/")[3]}` : `users/${state.user.id}`;
  const metadataUrl = `${url}/metadata`;
  const extra = Object.fromEntries(new FormData(form).entries());
  const updateRow = (index, text, className = "") => { const item = statusElement.querySelector(`[data-upload-index="${index}"] b`); if (item) { item.textContent = text; item.className = className; } };
  const queue = [...files.entries()];
  const results = [];
  let completed = 0;

  const worker = async () => {
    while (queue.length) {
      if (isCancelled) break;
      const [index, file] = queue.shift();
      const cancelRef = {};
      cancelRefs[index] = cancelRef;
      try {
        updateRow(index, "Uploading");
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const objectPath = `${owner}/${Date.now()}-${crypto.randomUUID()}-${safeName}`;
        const uploaded = await uploadFileToStorage(bucket, objectPath, file, bytes => {
          updateRow(index, `${Math.round(bytes / file.size * 100)}%`);
        }, cancelRef);
        const metadata = await api(metadataUrl, { method:"POST", body:JSON.stringify({ file: { original_name:file.name, storage_path:uploaded.path, storage_bucket:uploaded.bucket, mime:file.type, size:file.size, display_name:files.length === 1 ? (extra.display_name || file.name) : file.name, folder:extra.folder || (isGroup ? "General" : "Personal"), subject_id:extra.subject_id || null, topic_id:extra.topic_id || null } }) });
        results.push(metadata);
        updateRow(index, "Uploaded ✓", "upload-success");
      } catch (err) {
        if (err.message === "cancelled" || isCancelled) {
          updateRow(index, "Cancelled", "upload-failed");
        } else {
          updateRow(index, "Failed", "upload-failed");
          toast(`${file.name}: ${err.message}`, true);
        }
      } finally {
        delete cancelRefs[index];
        if (!isCancelled) {
          completed++;
          const percent = Math.round(completed / files.length * 100);
          statusElement.querySelector(".upload-percent").textContent = `${percent}%`;
          statusElement.querySelector(".upload-progress i").style.width = `${percent}%`;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(6, files.length) }, worker));
  if (!isCancelled && results.length) {
    toast(`${results.length} of ${files.length} file${files.length === 1 ? "" : "s"} uploaded`);
    await onSuccess(results);
  }
}

function updateFileTopics() {
  const subjectId = $("#file-subject").value;
  $("#file-topic").innerHTML = `<option value="">Optional topic</option>${(state.topics[subjectId] || []).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}`;
}

function renderSubjects() {
  const topicTree = (subjectId, parentId = null) => (state.topics[subjectId] || []).filter(t => (t.parent_id || null) === parentId).map(t => `<li><div class="topic-line"><span>${esc(t.name)}</span><span class="topic-actions">${t.progress}% <button data-add-topic="${subjectId}" data-parent-topic="${t.id}">+ subtopic</button><button data-delete-topic="${subjectId}" data-topic-id="${t.id}">×</button></span></div>${topicTree(subjectId, t.id)}</li>`).join("");
  const html = state.subjects.map(s => `<article class="subject-card" data-open-subject="${s.id}"><div class="subject-top"><h3>${esc(s.name)}</h3><span class="status-pill ${s.status === "complete" ? "complete" : ""}">${esc(s.status.replace("-", " "))}</span></div><p>${esc(s.description || "No description yet.")}</p><div class="progress"><i style="width:${s.progress}%"></i></div><div class="syllabus-tree"><div class="tree-head"><b>Topics</b><button class="text-btn" data-add-topic="${s.id}">＋ Add topic</button></div><ul>${topicTree(s.id) || "<li class='muted tiny'>No topics yet.</li>"}</ul></div><div class="card-foot"><span>${s.progress}% complete${s.exam_date ? ` · ${fmtDate(s.exam_date)}` : ""}</span><span class="card-actions"><button data-edit-subject="${s.id}">Edit</button><button data-delete-subject="${s.id}">Delete</button></span></div></article>`).join("");
  $("#subject-grid").innerHTML = html || `<div class="empty-state">No subjects yet. Add one to start mapping your exam.</div>`;
  const preview = state.subjects.slice(0, 4).map(s => `<div class="subject-row"><span class="subject-dot ${s.status === "complete" ? "done" : ""}"></span><div class="subject-info"><b>${esc(s.name)}</b><small>${esc(s.status.replace("-", " "))}</small></div><span class="subject-pct">${s.progress}%</span></div>`).join("");
  $("#subject-preview").className = preview ? "" : "empty-state"; $("#subject-preview").innerHTML = preview || "No subjects yet. Add your first one.";
  ["#timer-subject","#log-subject"].forEach(selector => { const el = $(selector); if (!el) return; const first = el.options[0].outerHTML; el.innerHTML = first + state.subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join(""); });
}

function renderLogs() {
  const html = state.logs.slice(0, 5).map(l => `<div class="activity-row"><span class="activity-icon">◷</span><div class="activity-copy"><b>${l.minutes} min · ${esc(l.subject_name || "General study")}</b><small>${esc(l.note || "Focused study")} · ${fmtDate(l.logged_at)}</small></div><button type="button" class="delete-log" data-delete-log="${l.id}" aria-label="Delete study log">×</button></div>`).join("");
  $("#log-preview").className = html ? "activity-list" : "empty-state"; $("#log-preview").innerHTML = html || "Your activity will appear here.";
}

async function loadDashboard() {
  const requestId = ++state.dashboardRequest;
  try {
    const data = await api("/api/dashboard");
    if (requestId !== state.dashboardRequest) return;
    state.subjects = Array.isArray(data.subjects) ? data.subjects : [];
    renderSubjects();
    const logsPromise = api("/api/study-logs").then(logs => { state.logs = Array.isArray(logs) ? logs : []; renderLogs(); }).catch(() => { state.logs = []; renderLogs(); });
    await Promise.all(state.subjects.map(async subject => {
      try {
        const subjectData = await api(`/api/subjects/${subject.id}/topics`);
        if (requestId !== state.dashboardRequest) return;
        state.topics[subject.id] = subjectData.topics || [];
        state.notes[subject.id] = subjectData.notes || [];
      } catch (_) {
        state.topics[subject.id] = [];
        state.notes[subject.id] = [];
      }
    }));
    if (requestId !== state.dashboardRequest) return;
    renderSubjects(); renderLogs();
    await logsPromise;
    $("#week-minutes").textContent = `${data.weekMinutes} min this week`;
    $("#subject-count").textContent = `${state.subjects.length} subject${state.subjects.length === 1 ? "" : "s"}`;
    const avg = state.subjects.length ? Math.round(state.subjects.reduce((a, s) => a + s.progress, 0) / state.subjects.length) : 0;
    $("#avg-progress").textContent = `${avg}%`; $("#avg-progress-bar").style.width = `${avg}%`;
    const next = state.subjects.filter(s => s.exam_date && new Date(s.exam_date) >= new Date()).sort((a,b) => a.exam_date.localeCompare(b.exam_date))[0];
    $("#next-exam").textContent = next ? fmtDate(next.exam_date) : "—"; $("#countdown").textContent = next ? `${Math.ceil((new Date(`${next.exam_date}T23:59:59`) - Date.now()) / 86400000)} days to go · ${next.name}` : "Add an exam date";
    $("#today-minutes").textContent = data.todayMinutes;
    if (data.activeTimer) {
      state.timer = data.activeTimer;
      const startedAt = Date.parse(`${data.activeTimer.started_at.replace(" ", "T")}Z`);
      const liveElapsed = Number.isFinite(startedAt) ? Math.floor((Date.now() - startedAt) / 1000) : 0;
      state.elapsed = Math.max(data.activeTimer.seconds || 0, liveElapsed);
      state.sessionStarted = true; startTicker(false);
    } else if (state.timer) {
      clearInterval(state.timerHandle); state.timer = null; state.sessionStarted = false;
    }
  } catch (err) { if (requestId === state.dashboardRequest) toast("Dashboard failed to load — retrying…", true); }
}

async function loadAnalytics() {
  try {
    const data = await api("/api/analytics");
    renderAnalytics(data, $("#analytics-range")?.value || "week");
  } catch (err) { toast("Could not load analytics", true); }
}

function renderAnalytics(data, range) {
  let points;
  if (range === "month") {
    const count = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    points = Array.from({ length:count }, (_, i) => { const key = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,"0")}-${String(i+1).padStart(2,"0")}`; return { label:i+1, minutes:data.monthDaily.find(x => x.day === key)?.minutes || 0 }; });
  } else if (range === "year") {
    points = Array.from({ length:12 }, (_, i) => { const key = `${new Date().getFullYear()}-${String(i+1).padStart(2,"0")}`; return { label:new Date(2000,i,1).toLocaleDateString(undefined,{month:"short"}), minutes:data.yearMonthly.find(x => x.month === key)?.minutes || 0 }; });
  } else {
    points = Array.from({ length:7 }, (_, i) => { const date = new Date(Date.now() - (6-i)*86400000); const key = date.toISOString().slice(0,10); return { label:date.toLocaleDateString(undefined,{weekday:"short"}), minutes:data.weekDaily.find(x => x.day === key)?.minutes || 0 }; });
  }
  const max = Math.max(...points.map(d => d.minutes), 30);
  $("#bar-chart").innerHTML = points.map(d => `<div class="bar-col"><div class="bar" style="height:${Math.max(3,d.minutes/max*150)}px" title="${d.minutes} minutes"></div><small>${d.label}</small></div>`).join("");
  const total = range === "month" ? data.monthDaily.reduce((sum,x) => sum + x.minutes, 0) : range === "year" ? data.yearMonthly.reduce((sum,x) => sum + x.minutes, 0) : data.weekDaily.reduce((sum,x) => sum + x.minutes, 0);
  $("#analytics-title").textContent = range === "month" ? "This month" : range === "year" ? "This year" : "This week";
  $("#analytics-summary").textContent = `${total} minutes · ${Math.floor(total / 60)}h ${total % 60}m`;
  $("#subject-breakdown").innerHTML = data.bySubject.map(x => `<div class="breakdown-row"><span>${esc(x.name)}</span><b>${x.minutes} min</b></div>`).join("") || `<p class="empty-state">Log a session to see your breakdown.</p>`;
  const yearLogList = $("#year-log-list");
  if (yearLogList) {
    yearLogList.classList.toggle("hidden", range !== "year");
    const yearRows = data.yearLogs.map(log => `<div class="year-log-row"><div><b>${log.minutes} min · ${esc(log.subject_name || "General study")}</b><small>${fmtDate(log.logged_at)} · ${esc(log.note || "Focused study")}</small></div><button type="button" class="delete-log" data-delete-log="${log.id}" aria-label="Delete study log">×</button></div>`).join("");
    yearLogList.innerHTML = range === "year" ? `<h4>Study logs this year</h4>${yearRows || '<p class="empty-state">No study logs recorded this year.</p>'}` : "";
  }
}

function startTicker(restart = true) {
  if (restart) state.elapsed = 0;
  clearInterval(state.timerHandle);
  $("#timer-start").classList.add("hidden"); $("#timer-stop").classList.remove("hidden"); $("#timer-status").textContent = "IN THE ZONE";
  const render = () => { const m = String(Math.floor(state.elapsed/60)).padStart(2,"0"), s = String(state.elapsed%60).padStart(2,"0"); if ($("#timer-display")) $("#timer-display").textContent = `${m}:${s}`; if ($(".timer-ring")) $(".timer-ring").style.background = `conic-gradient(var(--coral) ${Math.min(359,state.elapsed/1500*360)}deg,#f4eee6 0deg)`; };
  render();
  state.timerHandle = setInterval(() => {
    state.elapsed++;
    render();
    // Heartbeat every 15 seconds — updates server so stale-session reaper has fresh data
    if (state.elapsed % 15 === 0 && state.timer) {
      api("/api/timer/heartbeat", { method:"POST", body:JSON.stringify({ id:state.timer.id, seconds:state.elapsed }) })
        .then(result => { state.elapsed = Math.max(state.elapsed, result.seconds); })
        .catch(() => {});
    }
  }, 1000);
}

async function stopTimer() {
  if (!state.timer) return;
  clearInterval(state.timerHandle);
  const timer = state.timer;
  try {
    await api("/api/timer/stop", { method:"POST", body:JSON.stringify({ id:timer.id, seconds:state.elapsed }) });
    state.timer = null; state.sessionStarted = true;
    $("#timer-stop").classList.add("hidden"); $("#timer-start").classList.remove("hidden"); $("#timer-status").textContent = "SESSION SAVED";
    toast("Focus session saved");
    await Promise.all([loadDashboard(), loadAnalytics(), loadProgress()]);
  } catch (err) {
    startTicker(false);
    toast(`Could not save timer: ${err.message}`, true);
  }
}

async function loadGroups() {
  const el = $("#group-grid"); if (el) el.innerHTML = '<p class="muted tiny">Loading groups…</p>';
  try {
    state.groups = await api("/api/groups");
    el.innerHTML = state.groups.map(g => `<article class="group-card"><h3>${esc(g.name)}</h3><p>${esc(g.description || "A shared space for focused preparation.")}</p><span class="members">${g.member_count} member${g.member_count === 1 ? "" : "s"} · by ${esc(g.owner_name)}</span>${g.joined ? `<div class="group-actions"><button class="secondary" data-open-group="${g.id}">Open room →</button>${g.owner_id === state.user.id ? `<button class="danger-text" data-delete-group="${g.id}">Delete group</button><small class="muted">Invite code: ${esc(g.invite_code)}</small>` : ""}</div>` : `<button class="primary" data-join-group="${g.id}">Join group</button>`}</article>`).join("") || `<div class="empty-state">No groups yet. Create one and invite your study partners.</div>`;
  } catch (err) { toast("Could not load groups", true); }
}

async function openGroup(id) {
  const data = await api(`/api/groups/${id}`); state.group = data; $("#group-grid").classList.add("hidden"); const room = $("#group-room"); room.classList.remove("hidden");
  room.innerHTML = `<section class="chat-panel"><div class="chat-head"><div><span class="eyebrow">STUDY ROOM</span><h3>${esc(data.group.name)}</h3></div><button class="text-btn" id="close-room">← All groups</button></div><div id="chat-messages" class="chat-messages">${data.messages.map(messageHtml).join("")}</div><form id="chat-form" class="chat-form"><input name="body" placeholder="Message, emoji, or attach a file…" autocomplete="off"><input name="file" type="file" class="chat-file" accept="*/*"><button class="primary">Send</button></form></section><section class="panel members-panel"><div class="panel-head"><div><span class="eyebrow">PEOPLE</span><h3>${data.members.length} members</h3></div></div>${data.members.map(m => `<div class="member"><span>${esc(m.name)}${m.id===state.user.id ? " (you)" : ""}</span><small>${m.role}</small></div>`).join("")}<hr><form id="file-form"><label>Share up to 50 files<input type="file" name="file" multiple required></label><input name="folder" placeholder="Folder (e.g. Notes)" value="General"><button class="secondary full">Upload files</button></form><div id="group-upload-status" class="upload-status hidden"></div><div id="file-list">${data.files.map(fileHtml).join("")}</div></section>`;
  $("#close-room").onclick = () => { room.classList.add("hidden"); $("#group-grid").classList.remove("hidden"); state.group = null; };
  $("#chat-form").onsubmit = async e => {
    e.preventDefault();
    const payload = new FormData(e.target);
    const body = String(payload.get("body") || "").trim();
    const attachment = payload.get("file");
    if (attachment?.size) {
      try { await api(`/api/groups/${id}/messages`, { method:"POST", body:payload }); e.target.reset(); toast("Message shared"); }
      catch (err) { toast(err.message, true); }
      return;
    }
    if (!body) return;
    if (!state.socket?.connected) return toast("Chat is connecting. Try again in a moment.", true);
    state.socket.emit("chat:message", { groupId:id, body }, error => { if (error) toast(error, true); });
    e.target.reset();
  };
  $("#file-form").onsubmit = e => { e.preventDefault(); uploadWithStatus(`/api/groups/${id}/files`, e.target, $("#group-upload-status"), results => { results.forEach(result => $("#file-list").insertAdjacentHTML("afterbegin", fileHtml(result))); e.target.reset(); }); };
  await connectSocket();
  const joinGroup = () => state.socket.emit("group:join", id);
  if (state.socket.connected) joinGroup(); else state.socket.once("connect", joinGroup);
}

const messageHtml = m => `<div class="chat-message"><b>${esc(m.name)}</b><small>${fmtDate(m.created_at)}</small>${m.body ? `<p>${esc(m.body)}</p>` : ""}${m.file_stored_name ? `<a class="chat-attachment" href="${m.file_url || `/uploads/${encodeURIComponent(m.file_stored_name)}`}" target="_blank" rel="noopener">${esc(m.file_name)} · ${Math.ceil((m.file_size || 0) / 1024)} KB</a>${String(m.file_mime || "").startsWith("image/") ? `<img src="${m.file_url || `/uploads/${encodeURIComponent(m.file_stored_name)}`}" alt="${esc(m.file_name)}">` : ""}${String(m.file_mime || "").startsWith("video/") ? `<video controls src="${m.file_url || `/uploads/${encodeURIComponent(m.file_stored_name)}`}"></video>` : ""}` : ""}</div>`;
const fileHtml = f => `<div class="member"><a href="${f.url || `/uploads/${encodeURIComponent(f.stored_name)}`}" target="_blank">${esc(f.original_name)}</a><small>${Math.ceil(f.size/1024)} KB</small><button class="danger-text" data-delete-group-file="${f.id}">Delete</button></div>`;

async function connectSocket() {
  if (state.socket?.connected) return state.socket;
  if (state.socket?.connectingPromise) return state.socket.connectingPromise;
  const token = await api("/api/socket-token");
  const socket = state.socket || io({ autoConnect:false });
  state.socket = socket;
  socket.auth = { token:token.token, sessionId:token.sessionId };
  socket.on("chat:message", m => { if (state.group && m.group_id === state.group.group.id) $("#chat-messages").insertAdjacentHTML("beforeend", messageHtml(m)); });
  socket.on("connect_error", e => toast(`Chat connection failed: ${e.message}`, true));
  socket.connectingPromise = new Promise((resolve, reject) => {
    const connected = () => { cleanup(); resolve(socket); };
    const failed = error => { cleanup(); reject(error); };
    const cleanup = () => { socket.off("connect", connected); socket.off("connect_error", failed); };
    socket.once("connect", connected); socket.once("connect_error", failed);
    socket.connect();
  }).finally(() => { delete socket.connectingPromise; });
  return socket.connectingPromise;
}

async function loadAdmin() {
  const el = $("#admin-content"); if (el) el.innerHTML = '<p class="muted tiny">Loading…</p>';
  try {
    const d = await api("/api/admin");
    el.innerHTML = `<div class="admin-grid"><section class="panel"><span class="eyebrow">FOLLOW UPS</span><h3>Tasks</h3><form id="admin-task" class="admin-list"><input name="title" placeholder="New task" required><input name="due_date" type="date"><select name="user_id"><option value="">Assign later</option>${d.users.map(u=>`<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select><button class="secondary full">＋ Add task</button></form><div class="admin-list">${d.tasks.map(x=>`<div class="admin-line"><span>${x.done?"✓ ":""}${esc(x.title)}</span><button data-task="${x.id}" data-done="${x.done?0:1}">${x.done?"Undo":"Done"}</button></div>`).join("")}</div></section><section class="panel"><span class="eyebrow">NORTH STAR</span><h3>Goals</h3><form id="admin-goal" class="admin-list"><input name="title" placeholder="New goal" required><input name="target" placeholder="Target"><select name="user_id"><option value="">Assign later</option>${d.users.map(u=>`<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select><button class="secondary full">＋ Add goal</button></form><div class="admin-list">${d.goals.map(x=>`<div class="admin-line"><span>${x.done?"✓ ":""}${esc(x.title)}</span><button data-goal="${x.id}" data-done="${x.done?0:1}">${x.done?"Undo":"Done"}</button></div>`).join("")}</div></section><section class="panel"><span class="eyebrow">ACCOUNTABILITY</span><h3>Arrest warrants</h3><form id="admin-warrant" class="admin-list"><select name="user_id" required><option value="">Select student</option>${d.users.map(u=>`<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select><input name="reason" placeholder="Reason" required><button class="secondary full">＋ Issue warrant</button></form><div class="admin-list">${d.warrants.map(x=>`<div class="admin-line"><span>${esc(x.user_name)}: ${esc(x.reason)}</span><button data-warrant="${x.id}" data-status="${x.status==="open"?"resolved":"open"}">${x.status==="open"?"Resolve":"Reopen"}</button></div>`).join("")}</div></section></div><section class="panel" style="margin-top:18px"><div class="panel-head"><div><span class="eyebrow">PEOPLE</span><h3>Users</h3></div></div>${d.users.map(u=>`<div class="admin-line"><span>${esc(u.name)} · ${esc(u.email)}</span><button data-role-id="${u.id}" data-role="${u.role==="admin"?"student":"admin"}">${u.role==="admin"?"Remove admin":"Make admin"}</button></div>`).join("")}</section>`;
    $("#admin-task").onsubmit = adminSubmit("/api/admin/tasks");
    $("#admin-goal").onsubmit = adminSubmit("/api/admin/goals");
    $("#admin-warrant").onsubmit = adminSubmit("/api/admin/warrants");
  } catch (err) { toast("Could not load admin panel", true); }
}
function adminSubmit(url) { return async e => { e.preventDefault(); try { await api(url, { method:"POST", body:JSON.stringify(formData(e.target)) }); toast("Updated"); loadAdmin(); } catch (err) { toast(err.message, true); } }; }

// ── Supabase Realtime subscriptions ──────────────────────────────────────────
// Syllabus topics: any tab/device that changes a topic → all other tabs update live
// Timer sessions: start/stop/heartbeat in one tab → syncs to all open tabs
function initRealtime() {
  if (window._realtimeChannels) {
    window._realtimeChannels.forEach(ch => { try { supabaseClient.removeChannel(ch); } catch (_) {} });
  }
  window._realtimeChannels = [];

  // Syllabus topics sync
  const syllabusChannel = supabaseClient
    .channel("atlas-syllabus-sync")
    .on("postgres_changes",
      { event: "*", schema: "public", table: "syllabus_topics" },
      payload => {
        const subjectId = payload.new?.subject_id ?? payload.old?.subject_id;
        if (!subjectId || !(subjectId in state.topics)) return;
        if (payload.eventType === "DELETE") {
          state.topics[subjectId] = (state.topics[subjectId] || []).filter(t => t.id !== payload.old.id);
        } else if (payload.eventType === "INSERT") {
          if (!(state.topics[subjectId] || []).find(t => t.id === payload.new.id)) {
            state.topics[subjectId] = [...(state.topics[subjectId] || []), payload.new];
          }
        } else {
          state.topics[subjectId] = (state.topics[subjectId] || []).map(t => t.id === payload.new.id ? { ...t, ...payload.new } : t);
        }
        renderSubjects();
        if (state.detailSubjectId === subjectId) renderSubjectDetail();
      }
    )
    .subscribe(status => { if (status === "CHANNEL_ERROR") console.warn("Syllabus Realtime channel error — check supabase_realtime publication includes syllabus_topics"); });
  window._realtimeChannels.push(syllabusChannel);

  // Timer session sync (cross-tab: start/stop propagates instantly)
  const timerChannel = supabaseClient
    .channel("atlas-timer-sync")
    .on("postgres_changes",
      { event: "*", schema: "public", table: "timer_sessions", filter: `user_id=eq.${state.user.id}` },
      payload => {
        if (payload.eventType === "INSERT" && !payload.new.ended_at && !state.timer) {
          // Another tab started a timer — adopt it
          state.timer = payload.new;
          state.elapsed = payload.new.seconds || 0;
          state.sessionStarted = true;
          startTicker(false);
        } else if (payload.eventType === "UPDATE" && state.timer?.id === payload.new.id) {
          if (payload.new.ended_at) {
            // Timer stopped from another tab
            clearInterval(state.timerHandle);
            state.timer = null; state.sessionStarted = false;
            $("#timer-stop")?.classList.add("hidden");
            $("#timer-start")?.classList.remove("hidden");
            if ($("#timer-status")) $("#timer-status").textContent = "READY TO FOCUS";
          } else {
            // Heartbeat — sync if drift > 5 s
            const serverSecs = payload.new.seconds || 0;
            if (Math.abs(serverSecs - state.elapsed) > 5) state.elapsed = serverSecs;
          }
        }
      }
    )
    .subscribe(status => { if (status === "CHANNEL_ERROR") console.warn("Timer Realtime channel error — check supabase_realtime publication includes timer_sessions"); });
  window._realtimeChannels.push(timerChannel);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    const config = await fetch("/api/config").then(r => r.json());
    window._appConfig = config; // used by upload functions to pick R2 vs Supabase
    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    const { data: session } = await supabaseClient.auth.getSession();
    if (session.session?.access_token) localStorage.setItem("atlas:auth-token", session.session.access_token);
    const data = await api("/api/me"); state.user = data.user; showApp();
    supabaseClient.auth.onAuthStateChange((_event, next) => { if (next?.access_token) localStorage.setItem("atlas:auth-token", next.access_token); else localStorage.removeItem("atlas:auth-token"); });
  } catch (_) { localStorage.removeItem("atlas:auth-token"); $("#auth-view").classList.remove("hidden"); }
}

window.addEventListener("beforeunload", () => {
  if (!state.timer) return;
  const headers = { "Content-Type":"application/json" };
  const token = localStorage.getItem("atlas:auth-token");
  if (token) headers.Authorization = `Bearer ${token}`;
  fetch("/api/timer/close", { method:"POST", keepalive:true, headers, body:JSON.stringify({ id:state.timer.id, seconds:state.elapsed }) });
});

function showApp() {
  $("#auth-view").classList.add("hidden"); $("#app-view").classList.remove("hidden");
  $("#user-name").textContent = `, ${state.user.name.split(" ")[0]}`;
  $("#avatar").textContent = state.user.name[0].toUpperCase();
  $$(".admin-only").forEach(x => x.classList.toggle("hidden", state.user.role !== "admin"));
  rotateQuote();
  clearInterval(state.quoteHandle); state.quoteHandle = setInterval(rotateQuote, 60000);
  clearInterval(state.syncHandle); state.syncHandle = setInterval(() => { if (document.visibilityState === "visible") loadDashboard().then(() => { if (!$("#page-files").classList.contains("hidden")) loadPersonalFiles(); }).catch(() => {}); }, 20000);
  // Update file size limit hint
  const cfg = window._appConfig;
  const hint = cfg?.hasR2 ? `Up to ${cfg.maxFileSizeMb >= 1000 ? Math.floor(cfg.maxFileSizeMb/1000)+"GB" : cfg.maxFileSizeMb+"MB"} per file · Cloudflare R2` : "Up to 250 MB per file · Supabase Storage";
  $$(".upload-size-hint").forEach(el => el.textContent = hint);
  // Start Realtime subscriptions for live syllabus + timer sync
  initRealtime();
  const lastPage = localStorage.getItem(`atlas:last-page:${state.user.id}`);
  showPage(lastPage === "subject-detail" ? "overview" : (lastPage || "overview"));
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.user) loadDashboard().catch(() => {}); });

// ── Event handlers ────────────────────────────────────────────────────────────
document.addEventListener("click", async e => {
  const sw = e.target.closest("[data-auth-switch]"); if (sw) { $("#login-form").classList.toggle("hidden", sw.dataset.authSwitch !== "login"); $("#register-form").classList.toggle("hidden", sw.dataset.authSwitch !== "register"); }
  const page = e.target.closest("[data-page], [data-page-link]"); if (page) showPage(page.dataset.page || page.dataset.pageLink);

  const toggleTask = e.target.closest("[data-toggle-task]");
  if (toggleTask) { try { await api(`/api/tasks/${toggleTask.dataset.toggleTask}`, { method:"PATCH", body:JSON.stringify({ done:Number(toggleTask.dataset.done) }) }); loadTodos(); } catch (err) { toast(err.message, true); } }

  const deleteTask = e.target.closest("[data-delete-task]");
  if (deleteTask) { try { await api(`/api/tasks/${deleteTask.dataset.deleteTask}`, { method:"DELETE" }); loadTodos(); toast("Task removed"); } catch (err) { toast(err.message, true); } }

  const deleteLog = e.target.closest("[data-delete-log]");
  if (deleteLog && confirm("Delete this study log?")) {
    try { await api(`/api/study-logs/${deleteLog.dataset.deleteLog}`, { method:"DELETE" }); await Promise.all([loadDashboard(), loadAnalytics(), loadProgress()]); toast("Study log deleted"); }
    catch (err) { toast(err.message, true); }
  }

  const deletePersonalFile = e.target.closest("[data-delete-personal-file]");
  if (deletePersonalFile && confirm("Delete this uploaded file permanently?")) {
    try { await api(`/api/personal-files/${deletePersonalFile.dataset.deletePersonalFile}`, { method:"DELETE" }); await loadPersonalFiles(); toast("File deleted"); }
    catch (err) { toast(err.message, true); }
  }

  const deleteGroupFile = e.target.closest("[data-delete-group-file]");
  if (deleteGroupFile && state.group && confirm("Delete this group file permanently?")) {
    try { await api(`/api/groups/${state.group.group.id}/files/${deleteGroupFile.dataset.deleteGroupFile}`, { method:"DELETE" }); deleteGroupFile.closest(".member")?.remove(); toast("Group file deleted"); }
    catch (err) { toast(err.message, true); }
  }

  const subjectCard = e.target.closest("[data-open-subject]");
  if (subjectCard && !e.target.closest("button")) openSubjectDetail(subjectCard.dataset.openSubject);
  if (e.target.id === "back-to-syllabus") showPage("syllabus");

  if (e.target.id === "detail-add-topic") {
    const name = prompt("Topic or subtopic name");
    if (name?.trim()) try { await api(`/api/subjects/${state.detailSubjectId}/topics`, { method:"POST", body:JSON.stringify({ name }) }); await loadDashboard(); renderSubjectDetail(); toast("Topic added"); } catch (err) { toast(err.message, true); }
  }

  const detailAdd = e.target.closest("[data-detail-add-topic]");
  if (detailAdd) {
    const name = prompt("Subtopic name");
    if (name?.trim()) try { await api(`/api/subjects/${state.detailSubjectId}/topics`, { method:"POST", body:JSON.stringify({ name, parent_id:detailAdd.dataset.detailAddTopic }) }); await loadDashboard(); renderSubjectDetail(); toast("Subtopic added"); } catch (err) { toast(err.message, true); }
  }

  const detailProgress = e.target.closest("[data-detail-topic-progress]");
  if (detailProgress) {
    const topic = (state.topics[state.detailSubjectId] || []).find(item => item.id == detailProgress.dataset.detailTopicProgress);
    const value = prompt("Progress percentage (0-100)", topic?.progress ?? 0);
    if (value !== null) try { await api(`/api/subjects/${state.detailSubjectId}/topics/${detailProgress.dataset.detailTopicProgress}`, { method:"PATCH", body:JSON.stringify({ progress:Number(value), status:Number(value) >= 100 ? "complete" : Number(value) > 0 ? "in-progress" : "not-started" }) }); await loadDashboard(); renderSubjectDetail(); toast("Progress updated"); } catch (err) { toast(err.message, true); }
  }

  if (e.target.id === "logout") {
    if (window._realtimeChannels) { window._realtimeChannels.forEach(ch => { try { supabaseClient.removeChannel(ch); } catch (_) {} }); window._realtimeChannels = []; }
    if (supabaseClient) await supabaseClient.auth.signOut();
    localStorage.removeItem("atlas:auth-token"); location.reload();
  }

  const close = e.target.closest(".close"); if (close) { e.preventDefault(); close.closest("dialog")?.close(); return; }
  if (e.target.id === "add-subject") { $("#subject-form").reset(); $("#subject-form [name=id]").value = ""; $("#subject-dialog-title").textContent = "Add subject"; $("#subject-dialog").showModal(); }
  if (e.target.id === "quick-log" || e.target.id === "overview-log") { $("#log-form").reset(); $("#log-dialog").showModal(); }

  const edit = e.target.closest("[data-edit-subject]");
  if (edit) { const s = state.subjects.find(x => x.id == edit.dataset.editSubject); const f = $("#subject-form"); Object.entries(s).forEach(([k,v]) => { if (f.elements[k]) f.elements[k].value = v ?? ""; }); $("#subject-dialog-title").textContent = "Edit subject"; $("#subject-dialog").showModal(); }

  const del = e.target.closest("[data-delete-subject]");
  if (del && confirm("Delete this subject?")) {
    try { await api(`/api/subjects/${del.dataset.deleteSubject}`, { method:"DELETE" }); toast("Subject removed"); loadDashboard(); }
    catch (err) { toast(err.message, true); }
  }

  const join = e.target.closest("[data-join-group]");
  if (join) {
    try { await api(`/api/groups/${join.dataset.joinGroup}/join`, { method:"POST" }); toast("Welcome to the group"); loadGroups(); }
    catch (err) { toast(err.message, true); }
  }

  const open = e.target.closest("[data-open-group]"); if (open) openGroup(open.dataset.openGroup);

  const deleteGroup = e.target.closest("[data-delete-group]");
  if (deleteGroup && confirm("Delete this group and all its messages and files? This cannot be undone.")) {
    try {
      await api(`/api/groups/${deleteGroup.dataset.deleteGroup}`, { method:"DELETE" });
      if (state.group?.group.id == deleteGroup.dataset.deleteGroup) { $("#group-room").classList.add("hidden"); $("#group-grid").classList.remove("hidden"); state.group = null; }
      await loadGroups(); toast("Group deleted");
    } catch (err) { toast(err.message, true); }
  }

  const editFile = e.target.closest("[data-edit-file]");
  if (editFile) {
    try {
      const file = (await api("/api/personal-files")).find(item => item.id == editFile.dataset.editFile);
      if (!file) return toast("File not found", true);
      const displayName = prompt("New file name", file.display_name || file.original_name);
      if (displayName === null) return;
      const subjectId = prompt(`Subject ID to move to (current: ${file.subject_id || "none"})`, file.subject_id || "");
      const topicId = prompt(`Topic ID to move to (current: ${file.topic_id || "none"})`, file.topic_id || "");
      await api(`/api/personal-files/${file.id}`, { method:"PATCH", body:JSON.stringify({ display_name:displayName, subject_id:subjectId || null, topic_id:topicId || null }) }); toast("File updated"); loadPersonalFiles();
    } catch (err) { toast(err.message, true); }
  }

  const addTopic = e.target.closest("[data-add-topic]");
  if (addTopic) {
    const name = prompt(addTopic.dataset.parentTopic ? "Subtopic name" : "Topic name");
    if (name?.trim()) try { await api(`/api/subjects/${addTopic.dataset.addTopic}/topics`, { method:"POST", body:JSON.stringify({ name, parent_id:addTopic.dataset.parentTopic || null }) }); await loadDashboard(); toast("Syllabus item added"); } catch (err) { toast(err.message, true); }
  }

  const deleteTopic = e.target.closest("[data-delete-topic]");
  if (deleteTopic && confirm("Delete this topic and its subtopics?")) {
    try { await api(`/api/subjects/${deleteTopic.dataset.deleteTopic}/topics/${deleteTopic.dataset.topicId}`, { method:"DELETE" }); await loadDashboard(); toast("Syllabus item removed"); } catch (err) { toast(err.message, true); }
  }

  const task = e.target.closest("[data-task]"); if (task) { try { await api(`/api/admin/tasks/${task.dataset.task}`, { method:"PATCH", body:JSON.stringify({ done:+task.dataset.done }) }); loadAdmin(); } catch (err) { toast(err.message, true); } }
  const goal = e.target.closest("[data-goal]"); if (goal) { try { await api(`/api/admin/goals/${goal.dataset.goal}`, { method:"PATCH", body:JSON.stringify({ done:+goal.dataset.done }) }); loadAdmin(); } catch (err) { toast(err.message, true); } }
  const warrant = e.target.closest("[data-warrant]"); if (warrant) { try { await api(`/api/admin/warrants/${warrant.dataset.warrant}`, { method:"PATCH", body:JSON.stringify({ status:warrant.dataset.status }) }); loadAdmin(); } catch (err) { toast(err.message, true); } }
  const role = e.target.closest("[data-role-id]"); if (role) { try { await api(`/api/admin/users/${role.dataset.roleId}`, { method:"PATCH", body:JSON.stringify({ role:role.dataset.role }) }); loadAdmin(); } catch (err) { toast(err.message, true); } }
});

$$("[data-auth]").forEach(form => form.addEventListener("submit", async e => { e.preventDefault(); try {
  const values = formData(form); const result = form.dataset.auth === "register"
    ? await supabaseClient.auth.signUp({ email: values.email, password: values.password, options: { data: { name: values.name } } })
    : await supabaseClient.auth.signInWithPassword({ email: values.email, password: values.password });
  if (result.error) throw result.error; if (!result.data.session) throw new Error("Check your email to confirm your account");
  localStorage.setItem("atlas:auth-token", result.data.session.access_token); const me = await api("/api/me"); state.user = me.user; showApp();
} catch (err) { toast(err.message, true); } }));

$("#subject-form").addEventListener("submit", async e => { e.preventDefault(); const f = formData(e.target); const id = f.id; delete f.id; try { const saved = await api(id ? `/api/subjects/${id}` : "/api/subjects", { method:id?"PUT":"POST", body:JSON.stringify(f) }); if (id) state.subjects = state.subjects.map(subject => subject.id == saved.id ? saved : subject); else state.subjects = [saved, ...state.subjects]; renderSubjects(); $("#subject-dialog").close(); await loadDashboard(); toast("Syllabus updated"); } catch(err) { toast(err.message, true); } });
$("#log-form").addEventListener("submit", async e => { e.preventDefault(); try { await api("/api/study-logs", { method:"POST", body:JSON.stringify(formData(e.target)) }); $("#log-dialog").close(); toast("Study time logged"); loadDashboard(); } catch(err) { toast(err.message, true); } });
$("#personal-file-form").addEventListener("submit", async e => { e.preventDefault(); uploadWithStatus("/api/personal-files", e.target, $("#personal-upload-status"), () => { e.target.reset(); loadPersonalFiles(); }); });
$("#file-subject").addEventListener("change", updateFileTopics);
$("#group-form").addEventListener("submit", async e => { e.preventDefault(); try { const group = await api("/api/groups", { method:"POST", body:JSON.stringify(formData(e.target)) }); $("#group-dialog").close(); toast(`Group created. Invite code: ${group.invite_code}`); loadGroups(); } catch(err) { toast(err.message, true); } });
$("#join-form").addEventListener("submit", async e => { e.preventDefault(); try { await api("/api/groups/join-by-code", { method:"POST", body:JSON.stringify(formData(e.target)) }); $("#join-dialog").close(); toast("Welcome to the group"); e.target.reset(); loadGroups(); } catch(err) { toast(err.message, true); } });
$("#create-group").onclick = () => { $("#group-form").reset(); $("#group-dialog").showModal(); };
$("#join-code").onclick = () => { $("#join-form").reset(); $("#join-dialog").showModal(); };
$("#timer-start").onclick = async () => { try { state.timer = await api("/api/timer/start", { method:"POST", body:JSON.stringify({ subject_id:$("#timer-subject").value }) }); state.sessionStarted = true; startTicker(); } catch (err) { toast(err.message, true); } };
$("#timer-stop").onclick = stopTimer;
$("#analytics-range").onchange = async () => { try { renderAnalytics(await api("/api/analytics"), $("#analytics-range").value); } catch (err) { toast("Could not load analytics", true); } };
$("#todo-form").onsubmit = async e => { e.preventDefault(); try { await api("/api/tasks", { method:"POST", body:JSON.stringify(formData(e.target)) }); e.target.reset(); loadTodos(); toast("Task added"); } catch (err) { toast(err.message, true); } };
boot();
