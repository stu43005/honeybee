import { castBool } from "./util.js";

// Shutdown budget for graceful module close (Agenda drain, Bee-Queue drain, etc).
// Must be strictly less than k8s `terminationGracePeriodSeconds` (60s) so that
// after drain completes there is still headroom for MongoDB/Redis/HTTP cleanup
// before kubelet sends SIGKILL.
export const SHUTDOWN_TIMEOUT = 45 * 1000;
export const IGNORE_FREE_CHAT = castBool(process.env.IGNORE_FREE_CHAT ?? false);
export const JOB_CONCURRENCY = Number(process.env.JOB_CONCURRENCY ?? 1);
export const HOLODEX_API_KEY = process.env.HOLODEX_API_KEY ?? "";
export const HOLODEX_ALL_VTUBERS = "All Vtubers";
export const HOLODEX_FETCH_ORG =
  process.env.HOLODEX_FETCH_ORG ?? HOLODEX_ALL_VTUBERS;
export const HOLODEX_MAX_UPCOMING_HOURS = Number(
  process.env.HOLODEX_MAX_UPCOMING_HOURS ?? 12
);
// Public base URL the deployment is reachable at (shared ingress host), e.g.
// https://honeybee.example.ts.net — used both to build the crawler's PubSubHubbub
// callback and the OAuth providers' redirect URIs.
export const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
export const YOUTUBE_PUBSUB_SECRET = process.env.YOUTUBE_PUBSUB_SECRET;
export const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

export const REDIS_URI = process.env.REDIS_URI;

export const METRICS_MAX_UPCOMING_HOURS = 48;
export const METRICS_MAX_ENDED_HOURS = 1;
export const MAX_HOURS_BEFORE_CLEANUP = METRICS_MAX_ENDED_HOURS + 1;
export const CRAWL_REPLAY_MAX_HOURS = 1;

export const CHAT_ARCHIVE_DIR = process.env.CHAT_ARCHIVE_DIR;

// ─────────────────────────────────────────────────────────────────────
// Webhook 水平擴展：共用常數
// 依事件流分組：Partition → ChangeStream → Task Distribution → Execution
// ─────────────────────────────────────────────────────────────────────

// ─── Partition Assignment（分區分配層） ───────────────────────────

// 分區心跳週期：每個實例把自己的 webhook:instance:<id> key 續租一次的
// 間隔。同一個 setInterval tick 也會 SCAN 所有 instance key，偵測其他
// 實例崩潰 / 離線後主動觸發 rebalance。
export const WEBHOOK_PARTITION_HEARTBEAT_MS = 5000;

// 分區實例 key 的 TTL：webhook:instance:<id> key 沒被心跳續租時，Redis
// 自動移除的時間。設為 3× heartbeat 容許最多 2 次心跳遺失才被視為死亡，
// 避免單次網路抖動就觸發不必要的 rebalance。
export const WEBHOOK_PARTITION_TTL_MS = 15_000;

// Rebalance debounce：收到 rebalance 廣播（其他實例加入 / 離開）後延遲
// 觸發 setupCollections 的等待時間。避免 rolling deploy 期間多個實例
// 連續進出導致 changeStream 反覆開關、浪費 MongoDB oplog 連線。
export const WEBHOOK_REBALANCE_DEBOUNCE_MS = 500;

// ─── ChangeStream Listener（監聽層） ──────────────────────────────

// Resume token 定時持久化週期：每個 collection changeStream 把最新
// resumeToken 寫入 Redis（webhook:resumetoken:<coll>）的間隔。太短浪費
// IO、太長則實例重啟或 rebalance 後接手方的事件重播窗口變大。
export const WEBHOOK_RESUME_TOKEN_SAVE_INTERVAL_MS = 3000;

// Resume token key（webhook:resumetoken:<coll>）的 Redis TTL：非運作中
// instance 留在 Redis 的 resume token 最長保留時間。設為 1 小時，若 instance
// 停機超過此時間，下次接手方會從 oplog tail 重新監聽（可能漏掉停機期間事件
// —— 此為 operationally accepted tradeoff；若停機時間超過 oplog 保留視窗
// 本來就會丟 resume token）。
export const WEBHOOK_RESUME_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── Task Distribution（任務分發層） ──────────────────────────────

// Follow-Update 事件冷卻時間：同一 (webhookId, coll, docId) 的兩次 worker
// 觸發之間必須間隔至少此時間。主要在 followUpdate=true 模式下生效 ——
// 冷卻期內的連續 update 事件會被合併為單一 delayed job，避免高頻文件變更
// 讓下游 webhook 目標被重複打擊。
export const WEBHOOK_FOLLOW_UPDATE_COOLDOWN_MS = 5000;

