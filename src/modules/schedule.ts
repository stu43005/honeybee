import Agenda from "agenda";
import assert from "assert";
import { MONGO_URI } from "./db";

export function getAgenda() {
  assert(MONGO_URI, "MONGO_URI should be defined.");

  const agenda = new Agenda({
    db: {
      address: MONGO_URI,
      // collection: isProd ? "agendaJobs" : `testJobs-${HOSTNAME}`,
    },
  });

  agenda.on("start", (job) => {
    console.log(`[${job.attrs.name}] starting at ${new Date()}`);
  });

  agenda.on("success", (job) => {
    console.log(`[${job.attrs.name}] successed at ${new Date()}`);
  });

  agenda.on("fail", (err, job) => {
    console.log(`[${job.attrs.name}] failed with error: ${err.message}`);
  });

  return agenda;
}
