import bcrypt from "bcryptjs";
import toObjectId from "../../utils/db.js";

// ── Support-admin constants ────────────────────────────────────────────────
// Login for these accounts is handled by a separate backend — this plugin
// only creates/lists/deletes the underlying documents.
// These documents live in the same collection as regular admins, so every
// query below scopes with `supportAdminExpiresAt: { $exists: true }` —
// support admins are the only docs in this collection that ever carry that
// field. Deliberately NOT named `expiresAt`: a generic name risks collision
// if a regular-admin feature (password reset expiry, invite expiry, etc.)
// ever adds its own expiry field to the same collection — since the TTL
// index below is collection-wide and keyed purely on field name, a name
// collision would silently auto-delete unrelated admin documents.
const SUPPORT_NAME = "LabPilot Support Team";
const DEFAULT_SUPPORT_PHONE = "01111111111";
const DEFAULT_SUPPORT_TTL_MINUTES = 60; // 1hr default when validity isn't specified
const MAX_SUPPORT_TTL_MINUTES = 10080; // 7 days — upper bound to prevent open-ended accounts
const SUPPORT_ADMIN_FILTER = { supportAdminExpiresAt: { $exists: true } };

// ── Route schemas ─────────────────────────────────────────────────────────

const createSupportAdminSchema = {
  schema: {
    tags: ["Support Admin"],
    summary: "Create a temporary support-admin account (default 1hr validity, auto-deleted)",
    body: {
      type: "object",
      required: ["labKey", "password"],
      additionalProperties: false,
      properties: {
        labKey: { type: "string", pattern: "^\\d{1,5}$" },
        phone: { type: "string", pattern: "^\\d{6,20}$" },
        password: { type: "string", minLength: 6, maxLength: 100 },
        // Optional short tag appended to the display name, letters only —
        // helps tell apart multiple support admins created around the same
        // time (e.g. "RAK" for a support person's initials).
        suffix: { type: "string", pattern: "^[A-Za-z]{1,5}$" },
        // Optional — minutes until the account expires. Omit for the 1hr default.
        validityMinutes: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SUPPORT_TTL_MINUTES,
        },
      },
    },
  },
};

const searchLabsSchema = {
  schema: {
    tags: ["Support Admin"],
    summary: "Search labs by labKey (for the support-admin creation flow)",
    querystring: {
      type: "object",
      properties: {
        labKey: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
    },
  },
};

const listSupportAdminsSchema = {
  schema: {
    tags: ["Support Admin"],
    summary: "List all active temporary support-admin accounts",
  },
};

const deleteSupportAdminSchema = {
  schema: {
    tags: ["Support Admin"],
    summary: "Delete a specific support-admin account by id",
    params: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1 },
      },
    },
  },
};

const deleteAllSupportAdminsSchema = {
  schema: {
    tags: ["Support Admin"],
    summary: "Delete every support-admin account",
  },
};

