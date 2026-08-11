// ── jobs/generateMonthlyBills.js ─────────────────────────────────────────────
//
// Bill generation rules:
//  - Bills are POSTPAID: April's bill is generated on May 1st (BST) at 00:05.
//  - Period boundaries are stored as UTC ms (startOfMonthBST / endOfMonthBST).
//  - dueDate is always 23:59:59.999 BST of the Nth day after generation.
//  - Idempotent: re-running for the same period skips existing bills.
//  - December→January: handled automatically by month arithmetic.
//
//  Bill amount = monthlyFee + netInvoiceFee, where:
//    - lab.billing.forceInvoiceFee === true:
//        netInvoiceFee = (feePerInvoice - commission) * invoiceCount
//        (every invoice is charged the same flat fee, so no need to read
//         each invoice's own amount.invoiceFee)
//    - lab.billing.forceInvoiceFee === false:
//        netInvoiceFee = SUM(invoice.amount.invoiceFee) - commission * invoiceCount
//        (invoices may carry their own overridden fee, so sum what's
//         actually stored on them, then deduct commission per invoice)
//    netInvoiceFee is floored at 0 — a lab's invoice fees never discount
//    the monthly fee, they only ever add to it.

import { nowBST, endOfDayBST, startOfMonthBST, endOfMonthBST } from "../utils/time.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getPreviousMonth(bstNow) {
  let year = bstNow.year;
  let month = bstNow.month - 1; // previous month
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  return { year, month };
}

/**
 * One aggregation covering every lab's invoices for the period at once —
 * avoids an N+1 query per lab. Computes both invoiceCount and the raw
 * invoiceFee sum; the sum is cheap to include even for forceInvoiceFee
 * labs that end up not using it.
 * @returns {Map<string, { invoiceCount: number, totalInvoiceFee: number }>}
 */
async function getInvoiceStatsByLab(db, periodStartMs, periodEndMs) {
  const rows = await db
    .collection("invoices")
    .aggregate([
      {
        $match: {
          createdAt: { $gte: periodStartMs, $lte: periodEndMs },
          "deletion.status": { $ne: true },
        },
      },
      {
        $group: {
          _id: "$labId",
          invoiceCount: { $sum: 1 },
          totalInvoiceFee: { $sum: { $ifNull: ["$amount.invoiceFee", 0] } },
        },
      },
    ])
    .toArray();

  return new Map(rows.map((r) => [r._id.toString(), { invoiceCount: r.invoiceCount, totalInvoiceFee: r.totalInvoiceFee }]));
}

