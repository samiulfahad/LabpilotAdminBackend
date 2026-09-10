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

const checkDuplicateQuery = {
  type: "object",
  required: ["name"],
  properties: { name: { type: "string", minLength: 1 } },
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
const checkDuplicateSchema = {
  tags: ["Test"],
  summary: "Check whether a test name is an exact or near duplicate of an existing catalog test",
  querystring: checkDuplicateQuery,
};

// Similarity threshold for the *soft* fuzzy-match warning layer. Exact
// duplicates (any formatting variant of the same name) are always caught
// via nameKey below — this only surfaces "did you mean...?" suggestions
// for genuine typos, and never blocks on its own.
const FUZZY_SIMILARITY_THRESHOLD = 0.82;
const FUZZY_MAX_RESULTS = 5;

// Reduces a test name to a canonical comparison key by stripping everything
// that's just formatting: case, whitespace, punctuation (., -, (), etc).
//
//   "X-Ray"        -> "xray"
//   "Xray"          -> "xray"
//   "X Ray"         -> "xray"
//   "S.GPT"         -> "sgpt"
//   "S GPT"         -> "sgpt"
//   "S-GPT"         -> "sgpt"
//   "X-Ray (Knee)"  -> "xrayknee"
//   "Xray - Knee"   -> "xrayknee"
//
// This is the key stored on every testCatalog doc as `nameKey`, backed by a
// unique index — so exact-duplicate detection is an O(1) indexed lookup
// instead of a full-collection scan, and is race-safe under concurrent writes.
function normalizeTestName(name) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");
}

// Standard edit-distance calculation. Used only for the *soft* fuzzy-match
// warning layer (typos like "Ferritin" vs "Ferritn") — exact duplicates are
// caught separately and cheaply via the indexed `nameKey` field, not this.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const currRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1, // insertion
        prevRow[j] + 1, // deletion
        prevRow[j - 1] + cost, // substitution
      );
    }
    prevRow = currRow;
  }

  return prevRow[b.length];
}

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

  // Narrowed candidate set for fuzzy matching: pull only docs whose nameKey
  // shares a short prefix with the target, since a genuine typo rarely
  // changes the first couple characters. Keeps this cheap without a text index.
  async function findFuzzyMatches(nameKey, excludeId) {
    if (nameKey.length < 2) return [];
    const prefix = nameKey.slice(0, 2);

    const candidates = await col()
      .find(
        { nameKey: { $regex: `^${prefix}` }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) },
        { projection: { name: 1, nameKey: 1, categoryId: 1 } },
      )
      .toArray();

    const fuzzy = [];
    for (const c of candidates) {
      if (c.nameKey === nameKey) continue; // exact matches are handled separately
      const dist = levenshtein(nameKey, c.nameKey);
      const similarity = 1 - dist / Math.max(nameKey.length, c.nameKey.length);
      if (similarity >= FUZZY_SIMILARITY_THRESHOLD) fuzzy.push({ ...c, similarity });
    }

    return fuzzy.sort((a, b) => b.similarity - a.similarity).slice(0, FUZZY_MAX_RESULTS);
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

  // GET /test/check-duplicate?name=...
  // Frontend calls this (debounced) as the admin/client types a new test
  // name. `exact` (if present) should block submission client-side; `fuzzy`
  // matches are informational only — genuinely different tests can be
  // textually close (e.g. "X-Ray Knee" vs "X-Ray Ankle").
  fastify.get("/test/check-duplicate", { schema: checkDuplicateSchema }, async (request) => {
    const nameKey = normalizeTestName(request.query.name);
    if (!nameKey) return { exact: null, fuzzy: [] };

    const exact = await col().findOne({ nameKey }, { projection: { name: 1, categoryId: 1 } });
    const fuzzy = exact ? [] : await findFuzzyMatches(nameKey);

    return { exact, fuzzy };
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
  //
  // Duplicate detection: `nameKey` is the normalized comparison key
  // (normalizeTestName above) — same for "X-Ray"/"Xray"/"X Ray"/"S.GPT"/
  // "S GPT" etc. It's backed by a unique index (see migration note below),
  // so the findOne here gives a clean 409 message in the common case, and
  // the E11000 catch is the actual race-safe guarantee under concurrent writes.
  fastify.post("/test", { schema: createTestSchema }, async (request, reply) => {
    const { name, categoryId } = request.body;

    const categoryOid = toObjectId(categoryId);
    if (!categoryOid) return reply.code(400).send({ message: "Invalid categoryId format" });

    const category = await categoryCol().findOne({ _id: categoryOid });
    if (!category) return reply.code(422).send({ message: `Category "${categoryId}" does not exist` });

    const nameKey = normalizeTestName(name);

    const existing = await col().findOne({ nameKey }, { projection: { name: 1 } });
    if (existing) {
      return reply.code(409).send({
        message: `A test named "${existing.name}" already exists`,
        existingTestId: existing._id,
      });
    }

    try {
      const result = await col().insertOne({
        name,
        nameKey, // ← normalized, unique-indexed comparison key
        categoryId: categoryOid, // ← stored as ObjectId
        defaultSchemaId: null, // ← always null on creation
      });

      const created = await col().findOne({ _id: result.insertedId });
      return reply.code(201).send(created);
    } catch (err) {
      if (err.code === 11000) {
        return reply.code(409).send({ message: "This test already exists" });
      }
      throw err;
    }
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
  //
  // Renames recompute `nameKey` and run the same duplicate check as create —
  // otherwise a rename could silently collide with an existing test.
  fastify.patch("/test/:id", { schema: updateTestSchema }, async (request, reply) => {
    const id = toObjectId(request.params.id);
    if (!id) return reply.code(400).send({ message: "Invalid ID format" });

    const { name, categoryId, defaultSchemaId } = request.body;
    const updates = {};

    if (name) {
      const nameKey = normalizeTestName(name);

      const existing = await col().findOne({ nameKey, _id: { $ne: id } }, { projection: { name: 1 } });
      if (existing) {
        return reply.code(409).send({
          message: `A test named "${existing.name}" already exists`,
          existingTestId: existing._id,
        });
      }

      updates.name = name;
      updates.nameKey = nameKey;
    }

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

    let result;
    try {
      result = await col().findOneAndUpdate({ _id: id }, { $set: updates }, { returnDocument: "after" });
    } catch (err) {
      if (err.code === 11000) {
        return reply.code(409).send({ message: "This test already exists" });
      }
      throw err;
    }

    if (!result) return reply.code(404).send({ message: "Test not found" });

    // Cascade only the fields a lab's `tests` doc actually copies from the
    // catalog (name, categoryId) — defaultSchemaId lives solely on the
    // catalog test and is deliberately not part of this sync. `nameKey` is
    // a catalog-only dedup concept and is never cascaded.
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
