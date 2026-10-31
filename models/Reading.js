import mongoose from "mongoose";

// Keep this catalogue aligned with frontend/src/sensorConfig.js and the JSON
// keys emitted by esp32/sensor.ino. Only temperature and humidity are required.
export const SENSOR_FIELDS = [
  { name: "temperature", label: "Temperature", unit: "°C", min: -40, max: 125, required: true },
  { name: "humidity", label: "Relative humidity", unit: "%RH", min: 0, max: 100, required: true },
  { name: "pressure", label: "Barometric pressure", unit: "hPa", min: 300, max: 1100, required: false },
  { name: "co2", label: "CO₂ concentration", unit: "ppm", min: 250, max: 5000, required: false },
  { name: "airQuality", label: "Air quality index", unit: "AQI", min: 0, max: 500, required: false },
  { name: "light", label: "Ambient light", unit: "lux", min: 0, max: 100000, required: false },
  { name: "noise", label: "Sound level", unit: "dBA", min: 0, max: 140, required: false },
  { name: "voltage", label: "Voltage", unit: "V", min: 0, max: 300, required: false },
  { name: "current", label: "Current", unit: "A", min: 0, max: 100, required: false },
  { name: "vibration", label: "Vibration RMS", unit: "mm/s", min: 0, max: 100, required: false },
];

export const SENSOR_DESCRIPTION =
  "a multi-channel environment and equipment monitor measuring temperature, humidity, and optional air-quality, light, sound, electrical, and vibration channels";
export const SOURCES = ["manual", "usb"];

const schemaFields = {
  source: { type: String, enum: SOURCES, required: true },
  isSample: { type: Boolean, default: false },
};
for (const field of SENSOR_FIELDS) {
  schemaFields[field.name] = { type: Number, required: field.required, min: field.min, max: field.max };
}

const readingSchema = new mongoose.Schema(schemaFields, {
  timestamps: { createdAt: true, updatedAt: false },
  minimize: true,
});
readingSchema.index({ createdAt: -1 });
export default mongoose.model("Reading", readingSchema);
