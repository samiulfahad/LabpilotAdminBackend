// Tuition Media bundle: single entry point for admin + client routes.
// import tuitionMediaAdmin from "./admin/tuitionMediaAdmin.js";
import tuitionMediaClient from "./users/tuitionMediaClient.js";
import instituteRoutes from "./admin/tuitionMediaAdmin.js";

async function tuitionMedia(fastify, opts) {
  // opts.prefix is inherited automatically by child plugins
  // await fastify.register(tuitionMediaAdmin);
  await fastify.register(tuitionMediaClient);
  await fastify.register(instituteRoutes)
}

export default tuitionMedia;