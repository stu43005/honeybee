import axios from "axios";
import assert from "node:assert";
import http from "node:http";
import https from "node:https";
import { setTimeout } from "node:timers/promises";
import { matchPresets } from "../data/webhook.js";
import WebhookModel from "../models/Webhook.js";
import type { Application } from "../modules/application.js";
import { documentLog } from "../modules/db.js";
import type { AgendaModule } from "../modules/schedule.js";

export default function webhookPrepare(app: Application) {
  const { agenda } = app.get<AgendaModule>("agenda") ?? {};
  assert(agenda, "agenda should be defined.");

  const prepareAllWebhooks = "webhook prepare webhooks";
  agenda.define(prepareAllWebhooks, async (): Promise<void> => {
    const axiosInstance = axios.create({
      timeout: 4000,
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true }),
    });

    for await (const webhook of WebhookModel.findEnabled()) {
      // Check if the webhook is still valid
      webhook.failedAttempts ??= 0;
      try {
        await axiosInstance.get(webhook.insertUrl, {
          timeout: 60_000,
        });
        webhook.lastSuccess = new Date();
        webhook.failedAttempts = 0;
        webhook.enabled = true;
      } catch (error) {
        documentLog(
          webhook,
          "<!> [ERROR] Unable to connect to the webhook",
          error
        );
        webhook.failedAttempts += 1;

        // Disable webhook after 24 failed attempts to prevent excessive retries.
        if (webhook.failedAttempts >= 24) {
          webhook.enabled = false;
        }
      }
      webhook.lastChecked = new Date();

      // Prepare webhook match
      try {
        if (webhook.matchPreset && matchPresets[webhook.matchPreset]) {
          const match = await matchPresets[webhook.matchPreset](webhook);
          if (JSON.stringify(webhook.match) !== JSON.stringify(match)) {
            documentLog(webhook, "change match");
            webhook.match = match;
          }
        }
      } catch (error) {
        documentLog(webhook, "<!> [ERROR] Unable to prepare webhook", error);
      }

      await webhook.save();
      await setTimeout(1000);
    }
  });
  void agenda.every("1 hour", prepareAllWebhooks);
}
