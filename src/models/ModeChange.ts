import { getModelForClass, modelOptions, prop } from "@typegoose/typegoose";

@modelOptions({ schemaOptions: { collection: "modechanges" } })
export class ModeChange {
  @prop({ required: true, index: true })
  timestamp!: Date;

  @prop({ required: true, index: true })
  mode!: string;

  @prop({ required: true })
  enabled!: boolean;

  @prop({ required: true })
  description!: string;

  @prop({ required: true, index: true })
  originVideoId!: string;

  @prop({ required: true, index: true })
  originChannelId!: string;
}

export default getModelForClass(ModeChange);
