import { HttpServerModule } from "./http-server.js";
import type { Module } from "./module.js";

export class Application {
  private modules: Module[] = [];
  public http: HttpServerModule;

  constructor() {
    process.on("SIGTERM", async (signal) => {
      console.log("quitting (SIGTERM) ...");
      await this.close(signal);
      process.exit(0);
    });

    this.http = this.use(new HttpServerModule());
    this.http.server.get("/healthz", async (_request, _reply) => {
      for (let index = 0; index < this.modules.length; index++) {
        const module = this.modules[index];
        try {
          if (
            module.isInit &&
            module.healthCheck &&
            !(await module.healthCheck())
          ) {
            throw new Error(`${module.name} not ready.`);
          }
        } catch {
          throw new Error(`${module.name} not ready.`);
        }
      }
      return "ok";
    });
    this.http.addNoLogRoute("/healthz");
  }

  public use<T extends Module>(module: T): T {
    this.modules.push(module);
    return module;
  }

  public get<T extends Module>(name: string): T | undefined {
    return this.modules.find((m) => m.name === name) as T | undefined;
  }

  public async init(): Promise<void> {
    for (let index = 0; index < this.modules.length; index++) {
      const module = this.modules[index];
      if (!module.isInit) {
        module.isInit = true;
        await module.init?.();
      }
    }
  }

  public async close(signal: NodeJS.Signals): Promise<void> {
    for (let index = this.modules.length - 1; index >= 0; index--) {
      const module = this.modules[index];
      try {
        await module.close?.(signal);
        module.isInit = false;
      } catch (error) {
        console.error(
          `Failed to shut down gracefully [${module.name}]:`,
          error
        );
      }
    }
  }
}
