import dns from "node:dns";
import "dotenv/config"; // loads backend/.env into process.env
import mongoose from "mongoose";
import { createApp } from "./app.js";
import { initAuth, usingDemoDefaults } from "./auth.js";

// Some routers/resolvers reject Node's SRV lookup that Atlas ("mongodb+srv://") needs.
// Default: use Google DNS. Set DNS_SERVERS=system to keep your own resolver,
// or DNS_SERVERS=1.1.1.1,1.0.0.1 to choose different ones.
const dnsSetting = (process.env.DNS_SERVERS || "8.8.8.8,8.8.4.4").trim();
if (dnsSetting.toLowerCase() !== "system") {
  dns.setServers(dnsSetting.split(",").map((server) => server.trim()).filter(Boolean));
}

const PORT = process.env.PORT || 5000;

async function start() {
  if (!process.env.MONGODB_URI || process.env.MONGODB_URI.startsWith("your_")) {
    console.error("MONGODB_URI is missing. Copy .env.example to .env and add your Atlas connection string.");
    process.exit(1);
  }
  try {
    initAuth();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (usingDemoDefaults) {
    console.warn("WARNING: using DEMO login passwords (admin/admin123, trainee/trainee123). Set ADMIN_PASSWORD and TRAINEE_PASSWORD in backend/.env before sharing this app.");
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection failed:", err.message);
    console.error("Check the connection string, the database user/password, and that your IP is allowed in Atlas > Network Access.");
    process.exit(1);
  }

  const server = createApp().listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  server.on("error", (err) => {
    console.error(err.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Stop the other program or change PORT in backend/.env.` : err.message);
    process.exit(1);
  });

  const shutdown = async () => {
    server.close();
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start();
