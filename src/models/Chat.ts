import {
  getModelForClass,
  modelOptions,
  prop,
} from "@typegoose/typegoose";
import type { MessageAuthorType } from "../interfaces";

@modelOptions({ schemaOptions: { collection: "chats" } })
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
  public isVerified!: Boolean;

  @prop({ required: true })
  public isOwner!: Boolean;

  @prop({ required: true })
  public isModerator!: Boolean;

  @prop({ required: true, index: true })
  public originVideoId!: string;

  @prop({ required: true })
  public originChannelId!: string;

  @prop({ required: true })
  public timestamp!: Date;
}

export default getModelForClass(Chat);
