import chatsArchive from "../components/chats-archive";
import cleanup from "../components/cleanup";
import trackOperator from "../components/track-operator";
import videoScaler from "../components/video-scaler";
import videoStats from "../components/video-stats";
import webhookPrepare from "../components/webhook-prepare";
import { Application } from "../modules/application";
import { MongodbModule } from "../modules/db";
import { AgendaModule } from "../modules/schedule";

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
