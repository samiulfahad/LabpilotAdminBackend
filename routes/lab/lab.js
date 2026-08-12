// labRoutes.js
import crypto from "node:crypto";
import toObjectId from "../../utils/db.js";

// ─── JSON Schemas ──────────────────────────────────────────────────────────

const OID = { type: "string", minLength: 24, maxLength: 24, pattern: "^[a-fA-F0-9]{24}$" };

const idParam = {
  type: "object",
  additionalProperties: false,
  properties: { id: OID },
};

const paginationQuery = {
  type: "object",
  properties: {
    page: { type: "integer", minimum: 1, default: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
    labKey: { type: "string" },
    zoneId: OID,
  },
};

const contactSchema = {
  type: "object",
  properties: {
    primary: { type: "string" },
    secondary: { type: "string" },
    publicEmail: { type: "string", format: "email" },
    privateEmail: { type: "string", format: "email" },
    address: { type: "string" },
    district: { type: "string" },
    zone: { type: "string" },
    zoneId: OID,
  },
  additionalProperties: false,
};

const billingSchema = {
  type: "object",
  properties: {
    feePerInvoice: { type: "number", minimum: 0 },
    forceInvoiceFee: { type: "boolean", default: false },
    monthlyFee: { type: "number", minimum: 0 },
    commission: { type: "number", minimum: 0 },
  },
  additionalProperties: false,
};

const limitSchema = {
  type: "object",
  properties: {
    maxStaff: { type: "integer", minimum: 0 },
    maxProduct: { type: "integer", minimum: 0 },
    maxService: { type: "integer", minimum: 0 },
    maxMedicine: { type: "integer", minimum: 0 },
    maxReferrer: { type: "integer", minimum: 0 },
    maxDoctor: { type: "integer", minimum: 0 },
    maxAdmissionSpace: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
};

const medicalReportSchema = {
  type: "object",
  properties: {
    padHeight: { type: "number", minimum: 0 },
  },
  additionalProperties: false,
};

const createLabBody = {
  type: "object",
  required: ["name", "labKey", "contact", "billing"],
  properties: {
    name: { type: "string", minLength: 1 },
    labKey: { type: "string", minLength: 1, maxLength: 5, pattern: "^[0-9]{1,5}$" },
    type: { type: "string", enum: ["diagnostic", "hospital"] },
    registrationNumber: { type: "string" },
    contact: contactSchema,
    billing: billingSchema,
    limit: limitSchema,
    medicalReport: medicalReportSchema,
    isActive: { type: "boolean", default: true },
  },
  additionalProperties: false,
};

const updateDetailsBody = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    type: { type: "string", enum: ["diagnostic", "hospital"] },
    registrationNumber: { type: "string" },
  },
  additionalProperties: false,
};

const updateContactBody = {
  type: "object",
  required: ["contact"],
  properties: { contact: contactSchema },
  additionalProperties: false,
};

const updateBillingBody = {
  type: "object",
  required: ["billing"],
  properties: { billing: billingSchema },
  additionalProperties: false,
};

const updateLimitBody = {
  type: "object",
  required: ["limit"],
  properties: { limit: limitSchema },
  additionalProperties: false,
};

const updateMedicalReportBody = {
  type: "object",
  required: ["medicalReport"],
  properties: { medicalReport: medicalReportSchema },
  additionalProperties: false,
};

// ─── Route Schemas ─────────────────────────────────────────────────────────

const listLabsSchema = {
  tags: ["Lab"],
  summary: "List labs (paginated, search by labKey)",
  querystring: paginationQuery,
};
const statsLabSchema = { tags: ["Lab"], summary: "Get lab stats (total, active, inactive, revenue)" };
const getLabSchema = { tags: ["Lab"], summary: "Get a lab by ID", params: idParam };
const createLabSchema = { tags: ["Lab"], summary: "Create a new lab", body: createLabBody };
const updateDetailsSchema = {
  tags: ["Lab"],
  summary: "Update Lab Details — name, type, registrationNumber",
  params: idParam,
  body: updateDetailsBody,
};
const updateContactSchema = { tags: ["Lab"], summary: "Update lab contact", params: idParam, body: updateContactBody };
const updateBillingSchema = {
  tags: ["Lab"],
  summary: "Update lab billing — feePerInvoice, forceInvoiceFee, monthlyFee, commission",
  params: idParam,
  body: updateBillingBody,
};
const updateLimitSchema = {
  tags: ["Lab"],
  summary:
    "Update Lab Limits — maxStaff, maxProduct, maxService, maxMedicine, maxReferrer, maxDoctor, maxAdmissionSpace",
  params: idParam,
  body: updateLimitBody,
};
const updateMedicalReportSchema = {
  tags: ["Lab"],
  summary: "Update Lab Medical Report — padHeight",
  params: idParam,
  body: updateMedicalReportBody,
};
const activateLabSchema = { tags: ["Lab"], summary: "Activate a lab", params: idParam };
const deactivateLabSchema = { tags: ["Lab"], summary: "Deactivate a lab", params: idParam };
const deleteLabSchema = { tags: ["Lab"], summary: "Delete a lab", params: idParam };

