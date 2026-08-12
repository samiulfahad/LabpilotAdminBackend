// labStaffRoutes.js
import crypto from "node:crypto";
import toObjectId from "../../utils/db.js";

const OID = { type: "string", minLength: 24, maxLength: 24, pattern: "^[a-fA-F0-9]{24}$" };
const labIdParam = { type: "object", additionalProperties: false, properties: { labId: OID } };
const labStaffParam = { type: "object", additionalProperties: false, properties: { labId: OID, id: OID } };

// ─── Lab picker (minimal, view-only) schema ────────────────────────────────

const pickerQuery = {
  type: "object",
  properties: {
    q: { type: "string" }, // matches name or labKey
  },
};

const listLabsForPickerSchema = {
  tags: ["Staff"],
  summary: "List labs (minimal fields) for the staff/admin lab picker",
  querystring: pickerQuery,
};

// ─── Staff (view-only) schemas ─────────────────────────────────────────────

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

// ─── Admin schemas ──────────────────────────────────────────────────────────

const createAdminBody = {
  type: "object",
  required: ["name", "phone"],
  properties: {
    name: { type: "string", minLength: 1 },
    phone: { type: "string", pattern: "^(?:\\+?880|0)1[3-9][0-9]{8}$" },
  },
  additionalProperties: false,
};

const createAdminSchema = {
  tags: ["Staff"],
  summary: "Add an admin user to a lab — sends a password-set link via SMS",
  params: labIdParam,
  body: createAdminBody,
};

// ─── Staff CRUD schemas ─────────────────────────────────────────────────────
// Permission keys are fetched at runtime from the internal /internal/permissions
// call (not statically imported), so we can't enumerate exact keys in the JSON
// schema at load time. Validate/normalize against the fetched list in the
// handlers instead — schema here just checks shape.

