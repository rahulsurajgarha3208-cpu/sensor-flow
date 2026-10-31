// Adds (or removes) clearly-labelled SAMPLE readings so you can test the
// dashboard before the real sensor works.
//   npm run seed         -> adds 20 sample readings
//   npm run seed:clear   -> deletes all sample readings (real ones are kept)
import "dotenv/config";
import mongoose from "mongoose";
import Reading, { SENSOR_FIELDS } from "./models/Reading.js";

const clear = process.argv.includes("--clear");

try {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  if (clear) {
    const result = await Reading.deleteMany({ isSample: true });
    console.log(`Deleted ${result.deletedCount} sample readings`);
  } else {
    const COUNT = 20;
    const STEP_MS = 5 * 60 * 1000; // 5 minutes apart, ending now
    const docs = [];
    for (let i = 0; i < COUNT; i++) {
      const doc = {
        source: "manual",
        isSample: true,
        createdAt: new Date(Date.now() - (COUNT - 1 - i) * STEP_MS),
      };
      for (const field of SENSOR_FIELDS) {
        // Seeded values are synthetic demo data and are labelled isSample=true.
        const wave = Math.sin(i / 3);
        const presets = {
          temperature: 23 + wave * 2.5, humidity: 48 + wave * 8,
          pressure: 1012 + wave * 4, co2: 620 + wave * 80,
          airQuality: 32 + Math.abs(wave) * 18, light: 320 + wave * 70,
          noise: 38 + Math.abs(wave) * 6, voltage: 230 + wave * 2,
          current: 1.2 + Math.abs(wave) * 0.25, vibration: 1.1 + Math.abs(wave) * 0.3,
        };
        if (field.required || Object.hasOwn(presets, field.name)) {
          doc[field.name] = Number(presets[field.name].toFixed(2));
        }
      }
      docs.push(doc);
    }
    await Reading.insertMany(docs);
    console.log(`Inserted ${COUNT} SAMPLE readings (isSample = true)`);
  }
} catch (err) {
  console.error("Seed failed:", err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
