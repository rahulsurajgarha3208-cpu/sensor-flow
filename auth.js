// Minimal server-side authentication (no extra dependencies).
//
// - Users come from environment variables, never from the frontend bundle.
// - Login returns a signed token (HMAC-SHA256) that the frontend sends as
//   "Authorization: Bearer <token>". Every /api/readings and /api/ai request is checked.
// - Outside production, built-in DEMO passwords are used when none are configured,
//   and the server prints a warning. In production the server refuses to start without them.
import crypto from "node:crypto";

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_FAILED_LOGINS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

let secret = null;
let users = [];
export let usingDemoDefaults = false;

const b64url = (input) => Buffer.from(input).toString("base64url");
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest();

export function initAuth(env = process.env) {
  const isProduction = env.NODE_ENV === "production";
  const demoAllowed = !isProduction;
  usingDemoDefaults = false;

  const defs = [
    { username: env.ADMIN_USERNAME || "admin", password: env.ADMIN_PASSWORD, demo: "admin123", role: "Admin" },
    { username: env.TRAINEE_USERNAME || "trainee", password: env.TRAINEE_PASSWORD, demo: "trainee123", role: "Trainee" },
  ];
  users = [];
  for (const def of defs) {
    let password = def.password;
    if (!password && demoAllowed) {
      password = def.demo;
      usingDemoDefaults = true;
    }
    if (password) users.push({ username: def.username.toLowerCase(), role: def.role, hash: sha256(password) });
  }
  if (users.length === 0) {
    throw new Error("No login accounts configured. Set ADMIN_PASSWORD (and optionally TRAINEE_PASSWORD) in backend/.env.");
  }

  secret = env.AUTH_SECRET || null;
  if (!secret) {
    if (isProduction) throw new Error("AUTH_SECRET is required when NODE_ENV=production.");
    secret = crypto.randomBytes(32).toString("hex"); // tokens stop working after a restart
  }
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- tiny in-memory brute-force guard (per IP) ----
const failures = new Map();
function tooManyFailures(ip) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (entry.resetAt < Date.now()) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILED_LOGINS;
}
function recordFailure(ip) {
  const entry = failures.get(ip);
  if (!entry || entry.resetAt < Date.now()) failures.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  else entry.count += 1;
}

export function login(req, res) {
  const ip = req.ip || "unknown";
  if (tooManyFailures(ip)) {
    return res.status(429).json({ error: "Too many failed sign-in attempts. Try again in a few minutes." });
  }
  const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  const user = users.find((candidate) => candidate.username === username);
  // Always hash + compare so the response time does not reveal whether the user exists
  const ok = crypto.timingSafeEqual(user ? user.hash : sha256("x"), sha256(password)) && Boolean(user);
  if (!ok) {
    recordFailure(ip);
    return res.status(401).json({ error: "Operator ID or passphrase not recognized." });
  }
  failures.delete(ip);
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const token = sign({ u: user.username, r: user.role, exp: expiresAt });
  res.json({ token, expiresAt, user: { username: user.username, role: user.role } });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const payload = header.startsWith("Bearer ") ? verifyToken(header.slice(7)) : null;
  if (!payload) return res.status(401).json({ error: "Please sign in again." });
  req.user = { username: payload.u, role: payload.r };
  next();
}

export function me(req, res) {
  res.json({ user: req.user });
}
