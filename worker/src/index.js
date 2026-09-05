const encoder = new TextEncoder();
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_BODY_BYTES = 256_000;
const MAX_ATTEMPTS_PER_SYNC = 100;
const SAFE_ID = /^[a-zA-Z0-9._:-]{1,160}$/;

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function createSessionToken(subject, secret, now = Date.now()) {
  const payload = base64Url(encoder.encode(JSON.stringify({ sub: subject, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS })));
  return `${payload}.${base64Url(await hmac(payload, secret))}`;
}

export async function verifySessionToken(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const expected = await hmac(payload, secret);
  const received = decodeBase64Url(signature);
  if (expected.length !== received.length) return null;
  let difference = 0;
  expected.forEach((byte, index) => { difference |= byte ^ received[index]; });
  if (difference !== 0) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
    return data.exp > Math.floor(now / 1000) && SAFE_ID.test(data.sub) ? data : null;
  } catch {
    return null;
  }
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeTextEqual(left = "", right = "") {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const allowed = [env.ALLOWED_ORIGIN, "http://localhost:5173", "http://127.0.0.1:5173"].filter(Boolean);
  return allowed.includes(origin) ? origin : false;
}

function corsHeaders(origin) {
  return origin ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Report-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  } : {};
}

function json(data, status = 200, origin = null) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(origin) } });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "Corpo da requisição muito grande.");
  const text = await request.text();
  if (encoder.encode(text).byteLength > MAX_BODY_BYTES) throw new HttpError(413, "Corpo da requisição muito grande.");
  try { return JSON.parse(text); } catch { throw new HttpError(400, "JSON inválido."); }
}

function bearer(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

async function requireSession(request, env) {
  if (!env.SESSION_SECRET) throw new HttpError(503, "Sincronização ainda não configurada.");
  const session = await verifySessionToken(bearer(request), env.SESSION_SECRET);
  if (!session) throw new HttpError(401, "Sessão ausente ou expirada.");
  return session;
}

export function validateSyncPayload(body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "Dados de sincronização ausentes.");
  if (!SAFE_ID.test(body.deviceId || "")) throw new HttpError(400, "Identificador do dispositivo inválido.");
  if (!body.report || body.report.schema !== "pscpp-study-report/v3") throw new HttpError(400, "Relatório incompatível.");
  if (!SAFE_ID.test(body.report.roundId || "")) throw new HttpError(400, "Identificador da rodada inválido.");
  const attempts = Object.entries(body.rawAttempts || {});
  if (attempts.length > MAX_ATTEMPTS_PER_SYNC) throw new HttpError(400, "Quantidade de tentativas acima do limite.");
  for (const [questionId, attempt] of attempts) {
    if (!SAFE_ID.test(questionId) || !attempt || typeof attempt !== "object") throw new HttpError(400, "Tentativa inválida.");
    if (typeof attempt.correct !== "boolean" || !Number.isInteger(attempt.selected)) throw new HttpError(400, "Resultado da tentativa inválido.");
  }
  return { deviceId: body.deviceId, report: body.report, attempts };
}

function dateOrNow(value, now) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : now;
}

async function sync(request, env, subject) {
  const { deviceId, report, attempts } = validateSyncPayload(await readJson(request));
  const now = new Date().toISOString();
  const metadata = new Map((report.attempts || []).map(row => [row.questionId, row]));
  const statements = attempts.map(([questionId, attempt]) => {
    const row = metadata.get(questionId) || {};
    const updatedAt = dateOrNow(attempt.updatedAt || attempt.answeredAt, now);
    return env.DB.prepare(`INSERT INTO attempts
      (attempt_key, student_id, device_id, round_id, question_id, category, axis, correct, mastery, error_cause, next_review, answered_at, updated_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attempt_key) DO UPDATE SET
        device_id=excluded.device_id, category=excluded.category, axis=excluded.axis, correct=excluded.correct,
        mastery=excluded.mastery, error_cause=excluded.error_cause, next_review=excluded.next_review,
        answered_at=excluded.answered_at, updated_at=excluded.updated_at, payload_json=excluded.payload_json
      WHERE excluded.updated_at >= attempts.updated_at`)
      .bind(`${report.roundId}:${questionId}`, subject, deviceId, report.roundId, questionId, row.category || null, row.axis || null,
        attempt.correct ? 1 : 0, Number.isInteger(attempt.mastery) ? attempt.mastery : null, attempt.errorCause || null,
        attempt.nextReview || null, dateOrNow(attempt.answeredAt, now), updatedAt, JSON.stringify(attempt));
  });
  statements.push(env.DB.prepare(`INSERT INTO reports
    (report_key, student_id, device_id, round_id, generated_at, updated_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(report_key) DO UPDATE SET generated_at=excluded.generated_at, updated_at=excluded.updated_at, payload_json=excluded.payload_json
    WHERE excluded.updated_at >= reports.updated_at`)
    .bind(`${deviceId}:${report.roundId}`, subject, deviceId, report.roundId, dateOrNow(report.generatedAt, now), now, JSON.stringify(report)));
  await env.DB.batch(statements);
  return { ok: true, syncedAt: now, attempts: attempts.length };
}