// Follow-Update 冷卻 key（webhook:next:<jobId>）的 Redis TTL：紀錄下一次
// 允許觸發時間的 key 必須存活到對應 delayed job 實際執行之前，否則 TTL
// 到期後 key 消失會讓新 event 走「立即推入」分支、破壞最小間隔不變量。
// 取 3× cooldown 預留餘裕涵蓋時鐘抖動、Redis 複寫延遲與排隊時間。
export const WEBHOOK_FOLLOW_UPDATE_COOLDOWN_KEY_TTL_MS =
  WEBHOOK_FOLLOW_UPDATE_COOLDOWN_MS * 3;

// ─── Webhook Execution（執行層） ──────────────────────────────────

// Webhook worker 並發數：每個實例 bee-queue worker 同時處理幾個 webhook
// 發送任務。預設 10，可經 WEBHOOK_WORKER_CONCURRENCY env 覆寫。
export const WEBHOOK_WORKER_CONCURRENCY = Number(
  process.env.WEBHOOK_WORKER_CONCURRENCY ?? 10
);

// WebhookResult 記錄保留時間（非 follow-update）：非 follow-update webhook
// 只發送一次，成功後記錄僅作觀察除錯用，1 小時後由 MongoDB TTL index 自動
// 清除。
export const WEBHOOK_RESULT_NON_FOLLOW_TTL_MS = 60 * 60 * 1000; // 1 hour

// WebhookResult 記錄保留時間（follow-update）：follow-update webhook 的 body
// 需長期保留作為後續 update 事件的「與上次發送 body 是否相同」isEqual 比對
// 基準。設為 null 表示不寫入 expireAt、不由 MongoDB TTL index 自動清除；改由
// src/components/cleanup.ts 的 cleanWebhookResults 排程依原始來源文件狀態
// （poll 結束、raid 過期、video 非直播、來源文件已刪除等）移除。
export const WEBHOOK_RESULT_FOLLOW_TTL_MS: number | null = null;

// --- YouTube watch-page rate gate (src/modules/youtube-watch-gate.ts) ---

// Global (across ALL worker pods) minimum interval between watch-page requests.
// Pre-change was per-pod 1/s; 3 pods sharing one egress IP ≈ 3 req/s to YouTube.
// A global 1 req/s removes that 3x amplification. Env-overridable for tuning.
export const YOUTUBE_WATCH_INTERVAL_MS = Number(
  process.env.YOUTUBE_WATCH_INTERVAL_MS ?? 1000
);

// After a 429 every pod pauses watch-page requests for this long so YouTube's
// rate-limit window can cool down. 1 minute aligns with the stats-update period
// (skipping one cycle suffices to recover).
export const YOUTUBE_WATCH_COOLDOWN_MS = 60 * 1000;

// Redis TTL for the gate key. Clearly larger than the cooldown so the cooldown
// never lapses mid-window because the key expired (mirrors the `* 3` convention
// of WEBHOOK_FOLLOW_UPDATE_COOLDOWN_KEY_TTL_MS).
export const YOUTUBE_WATCH_GATE_KEY_TTL_MS = YOUTUBE_WATCH_COOLDOWN_MS * 3;

// Upper bound on how long a single acquire() queues for a free slot. 5s (= 5
// intervals) absorbs steady-state concurrent queueing; far below COOLDOWN_MS
// (skip rather than burn the job during a cooldown) and far below
// SHUTDOWN_TIMEOUT (45s), and the wait is abortable. Env-overridable for tuning.
export const YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS = Number(
  process.env.YOUTUBE_WATCH_ACQUIRE_MAX_WAIT_MS ?? 5000
);

// Minimum interval shared by the gate's three rate-limited alert logs (degraded
// / eval-error / saturated). 1 minute keeps a sustained anomaly observable
// without flooding (versus logging on every acquire).
export const YOUTUBE_WATCH_DEGRADED_LOG_INTERVAL_MS = 60 * 1000;

// YouTube DM personal-notification binding
export const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
export const GOOGLE_OAUTH_CLIENT_SECRET =
  process.env.GOOGLE_OAUTH_CLIENT_SECRET;
export const DISCORD_OAUTH_CLIENT_ID = process.env.DISCORD_OAUTH_CLIENT_ID;
export const DISCORD_OAUTH_CLIENT_SECRET =
  process.env.DISCORD_OAUTH_CLIENT_SECRET;
// OAuth state lifetime: 10 min — enough for one browser consent round-trip, short enough
// to bound the bearer-link replay window for the Google path.
export const OAUTH_STATE_TTL_MS = Number(
  process.env.OAUTH_STATE_TTL_MS ?? 10 * 60 * 1000
);
// Soft per-user channel cap — bounds a single derived webhook's $in size; not enforced atomically.
export const YOUTUBE_DM_MAX_CHANNELS_PER_USER = Number(
  process.env.YOUTUBE_DM_MAX_CHANNELS_PER_USER ?? 10
);
