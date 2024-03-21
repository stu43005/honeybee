import axios from "axios";
import NodeCache from "node-cache";
import { currencyMap } from "../data/currency";
import CurrencyExchange from "../models/CurrencyExchange";

const exchangeToJpyCache = new NodeCache({
  stdTTL: 3600,
});

// https://github.com/fawazahmed0/exchange-api
const exchangeApiUrls = Object.freeze([
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/{currencyCode}.min.json",
  "https://latest.currency-api.pages.dev/v1/currencies/{currencyCode}.min.json",
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/{currencyCode}.json",
  "https://latest.currency-api.pages.dev/v1/currencies/{currencyCode}.json",
]);

async function convert(
  value: number,
  fromCurrency: string,
  toCurrency: string
): Promise<{ value: number; date: string }> {
  if (
    typeof value !== "number" ||
    typeof fromCurrency !== "string" ||
    typeof toCurrency !== "string"
  ) {
    throw new Error("Please input the right types of arguments.");
  }

  fromCurrency = fromCurrency.trim().toLowerCase();
  toCurrency = toCurrency.trim().toLowerCase();

  for (const urlTemplate of exchangeApiUrls) {
    try {
      const res = await axios.get(
        urlTemplate.replaceAll("{currencyCode}", fromCurrency)
      );
      return {
        value: value * res.data[fromCurrency][toCurrency],
        date: res.data.date,
      };
    } catch (error) {
      // throw new Error("There was a problem fetching data");
    }
  }

  throw new Error("There was a problem fetching data");
}

async function getJpyExchange(fromCurrency: string) {
  const toCurrency = "JPY";
  const key = {
    fromCurrency: fromCurrency,
    toCurrency: toCurrency,
  };

  let jpyExchange = exchangeToJpyCache.get<number>(fromCurrency);
  if (jpyExchange) return jpyExchange;

  try {
    const { value, date } = await convert(1, fromCurrency, toCurrency);
    exchangeToJpyCache.set(fromCurrency, value);
    CurrencyExchange.updateOne(
      key,
      {
        $setOnInsert: key,
        $set: {
          value: value,
          timestamp: new Date(date),
        },
      },
      {
        upsert: true,
      }
    ).catch((err) => console.error(err));
    return value;
  } catch (error) {
    const doc = await CurrencyExchange.findOne(key);
    if (doc) {
      exchangeToJpyCache.set(fromCurrency, doc.value);
      return doc.value;
    }
  }
  throw new Error("There was a problem fetching data");
}

export function getCurrencymapItem(currency: string) {
  let currencymapEntry: undefined | typeof currencyMap.JPY;
  for (const key of ["code", "symbol", "symbol_native"] as const) {
    currencymapEntry = Object.values(currencyMap).find(
      (entry) => entry[key] === currency
    );
    if (currencymapEntry) break;
  }
  return (
    currencymapEntry ?? {
      symbol: "¥",
      code: "JPY",
      symbol_native: "￥",
      decimal_digits: 0,
      rounding: 0.0,
    }
  );
}

export async function currencyToJpyAmount(amount: number, currency: string) {
  const currencymapEntry = getCurrencymapItem(currency);
  if (currencymapEntry.code === "JPY") {
    return {
      amount,
      currency,
    };
  }

  try {
    const jpyExchange = await getJpyExchange(currencymapEntry.code);
    const jpyAmount = amount * jpyExchange;
    return {
      amount: jpyAmount,
      currency: "JPY",
    };
  } catch (error) {
    console.error(error);
    return {
      amount,
      currency,
    };
  }
}
