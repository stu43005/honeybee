import { getModelForClass, index, modelOptions, prop } from "@typegoose/typegoose";
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
}

export default getModelForClass(CurrencyExchange);
