import {
  getModelForClass,
  index,
  modelOptions,
  prop,
} from "@typegoose/typegoose";

@modelOptions({ schemaOptions: { collection: "membershipgiftpurchases" } })
@index({ originVideoId: 1, authorChannelId: 1 })
export class MembershipGiftPurchase {
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

  @prop({ required: true, index: true })
  public originVideoId!: string;

  @prop({ required: true, index: true })
  public originChannelId!: string;

  @prop({ required: true, index: true })
  public timestamp!: Date;
}

export default getModelForClass(MembershipGiftPurchase);
