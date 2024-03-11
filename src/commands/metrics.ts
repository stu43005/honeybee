import { HolodexApiClient } from "holodex.js";
import { HOLODEX_API_KEY } from "../constants";
import { CURRENCY_TO_TLS_MAP } from "../data/currency";
import BanAction from "../models/BanAction";
import Chat from "../models/Chat";
import DeleteAction from "../models/Deletion";
import Membership from "../models/Membership";
import Milestone from "../models/Milestone";
import Placeholder from "../models/Placeholder";
import SuperChat from "../models/SuperChat";
import SuperSticker from "../models/SuperSticker";
import { initMongo } from "../modules/db";
import { getQueueInstance } from "../modules/queue";
import { groupBy } from "../util";

// https://docs.influxdata.com/influxdb/v1.8/write_protocols/line_protocol_tutorial/

const INFLUX_MEASUREMENT_NAME = "honeybee";

const lastIdMap = new Map<string, string>();

interface InfluxPayload {
  fields: { [key: string]: string | number };
  tags?: { [key: string]: string | number };
}

type AggregatorModule = (
  records: any,
  key: string
) => AsyncGenerator<InfluxPayload>;

const holoapi = new HolodexApiClient({
  apiKey: HOLODEX_API_KEY,
});

async function getChannelName(cid: string) {
  const channel = await holoapi.getChannel(cid);
  return channel.englishName || channel.name;
}

function normalize(input: string): string {
  return input.replace(/[".,'’/\-]/g, "").replace(/\s/g, "-");
}

async function printInfluxLog({ fields, tags = {} }: InfluxPayload) {
  const tagSet = Object.entries(tags)
    .map(([k, v]) => {
      if (typeof v === "string") {
        return `${k}=${normalize(v)}`;
      }
      return `${k}=${v}`;
    })
    .join(",");
  const fieldSet = Object.entries(fields)
    .map(([k, v]) => {
      if (typeof v === "string") {
        return `${k}="${v.replace(/"/g, "")}"`;
      } else {
        return `${k}=${v}i`;
      }
    })
    .join(",");
  const timestamp = Date.now() * 1000 ** 2;
  console.log(
    `${INFLUX_MEASUREMENT_NAME}${
      tagSet.length > 0 ? "," : ""
    }${tagSet} ${fieldSet} ${timestamp}`
  );
}

async function* groupByChannel(
  records: any,
  key: string
): AsyncGenerator<InfluxPayload> {
  const groups = groupBy<any, any, any>(records, "originChannelId");
  for (const [chId, records] of Object.entries(groups)) {
    const channel = (await getChannelName(chId)).toLowerCase();
    yield {
      fields: { [key]: records.length },
      tags: {
        channel,
      },
    };
  }
}

async function* groupByCountry(records: any, key: string) {
  const groups = groupBy<any, any, any>(records, "currency");
  for (const [currency, records] of Object.entries(groups)) {
    const country = CURRENCY_TO_TLS_MAP[currency] ?? currency;
    yield {
      fields: { [key]: records.length },
      tags: {
        country,
      },
    };
  }
}

async function logCounts(
  key: string,
  model: any,
  {
    agg = groupByChannel,
    criteria,
    projection = { originChannelId: 1 },
  }: {
    agg?: AggregatorModule;
    criteria?: Record<string, any>;
    projection?: Record<string, 1>;
  } = {}
) {
  let lastId = lastIdMap.get(key);
  if (!lastId) {
    lastId = (
      await model.findOne({}, { _id: 1 }).sort({
        $natural: -1,
      })
    )._id;
    lastIdMap.set(key, lastId!);
  }

  const records = await model.find(
    { _id: { $gt: lastId }, ...criteria },
    projection
  );

  if (records.length > 0) {
    for await (const payload of agg(records, key)) {
      printInfluxLog(payload);
    }
    lastIdMap.set(key, records[records.length - 1]._id);
  }
}

export async function metrics() {
  const disconnect = await initMongo();
  const queue = getQueueInstance({ isWorker: false });

  async function printMetrics() {
    await logCounts("deletion", DeleteAction, {
      criteria: { retracted: false },
    });
    await logCounts("chat", Chat);
    await logCounts("ban", BanAction);
    await logCounts("placeholder", Placeholder);
    await logCounts("membership", Membership);
    await logCounts("milestone", Milestone);
    await logCounts("superchat", SuperChat);
    await logCounts("supersticker", SuperSticker);
    await logCounts("superchat_country", SuperChat, {
      projection: { currency: 1 },
      agg: groupByCountry,
    });

    const chatTotal = await Chat.estimatedDocumentCount();
    const superchatTotal = await SuperChat.estimatedDocumentCount();
    const banTotal = await BanAction.estimatedDocumentCount();
    const deletionTotal = await DeleteAction.estimatedDocumentCount();

    const { active, waiting, delayed, failed } = await queue.checkHealth();

    const metrics = {
      chatTotal,
      superchatTotal,
      deletionTotal,
      banTotal,
      active,
      waiting,
      delayed,
      failed,
    };

    printInfluxLog({ fields: metrics });
  }

  process.on("SIGINT", async () => {
    await queue.close();
    await disconnect();
    process.exit(0);
  });

  process.stdin.on("readable", () => {
    while (process.stdin.read() !== null) {
      printMetrics();
    }
  });
}
