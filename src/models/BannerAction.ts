import {
  getModelForClass,
  modelOptions,
  prop,
  Severity,
} from "@typegoose/typegoose";

@modelOptions({
  options: { allowMixed: Severity.ALLOW },
  schemaOptions: { collection: "banneractions" },
})
export class BannerAction {
  @prop({ required: true })
  public timestamp!: Date;

  @prop({ required: true, unique: true })
  public actionId!: string;

  @prop({ required: true })
  public title!: string;

  @prop({ required: true })
  public rawTitle!: any;

  @prop()
  public message?: string;

  @prop()
  public authorName?: string;

  @prop()
  public authorPhoto?: string;

  @prop({ required: true })
  public authorChannelId!: string;

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

  @prop()
  public isReplay?: boolean;
}

export default getModelForClass(BannerAction);
