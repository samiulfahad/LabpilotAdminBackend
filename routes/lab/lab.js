// labRoutes.js
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
    return result;
  });

  // DELETE /labs/:id
  fastify.delete("/labs/:id", { schema: deleteLabSchema }, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const result = await labs().deleteOne({ _id: oid });
    if (result.deletedCount === 0) return reply.code(404).send({ message: "Lab not found" });
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
}
