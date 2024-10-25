import {
  getModelForClass,
  index,
  modelOptions,
  prop,
  type ReturnModelType,
} from "@typegoose/typegoose";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";

@modelOptions({ schemaOptions: { collection: "currencyexchange" } })
@index({ fromCurrency: 1, toCurrency: 1 }, { unique: true })
export class CurrencyExchange extends TimeStamps {
  @prop({ required: true })
  fromCurrency!: string;

  @prop({ required: true })
  toCurrency!: string;

  @prop({ required: true })
  value!: number;

  @prop({ required: true })
  timestamp!: Date;

  //#region find methods

  public static findExchange(
    this: ReturnModelType<typeof CurrencyExchange>,
    fromCurrency: string,
    toCurrency: string
  ) {
    return this.findOne({
      fromCurrency: fromCurrency,
      toCurrency: toCurrency,
    });
  }

  //#endregion find methods

  //#region update methods

  public static async updateExchange(
    this: ReturnModelType<typeof CurrencyExchange>,
    fromCurrency: string,
    toCurrency: string,
    value: number,
    timestamp: Date
  ) {
    await this.updateOne(
      {
        fromCurrency: fromCurrency,
        toCurrency: toCurrency,
      },
      {
        $setOnInsert: {
          fromCurrency: fromCurrency,
          toCurrency: toCurrency,
        },
        $set: {
          value: value,
          timestamp: timestamp,
        },
      },
      {
        upsert: true,
      }
    );
  }

  //#endregion update methods
}

export default getModelForClass(CurrencyExchange);
