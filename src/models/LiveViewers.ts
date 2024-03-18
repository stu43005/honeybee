import { getModelForClass, modelOptions, prop } from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";
import type { LiveViewersSource } from "../interfaces";

@modelOptions({ schemaOptions: { collection: "liveviewers" } })
export class LiveViewers extends TimeStamps {
  @prop({ required: true, index: true })
  public originVideoId!: string;

  @prop({ required: true, index: true })
  public originChannelId!: string;

  @prop({ required: true })
  public viewers!: number;

  @prop({ required: true, index: true })
  public source!: LiveViewersSource;
}

export default getModelForClass(LiveViewers);
