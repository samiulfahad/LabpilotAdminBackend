import toObjectId from "../../utils/db.js";

/**
 * ── Scan route ────────────────────────────────────────────────────────────
 *
 * Powers a QR/link "scan" flow (e.g. patient scans a code printed on their
 * invoice/report) to check invoice + report status before allowing report
 * downloads. Read-only, data-shaping only — no writes here.
 *
 * Looked up by labId + the invoice's Mongo _id — both 24-char hex
 * ObjectId strings. labId scopes the lookup to the correct lab (there's
 * no JWT here to derive it from, since this is a public route) and
 * protects against cross-lab enumeration.
 *
 * Response is pre-shaped for the frontend to render directly:
 *   - labId + invoiceId, so the frontend can call the per-test report
 *     endpoint later without depending on the URL route params (the
 *     in-app camera scanner flow has no route params — only the QR
 *     landing-page flow does)
 *   - patient info
 *   - payment info (final/paid/due + isFullyPaid)
 *   - test list with testId, name, online/offline flag, and per-test completion
 *   - aggregate counts (total/online/offline, completed online count)
 *   - canDownloadReports: true only when the invoice is fully paid AND
 *     every online test's report is completed. Offline tests have no
 *     report to download, so they don't block this flag — they just
 *     don't count toward "reports" at all.
 * ────────────────────────────────────────────────────────────────────────
 */

// ─── Helpers ──────────────────────────────────────────────────────────────

const HEX24 = /^[a-fA-F0-9]{24}$/;

const round2 = (n) => Math.round(n * 100) / 100;

// ─── Route Schema ─────────────────────────────────────────────────────────

const scanInvoiceSchema = {
  schema: {
    tags: ["Scan"],
    summary: "Look up an invoice by labId + Mongo _id, for the scan/report view",
    params: {
      type: "object",
      required: ["labId", "invoiceId"],
      properties: {
        labId: {
          type: "string",
          minLength: 24,
          maxLength: 24,
          description: "Mongo ObjectId of the lab",
        },
        invoiceId: {
          type: "string",
          minLength: 24,
          maxLength: 24,
          description: "Mongo ObjectId (_id) of the invoice",
        },
      },
    },
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────

async function scanRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("invoices");

  // No fastify.authenticate hook — this is a public scan/verification
  // endpoint (QR code on a printed invoice/report), same pattern as
  // GET /invoice/:invoiceId and GET /invoice/search in invoiceRoutes.js.
  // labId is required in the path specifically because there's no JWT here
  // to derive it from.

  // ── GET /scan/:labId/:invoiceId ─────────────────────────────────────────
  fastify.get("/scan/:labId/:invoiceId", scanInvoiceSchema, async (req, reply) => {
    try {
      const { labId, invoiceId } = req.params;

      if (!HEX24.test(labId) || !HEX24.test(invoiceId)) {
        return reply.code(400).send({ error: "Invalid ID" });
      }

      const invoice = await col().findOne(
        {
          _id: toObjectId(invoiceId),
          labId: toObjectId(labId),
          "deletion.status": false,
        },
        {
          projection: {
            _id: 0,
            invoiceId: 1,
            createdAt: 1,
            "patient.name": 1,
            "patient.gender": 1,
            "patient.age": 1,
            "patient.contactNumber": 1,
            "referrer.name": 1,
            "referrer.type": 1,
            "doctor.name": 1,
            "doctor.degree": 1,
            "tests.testId": 1,
            "tests.name": 1,
            "tests.price": 1,
            "tests.schemaId": 1,
            "tests.isCompleted": 1,
            "tests.report.reportDate": 1,
            "products.name": 1,
            "products.price": 1,
            "products.quantity": 1,
            "products.type": 1,
            "amount.final": 1,
            "amount.paid": 1,
            paymentMode: 1,
            "delivery.status": 1,
          },
        },
      );

      if (!invoice) {
        return reply.code(404).send({ error: "Invoice not found" });
      }

      const tests = (invoice.tests || []).map((t) => {
        const isOnline = !!t.schemaId;
        return {
          testId: t.testId?.toString() ?? null,
          name: t.name,
          price: t.price,
          isOnline,
          // Offline tests have no report to complete — treat as
          // "completed" so they never block canDownloadReports, but they
          // also aren't counted in onlineCompletedCount below.
          isCompleted: isOnline ? !!t.isCompleted : true,
          reportDate: isOnline ? (t.report?.reportDate ?? null) : null,
        };
      });

      const onlineTests = tests.filter((t) => t.isOnline);
      const offlineTests = tests.filter((t) => !t.isOnline);
      const onlineCompletedCount = onlineTests.filter((t) => t.isCompleted).length;
      const allOnlineCompleted = onlineTests.every((t) => t.isCompleted);

      const final = invoice.amount?.final ?? 0;
      const paid = invoice.amount?.paid ?? 0;
      const due = Math.max(0, round2(final - paid));
      const isFullyPaid = due <= 0;

      return reply.send({
        invoiceId: invoice.invoiceId,
        // Echo the validated route param back — the in-app camera scanner
        // flow has no URL route params to fall back on (only the printed
        // QR "landing page" flow does), so the frontend needs this in the
        // payload to call the per-test report endpoint afterward.
        labId,
        createdAt: invoice.createdAt,

        patient: {
          name: invoice.patient?.name ?? "",
          gender: invoice.patient?.gender ?? "",
          age: invoice.patient?.age ?? null,
          contactNumber: invoice.patient?.contactNumber ?? "",
        },

        referrer: invoice.referrer?.name ? { name: invoice.referrer.name, type: invoice.referrer.type ?? null } : null,

        doctor: invoice.doctor?.name ? { name: invoice.doctor.name, degree: invoice.doctor.degree ?? null } : null,

        payment: {
          paymentMode: invoice.paymentMode,
          final,
          paid,
          due,
          isFullyPaid,
        },

        delivered: !!invoice.delivery?.status,

        tests,
        products: (invoice.products || []).map((p) => ({
          name: p.name,
          price: p.price,
          quantity: p.quantity,
          type: p.type,
        })),

        counts: {
          testCount: tests.length,
          onlineCount: onlineTests.length,
          offlineCount: offlineTests.length,
          onlineCompletedCount,
        },

        // The one flag the frontend needs to decide whether to show the
        // "Download Reports" button: fully paid AND every online test's
        // report is done. Offline-only invoices with no online tests are
        // vacuously "all completed" but have nothing to download — the
        // frontend should separately check onlineCount > 0 before showing
        // the button.
        allTestsCompleted: allOnlineCompleted,
        canDownloadReports: isFullyPaid && allOnlineCompleted && onlineTests.length > 0,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch invoice" });
    }
  });
}

export default scanRoutes;
