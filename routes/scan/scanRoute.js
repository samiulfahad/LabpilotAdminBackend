import toObjectId from "../../utils/db.js";

const HEX24 = /^[a-fA-F0-9]{24}$/;
const round2 = (n) => Math.round(n * 100) / 100;

const LAB_LETTERHEAD_PROJECTION = {
  name: 1,
  tagline: 1,
  "contact.address": 1,
  "contact.publicEmail": 1,
  "contact.primary": 1,
  registrationNumber: 1,
};

function shapeLabInfo(lab) {
  if (!lab) return null;
  return {
    name: lab.name ?? "",
    tagline: lab.tagline ?? "",
    address: lab.contact?.address ?? "",
    email: lab.contact?.publicEmail ?? "",
    phone: lab.contact?.primary ?? "",
    regNo: lab.registrationNumber ? String(lab.registrationNumber) : "",
  };
}

const scanInvoiceSchema = {
  schema: {
    tags: ["Scan"],
    summary: "Look up an invoice by labId + Mongo _id, for the scan/report view",
    params: {
      type: "object",
      required: ["labId", "invoiceId"],
      properties: {
        labId: { type: "string", minLength: 24, maxLength: 24, description: "Mongo ObjectId of the lab" },
        invoiceId: { type: "string", minLength: 24, maxLength: 24, description: "Mongo ObjectId (_id) of the invoice" },
      },
    },
  },
};

const getReportSchema = {
  schema: {
    tags: ["Scan"],
    summary: "Public: get a completed test's report for viewing/downloading via a scanned invoice QR",
    params: {
      type: "object",
      required: ["labId", "invoiceId", "testId"],
      properties: {
        labId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the lab" },
        invoiceId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the invoice" },
        testId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the test" },
      },
    },
  },
};

async function scanRoutes(fastify) {
  const invoicesCollection = () => fastify.mongo.db.collection("invoices");
  const labsCollection = () => fastify.mongo.db.collection("labs");

  // ── GET /scan/:labId/:invoiceId ─────────────────────────────────────────
  fastify.get("/scan/:labId/:invoiceId", scanInvoiceSchema, async (req, reply) => {
    try {
      const { labId, invoiceId } = req.params;

      if (!HEX24.test(labId) || !HEX24.test(invoiceId)) {
        return reply.code(400).send({ error: "Invalid ID" });
      }

      const labObjectId = toObjectId(labId);
      const invoiceObjectId = toObjectId(invoiceId);
      if (!labObjectId || !invoiceObjectId) return reply.code(400).send({ error: "Invalid ID" });

      const [invoice, lab] = await Promise.all([
        invoicesCollection().findOne(
          {
            _id: invoiceObjectId,
            labId: labObjectId,
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
        ),
        labsCollection().findOne({ _id: labObjectId }, { projection: LAB_LETTERHEAD_PROJECTION }),
      ]);

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
          // Offline tests have no report to complete — treat as "completed"
          // so they never block canDownloadReports, but they also aren't
          // counted in onlineCompletedCount below.
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
        invoiceObjectId: invoiceId,
        labId,
        createdAt: invoice.createdAt,

        labInfo: shapeLabInfo(lab),

        patient: {
          name: invoice.patient?.name ?? "",
          gender: invoice.patient?.gender ?? "",
          age: invoice.patient?.age ?? null,
          contactNumber: invoice.patient?.contactNumber ?? "",
        },

        doctor: invoice.doctor?.name ? { name: invoice.doctor.name, degree: invoice.doctor.degree ?? null } : null,

        payment: { paymentMode: invoice.paymentMode, final, paid, due, isFullyPaid },
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

        allTestsCompleted: allOnlineCompleted,
        canDownloadReports: isFullyPaid && allOnlineCompleted && onlineTests.length > 0,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch invoice" });
    }
  });

  // ── GET /scan/:labId/:invoiceId/report/:testId ──────────────────────────
  fastify.get("/scan/:labId/:invoiceId/report/:testId", getReportSchema, async (req, reply) => {
    try {
      const { labId, invoiceId, testId } = req.params;
      if (![labId, invoiceId, testId].every((v) => HEX24.test(v))) {
        return reply.code(400).send({ error: "Invalid ID" });
      }

      const labObjectId = toObjectId(labId);
      const invoiceObjectId = toObjectId(invoiceId);
      if (!labObjectId || !invoiceObjectId) return reply.code(400).send({ error: "Invalid ID" });

      const invoice = await invoicesCollection().findOne({ _id: invoiceObjectId, labId: labObjectId });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });

      const test = (invoice.tests ?? []).find((t) => t.testId?.toString() === testId);
      if (!test) return reply.code(404).send({ error: "Test not found on this invoice" });

      // Re-derive the same gate the frontend uses for canDownloadReports —
      // never trust that the client only linked here when it was actually true.
      const isFullyPaid = (invoice.amount?.paid ?? 0) >= (invoice.amount?.final ?? 0);
      if (!isFullyPaid) return reply.code(403).send({ error: "Payment not completed for this invoice" });
      if (!test.schemaId) {
        return reply.code(400).send({ error: "This test is offline and has no downloadable report" });
      }
      if (!test.isCompleted) return reply.code(409).send({ error: "Report not ready yet" });

      const lab = await labsCollection().findOne({ _id: labObjectId }, { projection: LAB_LETTERHEAD_PROJECTION });

      return reply.send({
        report: test.report ?? {},
        testName: test.name,
        invoiceId: invoice.invoiceId,
        patient: {
          name: invoice.patient?.name ?? "",
          age: invoice.patient?.age ?? null,
          gender: invoice.patient?.gender ?? "",
          contactNumber: invoice.patient?.contactNumber ?? "",
        },
        doctor: invoice.doctor?.name ? { name: invoice.doctor.name, degree: invoice.doctor.degree ?? null } : null,
        labInfo: shapeLabInfo(lab),
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch report" });
    }
  });
}

export default scanRoutes;
