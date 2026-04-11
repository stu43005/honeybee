import chatsArchive from "../components/chats-archive.js";
import cleanup from "../components/cleanup.js";
import trackOperator from "../components/track-operator.js";
import videoScaler from "../components/video-scaler.js";
import videoStats from "../components/video-stats.js";
import webhookPrepare from "../components/webhook-prepare.js";
import { Application } from "../modules/application.js";
import { MongodbModule } from "../modules/db.js";
import { AgendaModule } from "../modules/schedule.js";

export async function runManager() {
  const app = new Application();
  app.use(new MongodbModule());
  app.use(new AgendaModule());
  await app.init();
  console.log("Manager started");

  cleanup(app);
  trackOperator(app);
  webhookPrepare(app);
  videoStats(app);
  videoScaler(app);
  chatsArchive(app);
}