// Staff (view-only) schemas
const labIdParam = { type: "object", additionalProperties: false, properties: { labId: OID } };
const labStaffParam = { type: "object", additionalProperties: false, properties: { labId: OID, id: OID } };

const listStaffSchema = {
  tags: ["Staff"],
  summary: "List all staff & admins of a lab (view only)",
  params: labIdParam,
};
const getStaffByIdSchema = {
  tags: ["Staff"],
  summary: "Get a staff member by ID (view only)",
  params: labStaffParam,
};

// Admin schemas
const permissionsSchema = {
  type: "object",
  properties: {
    createInvoice: { type: "boolean", default: false },
    deleteInvoice: { type: "boolean", default: false },
    addExpense: { type: "boolean", default: false },
    deleteExpense: { type: "boolean", default: false },
    cashmemo: { type: "boolean", default: false },
    salesReport: { type: "boolean", default: false },
    expenseReport: { type: "boolean", default: false },
    commissionReport: { type: "boolean", default: false },
    collectionReport: { type: "boolean", default: false },
    testReportDownload: { type: "boolean", default: false },
    testReportUpload: { type: "boolean", default: false },
    manageProducts: { type: "boolean", default: false },
    manageReferrers: { type: "boolean", default: false },
    manageDoctors: { type: "boolean", default: false },
    manageTest: { type: "boolean", default: false },
    admitPatient: { type: "boolean", default: false },
    deletePatient: { type: "boolean", default: false },
    releasePatient: { type: "boolean", default: false },
  },
  additionalProperties: false,
};

const createAdminBody = {
  type: "object",
  required: ["name", "phone"],
  properties: {
    name: { type: "string", minLength: 1 },
    phone: { type: "string", pattern: "^(?:\\+?880|0)1[3-9][0-9]{8}$" },
    permissions: permissionsSchema,
  },
  additionalProperties: false,
};

