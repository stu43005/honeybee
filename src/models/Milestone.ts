import {
  getModelForClass,
  modelOptions,
  prop,
  Severity,
} from "@typegoose/typegoose";
import type { MessageAuthorType } from "../interfaces";

@modelOptions({
  options: { allowMixed: Severity.ALLOW },
  schemaOptions: { collection: "milestones" },
})
export class Milestone {
  @prop({ required: true, unique: true })
  public id!: string;

  @prop()
  public message!: string | null;

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

  @prop()
  public level?: string;

  @prop()
  public duration?: number;

  @prop()
  public since?: string;

  @prop({ required: true, index: true })
  public originVideoId!: string;

  @prop({ required: true })
  public originChannelId!: string;

  @prop({ required: true })
  public timestamp!: Date;
}

export default getModelForClass(Milestone);
