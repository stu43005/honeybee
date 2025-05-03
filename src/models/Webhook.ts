import {
  Severity,
  getModelForClass,
  index,
  modelOptions,
  prop,
  type Ref,
  type ReturnModelType,
} from "@typegoose/typegoose";
import { Base, TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";
import { Track } from "./Track";

export interface Webhook extends Base {}

@modelOptions({
  options: { allowMixed: Severity.ALLOW },
  schemaOptions: { collection: "webhooks" },
})
@index({ updatedAt: 1 })
@index({ track: 1, feature: 1 }, { unique: true })
export class Webhook extends TimeStamps {
  // basic info

  @prop({ default: true, index: true })
  public enabled!: boolean;

  @prop()
  public comment?: string;

  // database config

  @prop({ type: [String], required: true })
  public colls!: string[];

  /**
   * Used in the matching stage of change stream.
   *
   * {@link match} should be used preferentially over {@link filter}.
   */
  @prop()
  public match?: any;

  @prop()
  public matchPreset?: string;

  /**
   * Used in function processing, it has a more complete data structure.
   */
  @prop()
  public filter?: any;

  @prop()
  public followUpdate?: Boolean;

  // webhook config

  @prop({ required: true })
  public insertUrl!: string;

  /**
   * Only need to specify when {@link followUpdate} is set to `true`.
   * @defaultValue `{{insertUrl}}/messages/{{previousResponse.id}}`
   */
  @prop()
  public updateUrl?: string;

  /**
   * @defaultValue `POST`
   */
  @prop()
  public insertMethod?: string;

  /**
   * Only need to specify when {@link followUpdate} is set to `true`.
   * @defaultValue `PATCH`
   */
  @prop()
  public updateMethod?: string;

  // template config

  @prop()
  public templatePreset?: string;

  @prop()
  public template?: any;

  // check status

  @prop()
  public lastChecked?: Date;

  @prop()
  public lastSuccess?: Date;

  @prop({ default: 0 })
  public failedAttempts!: number;

  // track reference

  @prop({ ref: () => Track })
  public track?: Ref<Track>;

  @prop()
  public feature?: string;

  //#region find methods

  public static findEnabled(
    this: ReturnModelType<typeof Webhook>,
    enabled = true
  ) {
    return this.find({ enabled: { $ne: !enabled } }).sort({ _id: 1 });
  }

  //#endregion find methods
}

export default getModelForClass(Webhook);
