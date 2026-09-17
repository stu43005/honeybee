import type { Job } from "agenda";
import { PUBLIC_BASE_URL, YOUTUBE_PUBSUB_SECRET } from "../../constants.js";
import type { Application } from "../application.js";
import type { Module } from "../module.js";
import { AgendaModule } from "../schedule.js";
import { renewPubsubSubscriptions } from "./renewal.js";
import { pubsubRoutes } from "./routes.js";

const JOB_YOUTUBE_PUBSUB_SUBSCRIBE = "crawler youtube pubsub subscribe";

// The renewal schedule. The two forms must describe the same gap: agenda takes
// the human-readable string, and the migration check in init() needs it in
// milliseconds.
const RENEW_INTERVAL = "10 minutes";
const RENEW_INTERVAL_MS = 10 * 60 * 1000;

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
    const job = await this.agenda.every(
      RENEW_INTERVAL,
      JOB_YOUTUBE_PUBSUB_SUBSCRIBE
    );

    // every() rewrites repeatInterval on an existing job document but not its
    // nextRunAt: the value it computes is the current time, and the backend
    // moves a nextRunAt that is not in the future into $setOnInsert, so an
    // existing document keeps whatever the previous schedule left there. A
    // document written by the old twelve hour schedule can therefore sit up to
    // twelve hours out, and the expired-lock path will not run it either,
    // because a job scheduled that far ahead is released again instead of
    // executed. Only a shrunken interval can put the next run further out than
    // one interval, so a crawler restart partway through a healthy cycle is
    // left alone rather than being dragged forward into an extra round.
    const nextRunAt = job.attrs.nextRunAt;
    if (nextRunAt && nextRunAt.getTime() > Date.now() + RENEW_INTERVAL_MS) {
      console.log(
        `Pulling [${JOB_YOUTUBE_PUBSUB_SUBSCRIBE}] in from ${nextRunAt.toISOString()}`
      );
      // Saving again goes through the job's _id, which the backend updates with
      // a plain $set, and save() excludes the processor-managed fields, so a
      // lock that is genuinely held keeps its owner.
      job.schedule(new Date());
      await job.save();
    }
  }
}
