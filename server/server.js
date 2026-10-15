// Proxy OAuth para el plugin Heap Event Tracker.
// Guarda UN refresh token de Figma (la cuenta que autorizó) y lo usa para leer/borrar
// comentarios, de modo que el equipo no tenga que crear ni renovar tokens.
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

loadEnv(path.join(__dirname, ".env"));

const PORT = process.env.PORT || 3050;
const CLIENT_ID = process.env.FIGMA_CLIENT_ID;
const CLIENT_SECRET = process.env.FIGMA_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const PLUGIN_KEY = process.env.PLUGIN_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;
const SCOPES = "file_comments:read file_comments:write file_content:read";
const TOKEN_FILE = path.join(__dirname, "data", "tokens.json");

for (const [k, v] of Object.entries({ FIGMA_CLIENT_ID: CLIENT_ID, FIGMA_CLIENT_SECRET: CLIENT_SECRET, REDIRECT_URI, PLUGIN_KEY, ADMIN_KEY })) {
  if (!v) { console.error("Falta " + k + " en .env"); process.exit(1); }
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ─── Almacén de tokens ───────────────────────────────────────────────
function readTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); } catch (e) { return null; }
}
function writeTokens(t) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t), { mode: 0o600 });
}

const basicAuth = "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64");

async function figmaTokenRequest(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: basicAuth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || body.error || "OAuth " + res.status), { status: res.status });
  return body;
}

let refreshing = null; // evita refrescos concurrentes
async function getAccessToken() {
  const t = readTokens();
  if (!t) throw Object.assign(new Error("not_authorized"), { code: "not_authorized" });
  if (t.expires_at - Date.now() > 60 * 1000) return t.access_token;

  if (!refreshing) {
    refreshing = figmaTokenRequest("https://api.figma.com/v1/oauth/refresh", { refresh_token: t.refresh_token })
      .then((r) => {
        const next = { ...t, access_token: r.access_token, expires_at: Date.now() + r.expires_in * 1000 };
        writeTokens(next);
        return next.access_token;
      })
      .catch((e) => { throw Object.assign(e, { code: "refresh_failed" }); })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function figma(method, urlPath) {
  const token = await getAccessToken();
  return fetch("https://api.figma.com" + urlPath, { method, headers: { Authorization: "Bearer " + token } });
}

// ─── App ─────────────────────────────────────────────────────────────
const app = express();
const pendingStates = new Map(); // state -> expiración

// El iframe del plugin tiene origen "null", así que el navegador exige CORS (y preflight por el header X-Heap-Key).
// Es seguro abrirlo: el acceso real lo protege la clave del plugin.
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "X-Heap-Key",
    "Access-Control-Max-Age": "86400",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (req, res) => res.json({ ok: true }));

// Autorización (una sola vez): /auth/login?key=ADMIN_KEY
app.get("/auth/login", (req, res) => {
  if (!safeEqual(req.query.key, ADMIN_KEY)) return res.status(401).send("No autorizado");
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now() + 10 * 60 * 1000);
  const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPES, state, response_type: "code" });
  res.redirect("https://www.figma.com/oauth?" + q.toString());
});

app.get("/auth/callback", async (req, res) => {
  const exp = pendingStates.get(req.query.state);
  pendingStates.delete(req.query.state);
  if (!exp || exp < Date.now()) return res.status(400).send("Estado inválido o vencido. Vuelve a empezar desde /auth/login");
  if (!req.query.code) return res.status(400).send("Figma no devolvió código: " + (req.query.error || "desconocido"));
  try {
    const r = await figmaTokenRequest("https://api.figma.com/v1/oauth/token", {
      redirect_uri: REDIRECT_URI, code: req.query.code, grant_type: "authorization_code",
    });
    writeTokens({ access_token: r.access_token, refresh_token: r.refresh_token, expires_at: Date.now() + r.expires_in * 1000 });
    res.send("Listo: cuenta de Figma autorizada. Ya puedes cerrar esta pestaña.");
  } catch (e) {
    console.error("OAuth callback:", e.message);
    res.status(502).send("No se pudo completar la autorización: " + e.message);
  }
});

// Todo lo demás exige la clave del plugin
app.use((req, res, next) => {
  if (!safeEqual(req.get("X-Heap-Key"), PLUGIN_KEY)) return res.status(401).json({ error: "bad_key" });
  next();
});

function sendError(res, e) {
  if (e.code === "not_authorized") return res.status(503).json({ error: "not_authorized" });
  if (e.code === "refresh_failed") return res.status(503).json({ error: "refresh_failed" });
  console.error(e);
  res.status(502).json({ error: "upstream_error" });
}

const FILE_KEY = /^[A-Za-z0-9]+$/;
const COMMENT_ID = /^[0-9]+$/;

app.get("/status", (req, res) => res.json({ authorized: !!readTokens() }));

app.get("/files/:fileKey/comments", async (req, res) => {
  if (!FILE_KEY.test(req.params.fileKey)) return res.status(400).json({ error: "bad_file_key" });
  try {
    const r = await figma("GET", "/v1/files/" + req.params.fileKey + "/comments");
    res.status(r.status).type("json").send(await r.text());
  } catch (e) { sendError(res, e); }
});

// Devuelve 200 siempre que el servidor haya podido preguntar; "deleted" dice si Figma lo borró.
app.delete("/files/:fileKey/comments/:id", async (req, res) => {
  if (!FILE_KEY.test(req.params.fileKey) || !COMMENT_ID.test(req.params.id)) return res.status(400).json({ error: "bad_params" });
  try {
    const r = await figma("DELETE", "/v1/files/" + req.params.fileKey + "/comments/" + req.params.id);
    res.json({ deleted: r.ok, status: r.status });
  } catch (e) { sendError(res, e); }
});

app.listen(PORT, () => console.log("heap-api escuchando en :" + PORT));
