// ── server.js  (admin backend) ────────────────────────────────────────────────

import "dotenv/config";

import Fastify from "fastify";
import cors from "@fastify/cors";
import cron from "node-cron";

import mongoPlugin from "./plugins/mongo.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./routes/auth/auth.js";
import categoryRoutes from "./routes/category/category.js";
import testRoutes from "./routes/test/test.js";
import labRoutes from "./routes/lab/lab.js";
import zoneRoutes from "./routes/zone/zone.js";
import testSchemaRoutes from "./routes/testSchema/testSchema.js";
import staticDataRoutes from "./routes/staticData/staticData.js";
import demoReportRoutes from "./routes/demoReport/demoReport.js";
import billingRoutes from "./routes/billing/billing.js";
import { generateMonthlyBills } from "./jobs/generateMonthlyBills.js";

const fastify = Fastify({
  disableRequestLogging: true,
  logger: {
    transport: {
      target: "pino-pretty",
      options: { ignore: "pid,hostname,level,time,reqId,req,res,responseTime" },
    },
  },
});

// ── CORS ──────────────────────────────────────────────────────────────────────
await fastify.register(cors, {
  origin: ["https://lpadmin.netlify.app", "http://localhost:5173"],
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
   credentials: true,
});

// ── Plugins ───────────────────────────────────────────────────────────────────
await fastify.register(mongoPlugin);
await fastify.register(authPlugin);

// ── Routes ────────────────────────────────────────────────────────────────────
const API = "/v1";

fastify.register(authRoutes, { prefix: API });
fastify.register(categoryRoutes, { prefix: API });
fastify.register(testRoutes, { prefix: API });
fastify.register(labRoutes, { prefix: API });
fastify.register(zoneRoutes, { prefix: API });
fastify.register(testSchemaRoutes, { prefix: API });
fastify.register(staticDataRoutes, { prefix: API });
fastify.register(demoReportRoutes, { prefix: API });
fastify.register(billingRoutes, { prefix: API });

// ── Health check ──────────────────────────────────────────────────────────────
fastify.get("/health", async () => ({ status: "ok" }));

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

try {
  await fastify.listen({ port: PORT, host: HOST });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

// ── Billing cron ──────────────────────────────────────────────────────────────
// Runs at 00:05 BST on the 1st of every month.
//   - Generates bills for the PREVIOUS month (postpaid model).
//   - Example: fires 2026-05-01 00:05 BST → bills April 2026.
//   - December bills are generated on January 1st — handled automatically.
//
// If the cron run fails, use POST /api/v1/billing/generate from the admin UI
// to trigger manually, optionally with a custom year/month and due date.
//
// Schedule: "5 0 1 * *"  =  minute 5, hour 0, day 1 of month, every month
// Override via BILLING_CRON_SCHEDULE env var if needed.

const cronSchedule = process.env.BILLING_CRON_SCHEDULE ?? "5 0 1 * *";

cron.schedule(
  cronSchedule,
  async () => {
    fastify.log.info("[cron] Monthly billing job starting");
    try {
      const result = await generateMonthlyBills(fastify.mongo.db, { triggeredBy: "cron" });
      fastify.log.info({ result }, "[cron] Monthly billing job complete");
    } catch (err) {
      fastify.log.error({ err }, "[cron] Monthly billing job failed — use admin UI to retry");
    }
  },
  { timezone: "Asia/Dhaka" }, // Cron fires in BST; all timestamps stored UTC internally
);
