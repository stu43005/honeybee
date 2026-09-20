import assert from "node:assert";
import type { Application } from "../modules/application.js";
import type { AgendaModule } from "../modules/schedule.js";
import { transformYoutubeDmBindings } from "../modules/youtube-dm/transform.js";

export default function youtubeDmOperator(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  agenda.define("transform youtube dm bindings", transformYoutubeDmBindings);
  void agenda.every("1 hour", "transform youtube dm bindings");
}
