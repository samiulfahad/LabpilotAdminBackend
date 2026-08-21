/**
 * scanReportRoutes.js  (admin backend)
 *
 * Public counterpart to outdoorReportRoutes.js's GET /report/:invoiceId/:testId,
 * but keyed off the scan QR's shape (labId + invoice _id, both 24-char
 * ObjectId strings) instead of an authenticated staff session + human
 * invoiceId code. No fastify.authenticate hook — this is reached by patients
 * scanning their own printed invoice, same trust boundary as ScanRoute.js.
 *
 * Gating mirrors the frontend's `canDownloadReports` check in ScanInvoice.jsx
 * exactly, re-verified server-side so a crafted request can't skip it:
 *   - invoice must be fully paid
 *   - test must be an online test (has schemaId)
 *   - test must be completed
 */

import toObjectId from "../../utils/db.js";

const HEX24 = /^[a-fA-F0-9]{24}$/;

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

async function scanReportRoutes(fastify) {
  const invoicesCollection = () => fastify.mongo.db.collection("invoices");
  const labsCollection = () => fastify.mongo.db.collection("labs");

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

      // Re-derive the same gate ScanInvoice.jsx uses for canDownloadReports —
      // never trust that the client only linked here when it was actually true.
      const isFullyPaid = (invoice.amount?.paid ?? 0) >= (invoice.amount?.final ?? 0);
      if (!isFullyPaid) return reply.code(403).send({ error: "Payment not completed for this invoice" });
      if (!test.schemaId) {
        return reply.code(400).send({ error: "This test is offline and has no downloadable report" });
      }
      if (!test.isCompleted) return reply.code(409).send({ error: "Report not ready yet" });

      const lab = await labsCollection().findOne(
        { _id: labObjectId },
        {
          projection: {
            name: 1,
            tagline: 1,
            "contact.address": 1,
            "contact.publicEmail": 1,
            "contact.primary": 1,
            registrationNumber: 1,
            "medicalReport.padHeight": 1,
          },
        },
      );

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
        referrer: invoice.referrer ? { name: invoice.referrer.name } : null,
        labInfo: lab
          ? {
              name: lab.name ?? "",
              tagline: lab.tagline ?? "",
              address: lab.contact?.address ?? "",
              email: lab.contact?.publicEmail ?? "",
              phone: lab.contact?.primary ?? "",
              regNo: lab.registrationNumber ? String(lab.registrationNumber) : "",
              padHeight: lab.medicalReport?.padHeight ?? 0,
            }
          : null,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch report" });
    }
  });
}

export default scanReportRoutes;
