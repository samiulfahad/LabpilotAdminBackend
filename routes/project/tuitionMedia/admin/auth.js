import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import toObjectId from "../../../../utils/db.js";

// ── Isolation from the system-admin auth ─────────────────────────────────
// Separate collections, cookie names, JWT secrets and a `scope` claim, so a
// tuition-admin token can never authenticate on lab/system-admin routes
// (and vice versa).
//
// Required env:
//   TUITION_ADMIN_JWT_SECRET       (access token)
//   TUITION_ADMIN_REFRESH_SECRET   (refresh token)
//   TUITION_FAVORITE_WORDS         (comma-separated, case-insensitive)
// Optional env:
//   TUITION_ADMIN_ACCESS_EXPIRY    (default "15m")

const SCOPE = "tuition-admin";
const ACCESS_SECRET = process.env.TUITION_ADMIN_JWT_SECRET;
const REFRESH_SECRET = process.env.TUITION_ADMIN_REFRESH_SECRET;
const ACCESS_EXPIRY = process.env.TUITION_ADMIN_ACCESS_EXPIRY || "15m";

if (!ACCESS_SECRET || !REFRESH_SECRET) {
  throw new Error("[tuitionMediaAuth] TUITION_ADMIN_JWT_SECRET and TUITION_ADMIN_REFRESH_SECRET must be set.");
}

// ── Favorite-word allowlist ──────────────────────────────────────────────
// Third factor on top of identifier + password. Kept out of the database and
// loaded from env, so rotating it means editing .env and restarting.
//   TUITION_FAVORITE_WORDS="word1,word2,word3"
const FAVORITE_WORDS = (process.env.TUITION_FAVORITE_WORDS || "")
  .split(",")
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);

if (FAVORITE_WORDS.length === 0) {
  console.warn("[tuitionMediaAuth] TUITION_FAVORITE_WORDS is empty or unset, so no favorite word will ever pass.");
}

const isValidFavoriteWord = (word) => typeof word === "string" && FAVORITE_WORDS.includes(word.trim().toLowerCase());

const REFRESH_COOKIE = "tmRefreshToken";
const DEVICE_COOKIE = "tmDeviceId";
const MAX_ADMIN_SESSIONS = 3;
const REFRESH_GRACE_WINDOW_MS = 30_000;

// ── Guard (export + reuse in other tuition-admin routes) ─────────────────
export function makeTuitionAdminGuard(fastify) {
  return async function tuitionAdminGuard(req, reply) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return reply.code(401).send({ error: "Unauthorized" });

    try {
      const decoded = await fastify.jwt.verify(token, { key: ACCESS_SECRET });
      if (decoded.scope !== SCOPE) return reply.code(401).send({ error: "Unauthorized" });
      req.tuitionAdmin = decoded;
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  };
}

// ── Schemas ──────────────────────────────────────────────────────────────
const deviceSchemaProps = {
  type: "object",
  additionalProperties: false,
  properties: {
    browser: { type: "string", maxLength: 100 },
    browserVersion: { type: "string", maxLength: 50 },
    os: { type: "string", maxLength: 100 },
    osVersion: { type: "string", maxLength: 50 },
    deviceType: { type: "string", maxLength: 50 },
    screenRes: { type: "string", maxLength: 50 },
    timezone: { type: "string", maxLength: 100 },
    language: { type: "string", maxLength: 50 },
  },
};

const loginSchema = {
  schema: {
    tags: ["TuitionMedia Auth"],
    summary: "Tuition Media admin login (favorite word + identifier + password)",
    body: {
      type: "object",
      required: ["favoriteWord", "identifier", "password"],
      additionalProperties: false,
      properties: {
        favoriteWord: { type: "string", minLength: 1, maxLength: 100 },
        identifier: { type: "string", minLength: 1, maxLength: 100 },
        password: { type: "string", minLength: 1, maxLength: 100 },
        device: deviceSchemaProps,
      },
    },
  },
};

const changePasswordSchema = {
  schema: {
    tags: ["TuitionMedia Auth"],
    summary: "Change the current Tuition Media admin's password",
    body: {
      type: "object",
      required: ["currentPassword", "newPassword"],
      additionalProperties: false,
      properties: {
        currentPassword: { type: "string", minLength: 1, maxLength: 100 },
        newPassword: { type: "string", minLength: 6, maxLength: 100 },
      },
    },
  },
};

const deleteSessionSchema = {
  schema: {
    tags: ["TuitionMedia Auth"],
    summary: "Revoke a specific device's session",
    params: {
      type: "object",
      required: ["deviceId"],
      properties: { deviceId: { type: "string", minLength: 1, maxLength: 100 } },
    },
  },
};

