// ── routes/billing/billing.js ─────────────────────────────────────────────────

import { nowBST, endOfDayBST, parseDateStringToBSTEndOfDay } from "../../utils/time.js";
import { generateMonthlyBills, retryFailedLabs } from "../../jobs/generateMonthlyBills.js";

import { ObjectId } from "@fastify/mongodb";

const BST_OFFSET_MS = 6 * 60 * 60 * 1000;

const toOid = (v) => {
  try {
    return new ObjectId(v);
  } catch {
    return null;
  }
};

async function billingRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("billings");
  const runsCol = () => fastify.mongo.db.collection("billingRuns");

  // ── GET /billing/unpaid-labs ──────────────────────────────────────────────
  fastify.get(
    "/billing/unpaid-labs",
    {
      schema: {
        tags: ["Billing"],
        summary: "Labs with unpaid bills — grouped summary only (no history)",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            skip: { type: "integer", minimum: 0, default: 0 },
            search: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const limit = Math.min(req.query.limit ?? 20, 100);
        const skip = req.query.skip ?? 0;
        const search = req.query.search?.trim() || null;

        const searchStage = search
          ? [
              {
                $match: {
                  $or: [{ "labDoc.labKey": search }, { "labDoc.name": { $regex: search, $options: "i" } }],
                },
              },
            ]
          : [];

        const pipeline = [
          { $match: { status: "unpaid" } },
          { $sort: { billingPeriodStart: -1 } },
          {
            $group: {
              _id: "$labId",
              unpaidTotal: { $sum: "$totalAmount" },
              bills: {
                $push: {
                  billingId: "$_id",
                  billingPeriodStart: "$billingPeriodStart",
                  billingPeriodEnd: "$billingPeriodEnd",
                  dueDate: "$dueDate",
                  totalAmount: "$totalAmount",
                  invoiceCount: "$invoiceCount",
                },
              },
            },
          },
          {
            $lookup: {
              from: "labs",
              localField: "_id",
              foreignField: "_id",
              as: "labDoc",
              pipeline: [{ $project: { name: 1, labKey: 1, isActive: 1 } }],
            },
          },
          { $unwind: { path: "$labDoc", preserveNullAndEmptyArrays: false } },
          ...searchStage,
          { $sort: { unpaidTotal: -1 } },
          {
            $facet: {
              total: [{ $count: "n" }],
              labs: [{ $skip: skip }, { $limit: limit }],
            },
          },
        ];

        const [result] = await col().aggregate(pipeline).toArray();

        const total = result?.total?.[0]?.n ?? 0;
        const now = Date.now();
        const MONTH_FMT = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" });

        const labs = (result?.labs ?? []).map((doc) => ({
          labId: doc._id,
          labKey: doc.labDoc.labKey,
          labName: doc.labDoc.name,
          isActive: doc.labDoc.isActive,
          unpaidTotal: doc.unpaidTotal,
          unpaidMonths: doc.bills.map((b) => ({
            billingId: b.billingId,
            month: MONTH_FMT.format(new Date(b.billingPeriodStart + BST_OFFSET_MS)),
            billingPeriodStart: b.billingPeriodStart,
            billingPeriodEnd: b.billingPeriodEnd,
            dueDate: b.dueDate,
            isOverdue: now > b.dueDate,
            totalAmount: b.totalAmount,
            invoiceCount: b.invoiceCount ?? 0,
          })),
        }));

        return reply.send({ labs, total });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch unpaid labs" });
      }
    },
  );

  // ── GET /billing/lab/:labKey/history ──────────────────────────────────────
  fastify.get(
    "/billing/lab/:labKey/history",
    {
      schema: {
        tags: ["Billing"],
        summary: "Paginated billing history for a lab — fetched on demand",
        params: {
          type: "object",
          required: ["labKey"],
          properties: { labKey: { type: "string", minLength: 1, maxLength: 50 } },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 48, default: 12 },
            skip: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const lab = await fastify.mongo.db
          .collection("labs")
          .findOne({ labKey: req.params.labKey }, { projection: { name: 1, labKey: 1, isActive: 1 } });
        if (!lab) return reply.code(404).send({ error: "Lab not found" });

        const limit = Math.min(req.query.limit ?? 12, 48);
        const skip = req.query.skip ?? 0;

        const [bills, total, aggregate] = await Promise.all([
          col()
            .find(
              { labId: lab._id },
              {
                projection: {
                  // labId included so the frontend can mark bills paid directly
                  // from a history row (Pay button needs {billingId, labId}).
                  labId: 1,
                  status: 1,
                  totalAmount: 1,
                  dueDate: 1,
                  billingPeriodStart: 1,
                  billingPeriodEnd: 1,
                  invoiceCount: 1,
                  breakdown: 1,
                  paidAt: 1,
                },
              },
            )
            .sort({ billingPeriodStart: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(),

          col().countDocuments({ labId: lab._id }),

          col()
            .aggregate([
              { $match: { labId: lab._id } },
              { $group: { _id: "$status", count: { $sum: 1 }, total: { $sum: "$totalAmount" } } },
            ])
            .toArray(),
        ]);

        const stats = {
          paid: { count: 0, total: 0 },
          unpaid: { count: 0, total: 0 },
          free: { count: 0, total: 0 },
        };
        for (const g of aggregate) {
          if (g._id in stats) stats[g._id] = { count: g.count, total: g.total };
        }

        return reply.send({ lab, bills, total, stats });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch lab billing history" });
      }
    },
  );

  // ── GET /billing/lab/:labKey/summary ──────────────────────────────────────
  fastify.get(
    "/billing/lab/:labKey/summary",
    {
      schema: {
        tags: ["Billing"],
        summary: "Current unpaid bill + aggregate stats for a lab by labKey",
        params: {
          type: "object",
          required: ["labKey"],
          properties: { labKey: { type: "string", minLength: 1, maxLength: 50 } },
        },
      },
    },
    async (req, reply) => {
      try {
        const lab = await fastify.mongo.db
          .collection("labs")
          .findOne({ labKey: req.params.labKey }, { projection: { name: 1, labKey: 1, isActive: 1 } });
        if (!lab) return reply.code(404).send({ error: "Lab not found" });

        const [unpaidBill, aggregate] = await Promise.all([
          col().findOne({ labId: lab._id, status: "unpaid" }, { sort: { billingPeriodStart: -1 } }),
          col()
            .aggregate([
              { $match: { labId: lab._id } },
              { $group: { _id: "$status", count: { $sum: 1 }, total: { $sum: "$totalAmount" } } },
            ])
            .toArray(),
        ]);

        const stats = {
          paid: { count: 0, total: 0 },
          unpaid: { count: 0, total: 0 },
          free: { count: 0, total: 0 },
        };
        for (const g of aggregate) {
          if (g._id in stats) stats[g._id] = { count: g.count, total: g.total };
        }

        const currentBill = unpaidBill
          ? {
              id: unpaidBill._id,
              amount: unpaidBill.totalAmount,
              dueDate: unpaidBill.dueDate,
              isOverdue: Date.now() > unpaidBill.dueDate,
              billingPeriodStart: unpaidBill.billingPeriodStart,
              billingPeriodEnd: unpaidBill.billingPeriodEnd,
              invoiceCount: unpaidBill.invoiceCount,
              breakdown: unpaidBill.breakdown,
            }
          : null;

        return reply.send({ lab, currentBill, stats });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch lab billing summary" });
      }
    },
  );

  // ── GET /billing/runs ─────────────────────────────────────────────────────
  fastify.get(
    "/billing/runs",
    {
      schema: {
        tags: ["Billing"],
        summary: "Billing run history",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
            skip: { type: "integer", minimum: 0, default: 0 },
            hasErrors: { type: "string", enum: ["true", "false"] },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const limit = Math.min(req.query.limit ?? 20, 50);
        const skip = req.query.skip ?? 0;
        const filter = req.query.hasErrors === "true" ? { hasErrors: true } : {};

        const runs = await runsCol()
          .find(filter, {
            projection: {
              period: 1,
              billingPeriodStart: 1,
              triggeredBy: 1,
              triggeredAt: 1,
              totalLabs: 1,
              generated: 1,
              free: 1,
              skipped: 1,
              failedCount: 1,
              failedLabs: 1,
              hasErrors: 1,
              lastRetryAt: 1,
              retryResult: 1,
            },
          })
          .sort({ triggeredAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        return reply.send({ runs });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch billing runs" });
      }
    },
  );

  // ── GET /billing/month-overview ───────────────────────────────────────────
  fastify.get(
    "/billing/month-overview",
    {
      schema: {
        tags: ["Billing"],
        summary: "All billing periods grouped with paid/unpaid/free stats",
      },
    },
    async (req, reply) => {
      try {
        const pipeline = [
          {
            $group: {
              _id: "$billingPeriodStart",
              billingPeriodEnd: { $first: "$billingPeriodEnd" },
              totalLabs: { $sum: 1 },
              paidCount: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, 1, 0] } },
              unpaidCount: { $sum: { $cond: [{ $eq: ["$status", "unpaid"] }, 1, 0] } },
              freeCount: { $sum: { $cond: [{ $eq: ["$status", "free"] }, 1, 0] } },
              paidTotal: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$totalAmount", 0] } },
              unpaidTotal: { $sum: { $cond: [{ $eq: ["$status", "unpaid"] }, "$totalAmount", 0] } },
              freeTotal: { $sum: { $cond: [{ $eq: ["$status", "free"] }, "$totalAmount", 0] } },
            },
          },
          { $sort: { _id: -1 } },
        ];

        const rows = await col().aggregate(pipeline).toArray();

        const MONTH_FMT = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" });

        const months = rows.map((r) => {
          const bstDate = new Date(r._id + BST_OFFSET_MS);
          return {
            // e.g. "2026-03" — used as the <select> key/value in the frontend
            period: bstDate.toISOString().slice(0, 7),
            // e.g. "Mar 2026"
            label: MONTH_FMT.format(bstDate),
            periodStart: r._id,
            periodEnd: r.billingPeriodEnd,
            totalLabs: r.totalLabs,
            paid: { count: r.paidCount, total: r.paidTotal },
            unpaid: { count: r.unpaidCount, total: r.unpaidTotal },
            free: { count: r.freeCount, total: r.freeTotal },
          };
        });

        return reply.send({ months });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch month overview" });
      }
    },
  );

  // ── POST /billing/pay/:billingId ──────────────────────────────────────────
  fastify.post(
    "/billing/pay/:billingId",
    {
      schema: {
        tags: ["Billing"],
        summary: "Mark a bill as paid",
        params: {
          type: "object",
          required: ["billingId"],
          properties: { billingId: { type: "string", minLength: 24, maxLength: 24 } },
        },
        body: {
          type: "object",
          required: ["labId"],
          properties: { labId: { type: "string", minLength: 24, maxLength: 24 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        const billingOid = toOid(req.params.billingId);
        const labOid = toOid(req.body.labId);
        if (!billingOid || !labOid) return reply.code(400).send({ error: "Invalid ID format" });

        const result = await col().updateOne(
          { _id: billingOid, labId: labOid, status: "unpaid" },
          { $set: { status: "paid", paidAt: Date.now(), paidBy: { id: "admin", name: "Admin" } } },
        );

        if (result.matchedCount === 0) {
          return reply.code(404).send({ error: "Bill not found or already paid" });
        }

        // Fire-and-forget cache invalidation on the hospital backend.
        // Not awaited — worst case is a 5-min-stale billing status.
        fetch(`${process.env.LAB_API_INTERNAL_URL}/internal/billing/cache-invalidate/${req.body.labId}`, {
          method: "POST",
          headers: { "x-internal-secret": process.env.INTERNAL_SECRET },
        }).catch(() => {});

        return reply.send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to mark bill as paid" });
      }
    },
  );

  // ── PATCH /billing/:billingId/due-date ────────────────────────────────────
  fastify.patch(
    "/billing/:billingId/due-date",
    {
      schema: {
        tags: ["Billing"],
        summary: "Extend due date of an unpaid bill (max +10 days)",
        params: {
          type: "object",
          required: ["billingId"],
          properties: { billingId: { type: "string", minLength: 24, maxLength: 24 } },
        },
        body: {
          type: "object",
          required: ["dueDate"],
          properties: {
            dueDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        const oid = toOid(req.params.billingId);
        if (!oid) return reply.code(400).send({ error: "Invalid billing ID" });

        let newDueDateMs;
        try {
          newDueDateMs = parseDateStringToBSTEndOfDay(req.body.dueDate);
        } catch (e) {
          return reply.code(400).send({ error: e.message });
        }

        if (newDueDateMs <= Date.now()) {
          return reply.code(400).send({ error: "Due date must be in the future (BST)." });
        }

        const bill = await col().findOne({ _id: oid, status: "unpaid" }, { projection: { dueDate: 1, labId: 1 } });
        if (!bill) return reply.code(404).send({ error: "Bill not found or is not unpaid." });

        const maxAllowedMs = endOfDayBST(bill.dueDate + 10 * 24 * 60 * 60 * 1000);
        if (newDueDateMs > maxAllowedMs) {
          const maxBSTDate = new Date(maxAllowedMs + BST_OFFSET_MS).toISOString().slice(0, 10);
          return reply.code(400).send({
            error: `Max allowed: ${maxBSTDate} (BST). Cannot extend more than 10 days.`,
            maxAllowedBSTDate: maxBSTDate,
          });
        }

        await col().updateOne({ _id: oid }, { $set: { dueDate: newDueDateMs } });

        // Fire-and-forget cache invalidation on the hospital backend.
        // Not awaited — worst case is a 5-min-stale due date.
        fetch(`${process.env.LAB_API_INTERNAL_URL}/internal/billing/cache-invalidate/${bill.labId}`, {
          method: "POST",
          headers: { "x-internal-secret": process.env.INTERNAL_SECRET },
        }).catch(() => {});

        return reply.send({ success: true, dueDate: newDueDateMs, dueDateBST: req.body.dueDate });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to update due date." });
      }
    },
  );

  // ── POST /billing/generate ────────────────────────────────────────────────
  fastify.post(
    "/billing/generate",
    {
      schema: {
        tags: ["Billing"],
        summary: "Manually trigger bill generation (idempotent per period)",
        body: {
          type: "object",
          properties: {
            year: { type: "integer", minimum: 2024, maximum: 2100 },
            month: { type: "integer", minimum: 1, maximum: 12 },
            dueDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        const body = req.body ?? {};
        const options = { triggeredBy: "manual" };

        if (body.year != null || body.month != null) {
          if (body.year == null || body.month == null) {
            return reply.code(400).send({ error: "Both year and month must be provided together." });
          }
          const bstNow = nowBST();
          const y = parseInt(body.year, 10);
          const m = parseInt(body.month, 10);
          if (y > bstNow.year || (y === bstNow.year && m >= bstNow.month)) {
            return reply.code(400).send({
              error: `Cannot generate bills for ${y}-${String(m).padStart(2, "0")}. Month must have ended (BST).`,
            });
          }
          options.year = y;
          options.month = m;
        }

        if (body.dueDate) {
          try {
            options.dueDateMs = parseDateStringToBSTEndOfDay(body.dueDate);
          } catch (e) {
            return reply.code(400).send({ error: e.message });
          }
          if (options.dueDateMs <= Date.now()) {
            return reply.code(400).send({ error: "dueDate must be a future date (BST)." });
          }
        }

        generateMonthlyBills(fastify.mongo.db, options).catch(() => {});

        return reply.send({
          message: "Bill generation started",
          options: {
            year: options.year ?? "auto (previous BST month)",
            month: options.month ?? "auto (previous BST month)",
            dueDate: body.dueDate ?? `${process.env.BILLING_DUE_DAYS ?? 7} days from now (BST)`,
          },
        });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to start bill generation" });
      }
    },
  );

  // ── POST /billing/runs/:runId/retry-failed ────────────────────────────────
  fastify.post(
    "/billing/runs/:runId/retry-failed",
    {
      schema: {
        tags: ["Billing"],
        summary: "Retry failed labs from a billing run",
        params: {
          type: "object",
          required: ["runId"],
          properties: { runId: { type: "string", minLength: 24, maxLength: 24 } },
        },
      },
    },
    async (req, reply) => {
      try {
        const oid = toOid(req.params.runId);
        if (!oid) return reply.code(400).send({ error: "Invalid run ID" });

        const run = await runsCol().findOne(
          { _id: oid },
          { projection: { failedLabs: 1, billingPeriodStart: 1, period: 1 } },
        );
        if (!run) return reply.code(404).send({ error: "Run not found" });
        if (!run.failedLabs?.length) return reply.send({ message: "No failed labs in this run" });

        retryFailedLabs(fastify.mongo.db, run).catch(() => {});

        return reply.send({ message: `Retrying ${run.failedLabs.length} failed lab(s) from ${run.period}` });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to start retry" });
      }
    },
  );

  // ── GET /billing/period-bills ─────────────────────────────────────────────
  fastify.get(
    "/billing/period-bills",
    {
      schema: {
        tags: ["Billing"],
        summary: "All bills for a specific period — with lab name, status, amount",
        querystring: {
          type: "object",
          required: ["periodStart"],
          properties: {
            periodStart: { type: "integer" },
            skip: { type: "integer", minimum: 0, default: 0 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
            status: { type: "string", enum: ["paid", "unpaid", "free"] },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const periodStart = parseInt(req.query.periodStart, 10);
        if (!Number.isFinite(periodStart)) {
          return reply.code(400).send({ error: "periodStart must be a valid integer timestamp" });
        }

        const limit = Math.min(req.query.limit ?? 30, 100);
        const skip = req.query.skip ?? 0;

        const matchStage = { billingPeriodStart: periodStart };
        if (req.query.status) matchStage.status = req.query.status;

        const pipeline = [
          { $match: matchStage },
          {
            $lookup: {
              from: "labs",
              localField: "labId",
              foreignField: "_id",
              as: "labDoc",
              pipeline: [{ $project: { name: 1, labKey: 1, isActive: 1 } }],
            },
          },
          { $unwind: { path: "$labDoc", preserveNullAndEmptyArrays: true } },
          {
            $project: {
              status: 1,
              totalAmount: 1,
              dueDate: 1,
              paidAt: 1,
              invoiceCount: 1,
              billingPeriodStart: 1,
              billingPeriodEnd: 1,
              labName: { $ifNull: ["$labDoc.name", "Unknown"] },
              labKey: { $ifNull: ["$labDoc.labKey", null] },
              isActive: { $ifNull: ["$labDoc.isActive", false] },
            },
          },
          { $sort: { status: 1, totalAmount: -1 } },
          {
            $facet: {
              total: [{ $count: "n" }],
              bills: [{ $skip: skip }, { $limit: limit }],
            },
          },
        ];

        const [result] = await col().aggregate(pipeline).toArray();

        return reply.send({
          bills: result?.bills ?? [],
          total: result?.total?.[0]?.n ?? 0,
        });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch period bills" });
      }
    },
  );

  // ── DELETE /billing/period/:periodStart ───────────────────────────────────────
  fastify.delete(
    "/billing/period/:periodStart",
    {
      schema: {
        tags: ["Billing"],
        summary: "Delete all bills for a specific billing period",
        params: {
          type: "object",
          required: ["periodStart"],
          properties: { periodStart: { type: "string", pattern: "^\\d+$" } },
        },
      },
    },
    async (req, reply) => {
      try {
        const periodStart = parseInt(req.params.periodStart, 10);
        if (!Number.isFinite(periodStart)) {
          return reply.code(400).send({ error: "Invalid periodStart" });
        }

        // Dry-run count first so we can return how many were deleted
        const count = await col().countDocuments({ billingPeriodStart: periodStart });
        if (count === 0) {
          return reply.code(404).send({ error: "No bills found for this period" });
        }

        await col().deleteMany({ billingPeriodStart: periodStart });

        return reply.send({ success: true, deleted: count });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to delete period bills" });
      }
    },
  );
}

export default billingRoutes;
