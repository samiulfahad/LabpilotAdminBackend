import toObjectId from "../../utils/db.js";

const OID = {
  type: "string",
  minLength: 24,
  maxLength: 24,
  pattern: "^[a-fA-F0-9]{24}$",
};

const idParam = {
  type: "object",
  additionalProperties: false,
  properties: { id: OID },
};

const testIdParam = {
  type: "object",
  additionalProperties: false,
  properties: { testId: OID },
};

const listSchemasSchema = { tags: ["Test Schema"], summary: "List all test schemas" };
const listByTestSchema = { tags: ["Test Schema"], summary: "List schemas for a test", params: testIdParam };
const getSchemaSchema = { tags: ["Test Schema"], summary: "Get a schema by ID", params: idParam };
const createSchemaSchema = { tags: ["Test Schema"], summary: "Create a new test schema" };
const updateSchemaSchema = { tags: ["Test Schema"], summary: "Update a test schema", params: idParam };
const deleteSchemaSchema = { tags: ["Test Schema"], summary: "Delete a test schema", params: idParam };
const setDefaultSchema = {
  tags: ["Test Schema"],
  summary: "Set a schema as the default for its test",
  params: idParam,
};

export default async function schemaRoutes(fastify) {
  function col() {
    return fastify.mongo.db.collection("testSchemas");
  }

  function testCol() {
    return fastify.mongo.db.collection("testCatalog");
  }

  // GET /test-schema/all
  fastify.get("/test-schema/all", { schema: listSchemasSchema }, async () => {
    const docs = await col().find({}).sort({ createdAt: -1 }).toArray();

    const testsWithDefault = await testCol()
      .find({ defaultSchemaId: { $ne: null } })
      .toArray();
    const defaultIds = new Set(testsWithDefault.map((t) => t.defaultSchemaId?.toString()));

    return docs.map((doc) => ({ ...doc, isDefault: defaultIds.has(doc._id.toString()) }));
  });

  // GET /test-schema/by-test/:testId
  fastify.get("/test-schema/by-test/:testId", { schema: listByTestSchema }, async (request, reply) => {
    const testId = toObjectId(request.params.testId);
    if (!testId) return reply.code(400).send({ message: "Invalid testId format" });

    const [docs, test] = await Promise.all([
      col().find({ testId }).sort({ createdAt: -1 }).toArray(),
      testCol().findOne({ _id: testId }),
    ]);

    const defaultId = test?.defaultSchemaId?.toString();
    return docs.map((doc) => ({ ...doc, isDefault: !!defaultId && doc._id.toString() === defaultId }));
  });

  // GET /test-schema/:id
  fastify.get("/test-schema/:id", { schema: getSchemaSchema }, async (request, reply) => {
    const id = toObjectId(request.params.id);
    if (!id) return reply.code(400).send({ message: "Invalid ID format" });

    const doc = await col().findOne({ _id: id });
    if (!doc) return reply.code(404).send({ message: "Test schema not found" });

    return doc;
  });

  // POST /test-schema
  fastify.post("/test-schema", { schema: createSchemaSchema }, async (request, reply) => {
    const body = request.body ?? {};

    if (body.testId) {
      const testOid = toObjectId(body.testId);
      if (!testOid) return reply.code(400).send({ message: "Invalid testId format" });
      body.testId = testOid;
    }

    const doc = {
      ...body,
      createdAt: Date.now(),
    };

    const result = await col().insertOne(doc);
    const created = await col().findOne({ _id: result.insertedId });
    return reply.code(201).send(created);
  });

  // PATCH /test-schema/:id
  fastify.patch("/test-schema/:id", { schema: updateSchemaSchema }, async (request, reply) => {
    const id = toObjectId(request.params.id);
    if (!id) return reply.code(400).send({ message: "Invalid ID format" });

    const { _id, createdAt, ...rest } = request.body ?? {};

    if (Object.keys(rest).length === 0) {
      return reply.code(400).send({ message: "Nothing to update" });
    }

    if (rest.testId) {
      const testOid = toObjectId(rest.testId);
      if (!testOid) return reply.code(400).send({ message: "Invalid testId format" });
      rest.testId = testOid;
    }

    const result = await col().findOneAndUpdate({ _id: id }, { $set: rest }, { returnDocument: "after" });

    if (!result) return reply.code(404).send({ message: "Test schema not found" });
    return result;
  });

  // PATCH /test-schema/:id/set-default
  // Sets this schema as the default for its own test (testCatalog.defaultSchemaId).
  // This is the ONLY place defaultSchemaId is ever written — testRoutes.js only
  // ever creates it as null and never updates it.
  fastify.patch("/test-schema/:id/set-default", { schema: setDefaultSchema }, async (request, reply) => {
    const id = toObjectId(request.params.id);
    if (!id) return reply.code(400).send({ message: "Invalid ID format" });

    const schemaDoc = await col().findOne({ _id: id });
    if (!schemaDoc) return reply.code(404).send({ message: "Test schema not found" });
    if (!schemaDoc.testId) return reply.code(422).send({ message: "Schema is not attached to a test" });

    const result = await testCol().findOneAndUpdate(
      { _id: schemaDoc.testId },
      { $set: { defaultSchemaId: id } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Test not found for this schema" });
    return result;
  });

  // DELETE /test-schema/:id
  // Blocked if any test currently points to this schema as its default —
  // must be unset (by making another schema default) before it can be deleted.
  fastify.delete("/test-schema/:id", { schema: deleteSchemaSchema }, async (request, reply) => {
    const id = toObjectId(request.params.id);
    if (!id) return reply.code(400).send({ message: "Invalid ID format" });

    const test = await testCol().findOne({ defaultSchemaId: id });
    if (test) {
      return reply
        .code(422)
        .send({ message: `Cannot delete: this schema is set as the default schema for "${test.name}"` });
    }

    const result = await col().deleteOne({ _id: id });
    if (result.deletedCount === 0) return reply.code(404).send({ message: "Test schema not found" });

    return { message: "Test schema deleted successfully" };
  });
}
