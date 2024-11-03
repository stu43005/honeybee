import {
  Severity,
  getModelForClass,
  index,
  modelOptions,
  prop,
  type DocumentType,
  type ReturnModelType,
} from "@typegoose/typegoose";
import { Base, TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";

export interface Webhook extends Base {}

@modelOptions({
  options: { allowMixed: Severity.ALLOW },
  schemaOptions: { collection: "webhooks" },
})
@index({ updatedAt: 1 })
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

  @prop()
  public templatePreset?: string;

  @prop()
  public template?: any;

  //#region find methods

  public static async findEnabled(
    this: ReturnModelType<typeof Webhook>,
    enabled = true
  ): Promise<DocumentType<Webhook>[]> {
    const result: DocumentType<Webhook>[] = [];
    let i = 0;
    for await (const webhook of this.find({ enabled: { $ne: !enabled } })) {
      if (i > Number.MAX_SAFE_INTEGER) {
        throw TypeError(
          "Input is too long and exceeded Number.MAX_SAFE_INTEGER times."
        );
      }
      result[i] = webhook;
      i++;
    }
    result.length = i;
    return result;
  }

  //#endregion find methods
}

export default getModelForClass(Webhook);