const permissionsBodySchema = {
  type: "object",
  additionalProperties: { type: "boolean" },
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const staffBodyProperties = {
  name: { type: "string", minLength: 1, maxLength: 100, description: "Full name" },
  email: {
    anyOf: [
      { type: "string", minLength: 5, maxLength: 254 },
      { type: "string", maxLength: 0 },
    ],
    description: "Unique email address (optional)",
  },
  phone: { type: "string", minLength: 10, maxLength: 15, description: "Unique phone number" },
  permissions: permissionsBodySchema,
  maxLabAdjustment: {
    type: "number",
    minimum: 0,
    description: "Max amount this staff can apply as a lab/bill adjustment (0 = disabled)",
  },
};

const createStaffSchema = {
  tags: ["Staff"],
  summary: "Add a new staff member to a lab — sends a password-set link via SMS",
  params: labIdParam,
  body: {
    type: "object",
    required: ["name", "phone", "permissions"],
    additionalProperties: false,
    properties: staffBodyProperties,
  },
};

const updatePermissionsSchema = {
  tags: ["Staff"],
  summary: "Update a staff member's permissions",
  params: labStaffParam,
  body: {
    type: "object",
    required: ["permissions"],
    additionalProperties: false,
    properties: {
      permissions: permissionsBodySchema,
    },
  },
};

const updateAdjustmentSchema = {
  tags: ["Staff"],
  summary: "Update a staff member's max lab/bill adjustment limit",
  params: labStaffParam,
  body: {
    type: "object",
    required: ["maxLabAdjustment"],
    additionalProperties: false,
    properties: {
      maxLabAdjustment: staffBodyProperties.maxLabAdjustment,
    },
  },
};

const deactivateStaffSchema = {
  tags: ["Staff"],
  summary: "Deactivate a staff member",
  params: labStaffParam,
};

const activateStaffSchema = {
  tags: ["Staff"],
  summary: "Activate a staff member",
  params: labStaffParam,
};

const deleteStaffSchema = {
  tags: ["Staff"],
  summary: "Permanently delete a staff member",
  params: labStaffParam,
};

const resendPasswordSetupSchema = {
  tags: ["Staff"],
  summary: "Resend the password-set SMS link — only while no password has been set yet",
  params: labStaffParam,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

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

const hashToken = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

// System-actor stamp for every create/update made from this file — these
// routes are operated by LabPilot Pro's own support team, not a lab's own
// logged-in admin, so there's no req.user identity to attribute changes to.
const SYSTEM_ACTOR = { id: null, name: "LabPilot Pro Support Team" };

// ─── Permissions (fetched from the internal API, not imported statically) ──
// Cached briefly in-memory so every staff create/update doesn't round-trip
// to the internal endpoint. Cache is per-process and intentionally short-lived
// so a permission-catalog change picks up quickly without a restart.
let permsCache = { data: null, fetchedAt: 0 };
const PERMS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getAllowedPermissions() {
  const now = Date.now();
  if (permsCache.data && now - permsCache.fetchedAt < PERMS_CACHE_TTL_MS) {
    return permsCache.data;
  }

  const res = await fetch(`${process.env.LAB_API_INTERNAL_URL}/internal/permissions`, {
    headers: { "x-internal-secret": process.env.INTERNAL_SECRET },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch permissions from internal API: ${res.status}`);
  }
  const { permissions } = await res.json();

  permsCache = { data: permissions, fetchedAt: now };
  return permissions;
}

// Fills in every known permission key (false if absent) and drops any key
// not in the fetched catalog, mirroring the old ALLOWED_PERMISSIONS-derived
// normalizer but sourced from the internal call.
const normalizePermissions = (allowedPermissions, perms = {}) =>
  Object.fromEntries(allowedPermissions.map((p) => [p.key, perms[p.key] ?? false]));

// Same derivation as before: group stays out unless at least one of its
// permission keys is true. Order follows allowedPermissions' first
// occurrence of each group. Call after normalizePermissions.
// NOTE: the internal permissions API returns "group", not "module" — this
// was originally written against a doc that used "module" and got fixed
// once the real response shape came back.
const computeModules = (allowedPermissions, normalizedPerms) => {
  const modules = [];
  for (const p of allowedPermissions) {
    if (normalizedPerms[p.key] && !modules.includes(p.group)) {
      modules.push(p.group);
    }
  }
  return modules;
};

// Issues a fresh one-time password-set token for a staff member and texts
// the link. Wipes any still-live token for that staff first. Shared by
// staff creation and the resend endpoint.
const issuePasswordSetLink = async (fastify, passwordSetTokens, { staffId, lid, labKey, name, phone }) => {
  await passwordSetTokens.deleteMany({ staffId });

  const rawToken = crypto.randomBytes(32).toString("hex");
  const now = new Date();

  await passwordSetTokens.insertOne({
    staffId,
    labId: lid,
    tokenHash: hashToken(rawToken),
    createdAt: now,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), // 24h
  });

  const setPasswordUrl = `${process.env.CLIENT_URL}/set-password?token=${rawToken}&labKey=${labKey}`;

  try {
    await fastify.sendSMS({
      number: phone,
      message: `LabPilotPro.com-এ আপনাকে স্বাগতম, ${name}। আপনার পাসওয়ার্ড সেট করুন: ${setPasswordUrl} (২৪ ঘণ্টার মধ্যে মেয়াদ শেষ হবে)`,
    });
    return true;
  } catch (err) {
    fastify.log.error({ err, staffId }, "Failed to send staff password-set SMS");
    return false;
  }
};

// ─── Main Plugin ────────────────────────────────────────────────────────────

export default async function labStaffRoutes(fastify) {
  const labs = () => fastify.mongo.db.collection("labs");
  const staffs = () => fastify.mongo.db.collection("staffs");
  const passwordSetTokens = () => fastify.mongo.db.collection("passwordSetTokens");

  // Shared guard: staff must exist under this lab and must not be an admin
  // account — admins have fixed, full access and are never edited/deactivated/
  // deleted through these staff routes.
  const findEditableStaff = async (req, reply, lid) => {
    const _id = toObjectId(req.params.id);
    if (!_id) {
      reply.code(400).send({ error: "Invalid staff ID" });
      return null;
    }
    const existing = await staffs().findOne({ _id, labId: lid }, { projection: { role: 1 } });
    if (!existing) {
      reply.code(404).send({ error: "Staff not found" });
      return null;
    }
    if (existing.role === "admin") {
      reply.code(403).send({ error: "Admin accounts cannot be edited" });
      return null;
    }
    return _id;
  };

  // =========================================================================
  //  LAB PICKER (minimal, owned by this file — no dependency on labRoutes.js)
  // =========================================================================

  // GET /labs/staff/permissions
  // Frontend-facing catalog for this backend — proxies getAllowedPermissions()
  // (which itself calls the tenant backend's secret-protected /internal/permissions).
  // The tenant backend's public /staff-permissions route is NOT reachable from
  // this app's frontend, since it only talks to this system backend.
  fastify.get("/labs/staff/permissions", async (_req, reply) => {
    try {
      const permissions = await getAllowedPermissions();
      return reply.send({ permissions });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(502).send({ error: "Failed to fetch permissions catalog" });
    }
  });

  // GET /labs/staff/labs
  fastify.get("/labs/staff/labs", { schema: listLabsForPickerSchema }, async (request) => {
    const q = request.query.q?.trim();
    const filter = q ? { $or: [{ name: { $regex: q, $options: "i" } }, { labKey: { $regex: q, $options: "i" } }] } : {};

    return labs()
      .find(filter, { projection: { name: 1, labKey: 1, type: 1, isActive: 1 } })
      .sort({ name: 1 })
      .toArray();
  });

  // =========================================================================
  //  STAFF ENDPOINTS (view only)
  // =========================================================================

  // Attaches a readable permissionsDetailed array (key/label/group/for/value)
  // built from the internal permissions catalog, alongside the raw boolean
  // permissions map already on the doc — so the frontend doesn't need a
  // second round trip to label what's enabled.
  const withPermissionLabels = (allowedPermissions, staff) => ({
    ...staff,
    permissionsDetailed: allowedPermissions.map((p) => ({
      key: p.key,
      label: p.label,
      group: p.group,
      for: p.for,
      value: Boolean(staff.permissions?.[p.key]),
    })),
  });

  // GET /labs/:labId/staff
  fastify.get("/labs/:labId/staff", { schema: listStaffSchema }, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply, labs());
    if (!lab) return;
    const [staffList, allowedPermissions] = await Promise.all([
      staffs().find({ labId: lab._id }).sort({ role: 1, name: 1 }).toArray(),
      getAllowedPermissions(),
    ]);
    return staffList.map((s) => withPermissionLabels(allowedPermissions, s));
  });

  // GET /labs/:labId/staff/:id
  fastify.get("/labs/:labId/staff/:id", { schema: getStaffByIdSchema }, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply, labs());
    if (!lab) return;
    const staffOid = toObjectId(req.params.id);
    if (!staffOid) return reply.code(400).send({ message: "Invalid staff ID format" });
    const staff = await staffs().findOne({ _id: staffOid, labId: lab._id });
    if (!staff) return reply.code(404).send({ message: "Staff member not found" });
    const allowedPermissions = await getAllowedPermissions();
    return withPermissionLabels(allowedPermissions, staff);
  });

  // =========================================================================
  //  ADMIN ENDPOINTS
  // =========================================================================

  // POST /labs/:labId/admins
  fastify.post("/labs/:labId/admins", { schema: createAdminSchema }, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply, labs());
    if (!lab) return;

    const phone = req.body.phone.replace(/^(\+?880|0)/, "0");

    const existing = await staffs().findOne({ labId: lab._id, phone });
    if (existing) {
      return reply.code(409).send({ message: "A staff member with this phone already exists in this lab" });
    }

    const now = new Date();

    const doc = {
      labId: lab._id,
      labKey: String(lab.labKey),
      name: req.body.name,
      phone,
      password: null,
      role: "admin",
      isActive: true,
      created: { at: Date.now(), by: SYSTEM_ACTOR },
      updatedAt: now,
      updated: { at: Date.now(), by: SYSTEM_ACTOR },
    };

    const { insertedId } = await staffs().insertOne(doc);

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);

    await passwordSetTokens().insertOne({
      staffId: insertedId,
      labId: lab._id,
      tokenHash,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    });

    const setPasswordUrl = `${process.env.CLIENT_URL}/set-password?token=${rawToken}&labKey=${lab.labKey}`;

    try {
      await fastify.sendSMS({
        number: phone,
        message: `Welcome to LabPilot Pro. আপনার আকাউন্টের পাসওয়ার্ড সেট করতে এখানে ক্লিক করুন: ${setPasswordUrl} (expires in 24 hours)`,
      });
    } catch (err) {
      fastify.log.error({ err, staffId: insertedId }, "Failed to send admin password-set SMS");
      const created = await staffs().findOne({ _id: insertedId });
      return reply.code(201).send({ ...created, smsSent: false });
    }

    const created = await staffs().findOne({ _id: insertedId });
    return reply.code(201).send({ ...created, smsSent: true });
  });

  // =========================================================================
  //  STAFF CRUD (system-admin operated — actor is always LabPilot Pro Support)
  // =========================================================================

  // POST /labs/:labId/staff
  fastify.post("/labs/:labId/staff", { schema: createStaffSchema }, async (req, reply) => {
    try {
      const lab = await resolveLab(req.params.labId, reply, labs());
      if (!lab) return;

      const labDoc = await labs().findOne({ _id: lab._id }, { projection: { "limit.maxStaff": 1 } });
      const maxStaff = labDoc?.limit?.maxStaff;

      if (typeof maxStaff === "number") {
        const currentStaffCount = await staffs().countDocuments({ labId: lab._id, role: "staff" });
        if (currentStaffCount >= maxStaff) {
          return reply.code(403).send({
            error: `আপনার প্ল্যানে সর্বোচ্চ ${maxStaff} জন স্টাফ যোগ করা যাবে। সীমা বাড়াতে আপনার প্ল্যান আপগ্রেড করুন।`,
            code: "STAFF_LIMIT_REACHED",
            limit: maxStaff,
            current: currentStaffCount,
          });
        }
      }

      const { name, email: rawEmail, phone: rawPhone, permissions, maxLabAdjustment } = req.body;

      const email = rawEmail?.trim() ? rawEmail.toLowerCase().trim() : null;
      const phone = rawPhone.trim();

      if (email) {
        if (!EMAIL_REGEX.test(email)) {
          return reply.code(400).send({ error: "Invalid email format" });
        }
        if (await staffs().findOne({ email, labId: lab._id }, { projection: { _id: 1 } })) {
          return reply.code(409).send({ error: "Email already exists in this lab" });
        }
      }

      if (await staffs().findOne({ phone, labId: lab._id }, { projection: { _id: 1 } })) {
        return reply.code(409).send({ error: "Phone number already exists in this lab" });
      }

      const allowedPermissions = await getAllowedPermissions();
      const normalizedPermissions = normalizePermissions(allowedPermissions, permissions);
      const name_ = name.trim();
      const labKeyStr = String(lab.labKey);

      const result = await staffs().insertOne({
        labId: lab._id,
        labKey: labKeyStr,
        name: name_,
        ...(email && { email }),
        phone,
        password: null,
        role: "staff",
        permissions: normalizedPermissions,
        modules: computeModules(allowedPermissions, normalizedPermissions),
        isActive: true,
        maxLabAdjustment: maxLabAdjustment ?? 0,
        created: { at: Date.now(), by: SYSTEM_ACTOR },
      });

      const smsSent = await issuePasswordSetLink(fastify, passwordSetTokens(), {
        staffId: result.insertedId,
        lid: lab._id,
        labKey: labKeyStr,
        name: name_,
        phone,
      });

      return reply.code(201).send({ _id: result.insertedId, smsSent });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to create staff member" });
    }
  });

  // POST /labs/:labId/staff/:id/resend-password-setup
  fastify.post(
    "/labs/:labId/staff/:id/resend-password-setup",
    { schema: resendPasswordSetupSchema },
    async (req, reply) => {
      try {
        const lab = await resolveLab(req.params.labId, reply, labs());
        if (!lab) return;

        const _id = toObjectId(req.params.id);
        if (!_id) return reply.code(400).send({ error: "Invalid staff ID" });

        const staff = await staffs().findOne(
          { _id, labId: lab._id },
          { projection: { role: 1, password: 1, phone: 1, name: 1, labKey: 1 } },
        );
        if (!staff) return reply.code(404).send({ error: "Staff not found" });
        if (staff.role === "admin") return reply.code(403).send({ error: "Admin accounts cannot be edited" });
        if (staff.password) return reply.code(409).send({ error: "This staff member has already set their password" });

        const smsSent = await issuePasswordSetLink(fastify, passwordSetTokens(), {
          staffId: _id,
          lid: lab._id,
          labKey: staff.labKey,
          name: staff.name,
          phone: staff.phone,
        });

        return { message: smsSent ? "Password-set link resent" : "Link created but SMS failed to send", smsSent };
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to resend password-set link" });
      }
    },
  );

  // PUT /labs/:labId/staff/:id/permissions
  fastify.put("/labs/:labId/staff/:id/permissions", { schema: updatePermissionsSchema }, async (req, reply) => {
    try {
      const lab = await resolveLab(req.params.labId, reply, labs());
      if (!lab) return;

      const _id = await findEditableStaff(req, reply, lab._id);
      if (!_id) return;

      const allowedPermissions = await getAllowedPermissions();
      const normalizedPermissions = normalizePermissions(allowedPermissions, req.body.permissions);

      await staffs().updateOne(
        { _id, labId: lab._id },
        {
          $set: {
            permissions: normalizedPermissions,
            modules: computeModules(allowedPermissions, normalizedPermissions),
            updated: { at: Date.now(), by: SYSTEM_ACTOR },
          },
        },
      );

      await fastify.mongo.db.collection("tokens").deleteMany({ userId: _id });

      return { message: "Permissions updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update permissions" });
    }
  });

  // PUT /labs/:labId/staff/:id/adjustment
  fastify.put("/labs/:labId/staff/:id/adjustment", { schema: updateAdjustmentSchema }, async (req, reply) => {
    try {
      const lab = await resolveLab(req.params.labId, reply, labs());
      if (!lab) return;

      const _id = await findEditableStaff(req, reply, lab._id);
      if (!_id) return;

      await staffs().updateOne(
        { _id, labId: lab._id },
        {
          $set: {
            maxLabAdjustment: req.body.maxLabAdjustment,
            updated: { at: Date.now(), by: SYSTEM_ACTOR },
          },
        },
      );

      await fastify.mongo.db.collection("tokens").deleteMany({ userId: _id });

      return { message: "Adjustment limit updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update adjustment limit" });
    }
  });

  // PATCH /labs/:labId/staff/:id/deactivate
  fastify.patch("/labs/:labId/staff/:id/deactivate", { schema: deactivateStaffSchema }, async (req, reply) => {
    try {
      const lab = await resolveLab(req.params.labId, reply, labs());
      if (!lab) return;

      const _id = await findEditableStaff(req, reply, lab._id);
      if (!_id) return;

      await staffs().updateOne(
        { _id, labId: lab._id },
        {
          $set: {
            isActive: false,
            updated: { at: Date.now(), by: SYSTEM_ACTOR },
          },
        },
      );

      await fastify.mongo.db.collection("tokens").deleteMany({ userId: _id });

      return { message: "Staff deactivated successfully", _id: req.params.id };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to deactivate staff member" });
    }
  });

  // PATCH /labs/:labId/staff/:id/activate
  fastify.patch("/labs/:labId/staff/:id/activate", { schema: activateStaffSchema }, async (req, reply) => {
    try {
      const lab = await resolveLab(req.params.labId, reply, labs());
      if (!lab) return;

      const _id = await findEditableStaff(req, reply, lab._id);
      if (!_id) return;

      await staffs().updateOne(
        { _id, labId: lab._id },
        {
          $set: {
            isActive: true,
            updated: { at: Date.now(), by: SYSTEM_ACTOR },
          },
        },
      );

      return { message: "Staff activated successfully", _id: req.params.id };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to activate staff member" });
    }
  });

  // DELETE /labs/:labId/staff/:id
  fastify.delete("/labs/:labId/staff/:id", { schema: deleteStaffSchema }, async (req, reply) => {
    try {
      const lab = await resolveLab(req.params.labId, reply, labs());
      if (!lab) return;

      const _id = await findEditableStaff(req, reply, lab._id);
      if (!_id) return;

      const result = await staffs().deleteOne({ _id, labId: lab._id });
      if (result.deletedCount === 0) return reply.code(404).send({ error: "Staff not found" });

      await fastify.mongo.db.collection("tokens").deleteMany({ userId: _id });
      await passwordSetTokens().deleteMany({ staffId: _id });

      return { message: "Staff deleted successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete staff member" });
    }
  });
}
