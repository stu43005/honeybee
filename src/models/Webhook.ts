import {
  Severity,
  getModelForClass,
  modelOptions,
  prop,
} from "@typegoose/typegoose";
import { Base, TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";

export interface Webhook extends Base {}

@modelOptions({
  options: { allowMixed: Severity.ALLOW },
  schemaOptions: { collection: "webhooks" },
})
export class Webhook extends TimeStamps {
  /**
   * default `true`
   */
  @prop()
  public enabled?: boolean;

  @prop()
  public comment?: string;

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

  // webhook

  @prop({ required: true })
  public insertUrl!: string;

  /**
   * Only need to specify when {@link followUpdate} is set to `true`.
   * @defaultValue `{{insertUrl}}/messages/{{previousResponse.id}}`
   */
  @prop()
  public updateUrl?: string;

  /**
   * Only need to specify when {@link followUpdate} is set to `true`.
   * @defaultValue some as {@link updateUrl}
   */
  @prop()
  public replaceUrl?: string;

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

  /**
   * Only need to specify when {@link followUpdate} is set to `true`.
   * @defaultValue some as {@link updateMethod}
   */
  @prop()
  public replaceMethod?: string;

  @prop()
  public templatePreset?: string;

  @prop()
  public template?: any;
}

export default getModelForClass(Webhook);
