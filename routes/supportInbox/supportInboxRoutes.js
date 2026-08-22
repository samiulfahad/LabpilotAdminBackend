import toObjectId from "../../utils/db.js";

const ALLOWED_STATUSES = ["unread", "read", "investigating", "resolved"];

/**
 * DELETE GUARD:
 * A message can only be deleted once it's "resolved". Any other status
 * ("unread", "read", or "investigating") is treated as still-open, so the
 * delete route refuses with 409 rather than letting an admin lose an
 * unhandled complaint. This is enforced here on the backend — the admin
 * frontend also disables the Delete button proactively for open messages,
 * but that's UX only; this is the authoritative check.
 */

// ─── Reusable Schema Fragments ────────────────────────────────────────────────

const objectIdSchema = {
  type: "string",
  minLength: 24,
  maxLength: 24,
  description: "MongoDB ObjectId (24-character hex string)",
};

const messageIdParamSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { ...objectIdSchema, description: "ObjectId of the support message" },
  },
};

// ─── Route Schemas ────────────────────────────────────────────────────────────

const getMessagesSchema = {
  schema: {
    tags: ["Support"],
    summary: "Get all support messages across all labs (system admin)",
    querystring: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ALLOWED_STATUSES, description: "Optional status filter" },
      },
    },
  },
};

const updateStatusSchema = {
  schema: {
    tags: ["Support"],
    summary: "Update a support message's status",
    params: messageIdParamSchema,
    body: {
      type: "object",
      required: ["status"],
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ALLOWED_STATUSES },
      },
    },
  },
};

const deleteMessageSchema = {
  schema: {
    tags: ["Support"],
    summary: "Delete a support message — only allowed once resolved",
    params: messageIdParamSchema,
  },
};

async function supportInboxRoutes(fastify) {
  const supportMessagesCollection = () => fastify.mongo.db.collection("supportMessages");

  fastify.addHook("onRequest", fastify.authenticate);

  // ── GET /support/messages ───────────────────────────────────────────────
  fastify.get("/support/messages", getMessagesSchema, async (req, reply) => {
    try {
      const filter = {};
      if (req.query.status) filter.status = req.query.status;

      const messages = await supportMessagesCollection().find(filter).sort({ createdAt: -1 }).toArray();

      return { messages };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch support messages" });
    }
  });

  // ── PATCH /support/messages/:id/status ──────────────────────────────────
  fastify.patch("/support/messages/:id/status", updateStatusSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid message ID" });

      const result = await supportMessagesCollection().updateOne(
        { _id },
        {
          $set: {
            status: req.body.status,
            updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
          },
        },
      );

      if (result.matchedCount === 0) return reply.code(404).send({ error: "Message not found" });

      return { message: "Status updated successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update message status" });
    }
  });

  // ── DELETE /support/messages/:id ────────────────────────────────────────
  fastify.delete("/support/messages/:id", deleteMessageSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid message ID" });

      const existing = await supportMessagesCollection().findOne({ _id }, { projection: { status: 1 } });

      if (!existing) return reply.code(404).send({ error: "Message not found" });
      if (existing.status !== "resolved") {
        return reply.code(409).send({ error: "শুধুমাত্র সমাধান হওয়া বার্তা মুছে ফেলা যাবে।" });
      }

      await supportMessagesCollection().deleteOne({ _id });

      return { message: "Message deleted successfully" };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete message" });
    }
  });
}

export default supportInboxRoutes;
