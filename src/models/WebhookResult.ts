import {
  Severity,
  getModelForClass,
  index,
  modelOptions,
  prop,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";

@modelOptions({
  options: { allowMixed: Severity.ALLOW },
  schemaOptions: { collection: "webhookresults" },
})
@index({ webhookId: 1, coll: 1, docId: 1 }, { unique: true })
@index({ coll: 1, docId: 1 })
export class WebhookResult extends TimeStamps {
  @prop({ required: true, index: true })
  public webhookId!: string;

  @prop({ required: true })
  public coll!: string;

  @prop({ required: true })
  public docId!: string;

  @prop({ required: true })
  public method!: string;

  @prop({ required: true })
  public url!: string;

  @prop({ required: true })
  public body!: any;

  @prop()
  public statusCode?: number;

  @prop()
  public response?: any;

  @prop()
  public error?: string;
}

export default getModelForClass(WebhookResult);
