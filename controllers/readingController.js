import Reading, { SENSOR_FIELDS, SOURCES } from "../models/Reading.js";

// Checks the request body and returns { data, errors }.
// This is the ONLY place where reading validation happens.
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function validateReading(body) {
  const errors = [];
  const data = {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { data, errors: ["Request body must be a JSON object"] };
  }

  for (const field of SENSOR_FIELDS) {
    const value = body[field.name];
    // A whitespace-only string counts as blank (Number("  ") would silently become 0)
    const blank = value === undefined || value === null || (typeof value === "string" && value.trim() === "");
    if (blank) {
      if (field.required) errors.push(`${field.name} is required`);
      continue;
    }
    if (typeof value !== "number" && typeof value !== "string") {
      errors.push(`${field.name} must be a number`);
      continue;
    }
    // Plain decimal strings only: rejects "0x10", "Infinity", "1,5" and similar surprises
    if (typeof value === "string" && !DECIMAL.test(value.trim())) {
      errors.push(`${field.name} must be a valid number`);
      continue;
    }
    const num = Number(value);
    if (!Number.isFinite(num)) errors.push(`${field.name} must be a valid number`);
    else if (num < field.min || num > field.max) errors.push(`${field.name} must be between ${field.min} and ${field.max}`);
    else data[field.name] = num;
  }

  if (!SOURCES.includes(body.source)) errors.push(`source must be one of: ${SOURCES.join(", ")}`);
  else data.source = body.source;
  return { data, errors };
}

// POST /api/readings
export async function createReading(req, res) {
  const { data, errors } = validateReading(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: "Invalid reading", details: errors });
  }

  try {
    const reading = await Reading.create(data);
    res.status(201).json(reading);
  } catch (err) {
    console.error("Failed to save reading:", err.message);
    res.status(500).json({ error: "Could not save the reading" });
  }
}

// GET /api/readings?limit=50  (newest first)
export async function getReadings(req, res) {
  // Default 50, minimum 1, maximum 200
  let limit = parseInt(req.query.limit, 10);
  if (Number.isNaN(limit)) limit = 50;
  limit = Math.min(Math.max(limit, 1), 200);

  try {
    const readings = await Reading.find().select("-__v").sort({ createdAt: -1 }).limit(limit).lean();
    res.json(readings);
  } catch (err) {
    console.error("Failed to fetch readings:", err.message);
    res.status(500).json({ error: "Could not fetch readings" });
  }
}

// GET /api/readings/latest
export async function getLatestReading(req, res) {
  try {
    const reading = await Reading.findOne().select("-__v").sort({ createdAt: -1 }).lean();
    if (!reading) {
      return res.status(404).json({ error: "No readings yet" });
    }
    res.json(reading);
  } catch (err) {
    console.error("Failed to fetch latest reading:", err.message);
    res.status(500).json({ error: "Could not fetch the latest reading" });
  }
}
