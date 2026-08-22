import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import toObjectId from "../../utils/db.js";

// ── Favorite-word allowlist ──────────────────────────────────────────────
// A third factor on top of identifier + password. Kept OUT of the database
// entirely and loaded from an env var so it can be rotated by editing the
// .env file and restarting the process — never touches source or git.
//
//   FAVORITE_WORDS="ironclad,obsidian,quorum,driftwood"
//
// Comma-separated, case-insensitive, whitespace-trimmed. Loaded once at
// module init — a restart is required to pick up a changed list, which is
// intentional (there's no runtime endpoint that can alter this file).
const FAVORITE_WORDS = (process.env.FAVORITE_WORDS || "")
  .split(",")
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);

if (FAVORITE_WORDS.length === 0) {
  console.warn("[authRoutes] FAVORITE_WORDS is empty or unset — no favorite word will ever pass.");
}

const isValidFavoriteWord = (word) => typeof word === "string" && FAVORITE_WORDS.includes(word.trim().toLowerCase());

const MAX_ADMIN_SESSIONS = 3;

// 30s grace window for refresh-token rotation races (e.g. two tabs
// refreshing near-simultaneously). Only the IMMEDIATELY PRIOR token for a
// given session may be replayed inside this window — matched by hash, not
// by "some session on this device was recently active" — so a stolen but
// already-rotated-away token from an earlier cycle is still rejected.
const REFRESH_GRACE_WINDOW_MS = 30_000;

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

// ── Route schemas ─────────────────────────────────────────────────────────

