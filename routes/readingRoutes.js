import express from "express";
import {
  createReading,
  getReadings,
  getLatestReading,
} from "../controllers/readingController.js";

const router = express.Router();

router.post("/", createReading);
router.get("/latest", getLatestReading); // must be listed before "/"
router.get("/", getReadings);

export default router;
