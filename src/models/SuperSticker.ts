import {
  getModelForClass,
  modelOptions,
  prop,
  Severity,
} from "@typegoose/typegoose";
import type { MessageAuthorType } from "../interfaces";

@modelOptions({
  options: { allowMixed: Severity.ALLOW },
  schemaOptions: { collection: "superstickers" },
})
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
  public isVerified!: Boolean;

  @prop({ required: true })
  public isOwner!: Boolean;

  @prop({ required: true })
  public isModerator!: Boolean;

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
}

export default getModelForClass(SuperSticker);
