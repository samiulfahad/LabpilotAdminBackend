import toObjectId from "../../utils/db.js";

const OID = {
  type: "string",
  minLength: 24,
  maxLength: 24,
  pattern: "^[a-fA-F0-9]{24}$",
};

const OID_NULLABLE = {
  type: ["string", "null"],
  minLength: 24,
  maxLength: 24,
  pattern: "^[a-fA-F0-9]{24}$",
};

const idParam = {
  type: "object",
  additionalProperties: false,
  properties: { id: OID },
};

const createTestBody = {
  type: "object",
  required: ["name", "categoryId"],
  properties: {
    name: { type: "string", minLength: 1 },
    categoryId: OID,
  },
  additionalProperties: false,
};

const updateTestBody = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    categoryId: OID,
    defaultSchemaId: OID_NULLABLE,
  },
  additionalProperties: false,
};

const listTestsQuery = {
  type: "object",
  properties: { categoryId: { type: "string" } },
};

const listTestsSchema = { tags: ["Test"], summary: "List all tests", querystring: listTestsQuery };
const getTestSchema = { tags: ["Test"], summary: "Get a test by ID", params: idParam };
const createTestSchema = { tags: ["Test"], summary: "Create a new test", body: createTestBody };
const updateTestSchema = {
  tags: ["Test"],
  summary: "Update a test (name, category, or default schema)",
  params: idParam,
  body: updateTestBody,
};
const deleteTestSchema = { tags: ["Test"], summary: "Delete a test", params: idParam };

export default async function testRoutes(fastify) {
  function col() {
    return fastify.mongo.db.collection("testCatalog");
  }

  function categoryCol() {
    return fastify.mongo.db.collection("testCategories");
  }

  function schemaCol() {
    return fastify.mongo.db.collection("testSchemas");
  }

  // Lab-owned test docs (testRoutes.js) copy `name`/`categoryId` from the
  // catalog test at creation time — these need to stay in sync whenever the
  // catalog test is renamed or recategorized, across every lab that has it.
  function labTestsCol() {
    return fastify.mongo.db.collection("tests");
  }

  // GET /test/all
  fastify.get("/test/all", { schema: listTestsSchema }, async (request) => {
    const filter = {};

    if (request.query.categoryId) {
      filter.categoryId = toObjectId(request.query.categoryId);
    }
    const result = await col().find(filter).toArray();
    return result;
  });

  // GET /test/:id
  fastify.get("/test/:id", { schema: getTestSchema }, async (request, reply) => {
    const id = toObjectId(request.params.id);
    if (!id) return reply.code(400).send({ message: "Invalid ID format" });

    const test = await col().findOne({ _id: id });
    if (!test) return reply.code(404).send({ message: "Test not found" });

    return test;
  });

  // POST /test
  // A test is "online" purely by having schema(s) attached to it (see
  // /test-schema/by-test/:testId) — the test document itself carries no
  // schema-selection field. defaultSchemaId is always null at creation;
  // it can only be set afterward, once at least one schema exists for the
  // test, via PATCH /test/:id.
  fastify.post("/test", { schema: createTestSchema }, async (request, reply) => {
    const { name, categoryId } = request.body;

    const categoryOid = toObjectId(categoryId);
    if (!categoryOid) return reply.code(400).send({ message: "Invalid categoryId format" });

    const category = await categoryCol().findOne({ _id: categoryOid });
    if (!category) return reply.code(422).send({ message: `Category "${categoryId}" does not exist` });

    const result = await col().insertOne({
      name,
      categoryId: categoryOid, // ← stored as ObjectId
      defaultSchemaId: null, // ← always null on creation
    });

    const created = await col().findOne({ _id: result.insertedId });
    return reply.code(201).send(created);
  });

  // PATCH /test/:id
  // defaultSchemaId, when non-null, must reference a schema that actually
  // belongs to this test (testSchemas.testId === id) — otherwise a test
  // could be pointed at another test's schema by mistake.
  //
  // When name/categoryId change here, every lab's `tests` doc that
  // references this catalog test (tests.testId === id) is denormalized —
  // it copied these fields at creation time — so we cascade the same
  // fields into the `tests` collection via updateMany, scoped by testId
  // (intentionally unscoped by labId — this cascades across all labs).
  fastify.patch("/test/:id", { schema: updateTestSchema }, async (request, reply) => {
    const id = toObjectId(request.params.id);
    if (!id) return reply.code(400).send({ message: "Invalid ID format" });

    const { name, categoryId, defaultSchemaId } = request.body;
    const updates = {};

    if (name) updates.name = name;

    if (categoryId !== undefined) {
      const categoryOid = toObjectId(categoryId);
      if (!categoryOid) return reply.code(400).send({ message: "Invalid categoryId format" });

      const category = await categoryCol().findOne({ _id: categoryOid });
      if (!category) return reply.code(422).send({ message: `Category "${categoryId}" does not exist` });

      updates.categoryId = categoryOid; // ← stored as ObjectId
    }

    if (defaultSchemaId !== undefined) {
      if (defaultSchemaId === null) {
        updates.defaultSchemaId = null;
      } else {
        const defaultSchemaOid = toObjectId(defaultSchemaId);
        if (!defaultSchemaOid) return reply.code(400).send({ message: "Invalid defaultSchemaId format" });

        const schema = await schemaCol().findOne({ _id: defaultSchemaOid });
        if (!schema) return reply.code(422).send({ message: `Schema "${defaultSchemaId}" does not exist` });
        if (schema.testId?.toString() !== id.toString()) {
          return reply.code(422).send({ message: "Schema does not belong to this test" });
        }

        updates.defaultSchemaId = defaultSchemaOid; // ← stored as ObjectId
      }
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ message: "Nothing to update" });
    }

    const result = await col().findOneAndUpdate({ _id: id }, { $set: updates }, { returnDocument: "after" });

    if (!result) return reply.code(404).send({ message: "Test not found" });

    // Cascade only the fields a lab's `tests` doc actually copies from the
    // catalog (name, categoryId) — defaultSchemaId lives solely on the
    // catalog test and is deliberately not part of this sync.
    const cascade = {};
    if (updates.name !== undefined) cascade.name = updates.name;
    if (updates.categoryId !== undefined) cascade.categoryId = updates.categoryId;

    if (Object.keys(cascade).length > 0) {
      await labTestsCol().updateMany({ testId: id }, { $set: cascade });
    }

    return result;
  });

  // DELETE /test/:id
  fastify.delete("/test/:id", { schema: deleteTestSchema }, async (request, reply) => {
    const id = toObjectId(request.params.id);
    if (!id) return reply.code(400).send({ message: "Invalid ID format" });

    const result = await col().deleteOne({ _id: id });
    if (result.deletedCount === 0) return reply.code(404).send({ message: "Test not found" });

    return { message: "Test deleted successfully" };
  });
}
