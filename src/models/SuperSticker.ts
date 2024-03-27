import {
  getModelForClass,
  modelOptions,
  prop,
  Severity,
} from "@typegoose/typegoose";

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

  @prop({ required: true, index: true })
  public authorChannelId!: string;

  @prop()
  public membership?: string;

  @prop({ required: true, index: true })
  public isVerified!: Boolean;

  @prop({ required: true, index: true })
  public isOwner!: Boolean;

  @prop({ required: true, index: true })
  public isModerator!: Boolean;

  @prop({ required: true })
  public amount!: number;

  @prop({ required: true })
  public jpyAmount!: number;

  @prop({ required: true, index: true })
  public currency!: string;

  @prop()
  public text?: string;

  @prop({ required: true })
  public image!: string;

  @prop({ index: true })
  public significance?: number;

  @prop()
  public color?: string;

  @prop({ required: true, index: true })
  public originVideoId!: string;

  @prop({ required: true, index: true })
  public originChannelId!: string;

  @prop({ required: true, index: true })
  public timestamp!: Date;
}

export default getModelForClass(SuperSticker);