const loginSchema = {
  schema: {
    tags: ["Auth"],
    summary: "System admin login (favorite word + identifier + password)",
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

const refreshSchema = {
  schema: {
    tags: ["Auth"],
    summary: "Rotate refresh token and issue a new access token",
  },
};

const logoutSchema = {
  schema: {
    tags: ["Auth"],
    summary: "Log out the current device",
  },
};

const logoutAllSchema = {
  schema: {
    tags: ["Auth"],
    summary: "Log out all devices for the current admin",
  },
};

const meSchema = {
  schema: {
    tags: ["Auth"],
    summary: "Get the current admin's profile",
  },
};

const sessionsSchema = {
  schema: {
    tags: ["Auth"],
    summary: "List active sessions for the current admin",
  },
};

const deleteSessionSchema = {
  schema: {
    tags: ["Auth"],
    summary: "Revoke a specific device's session",
    params: {
      type: "object",
      required: ["deviceId"],
      properties: {
        deviceId: { type: "string", minLength: 1, maxLength: 100 },
      },
    },
  },
};

const changePasswordSchema = {
  schema: {
    tags: ["Auth"],
    summary: "Change the current admin's password",
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

async function authRoutes(fastify) {
  const adminsCollection = () => fastify.mongo.db.collection("theGreatKingo");
  const tokensCollection = () => fastify.mongo.db.collection("theGreatKingoTokens");

  // ── POST /admin/login ─────────────────────────────────────────────────
  fastify.post("/admin/login", loginSchema, async (req, reply) => {
    const { favoriteWord, identifier, password, device } = req.body || {};

    if (!isValidFavoriteWord(favoriteWord)) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const trimmedIdentifier = String(identifier).trim();
    const admin = await adminsCollection().findOne({
      $or: [{ username: trimmedIdentifier }, { phone: trimmedIdentifier }],
    });

    if (!admin || !admin.isActive || !(await bcrypt.compare(password, admin.password))) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const payload = {
      id: admin._id.toString(),
      username: admin.username,
      phone: admin.phone,
    };

    const deviceId = randomUUID();
    const accessToken = await reply.jwtSign(payload);
    const refreshTokenPlain = await fastify.jwt.sign(payload, {
      key: fastify.REFRESH_SECRET,
      expiresIn: fastify.REFRESH_EXPIRY,
    });

    // ── Enforce max concurrent sessions ───────────────────────────────
    const sessions = await tokensCollection()
      .find({ adminId: toObjectId(payload.id) })
      .sort({ createdAt: 1 })
      .toArray();
    if (sessions.length >= MAX_ADMIN_SESSIONS) {
      await tokensCollection().deleteOne({ _id: sessions[0]._id });
    }

    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
    const userAgent = req.headers["user-agent"] || "unknown";

    const deviceInfo = {
      browser: device?.browser ?? "Unknown",
      browserVersion: device?.browserVersion ?? "",
      os: device?.os ?? "Unknown",
      osVersion: device?.osVersion ?? "",
      deviceType: device?.deviceType ?? "unknown",
      screenRes: device?.screenRes ?? "",
      timezone: device?.timezone ?? "",
      language: device?.language ?? "",
      ip,
      userAgent,
    };

    await tokensCollection().insertOne({
      adminId: toObjectId(payload.id),
      deviceId,
      refreshToken: fastify.hashToken(refreshTokenPlain),
      previousRefreshTokenHash: null,
      device: deviceInfo,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + fastify.REFRESH_EXPIRY_MS),
    });

    reply
      .setCookie("refreshToken", refreshTokenPlain, fastify.cookieOptions)
      .setCookie("deviceId", deviceId, fastify.cookieOptions);

    return { accessToken, admin: { id: payload.id, username: admin.username, phone: admin.phone } };
  });

  // ── POST /admin/refresh ───────────────────────────────────────────────
  fastify.post("/admin/refresh", refreshSchema, async (req, reply) => {
    const { refreshToken, deviceId } = req.cookies || {};
    if (!refreshToken || !deviceId) {
      return reply.code(445).send({ error: "Missing tokens" });
    }

    let decoded;
    try {
      decoded = await fastify.jwt.verify(refreshToken, { key: fastify.REFRESH_SECRET });
    } catch {
      return reply.code(445).send({ error: "Invalid or expired refresh token" });
    }

    const payload = {
      id: decoded.id,
      username: decoded.username,
      phone: decoded.phone,
    };

    const presentedHash = fastify.hashToken(refreshToken);

    // Matches either:
    //  (a) the CURRENT refresh token for this session — normal case, or
    //  (b) the IMMEDIATELY PRIOR token, but only within the grace window —
    //      covers a legitimate rotation race (e.g. two tabs refreshing at
    //      once). Matching by hash (not just "session was recently active")
    //      means a stolen token from an earlier, already-superseded cycle
    //      is rejected even inside the same 30s window.
    const session = await tokensCollection().findOne({
      adminId: toObjectId(payload.id),
      deviceId: deviceId,
      expiresAt: { $gt: new Date() },
      $or: [
        { refreshToken: presentedHash },
        {
          previousRefreshTokenHash: presentedHash,
          lastUsedAt: { $gt: new Date(Date.now() - REFRESH_GRACE_WINDOW_MS) },
        },
      ],
    });

    if (!session) {
      return reply.code(445).send({ error: "Session expired or revoked" });
    }

    const newRefreshTokenPlain = await fastify.jwt.sign(payload, {
      key: fastify.REFRESH_SECRET,
      expiresIn: fastify.REFRESH_EXPIRY,
    });

    await tokensCollection().updateOne(
      { _id: session._id },
      {
        $set: {
          refreshToken: fastify.hashToken(newRefreshTokenPlain),
          previousRefreshTokenHash: presentedHash,
          lastUsedAt: new Date(),
          expiresAt: new Date(Date.now() + fastify.REFRESH_EXPIRY_MS),
        },
      },
    );

    const newAccessToken = await reply.jwtSign(payload);
    reply.setCookie("refreshToken", newRefreshTokenPlain, fastify.cookieOptions);

    return { accessToken: newAccessToken };
  });

  // ── POST /admin/logout ────────────────────────────────────────────────
  fastify.post("/admin/logout", logoutSchema, async (req, reply) => {
    const { refreshToken, deviceId } = req.cookies || {};

    if (refreshToken && deviceId) {
      let adminId;
      try {
        const decoded = fastify.jwt.decode(refreshToken);
        adminId = decoded?.id;
      } catch {
        // still clear cookies below
      }

      await tokensCollection().deleteOne({
        ...(adminId && { adminId: toObjectId(adminId) }),
        deviceId: deviceId,
        refreshToken: fastify.hashToken(refreshToken),
      });
    }

    reply.clearCookie("refreshToken", fastify.cookieOptions).clearCookie("deviceId", fastify.cookieOptions);

    return { message: "Logged out from this device" };
  });

  // ── POST /admin/logout-all ────────────────────────────────────────────
  fastify.post("/admin/logout-all", { ...logoutAllSchema, onRequest: [fastify.authenticate] }, async (req, reply) => {
    await tokensCollection().deleteMany({ adminId: toObjectId(req.user.id) });

    reply.clearCookie("refreshToken", fastify.cookieOptions).clearCookie("deviceId", fastify.cookieOptions);

    return { message: "Logged out from all devices" };
  });

  // ── GET /admin/me ─────────────────────────────────────────────────────
  fastify.get("/admin/me", { ...meSchema, onRequest: [fastify.authenticate] }, async (req) => {
    const admin = await adminsCollection().findOne({ _id: toObjectId(req.user.id) }, { projection: { password: 0 } });
    return { admin };
  });

  // ── GET /admin/sessions ──────────────────────────────────────────────
  fastify.get("/admin/sessions", { ...sessionsSchema, onRequest: [fastify.authenticate] }, async (req) => {
    const currentDeviceId = req.cookies?.deviceId;

    const sessions = await tokensCollection()
      .find({ adminId: toObjectId(req.user.id) })
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

  // ── DELETE /admin/sessions/:deviceId ─────────────────────────────────
  // Revoke a specific device's session. Revoking the CURRENT device is
  // rejected here — use POST /admin/logout for that (it also clears cookies).
  fastify.delete(
    "/admin/sessions/:deviceId",
    { ...deleteSessionSchema, onRequest: [fastify.authenticate] },
    async (req, reply) => {
      const currentDeviceId = req.cookies?.deviceId;
      const { deviceId } = req.params;

      if (deviceId === currentDeviceId) {
        return reply.code(400).send({ error: "Use logout to sign out of the current device" });
      }

      const result = await tokensCollection().deleteOne({
        adminId: toObjectId(req.user.id),
        deviceId,
      });

      if (result.deletedCount === 0) {
        return reply.code(404).send({ error: "Session not found" });
      }

      return { message: "Session revoked" };
    },
  );

  // ── POST /admin/change-password ──────────────────────────────────────
  fastify.post(
    "/admin/change-password",
    { ...changePasswordSchema, onRequest: [fastify.authenticate] },
    async (req, reply) => {
      const { currentPassword, newPassword } = req.body;

      const admin = await adminsCollection().findOne({ _id: toObjectId(req.user.id) });
      if (!admin || !(await bcrypt.compare(currentPassword, admin.password))) {
        return reply.code(401).send({ error: "Current password is incorrect" });
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      await adminsCollection().updateOne({ _id: admin._id }, { $set: { password: newHash } });

      return { message: "Password changed successfully" };
    },
  );
}

export default authRoutes;
