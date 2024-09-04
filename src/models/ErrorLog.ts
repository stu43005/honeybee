import {
  Severity,
  getModelForClass,
  modelOptions,
  prop,
} from "@typegoose/typegoose";

@modelOptions({
  options: { allowMixed: Severity.ALLOW },
  schemaOptions: { collection: "errorlogs" },
})
export class ErrorLog {
  @prop({ required: true })
  public timestamp!: Date;

  @prop({ index: true })
  public originVideoId?: string;

  @prop()
  public originChannelId?: string;

  @prop()
  public error?: string;

  @prop()
  public message?: string;

  @prop()
  public stack?: string;

  @prop()
  public payload?: any;
}

export default getModelForClass(ErrorLog);
