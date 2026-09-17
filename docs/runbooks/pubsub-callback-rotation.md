# Changing YOUTUBE_PUBSUB_SECRET or PUBLIC_BASE_URL

A PubSubHubbub subscription is keyed by `(topic, callback URL)`, and the
crawler's callback URL carries a token derived from `YOUTUBE_PUBSUB_SECRET`.
Changing either setting therefore invalidates every existing subscription on the
hub side (the signature no longer verifies, or the callback address no longer
points at us), while `channels.pubsubExpiresAt` in MongoDB still looks valid.
Those channels would be skipped by renewal for up to about four days.

## Order (there is only one correct order)

1. Apply the new configuration and redeploy the crawler.
2. Wait for the rollout to finish:

   ```bash
   kubectl rollout status deploy/crawler -n honeybee
   ```

3. Wait until the old pod is really gone. `rollout status` returns as soon as
   the new ReplicaSet is complete, but the old pod can still be terminating —
   `terminationGracePeriodSeconds` is 60 — and a process in that state can
   still write to MongoDB. The deployment runs one replica, so wait for exactly
   one pod to remain:

   ```bash
   until [ "$(kubectl get pods -n honeybee -l app=crawler --no-headers | wc -l | tr -d ' ')" = "1" ]; do
     sleep 5
   done
   kubectl get pods -n honeybee -l app=crawler
   ```

   Confirm from that last listing that the single remaining pod is `Running`
   and is the new one (its name changes with every rollout).

4. Clear every stored expiry, so all channels become renewal candidates again:

   ```js
   db.channels.updateMany({}, { $unset: { pubsubExpiresAt: "" } });
   ```

Nothing else is needed afterwards. Renewal refills the whole set in roughly six
hours (five channels every ten minutes).

## Why clearing first and deploying second is wrong

While a process with the old configuration is still alive, a verification for a
request it already sent can arrive _after_ the clear. That handler only checks
the `pubsubRequestedAt` window and has no idea the configuration changed, so it
writes back a `pubsubExpiresAt` describing the old callback, and the channel
drops out of renewal again. Clearing after the old pods are gone leaves no
writer that can pollute the reset state (the crawler runs `replicas: 1`).

## Known trade-off

Uploads published during the rebuild window (about six hours) can be missed: the
old subscriptions are already invalid, the new ones do not exist yet, and the
Holodex polls only cover streams, not ordinary uploads. This is a deliberately
accepted limitation, so prefer a low-activity window for this change.
