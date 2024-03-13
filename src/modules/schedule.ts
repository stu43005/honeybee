import Agenda from "agenda";
import assert from "assert";
import { MONGO_URI } from "./db";

export function getAgenda() {
  assert(MONGO_URI);

  return new Agenda({
    db: {
      address: MONGO_URI,
      // collection: isProd ? "agendaJobs" : `testJobs-${HOSTNAME}`,
    },
  });
}
