import {
  getModelForClass,
  index,
  modelOptions,
  prop,
} from "@typegoose/typegoose";
import type { MessageAuthorType } from "../interfaces.js";

@modelOptions({ schemaOptions: { collection: "chats" } })
@index({ originVideoId: 1, timestamp: 1 })
@index(
  { originVideoId: 1, isOwner: 1, timestamp: 1 },
  {
    partialFilterExpression: {
      isOwner: true,
    },
  }
)
@index(
  { originVideoId: 1, isModerator: 1, timestamp: 1 },
  {
    partialFilterExpression: {
      isModerator: true,
    },
  }
)
export class Chat {
  @prop({ required: true, unique: true })
  public id!: string;

  @prop({ required: true })
  public message!: string;

  @prop()
  public authorName?: string;

  @prop()
  public authorPhoto?: string;

  @prop({ required: true })
  public authorChannelId!: string;

  @prop({ required: true })
  public authorType!: MessageAuthorType;

  @prop()
  public membership?: string;

  @prop({ required: true })
  public isVerified!: boolean;

  @prop({ required: true })
  public isOwner!: boolean;

  @prop({ required: true })
  public isModerator!: boolean;

  @prop({ required: true, index: true })
  public originVideoId!: string;

  @prop({ required: true })
  public originChannelId!: string;

  @prop({ required: true })
  public timestamp!: Date;

  @prop()
  public isReplay?: boolean;
}

export default getModelForClass(Chat);