async function stateFromDb(env, subject) {
  const result = await env.DB.prepare("SELECT question_id, updated_at, payload_json FROM attempts WHERE student_id = ? ORDER BY updated_at DESC LIMIT 1000").bind(subject).all();
  return { attempts: (result.results || []).map(row => ({ questionId: row.question_id, updatedAt: row.updated_at, payload: JSON.parse(row.payload_json) })) };
}

function increment(bucket, key) {
  const label = key || "não informado";
  bucket[label] = (bucket[label] || 0) + 1;
}

export function aggregateAttempts(rows, now = new Date()) {
  const attempts = rows.map(row => ({ ...row, payload: typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json }));
  const correct = attempts.filter(row => Boolean(row.correct)).length;
  const byAxis = {}, byCategory = {}, byErrorCause = {};
  for (const row of attempts) {
    increment(byAxis, row.axis); increment(byCategory, row.category);
    if (!row.correct) increment(byErrorCause, row.error_cause);
  }
  const dueReviews = attempts.filter(row => row.next_review && new Date(row.next_review) <= now)
    .sort((a, b) => new Date(a.next_review) - new Date(b.next_review))
    .map(row => ({ roundId: row.round_id, questionId: row.question_id, axis: row.axis, mastery: row.mastery, errorCause: row.error_cause, nextReview: row.next_review }));
  const weakest = attempts.filter(row => !row.correct || row.mastery === 0 || row.mastery === 1)
    .sort((a, b) => (a.mastery ?? 0) - (b.mastery ?? 0) || new Date(b.updated_at) - new Date(a.updated_at))
    .slice(0, 20).map(row => ({ roundId: row.round_id, questionId: row.question_id, axis: row.axis, correct: Boolean(row.correct), mastery: row.mastery, errorCause: row.error_cause }));
  return { totalAttempts: attempts.length, correct, wrong: attempts.length - correct, accuracy: attempts.length ? Math.round(correct / attempts.length * 1000) / 10 : 0, byAxis, byCategory, byErrorCause, dueReviews, weakest };
}

async function reportFromDb(env, subject) {
  const attempts = await env.DB.prepare("SELECT * FROM attempts WHERE student_id = ? ORDER BY updated_at DESC LIMIT 5000").bind(subject).all();
  const latest = await env.DB.prepare("SELECT generated_at, updated_at, payload_json FROM reports WHERE student_id = ? ORDER BY updated_at DESC LIMIT 1").bind(subject).first();
  return { schema: "pscpp-study-cloud-report/v1", generatedAt: new Date().toISOString(), lastSyncAt: latest?.updated_at || null,
    latestRound: latest ? JSON.parse(latest.payload_json) : null, summary: aggregateAttempts(attempts.results || []) };
}

async function reportAuthorized(request, env) {
  if (env.SESSION_SECRET && await verifySessionToken(bearer(request), env.SESSION_SECRET)) return true;
  const supplied = request.headers.get("X-Report-Token") || new URL(request.url).searchParams.get("token") || "";
  return Boolean(env.REPORT_READ_TOKEN && timingSafeTextEqual(supplied, env.REPORT_READ_TOKEN));
}

async function handle(request, env, origin) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (url.pathname === "/health" && request.method === "GET") return json({
    ok: true,
    service: "pscpp-study-sync",
    storage: Boolean(env.DB),
    configuration: {
      passwordHash: Boolean(env.PASSWORD_HASH),
      sessionSecret: Boolean(env.SESSION_SECRET),
      reportReadToken: Boolean(env.REPORT_READ_TOKEN)
    }
  }, 200, origin);
  if (url.pathname === "/api/session" && request.method === "POST") {
    if (!env.PASSWORD_HASH || !env.SESSION_SECRET) throw new HttpError(503, "Sincronização ainda não configurada.");
    const body = await readJson(request);
    const valid = typeof body.password === "string" && timingSafeTextEqual(await sha256(body.password), env.PASSWORD_HASH);
    if (!valid) throw new HttpError(401, "Senha incorreta.");
    return json({ token: await createSessionToken(env.STUDENT_ID || "student", env.SESSION_SECRET), expiresIn: SESSION_TTL_SECONDS }, 200, origin);
  }
  if (url.pathname === "/api/sync" && request.method === "POST") {
    const session = await requireSession(request, env);
    return json(await sync(request, env, session.sub), 200, origin);
  }
  if (url.pathname === "/api/state" && request.method === "GET") {
    const session = await requireSession(request, env);
    return json(await stateFromDb(env, session.sub), 200, origin);
  }
  if (url.pathname === "/api/report" && request.method === "GET") {
    if (!await reportAuthorized(request, env)) throw new HttpError(401, "Acesso ao relatório não autorizado.");
    return json(await reportFromDb(env, env.STUDENT_ID || "student"), 200, origin);
  }
  throw new HttpError(404, "Rota não encontrada.");
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    if (origin === false) return json({ error: "Origem não permitida." }, 403);
    try { return await handle(request, env, origin); }
    catch (error) {
      console.error(error);
      return json({ error: error instanceof HttpError ? error.message : "Erro interno." }, error instanceof HttpError ? error.status : 500, origin);
    }
  }
};