// ── Routes ───────────────────────────────────────────────────────────────
async function tuitionMediaAuth(fastify) {
  const adminsCollection = () => fastify.mongo.db.collection("tuitionMediaAdmins");
  const tokensCollection = () => fastify.mongo.db.collection("tuitionMediaAdminTokens");
  const guard = makeTuitionAdminGuard(fastify);

  try {
    await adminsCollection().createIndex({ username: 1 }, { unique: true, name: "uniq_username" });
    await adminsCollection().createIndex(
      { phone: 1 },
      { unique: true, partialFilterExpression: { phone: { $type: "string" } }, name: "uniq_phone" },
    );
    await tokensCollection().createIndex({ adminId: 1, deviceId: 1 }, { name: "admin_device" });
    await tokensCollection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "ttl_expires" });
  } catch (err) {
    fastify.log.error({ err }, "Failed to ensure tuition admin indexes");
  }

  const signAccess = (payload) => fastify.jwt.sign(payload, { key: ACCESS_SECRET, expiresIn: ACCESS_EXPIRY });
  const signRefresh = (payload) =>
    fastify.jwt.sign(payload, { key: REFRESH_SECRET, expiresIn: fastify.REFRESH_EXPIRY });

  const clearCookies = (reply) =>
    reply.clearCookie(REFRESH_COOKIE, fastify.cookieOptions).clearCookie(DEVICE_COOKIE, fastify.cookieOptions);

  // ── POST /tuition-admin/login ──────────────────────────────────────────
  fastify.post("/tuition-admin/login", loginSchema, async (req, reply) => {
    const { favoriteWord, identifier, password, device } = req.body;

    if (!isValidFavoriteWord(favoriteWord)) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const trimmed = String(identifier).trim();
    const admin = await adminsCollection().findOne({
      $or: [{ username: trimmed }, { phone: trimmed }],
    });

    if (!admin || !admin.isActive || !(await bcrypt.compare(password, admin.password))) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const payload = {
      id: admin._id.toString(),
      username: admin.username,
      phone: admin.phone ?? null,
      scope: SCOPE,
    };

    const deviceId = randomUUID();
    const accessToken = await signAccess(payload);
    const refreshTokenPlain = await signRefresh(payload);

    // Enforce max concurrent sessions (evict oldest)
    const sessions = await tokensCollection().find({ adminId: admin._id }).sort({ createdAt: 1 }).toArray();
    if (sessions.length >= MAX_ADMIN_SESSIONS) {
      const excess = sessions.slice(0, sessions.length - MAX_ADMIN_SESSIONS + 1).map((s) => s._id);
      await tokensCollection().deleteMany({ _id: { $in: excess } });
    }

    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";

    await tokensCollection().insertOne({
      adminId: admin._id,
      deviceId,
      refreshToken: fastify.hashToken(refreshTokenPlain),
      previousRefreshTokenHash: null,
      device: {
        browser: device?.browser ?? "Unknown",
        browserVersion: device?.browserVersion ?? "",
        os: device?.os ?? "Unknown",
        osVersion: device?.osVersion ?? "",
        deviceType: device?.deviceType ?? "unknown",
        screenRes: device?.screenRes ?? "",
        timezone: device?.timezone ?? "",
        language: device?.language ?? "",
        ip,
        userAgent: req.headers["user-agent"] || "unknown",
      },
      createdAt: new Date(),
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + fastify.REFRESH_EXPIRY_MS),
    });

    await adminsCollection().updateOne({ _id: admin._id }, { $set: { lastLoginAt: new Date() } });

    reply
      .setCookie(REFRESH_COOKIE, refreshTokenPlain, fastify.cookieOptions)
      .setCookie(DEVICE_COOKIE, deviceId, fastify.cookieOptions);

    return {
      accessToken,
      admin: { id: payload.id, username: admin.username, phone: admin.phone ?? null, name: admin.name ?? null },
    };
  });

  // ── POST /tuition-admin/refresh ────────────────────────────────────────
  fastify.post("/tuition-admin/refresh", async (req, reply) => {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    const deviceId = req.cookies?.[DEVICE_COOKIE];
    if (!refreshToken || !deviceId) return reply.code(445).send({ error: "Missing tokens" });

    let decoded;
    try {
      decoded = await fastify.jwt.verify(refreshToken, { key: REFRESH_SECRET });
    } catch {
      return reply.code(445).send({ error: "Invalid or expired refresh token" });
    }
    if (decoded.scope !== SCOPE) return reply.code(445).send({ error: "Invalid refresh token" });

    const payload = { id: decoded.id, username: decoded.username, phone: decoded.phone, scope: SCOPE };
    const presentedHash = fastify.hashToken(refreshToken);

    const session = await tokensCollection().findOne({
      adminId: toObjectId(payload.id),
      deviceId,
      expiresAt: { $gt: new Date() },
      $or: [
        { refreshToken: presentedHash },
        {
          previousRefreshTokenHash: presentedHash,
          lastUsedAt: { $gt: new Date(Date.now() - REFRESH_GRACE_WINDOW_MS) },
        },
      ],
    });
    if (!session) return reply.code(445).send({ error: "Session expired or revoked" });

    // Block refresh for deactivated/deleted admins
    const admin = await adminsCollection().findOne({ _id: session.adminId }, { projection: { isActive: 1 } });
    if (!admin?.isActive) {
      await tokensCollection().deleteMany({ adminId: session.adminId });
      return reply.code(445).send({ error: "Session expired or revoked" });
    }

    const newRefreshPlain = await signRefresh(payload);
    await tokensCollection().updateOne(
      { _id: session._id },
      {
        $set: {
          refreshToken: fastify.hashToken(newRefreshPlain),
          previousRefreshTokenHash: presentedHash,
          lastUsedAt: new Date(),
          expiresAt: new Date(Date.now() + fastify.REFRESH_EXPIRY_MS),
        },
      },
    );

    const accessToken = await signAccess(payload);
    reply.setCookie(REFRESH_COOKIE, newRefreshPlain, fastify.cookieOptions);
    return { accessToken };
  });

  // ── POST /tuition-admin/logout ─────────────────────────────────────────
  fastify.post("/tuition-admin/logout", async (req, reply) => {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    const deviceId = req.cookies?.[DEVICE_COOKIE];

    if (refreshToken && deviceId) {
      let adminId;
      try {
        adminId = fastify.jwt.decode(refreshToken)?.id;
      } catch {
        // still clear cookies
      }
      await tokensCollection().deleteOne({
        ...(adminId && { adminId: toObjectId(adminId) }),
        deviceId,
        refreshToken: fastify.hashToken(refreshToken),
      });
    }

    clearCookies(reply);
    return { message: "Logged out from this device" };
  });

  // ── POST /tuition-admin/logout-all ─────────────────────────────────────
  fastify.post("/tuition-admin/logout-all", { onRequest: [guard] }, async (req, reply) => {
    await tokensCollection().deleteMany({ adminId: toObjectId(req.tuitionAdmin.id) });
    clearCookies(reply);
    return { message: "Logged out from all devices" };
  });

  // ── GET /tuition-admin/me ──────────────────────────────────────────────
  fastify.get("/tuition-admin/me", { onRequest: [guard] }, async (req, reply) => {
    const admin = await adminsCollection().findOne(
      { _id: toObjectId(req.tuitionAdmin.id) },
      { projection: { password: 0 } },
    );
    if (!admin || !admin.isActive) return reply.code(401).send({ error: "Unauthorized" });
    return { admin };
  });

  // ── GET /tuition-admin/sessions ────────────────────────────────────────
  fastify.get("/tuition-admin/sessions", { onRequest: [guard] }, async (req) => {
    const currentDeviceId = req.cookies?.[DEVICE_COOKIE];
    const sessions = await tokensCollection()
      .find({ adminId: toObjectId(req.tuitionAdmin.id) })
      .sort({ lastUsedAt: -1 })
      .toArray();

    return {
      sessions: sessions.map((s) => ({
        deviceId: s.deviceId,
        device: s.device,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        isCurrent: s.deviceId === currentDeviceId,
      })),
    };
  });

  // ── DELETE /tuition-admin/sessions/:deviceId ───────────────────────────
  fastify.delete(
    "/tuition-admin/sessions/:deviceId",
    { ...deleteSessionSchema, onRequest: [guard] },
    async (req, reply) => {
      const { deviceId } = req.params;
      if (deviceId === req.cookies?.[DEVICE_COOKIE]) {
        return reply.code(400).send({ error: "Use logout to sign out of the current device" });
      }

      const result = await tokensCollection().deleteOne({
        adminId: toObjectId(req.tuitionAdmin.id),
        deviceId,
      });
      if (result.deletedCount === 0) return reply.code(404).send({ error: "Session not found" });
      return { message: "Session revoked" };
    },
  );

  // ── POST /tuition-admin/change-password ────────────────────────────────
  // Revokes all OTHER devices after a successful change.
  fastify.post(
    "/tuition-admin/change-password",
    { ...changePasswordSchema, onRequest: [guard] },
    async (req, reply) => {
      const { currentPassword, newPassword } = req.body;

      const admin = await adminsCollection().findOne({ _id: toObjectId(req.tuitionAdmin.id) });
      if (!admin || !(await bcrypt.compare(currentPassword, admin.password))) {
        return reply.code(401).send({ error: "Current password is incorrect" });
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      await adminsCollection().updateOne({ _id: admin._id }, { $set: { password: newHash } });

      const currentDeviceId = req.cookies?.[DEVICE_COOKIE];
      await tokensCollection().deleteMany({
        adminId: admin._id,
        ...(currentDeviceId && { deviceId: { $ne: currentDeviceId } }),
      });

      return { message: "Password changed successfully" };
    },
  );
}

export default tuitionMediaAuth;