const createAdminSchema = {
  tags: ["Staff"],
  summary: "Add an admin user to a lab — sends a password-set link via SMS",
  params: labIdParam,
  body: createAdminBody,
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function normalizeContact(contact) {
  if (!contact) return contact;
  const c = { ...contact };
  if (c.zoneId) {
    const oid = toObjectId(c.zoneId);
    if (!oid) throw { statusCode: 400, message: "Invalid zoneId format" };
    c.zoneId = oid;
  }
  return c;
}

const resolveLab = async (rawLabId, reply, col) => {
  const oid = toObjectId(rawLabId);
  if (!oid) {
    reply.code(400).send({ message: "Invalid lab ID format" });
    return null;
  }
  const lab = await col.findOne({ _id: oid }, { projection: { _id: 1, labKey: 1 } });
  if (!lab) {
    reply.code(404).send({ message: "Lab not found" });
    return null;
  }
  return { _id: oid, labKey: Number(lab.labKey) };
};

// ─── Main Plugin ────────────────────────────────────────────────────────────

export default async function labRoutes(fastify) {
  const labs = () => fastify.mongo.db.collection("labs");
  const staffs = () => fastify.mongo.db.collection("staffs");
  const tokens = () => fastify.mongo.db.collection("tokens");
  const passwordSetTokens = () => fastify.mongo.db.collection("passwordSetTokens");

  // Force re-login on all devices for a lab by wiping its refresh tokens
  const revokeLabTokens = (labId) => tokens().deleteMany({ labId });

  // GET /labs/stats
  fastify.get("/labs/stats", { schema: statsLabSchema }, async () => {
    const [result] = await labs()
      .aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            active: { $sum: { $cond: ["$isActive", 1, 0] } },
            inactive: { $sum: { $cond: ["$isActive", 0, 1] } },
            totalMonthly: { $sum: { $ifNull: ["$billing.monthlyFee", 0] } },
            totalInvoice: { $sum: { $ifNull: ["$billing.feePerInvoice", 0] } },
          },
        },
      ])
      .toArray();

    return result
      ? {
          total: result.total,
          active: result.active,
          inactive: result.inactive,
          totalMonthly: result.totalMonthly,
          totalInvoice: result.totalInvoice,
        }
      : { total: 0, active: 0, inactive: 0, totalMonthly: 0, totalInvoice: 0 };
  });

  // GET /labs/all
  fastify.get("/labs/all", { schema: listLabsSchema }, async (request, reply) => {
    const page = request.query.page ?? 1;
    const limit = request.query.limit ?? 10;
    const skip = (page - 1) * limit;
    const labKey = request.query.labKey?.trim();

    const filter = {};
    if (labKey) filter.labKey = { $regex: labKey, $options: "i" };
    if (request.query.zoneId) {
      const zoneOid = toObjectId(request.query.zoneId);
      if (!zoneOid) return reply.code(400).send({ message: "Invalid zoneId format" });
      filter["contact.zoneId"] = zoneOid;
    }

    const [data, total] = await Promise.all([
      labs().find(filter).skip(skip).limit(limit).sort({ createdAt: -1 }).toArray(),
      labs().countDocuments(filter),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  });

  // GET /labs/:id
  fastify.get("/labs/:id", { schema: getLabSchema }, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const lab = await labs().findOne({ _id: oid });
    if (!lab) return reply.code(404).send({ message: "Lab not found" });
    return lab;
  });

  // POST /labs
  fastify.post("/labs", { schema: createLabSchema }, async (request, reply) => {
    const { name, labKey, type, registrationNumber, billing, isActive = true } = request.body;

    let contact;
    try {
      contact = normalizeContact(request.body.contact);
    } catch (e) {
      return reply.code(400).send({ message: e.message });
    }

    const existing = await labs().findOne({ labKey });
    if (existing) return reply.code(409).send({ message: `Lab ID "${labKey}" already exists` });

    const doc = {
      name,
      labKey,
      type: type ?? null,
      registrationNumber: registrationNumber ?? null,
      contact,
      billing: { forceInvoiceFee: false, ...billing },
      limit: {
        maxStaff: 0,
        maxProduct: 0,
        maxService: 0,
        maxMedicine: 0,
        maxReferrer: 0,
        maxDoctor: 0,
        maxAdmissionSpace: 0,
        ...request.body.limit,
      },
      medicalReport: {
        padHeight: 0,
        ...request.body.medicalReport,
      },
      isActive,
      createdAt: new Date(),
    };

    const result = await labs().insertOne(doc);
    const created = await labs().findOne({ _id: result.insertedId });
    return reply.code(201).send(created);
  });

  // PATCH /labs/:id/details
  fastify.patch("/labs/:id/details", { schema: updateDetailsSchema }, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const $set = {};
    if (request.body.name) $set.name = request.body.name;
    if ("type" in request.body) $set.type = request.body.type || null;
    if ("registrationNumber" in request.body) {
      $set.registrationNumber = request.body.registrationNumber || null;
    }

    if (!Object.keys($set).length) return reply.code(400).send({ message: "Nothing to update" });

    const result = await labs().findOneAndUpdate({ _id: oid }, { $set }, { returnDocument: "after" });
    if (!result) return reply.code(404).send({ message: "Lab not found" });
    await revokeLabTokens(oid);
    return result;
  });

  // PATCH /labs/:id/contact
  fastify.patch("/labs/:id/contact", { schema: updateContactSchema }, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    let contact;
    try {
      contact = normalizeContact(request.body.contact);
    } catch (e) {
      return reply.code(400).send({ message: e.message });
    }

    const result = await labs().findOneAndUpdate({ _id: oid }, { $set: { contact } }, { returnDocument: "after" });
    if (!result) return reply.code(404).send({ message: "Lab not found" });
    await revokeLabTokens(oid);
    return result;
  });

  // PATCH /labs/:id/billing
  fastify.patch("/labs/:id/billing", { schema: updateBillingSchema }, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const result = await labs().findOneAndUpdate(
      { _id: oid },
      { $set: { billing: request.body.billing } },
      { returnDocument: "after" },
    );
    if (!result) return reply.code(404).send({ message: "Lab not found" });
    await revokeLabTokens(oid);
    return result;
  });

  // PATCH /labs/:id/limit
  fastify.patch("/labs/:id/limit", { schema: updateLimitSchema }, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const result = await labs().findOneAndUpdate(
      { _id: oid },
      { $set: { limit: request.body.limit } },
      { returnDocument: "after" },
    );
    if (!result) return reply.code(404).send({ message: "Lab not found" });
    await revokeLabTokens(oid);
    return result;
  });

  // PATCH /labs/:id/medical-report
  fastify.patch("/labs/:id/medical-report", { schema: updateMedicalReportSchema }, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const result = await labs().findOneAndUpdate(
      { _id: oid },
      { $set: { medicalReport: request.body.medicalReport } },
      { returnDocument: "after" },
    );
    if (!result) return reply.code(404).send({ message: "Lab not found" });
    await revokeLabTokens(oid);
    return result;
  });

  // PATCH /labs/:id/activate
  fastify.patch("/labs/:id/activate", { schema: activateLabSchema }, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const result = await labs().findOneAndUpdate(
      { _id: oid },
      { $set: { isActive: true } },
      { returnDocument: "after" },
    );
    if (!result) return reply.code(404).send({ message: "Lab not found" });
    await revokeLabTokens(oid);
    return result;
  });

  // PATCH /labs/:id/deactivate
  fastify.patch("/labs/:id/deactivate", { schema: deactivateLabSchema }, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const result = await labs().findOneAndUpdate(
      { _id: oid },
      { $set: { isActive: false } },
      { returnDocument: "after" },
    );
    if (!result) return reply.code(404).send({ message: "Lab not found" });
    await revokeLabTokens(oid);
    return result;
  });

  // DELETE /labs/:id
  fastify.delete("/labs/:id", { schema: deleteLabSchema }, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const result = await labs().deleteOne({ _id: oid });
    if (result.deletedCount === 0) return reply.code(404).send({ message: "Lab not found" });
    await revokeLabTokens(oid);
    return { message: "Lab deleted successfully" };
  });

  // =========================================================================
  //  STAFF ENDPOINTS (view only)
  // =========================================================================

  // GET /labs/:labId/staff
  fastify.get("/labs/:labId/staff", { schema: listStaffSchema }, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply, labs());
    if (!lab) return;
    return staffs()
      .find({ labId: lab._id, "deletion.status": { $ne: true } })
      .sort({ role: 1, name: 1 })
      .toArray();
  });

  // GET /labs/:labId/staff/:id
  fastify.get("/labs/:labId/staff/:id", { schema: getStaffByIdSchema }, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply, labs());
    if (!lab) return;

    const staffId = toObjectId(req.params.id);
    if (!staffId) return reply.code(400).send({ message: "Invalid staff ID format" });

    const member = await staffs().findOne({ _id: staffId, labId: lab._id, "deletion.status": { $ne: true } });
    if (!member) return reply.code(404).send({ message: "Staff member not found" });
    return member;
  });

  // =========================================================================
  //  ADMIN ENDPOINTS
  // =========================================================================

  // POST /labs/:labId/admins
  fastify.post("/labs/:labId/admins", { schema: createAdminSchema }, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply, labs());
    if (!lab) return;

    // Normalize to local 0XXXXXXXXXX form so lookups/storage stay consistent
    const phone = req.body.phone.replace(/^(\+?880|0)/, "0");

    // Scoped by labId (tenant) — the same phone can be an admin/staff in other labs
    const existing = await staffs().findOne({
      labId: lab._id,
      phone,
      "deletion.status": { $ne: true },
    });
    if (existing) {
      return reply.code(409).send({ message: "A staff member with this phone already exists in this lab" });
    }

    const permissions = {
      createInvoice: false,
      deleteInvoice: false,
      addExpense: false,
      deleteExpense: false,
      cashmemo: false,
      salesReport: false,
      expenseReport: false,
      commissionReport: false,
      collectionReport: false,
      testReportDownload: false,
      testReportUpload: false,
      manageProducts: false,
      manageReferrers: false,
      manageDoctors: false,
      manageTest: false,
      admitPatient: false,
      deletePatient: false,
      releasePatient: false,
      ...req.body.permissions,
    };

    const now = new Date();
    const actor = { id: req.user?.id ?? null, name: req.user?.name ?? "SYSTEM ADMIN" };

    const doc = {
      labId: lab._id,
      labKey: String(lab.labKey),
      name: req.body.name,
      phone,
      password: null, // set once the SMS link is used
      role: "admin",
      permissions,
      isActive: true,
      deletion: { status: false, at: null, by: null },
      created: { at: Date.now(), by: actor },
      updatedAt: now,
      updated: { at: Date.now(), by: actor },
    };

    const { insertedId } = await staffs().insertOne(doc);

    // One-time password-set token — only the hash is stored, the raw value goes out over SMS
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    await passwordSetTokens().insertOne({
      staffId: insertedId,
      labId: lab._id,
      tokenHash,
      used: false,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), // 24h
    });

    const setPasswordUrl = `${process.env.CLIENT_URL}/set-password?token=${rawToken}&labKey=${lab.labKey}`;

    try {
      await fastify.sendSMS({
        number: phone,
        message: `Welcome to ${doc.name}'s lab account. Set your password: ${setPasswordUrl} (expires in 24 hours)`,
      });
    } catch (err) {
      // Admin record still exists — surface the SMS failure so it can be resent rather than losing the account silently
      fastify.log.error({ err, staffId: insertedId }, "Failed to send admin password-set SMS");
      const created = await staffs().findOne({ _id: insertedId });
      return reply.code(201).send({ ...created, smsSent: false });
    }

    const created = await staffs().findOne({ _id: insertedId });
    return reply.code(201).send({ ...created, smsSent: true });
  });
}
