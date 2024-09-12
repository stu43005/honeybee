import {
  Severity,
  getModelForClass,
  modelOptions,
  prop,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";

export class PollChoice {
  @prop({ required: true })
  public text!: string;

  @prop()
  public voteRatio?: number;
}

@modelOptions({
  options: { allowMixed: Severity.ALLOW },
  schemaOptions: { collection: "polls" },
})
export class Poll extends TimeStamps {
  @prop({ required: true, unique: true })
  public id!: string;

  @prop()
  public question?: string;

  @prop({ required: true })
  public choices!: PollChoice[];

  @prop()
  public pollType?: string;

  @prop()
  public voteCount?: number;

  @prop()
  public finished!: boolean;

  @prop({ required: true, index: true })
  public originVideoId!: string;

  @prop({ required: true })
  public originChannelId!: string;
}

export default getModelForClass(Poll);
