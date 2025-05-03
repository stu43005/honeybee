import fastify, { type FastifyInstance } from "fastify";
import type { Module } from "./module";

export class HttpServerModule implements Module {
  name = "http-server";
  server: FastifyInstance;
  private noLogRoutes: string[] = [];

  constructor() {
    this.server = fastify({
      logger: true,
      disableRequestLogging: true,
    });
    this.server.addHook("onResponse", (req, reply, done) => {
      if (!this.noLogRoutes.some((route) => req.url?.startsWith(route))) {
        req.log.info(
          { res: reply, responseTime: reply.elapsedTime },
          "request completed"
        );
      }
      done();
    });
  }

  async init(): Promise<void> {
    await this.server.listen({
      port: Number(process.env.PORT || 3000),
      host: "0.0.0.0",
    });
  }

  async close(): Promise<void> {
    return this.server.close();
  }

  addNoLogRoute(route: string) {
    this.noLogRoutes.push(route);
  }
}
