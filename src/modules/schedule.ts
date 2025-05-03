import Agenda from "agenda";
import assert from "assert";
import { MONGO_URI } from "./db";
import type { Module } from "./module";

export class AgendaModule implements Module {
  name = "agenda";
  agenda: Agenda;

  constructor() {
    assert(MONGO_URI, "MONGO_URI should be defined.");

    this.agenda = new Agenda({
      db: {
        address: MONGO_URI,
        // collection: isProd ? "agendaJobs" : `testJobs-${HOSTNAME}`,
      },
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
    return this.agenda.drain();
  }
}
