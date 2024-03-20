import clc from "cli-color";
import clui from "clui";
import { setTimeout } from "node:timers/promises";
import BanAction from "../models/BanAction";
import Chat from "../models/Chat";
import Membership from "../models/Membership";
import Milestone from "../models/Milestone";
import Placeholder from "../models/Placeholder";
import RemoveChatAction from "../models/RemoveChatAction";
import SuperChat from "../models/SuperChat";
import SuperSticker from "../models/SuperSticker";
import { initMongo } from "../modules/db";
import { getQueueInstance } from "../modules/queue";
import { DeltaCollection } from "../util";
const { Line, LineBuffer, Sparkline } = clui;

const REFRESH_INTERVAL = Number(process.env.REFRESH_INTERVAL || 10);

export async function health() {
  const disconnect = await initMongo();
  const queue = getQueueInstance({ isWorker: false });

  process.on("SIGINT", async () => {
    await queue.close();
    await disconnect();
    process.exit(0);
  });

  const col = new DeltaCollection(60);

  col.addRecord("chat", () => Chat.estimatedDocumentCount());
  col.addRecord("superchat", () => SuperChat.estimatedDocumentCount());
  col.addRecord("supersticker", () => SuperSticker.estimatedDocumentCount());
  col.addRecord("membership", () => Membership.estimatedDocumentCount());
  col.addRecord("milestone", () => Milestone.estimatedDocumentCount());
  col.addRecord("placeholder", () => Placeholder.estimatedDocumentCount());
  col.addRecord("ban", () => BanAction.estimatedDocumentCount());
  col.addRecord("removechat", () => RemoveChatAction.estimatedDocumentCount());

  while (true) {
    const queueHealth = await queue.checkHealth();

    await col.refresh();

    const outputBuffer = new LineBuffer({
      x: 0,
      y: 0,
      width: "console",
      height: "console",
    });

    outputBuffer.addLine(
      new Line()
        .column(`honeybee cluster health [interval=${REFRESH_INTERVAL}s]`, 60, [
          clc.yellow,
        ])
        .fill()
    );

    outputBuffer.addLine(new Line().fill());

    const COLUMN_WIDTH = 14;
    outputBuffer.addLine(
      new Line()
        .column("Active", COLUMN_WIDTH, [clc.cyan])
        .column("Delayed", COLUMN_WIDTH, [clc.cyan])
        .column("Waiting", COLUMN_WIDTH, [clc.cyan])
        .column("Failed", COLUMN_WIDTH, [clc.cyan])
        .fill()
    );

    outputBuffer.addLine(
      new Line()
        .column(queueHealth.active.toString(), COLUMN_WIDTH)
        .column(queueHealth.delayed.toString(), COLUMN_WIDTH)
        .column(queueHealth.waiting.toString(), COLUMN_WIDTH)
        .column(queueHealth.failed.toString(), COLUMN_WIDTH)
        .fill()
    );

    outputBuffer.addLine(new Line().fill());

    outputBuffer.addLine(
      new Line()
        .column("Chat", COLUMN_WIDTH, [clc.cyan])
        .column("SuperChat", COLUMN_WIDTH, [clc.cyan])
        .column("SuperSticker", COLUMN_WIDTH, [clc.cyan])
        .column("Membership", COLUMN_WIDTH, [clc.cyan])
        .column("Milestone", COLUMN_WIDTH, [clc.cyan])
        .column("Placeholder", COLUMN_WIDTH, [clc.cyan])
        .column("Ban", COLUMN_WIDTH, [clc.cyan])
        .column("RemoveChat", COLUMN_WIDTH, [clc.cyan])
        .fill()
    );

    const columns = [
      "chat",
      "superchat",
      "supersticker",
      "membership",
      "milestone",
      "placeholder",
      "ban",
      "removechat",
    ];

    outputBuffer.addLine(
      columns
        .reduce(
          (line, name) =>
            line.column(
              Intl.NumberFormat().format(col.get(name)!.current!),
              COLUMN_WIDTH
            ),
          new Line()
        )
        .fill()
    );

    outputBuffer.addLine(
      columns
        .reduce(
          (line, name) =>
            line.column("+" + col.get(name)!.lastDelta, COLUMN_WIDTH, [
              clc.magentaBright,
            ]),
          new Line()
        )
        .fill()
    );

    outputBuffer.addLine(new Line().fill());

    columns.forEach((name: string) => {
      outputBuffer.addLine(
        new Line()
          .column(
            Sparkline(col.get(name)!.history, ` ${name}/${REFRESH_INTERVAL}s`),
            160
          )
          .fill()
      );
    });

    outputBuffer.addLine(new Line().fill());

    console.log(clc.erase.screen);
    outputBuffer.output();

    await setTimeout(REFRESH_INTERVAL * 1000);
  }
}
