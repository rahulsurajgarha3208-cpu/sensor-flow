// Runs without MongoDB or a Gemini key: the database calls and the Gemini request are replaced by fakes.
//   npm test
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import Reading from "../models/Reading.js";
import { validateReading } from "../controllers/readingController.js";
import { buildFacts, cleanThresholds } from "../controllers/aiController.js";
import { createApp } from "../app.js";
import { initAuth, verifyToken } from "../auth.js";

process.env.ADMIN_PASSWORD = "admin-pass";
process.env.TRAINEE_PASSWORD = "trainee-pass";
process.env.AUTH_SECRET = "test-secret";
process.env.GEMINI_API_KEY = "";
initAuth();

let server;
let base;
const saved = [];
const stored = [];

before(async () => {
  Reading.create = async (data) => {
    const doc = { _id: String(saved.length + 1), ...data, createdAt: new Date().toISOString() };
    saved.push(doc);
    return doc;
  };
  const query = () => {
    const chain = {
      select: () => chain,
      sort: () => chain,
      limit: () => chain,
      lean: () => chain,
      then: (resolve, reject) => Promise.resolve(stored).then(resolve, reject),
    };
    return chain;
  };
  Reading.find = query;
  Reading.findOne = () => {
    const chain = query();
    chain.then = (resolve, reject) => Promise.resolve(stored[0] || null).then(resolve, reject);
    return chain;
  };
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = (path, { token, method = "GET", body } = {}) =>
  fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

async function signIn(username = "admin", password = "admin-pass") {
  const res = await call("/api/auth/login", { method: "POST", body: { username, password } });
  return { res, data: await res.json() };
}

// ---------------- validation ----------------
test("validateReading accepts a normal reading and numeric strings", () => {
  const { data, errors } = validateReading({ temperature: "24.5", humidity: 50, co2: 600, source: "usb" });
  assert.deepEqual(errors, []);
  assert.deepEqual(data, { temperature: 24.5, humidity: 50, co2: 600, source: "usb" });
});

test("validateReading treats whitespace-only values as blank, not as 0", () => {
  const { errors } = validateReading({ temperature: "   ", humidity: 50, source: "manual" });
  assert.deepEqual(errors, ["temperature is required"]);
  const optional = validateReading({ temperature: 20, humidity: 50, pressure: "  ", source: "manual" });
  assert.equal("pressure" in optional.data, false);
});

test("validateReading rejects hex, Infinity, out-of-range, bad source and non-objects", () => {
  assert.ok(validateReading({ temperature: "0x10", humidity: 50, source: "usb" }).errors.length > 0);
  assert.ok(validateReading({ temperature: "Infinity", humidity: 50, source: "usb" }).errors.length > 0);
  assert.ok(validateReading({ temperature: 500, humidity: 50, source: "usb" }).errors[0].includes("between"));
  assert.ok(validateReading({ temperature: 20, humidity: 50, source: "wifi" }).errors[0].includes("source"));
  assert.ok(validateReading(null).errors.length > 0);
  assert.ok(validateReading([1, 2]).errors.length > 0);
});

// ---------------- facts ----------------
test("buildFacts: threshold status, trend and sample count", () => {
  const newestFirst = [30, 29, 24, 23, 22, 21].map((temperature, i) => ({
    temperature, humidity: 50, source: "usb", isSample: i === 0, createdAt: new Date(Date.now() - i * 1000),
  }));
  const facts = buildFacts(newestFirst, { temperature: { min: 18, max: 28 } });
  const t = facts.fields.find((f) => f.name === "temperature");
  assert.equal(t.latest, 30);
  assert.equal(t.status, "above maximum");
  assert.equal(t.recent.trend, "rising");
  assert.equal(facts.sampleReadingsIncluded, 1);
  assert.equal(facts.fields.find((f) => f.name === "humidity").recent.trend, "steady");
  assert.equal(facts.fields.some((f) => f.name === "co2"), false); // never invent missing channels
});

test("cleanThresholds reports bad input", () => {
  assert.equal(cleanThresholds({ temperature: { min: "abc" } }).errors.length, 1);
  assert.equal(cleanThresholds({ temperature: { min: 30, max: 20 } }).errors.length, 1);
  assert.deepEqual(cleanThresholds({ humidity: { max: "70" } }).thresholds, { humidity: { min: null, max: 70 } });
});

test("Seeded createdAt is kept by the schema timestamps", () => {
  const when = new Date("2025-01-01T00:00:00Z");
  const doc = new Reading({ source: "manual", temperature: 20, humidity: 40, createdAt: when });
  doc.initializeTimestamps?.();
  assert.equal(doc.createdAt.toISOString(), when.toISOString());
  assert.equal(doc.validateSync(), undefined);
});

// ---------------- auth ----------------
test("health is public and reports real state", async () => {
  const body = await (await call("/api/health")).json();
  assert.equal(body.status, "ok");
  assert.equal(body.database, "disconnected"); // no Mongo in this test
  assert.equal(body.ai, "not configured");
});

test("API routes reject missing, forged and expired tokens", async () => {
  assert.equal((await call("/api/readings")).status, 401);
  assert.equal((await call("/api/readings", { token: "abc.def" })).status, 401);
  const { data } = await signIn();
  const tampered = data.token.slice(0, -2) + (data.token.endsWith("AA") ? "BB" : "AA");
  assert.equal((await call("/api/readings", { token: tampered })).status, 401);
  assert.equal(verifyToken(data.token).u, "admin");
  assert.equal((await call("/api/ai/analyze", { method: "POST", body: {} })).status, 401);
});

test("login: wrong password rejected, right password returns role", async () => {
  assert.equal((await signIn("admin", "nope")).res.status, 401);
  assert.equal((await signIn("ghost", "admin-pass")).res.status, 401);
  const { res, data } = await signIn("Trainee", "trainee-pass"); // case-insensitive username
  assert.equal(res.status, 200);
  assert.equal(data.user.role, "Trainee");
  assert.equal((await call("/api/auth/me", { token: data.token })).status, 200);
});

// ---------------- readings ----------------
test("POST /api/readings validates and saves; GET lists", async () => {
  const { data } = await signIn();
  const bad = await call("/api/readings", { token: data.token, method: "POST", body: { temperature: " ", humidity: 40, source: "manual" } });
  assert.equal(bad.status, 400);
  assert.equal(saved.length, 0);

  const ok = await call("/api/readings", { token: data.token, method: "POST", body: { temperature: 21.5, humidity: 40, source: "manual", isSample: true } });
  assert.equal(ok.status, 201);
  assert.equal(saved[0].temperature, 21.5);
  assert.equal("isSample" in saved[0], false); // clients cannot mark data as sample

  const malformed = await call("/api/readings", { token: data.token, method: "POST", body: "{not json" });
  assert.equal(malformed.status, 400);

  stored.push({ _id: "1", temperature: 21.5, humidity: 40, source: "manual", createdAt: new Date() });
  assert.equal((await (await call("/api/readings?limit=5", { token: data.token })).json()).length, 1);
  assert.equal((await call("/api/readings/latest", { token: data.token })).status, 200);
});

// ---------------- AI ----------------
test("AI: missing key still returns the calculated facts", async () => {
  const { data } = await signIn();
  const res = await call("/api/ai/analyze", { token: data.token, method: "POST", body: { thresholds: { temperature: { max: 20 } } } });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.facts.fields[0].status, "above maximum");
});

test("AI: success path, empty answer, and cooldown", async () => {
  process.env.GEMINI_API_KEY = "fake-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash"; // thinking is only switched off for this model
  const realFetch = globalThis.fetch;
  let geminiBody;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage")) {
      geminiBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "What the readings show: fine." }] } }] }), { status: 200 });
    }
    return realFetch(url, options);
  };
  try {
    const { data } = await signIn();
    const res = await call("/api/ai/analyze", { token: data.token, method: "POST", body: {} });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.explanation, /fine/);
    assert.deepEqual(geminiBody.generationConfig.thinkingConfig, { thinkingBudget: 0 });

    const again = await call("/api/ai/analyze", { token: data.token, method: "POST", body: {} });
    assert.equal(again.status, 429); // 10 second cooldown
    assert.ok((await again.json()).facts);
  } finally {
    globalThis.fetch = realFetch;
    process.env.GEMINI_API_KEY = "";
  }
});
