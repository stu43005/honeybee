import {
  getModelForClass,
  index,
  modelOptions,
  prop,
} from "@typegoose/typegoose";
import type { MessageAuthorType, MessageType } from "../interfaces.js";

@modelOptions({ schemaOptions: { collection: "videouserstats" } })
@index(
  { videoId: 1, messageType: 1, authorChannelId: 1 },
  { unique: true }
)
@index({ videoId: 1, messageType: 1, authorType: 1 })
export class VideoUserStats {
  @prop({ required: true })
  public videoId!: string;

  @prop({ required: true })
  public messageType!: MessageType;

  @prop({ required: true })
  public authorChannelId!: string;

  @prop({ required: true })
  public authorType!: MessageAuthorType;
}

export default getModelForClass(VideoUserStats);
