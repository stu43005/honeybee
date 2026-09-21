import chatsArchive from "./chats-archive/index.js";
import cleanup from "./cleanup.js";
import giftPrice from "./gift-price.js";
import trackOperator from "./track-operator.js";
import videoScaler from "./video-scaler.js";
import videoStats from "./video-stats.js";
import webhookPrepare from "./webhook-prepare.js";
import youtubeDmOperator from "./youtube-dm-operator.js";
import { Application } from "#modules/application.js";
import { MongodbModule } from "#modules/db.js";
import { AgendaModule } from "#modules/schedule.js";

export async function runManager() {
  const app = new Application();
  app.use(new MongodbModule());
  app.use(new AgendaModule());
  await app.init();
  console.log("Manager started");

  cleanup(app);
  trackOperator(app);
  webhookPrepare(app);
  youtubeDmOperator(app);
  giftPrice(app);
  videoStats(app);
  videoScaler(app);
  chatsArchive(app);
}
