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
  @prop({ required: true, index: true })
  public timestamp!: Date;

  @prop({ required: true, unique: true })
  public id!: string;

  @prop()
  public authorName?: string;

  @prop({ required: true, index: true })
  public authorChannelId!: string;

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

  @prop()
  public significance?: number;

  @prop()
  public color?: string;

  @prop({ required: true, index: true })
  public originVideoId!: string;

  @prop({ required: true, index: true })
  public originChannelId!: string;
}

export default getModelForClass(SuperSticker);
