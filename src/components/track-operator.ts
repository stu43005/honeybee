import assert from "node:assert";
import type { Application } from "../modules/application.js";
import type { AgendaModule } from "../modules/schedule.js";
import { transformTracks } from "../modules/track/transform.js";

export default function trackOperator(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  agenda.define("transform tracks", transformTracks);
  void agenda.every("1 hour", "transform tracks");
}
