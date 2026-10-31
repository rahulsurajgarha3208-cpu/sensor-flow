import Reading, { SENSOR_FIELDS, SENSOR_DESCRIPTION } from "../models/Reading.js";
import { generateExplanation } from "../services/aiService.js";

const RECENT_COUNT = 10; // how many recent readings are analysed
const COOLDOWN_MS = 10 * 1000; // minimum time between two AI calls

// Simple protection against repeated AI requests (one server = one user here)
let lastAiCallAt = 0;
let aiBusy = false;

// ---------- Step 1: clean the thresholds sent by the frontend ----------
// Expected shape: { temperature: { min: 20, max: 30 }, humidity: { max: 70 } }
export function cleanThresholds(raw) {
  const thresholds = {};
  const errors = [];
  if (typeof raw !== "object" || raw === null) return { thresholds, errors };

  for (const field of SENSOR_FIELDS) {
    const entry = raw[field.name];
    if (typeof entry !== "object" || entry === null) continue;

    const toNumber = (value) =>
      value === undefined || value === null || value === "" ? null : Number(value);
    const min = toNumber(entry.min);
    const max = toNumber(entry.max);

    if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) {
      errors.push(`${field.name} thresholds must be numbers`);
    } else if (min !== null && max !== null && min > max) {
      errors.push(`${field.name}: minimum cannot be greater than maximum`);
    } else if (min !== null || max !== null) {
      thresholds[field.name] = { min, max };
    }
  }
  return { thresholds, errors };
}

// ---------- Step 2: facts calculated with plain JavaScript (no AI) ----------
const STEADY_FRACTION = 0.005; // a change below 0.5% of the sensor's full range counts as "steady"

// Values are oldest -> newest. With 4+ values we compare the average of the newer half
// with the average of the older half, so one noisy sample cannot flip the trend.
const mean = (list) => list.reduce((total, value) => total + value, 0) / list.length;
function trendChange(values) {
  if (values.length < 2) return 0;
  if (values.length < 4) return values[values.length - 1] - values[0];
  const half = Math.floor(values.length / 2);
  return mean(values.slice(-half)) - mean(values.slice(0, half));
}

function thresholdStatus(value, threshold) {
  if (!threshold) return "no threshold set";
  if (threshold.max !== null && value > threshold.max) return "above maximum";
  if (threshold.min !== null && value < threshold.min) return "below minimum";
  return "within the configured range";
}

export function buildFacts(readingsNewestFirst, thresholds) {
  const latest = readingsNewestFirst[0];
  const fields = SENSOR_FIELDS.flatMap((field) => {
    const validReadings = [...readingsNewestFirst].reverse().filter((reading) =>
      Number.isFinite(reading[field.name])
    );
    if (validReadings.length === 0) return [];

    const values = validReadings.map((reading) => reading[field.name]);
    const latestValue = values[values.length - 1];
    const change = trendChange(values);
    const steadyLimit = (field.max - field.min) * STEADY_FRACTION;
    let trend = "steady";
    if (values.length > 1 && change > steadyLimit) trend = "rising";
    if (values.length > 1 && change < -steadyLimit) trend = "falling";

    return [{
      name: field.name, label: field.label, unit: field.unit, latest: latestValue,
      latestTime: validReadings[validReadings.length - 1].createdAt,
      samplesAvailable: values.length,
      threshold: thresholds[field.name] || null,
      status: thresholdStatus(latestValue, thresholds[field.name]),
      recent: {
        min: Math.min(...values), max: Math.max(...values),
        average: Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(2)),
        change: Number(change.toFixed(2)), trend,
      },
    }];
  });

  return {
    readingsAnalysed: readingsNewestFirst.length,
    sampleReadingsIncluded: readingsNewestFirst.filter((r) => r.isSample).length,
    latestSource: latest.source, latestTime: latest.createdAt, fields,
  };
}

// ---------- Step 3: the text sent to the AI ----------
function buildPrompt(facts) {
  return `You are helping a beginner understand readings from ${SENSOR_DESCRIPTION}.

Below are MEASURED FACTS that were already calculated by the application.
Rules:
- Do not recalculate the facts and do not contradict them.
- Do not say that the situation is "safe" or "dangerous". Only report the threshold status given in the facts.
- If a field has no threshold, say that no threshold was set.
- If sampleReadingsIncluded is greater than 0, mention that some readings are sample data.
- Use simple language. Plain text only (no markdown symbols, no tables).
- Maximum 150 words, in exactly three short parts named: What the readings show, Trend, Suggested next steps.

FACTS (JSON):
${JSON.stringify(facts, null, 2)}`;
}

// ---------- The endpoint: POST /api/ai/analyze ----------
function fail(res, status, message, facts) {
  // Facts are included when we have them, so the dashboard can still show them
  res.status(status).json({ error: message, ...(facts ? { facts } : {}) });
}

export async function analyzeReadings(req, res) {
  const { thresholds, errors } = cleanThresholds(req.body?.thresholds);
  if (errors.length > 0) {
    return res.status(400).json({ error: "Invalid thresholds", details: errors });
  }

  let readings;
  try {
    readings = await Reading.find().sort({ createdAt: -1 }).limit(RECENT_COUNT);
  } catch (err) {
    console.error("Failed to load readings for AI:", err.message);
    return fail(res, 500, "Could not load readings");
  }
  if (readings.length === 0) {
    return fail(res, 404, "There are no readings to analyse yet");
  }

  const facts = buildFacts(readings, thresholds);

  const key = process.env.GEMINI_API_KEY;
  if (!key || key === "your_gemini_api_key_here") {
    return fail(res, 503, "AI is not configured. Add GEMINI_API_KEY to backend/.env and restart the server.", facts);
  }

  const waitMs = COOLDOWN_MS - (Date.now() - lastAiCallAt);
  if (aiBusy || waitMs > 0) {
    const seconds = Math.max(1, Math.ceil(waitMs / 1000));
    return fail(res, 429, `Please wait ${seconds} seconds before asking the AI again.`, facts);
  }

  aiBusy = true;
  lastAiCallAt = Date.now(); // failed calls count too, so errors cannot be hammered
  try {
    const result = await generateExplanation(buildPrompt(facts));
    res.json({
      facts,
      explanation: result.text,
      model: result.model,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("AI request failed:", err.message);
    fail(res, err.status || 502, err.message, facts);
  } finally {
    aiBusy = false;
  }
}