async function supportAdminRoutes(fastify) {
  // Auth applied once for every route in this file. supportAdminRoutes is
  // registered as a plain (non-fp) plugin, so Fastify's encapsulation means
  // this onRequest hook only affects routes declared in this context — it
  // won't leak onto sibling plugins registered alongside it.
  fastify.addHook("onRequest", fastify.authenticate);

  const adminsCollection = () => fastify.mongo.db.collection("supportAdmins");
  const labsCollection = () => fastify.mongo.db.collection("labs");

  // TTL index — MongoDB's background TTL monitor sweeps expired docs on its
  // own cycle (runs ~every 60s), so actual deletion typically lands within
  // 1-2min of `supportAdminExpiresAt`. The uniqueness check below filters on
  // `supportAdminExpiresAt > now` rather than relying on the sweep having
  // already run, so a just-expired (but not yet swept) account never blocks
  // a new one. createIndex is idempotent — safe to call on every boot.
  await adminsCollection().createIndex({ supportAdminExpiresAt: 1 }, { expireAfterSeconds: 0 });

  // ── GET /support-admin/search-labs ─────────────────────────────────────
  // Powers the labKey typeahead on the create-support-admin form.
  fastify.get("/support-admin/search-labs", searchLabsSchema, async (req) => {
    const { labKey, limit = 10 } = req.query;

    const filter = {};
    if (labKey?.trim()) filter.labKey = { $regex: labKey.trim(), $options: "i" };

    const labList = await labsCollection()
      .find(filter, { projection: { name: 1, labKey: 1, type: 1, isActive: 1 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    return { labs: labList };
  });

  // ── POST /support-admin ────────────────────────────────────────────────
  fastify.post("/support-admin", createSupportAdminSchema, async (req, reply) => {
    const { labKey, phone, password, validityMinutes, suffix } = req.body;
    const supportPhone = phone || DEFAULT_SUPPORT_PHONE;
    const ttlMinutes = validityMinutes || DEFAULT_SUPPORT_TTL_MINUTES;
    const now = new Date();
    const supportSuffix = suffix ? suffix : undefined;

    // Block creation if a still-live support admin exists either for this
    // lab, or on this phone number. The phone check matters even across
    // different labs: the other backend logs support admins in by phone,
    // so two live accounts sharing a phone (e.g. both left on the default)
    // would be ambiguous to log in as. Either conflict must be resolved by
    // deleting the existing account first — no more silent auto-delete.
    const conflict = await adminsCollection().findOne(
      { supportAdminExpiresAt: { $gt: now }, $or: [{ labKey }, { phone: supportPhone }] },
      { projection: { labKey: 1, phone: 1, supportAdminExpiresAt: 1 } },
    );

    if (conflict) {
      const reason =
        conflict.labKey === labKey
          ? "This lab already has an active support admin. Delete it before creating a new one."
          : "Another active support admin already uses this phone number. Delete it before creating a new one.";
      return reply.code(409).send({ error: reason, conflictingId: conflict._id.toString() });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    // Suffix is a secret identifier, not a display label — hashed the same
    // way as password so it's never recoverable from the stored document.
    const suffixHash = supportSuffix ? await bcrypt.hash(supportSuffix, 10) : undefined;
    const supportAdminExpiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

    const { insertedId } = await adminsCollection().insertOne({
      name: SUPPORT_NAME,
      phone: supportPhone,
      ...(suffixHash && { suffix: suffixHash }),
      password: passwordHash,
      role: "admin",
      labKey,
      createdAt: now,
      supportAdminExpiresAt,
    });

    return {
      id: insertedId.toString(),
      name: SUPPORT_NAME,
      phone: supportPhone,
      labKey,
      role: "admin",
      supportAdminExpiresAt,
    };
  });

  // ── GET /support-admin ─────────────────────────────────────────────────
  fastify.get("/support-admin", listSupportAdminsSchema, async () => {
    const supportAdmins = await adminsCollection()
      .find(SUPPORT_ADMIN_FILTER, { projection: { password: 0, suffix: 0 } })
      .sort({ createdAt: -1 })
      .toArray();

    return { supportAdmins };
  });

  // ── DELETE /support-admin/:id ──────────────────────────────────────────
  fastify.delete("/support-admin/:id", deleteSupportAdminSchema, async (req, reply) => {
    const { id } = req.params;

    // supportAdminExpiresAt-exists guard is deliberate — prevents this
    // endpoint from ever being used to delete a regular (non-support) admin
    // by id.
    const result = await adminsCollection().deleteOne({ _id: toObjectId(id), ...SUPPORT_ADMIN_FILTER });

    if (result.deletedCount === 0) {
      return reply.code(404).send({ error: "Support admin not found" });
    }

    return { message: "Support admin deleted" };
  });

  // ── DELETE /support-admin ──────────────────────────────────────────────
  fastify.delete("/support-admin", deleteAllSupportAdminsSchema, async () => {
    const result = await adminsCollection().deleteMany(SUPPORT_ADMIN_FILTER);
    return { message: "All support admins deleted", deletedCount: result.deletedCount };
  });
}

export default supportAdminRoutes;
