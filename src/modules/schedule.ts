import { Agenda } from "agenda";
import { MongoBackend } from "@agendajs/mongo-backend";
import assert from "node:assert";
import { SHUTDOWN_TIMEOUT } from "../constants.js";
import { MONGO_URI } from "./db.js";
import type { Module } from "./module.js";

export class AgendaModule implements Module {
  name = "agenda";
  agenda: Agenda;

  constructor() {
    assert(MONGO_URI, "MONGO_URI should be defined.");

    this.agenda = new Agenda({
      backend: new MongoBackend({
        address: MONGO_URI,
      }),
    });

    this.agenda.on("start", (job) => {
      console.log(
        `[${job.attrs.name}] starting at ${new Date().toISOString()}`
      );
    });

    this.agenda.on("success", (job) => {
      console.log(
        `[${job.attrs.name}] successed at ${new Date().toISOString()}`
      );
    });

    this.agenda.on("fail", (err, job) => {
      console.log(`[${job.attrs.name}] failed with error: ${err.message}`);
    });
  }

  async init() {
    await this.agenda.start();
  }

  async close() {
    const result = await this.agenda.drain(SHUTDOWN_TIMEOUT);
    if (result.timedOut) {
      console.warn(
        `[agenda] drain timed out after ${SHUTDOWN_TIMEOUT}ms; ${result.running} job(s) still running`
      );
    }
  }
}