function buildBillingDoc(lab, { periodStartMs, periodEndMs, invoiceCount, totalInvoiceFee, dueDate, nowUtc }) {
  const monthlyFee = lab.billing?.monthlyFee ?? 0;
  const commission = lab.billing?.commission ?? 0;
  const forceInvoiceFee = lab.billing?.forceInvoiceFee === true;
  const feePerInvoice = lab.billing?.feePerInvoice ?? 0;

  const rawNetInvoiceFee = forceInvoiceFee
    ? (feePerInvoice - commission) * invoiceCount
    : totalInvoiceFee - commission * invoiceCount;

  // Invoice fees only ever add to the bill — never let them discount monthlyFee.
  const netInvoiceFee = Math.max(0, rawNetInvoiceFee);

  const totalAmount = monthlyFee + netInvoiceFee;
  const isFree = totalAmount <= 0;

  return {
    labId: lab._id,
    labKey: lab.labKey,
    // Store as UTC ms — consistent with createdAt, paidAt, etc.
    billingPeriodStart: periodStartMs,
    billingPeriodEnd: periodEndMs,
    invoiceCount,
    breakdown: {
      monthlyFee,
      forceInvoiceFee,
      feePerInvoice,
      commission,
      // Raw invoice-fee sum as stored on invoices — meaningful mainly when forceInvoiceFee is false.
      totalInvoiceFee,
      netInvoiceFee,
    },
    totalAmount: isFree ? 0 : totalAmount,
    status: isFree ? "free" : "unpaid",
    // dueDate is 23:59:59.999 BST of the due day, stored as UTC ms.
    // Free bills have no due date.
    dueDate: isFree ? null : dueDate,
    createdAt: nowUtc,
    paidAt: null,
    paidBy: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates monthly bills for all active labs.
 *
 * @param {import('mongodb').Db} db
 * @param {object} options
 * @param {number} [options.year]         - BST year  (manual trigger)
 * @param {number} [options.month]        - BST month, 1-indexed (manual trigger)
 * @param {string} [options.triggeredBy]  - "cron" | "manual"
 * @param {number} [options.dueDateMs]    - Override due date UTC ms (manual trigger only)
 */
export async function generateMonthlyBills(db, options = {}) {
  const DUE_DAYS = parseInt(process.env.BILLING_DUE_DAYS ?? "7", 10);
  const nowUtc = Date.now();
  const triggeredBy = options.triggeredBy ?? "cron";

  // ── Determine billing period ──────────────────────────────────────────────
  let year, month;

  if (options.year && options.month) {
    year = options.year;
    month = options.month; // 1-indexed BST month
  } else {
    // Automatic: bill for the previous BST month
    const bstNow = nowBST();
    ({ year, month } = getPreviousMonth(bstNow));
  }

  const periodStartMs = startOfMonthBST(year, month);
  const periodEndMs = endOfMonthBST(year, month);

  // ── Due date ──────────────────────────────────────────────────────────────
  // Manual trigger may supply an explicit due date; otherwise N days from now.
  // Always snapped to 23:59:59.999 BST of the target day.
  const dueDate =
    options.dueDateMs != null ? endOfDayBST(options.dueDateMs) : endOfDayBST(nowUtc + DUE_DAYS * 24 * 60 * 60 * 1000);

  const periodLabel = `${year}-${String(month).padStart(2, "0")}`;

  // ── Fetch all active labs ─────────────────────────────────────────────────
  const labs = await db
    .collection("labs")
    .find(
      { isActive: true, "deletion.status": { $ne: true } },
      { projection: { _id: 1, name: 1, labKey: 1, billing: 1 } },
    )
    .toArray();

  // ── One batched aggregation for every lab's invoice fees this period ───────
  const invoiceStatsByLab = await getInvoiceStatsByLab(db, periodStartMs, periodEndMs);

  let generated = 0;
  let free = 0;
  let skipped = 0;
  const failedLabs = [];

  for (const lab of labs) {
    try {
      // Idempotency: skip if a bill for this period already exists
      const exists = await db
        .collection("billings")
        .findOne({ labId: lab._id, billingPeriodStart: periodStartMs }, { projection: { _id: 1 } });
      if (exists) {
        skipped++;
        continue;
      }

      const stats = invoiceStatsByLab.get(lab._id.toString()) ?? { invoiceCount: 0, totalInvoiceFee: 0 };

      const doc = buildBillingDoc(lab, {
        periodStartMs,
        periodEndMs,
        invoiceCount: stats.invoiceCount,
        totalInvoiceFee: stats.totalInvoiceFee,
        dueDate,
        nowUtc,
      });

      await db.collection("billings").insertOne(doc);
      doc.status === "free" ? free++ : generated++;
    } catch (err) {
      failedLabs.push({
        labId: lab._id,
        labName: lab.name ?? "Unknown",
        error: err.message,
      });
    }
  }

  // ── Write run log ─────────────────────────────────────────────────────────
  const runDoc = {
    period: periodLabel,
    billingPeriodStart: periodStartMs,
    triggeredBy,
    triggeredAt: nowUtc,
    totalLabs: labs.length,
    generated,
    free,
    skipped,
    failedCount: failedLabs.length,
    failedLabs,
    hasErrors: failedLabs.length > 0,
  };

  await db.collection("billingRuns").insertOne(runDoc);

  console.log(
    "[billing]",
    JSON.stringify({ period: periodLabel, generated, free, skipped, failedCount: failedLabs.length }),
  );

  return runDoc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry failed labs from a previous run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {import('mongodb').Db} db
 * @param {object} run  - The billingRun document
 */
export async function retryFailedLabs(db, run) {
  const DUE_DAYS = parseInt(process.env.BILLING_DUE_DAYS ?? "7", 10);
  const nowUtc = Date.now();

  const periodStartMs = run.billingPeriodStart;
  const periodEndMs = endOfMonthBSTFromStartMs(periodStartMs);
  const dueDate = endOfDayBST(nowUtc + DUE_DAYS * 24 * 60 * 60 * 1000);

  // Batched, same as the main run — covers all still-failing labs in one query.
  const invoiceStatsByLab = await getInvoiceStatsByLab(db, periodStartMs, periodEndMs);

  const retried = [];
  const stillFailing = [];

  for (const failed of run.failedLabs) {
    try {
      const exists = await db
        .collection("billings")
        .findOne({ labId: failed.labId, billingPeriodStart: periodStartMs }, { projection: { _id: 1 } });
      if (exists) {
        retried.push({ labId: failed.labId, result: "already existed" });
        continue;
      }

      const lab = await db
        .collection("labs")
        .findOne(
          { _id: failed.labId, isActive: true, "deletion.status": { $ne: true } },
          { projection: { _id: 1, name: 1, labKey: 1, billing: 1 } },
        );

      if (!lab) {
        stillFailing.push({ labId: failed.labId, labName: failed.labName, error: "Lab not found or inactive" });
        continue;
      }

      const stats = invoiceStatsByLab.get(lab._id.toString()) ?? { invoiceCount: 0, totalInvoiceFee: 0 };

      const doc = buildBillingDoc(lab, {
        periodStartMs,
        periodEndMs,
        invoiceCount: stats.invoiceCount,
        totalInvoiceFee: stats.totalInvoiceFee,
        dueDate,
        nowUtc,
      });
      await db.collection("billings").insertOne(doc);

      retried.push({ labId: lab._id, labName: lab.name, result: "success" });
    } catch (err) {
      stillFailing.push({ labId: failed.labId, labName: failed.labName, error: err.message });
    }
  }

  await db.collection("billingRuns").updateOne(
    { _id: run._id },
    {
      $set: {
        failedLabs: stillFailing,
        failedCount: stillFailing.length,
        hasErrors: stillFailing.length > 0,
        lastRetryAt: nowUtc,
        retryResult: { retried, stillFailing },
      },
    },
  );

  console.log(
    "[billing-retry]",
    JSON.stringify({ period: run.period, retried: retried.length, stillFailing: stillFailing.length }),
  );

  return { retried, stillFailing };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper: derive period end from period start (stored as UTC ms)
// ─────────────────────────────────────────────────────────────────────────────
function endOfMonthBSTFromStartMs(startMs) {
  // Shift start to BST to read year/month
  const bstMs = startMs + 6 * 60 * 60 * 1000;
  const d = new Date(bstMs);
  return endOfMonthBST(d.getUTCFullYear(), d.getUTCMonth() + 1);
}