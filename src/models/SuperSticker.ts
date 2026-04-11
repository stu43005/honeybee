import {
  getModelForClass,
  index,
  modelOptions,
  prop,
  Severity,
} from "@typegoose/typegoose";
import type { MessageAuthorType } from "../interfaces.js";

@modelOptions({
  options: { allowMixed: Severity.ALLOW },
  schemaOptions: { collection: "superstickers" },
})
@index({ originVideoId: 1, timestamp: 1 })
export class SuperSticker {
  @prop({ required: true, unique: true })
  public id!: string;

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

  @prop({ required: true })
  public amount!: number;

  @prop({ required: true })
  public jpyAmount!: number;

  @prop({ required: true })
  public currency!: string;

  @prop()
  public text?: string;

  @prop({ required: true })
  public image!: string;

  @prop()
  public significance?: number;

  @prop()
  public color?: string;

  @prop({ required: true, index: true })
  public originVideoId!: string;

  @prop({ required: true })
  public originChannelId!: string;

  @prop({ required: true })
  public timestamp!: Date;

  @prop()
  public isReplay?: boolean;
}

export default getModelForClass(SuperSticker);
