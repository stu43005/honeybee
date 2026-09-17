import type { Job } from "agenda";
import { PUBLIC_BASE_URL, YOUTUBE_PUBSUB_SECRET } from "../../constants.js";
import type { Application } from "../application.js";
import type { Module } from "../module.js";
import { AgendaModule } from "../schedule.js";
import { renewPubsubSubscriptions } from "./renewal.js";
import { pubsubRoutes } from "./routes.js";

const JOB_YOUTUBE_PUBSUB_SUBSCRIBE = "crawler youtube pubsub subscribe";

/**
 * Owns everything the pubsub subsystem needs at runtime: the notification
 * routes and the renewal job. A service that wants YouTube push notifications
 * only has to `app.use(new YoutubePubsubModule(app))`.
 */
export class YoutubePubsubModule implements Module {
  public readonly name = "youtube-pubsub";

  // Without a public address there is no callback URL to give the hub, and
  // without the secret a delivery cannot be verified, so pubsub stays off.
  private readonly enabled = !!PUBLIC_BASE_URL && !!YOUTUBE_PUBSUB_SECRET;
  private readonly agenda;

  constructor(private readonly app: Application) {
    const agendaModule = this.app.get<AgendaModule>("agenda");
    if (!agendaModule) {
      throw new Error(
        "YoutubePubsubModule: AgendaModule must be registered before YoutubePubsubModule"
      );
    }
    this.agenda = agendaModule.agenda;

    if (!this.enabled) {
      console.log(
        "youtube pubsub is disabled (PUBLIC_BASE_URL or YOUTUBE_PUBSUB_SECRET is unset)"
      );
      return;
    }

    // Routes must be registered before HttpServerModule.init() calls listen():
    // fastify refuses to add routes once it is listening, and HttpServerModule
    // is the first module Application registers, so its init() runs before
    // this module's. register() only queues the plugin — it is loaded during
    // listen() — so there is nothing to await here.
    void this.app.http.server.register(pubsubRoutes);
    // Deliveries are frequent, and one request log line each would drown out
    // everything else. The match is a prefix, so the tokenized path is covered.
    this.app.http.addNoLogRoute("/notifications/youtube");
  }

  async init(): Promise<void> {
    if (!this.enabled) return;

    // The job name is unchanged on purpose: renaming it would leave the old
    // agendaJobs document locked forever, with no code that ever clears it.
    this.agenda.define(
      JOB_YOUTUBE_PUBSUB_SUBSCRIBE,
      async (_job: Job): Promise<void> => {
        await renewPubsubSubscriptions();
      }
    );
    // Small batches, often: the loss ceiling of one crash or one throttling
    // response is those few channels, and the next round picks up ten minutes
    // later.
    await this.agenda.every("10 minutes", JOB_YOUTUBE_PUBSUB_SUBSCRIBE);
  }
}
