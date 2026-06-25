import axios from "axios";
import { Decimal } from "decimal.js";
import moment from "moment-timezone";
import { currencyMap } from "../data/currency.js";
import CurrencyExchange from "../models/CurrencyExchange.js";
import { getCacheInstance } from "./cache.js";

// Created on first conversion instead of at module load, so merely importing
// this module (e.g. transitively via the worker) does not eagerly build the
// cache (which would open a Redis connection and start a background timer).
// checkInterval: 0 disables CacheableMemory's sweep setInterval — it is never
// unref'd and would otherwise keep the process alive forever; expired entries
// are still evicted lazily on read.
let exchangeToJpyCache: ReturnType<typeof getCacheInstance> | undefined;
function getExchangeToJpyCache(): ReturnType<typeof getCacheInstance> {
  return (exchangeToJpyCache ??= getCacheInstance({
    ttl: moment.duration(1, "day").asMilliseconds(),
    refreshThreshold: moment.duration(1, "hour").asMilliseconds(),
    useClone: true,
    checkInterval: 0,
  }));
}

// https://github.com/fawazahmed0/exchange-api
const exchangeApiUrls = Object.freeze([
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/{currencyCode}.min.json",
  "https://latest.currency-api.pages.dev/v1/currencies/{currencyCode}.min.json",
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/{currencyCode}.json",
  "https://latest.currency-api.pages.dev/v1/currencies/{currencyCode}.json",
]);

// https://www.exchangerate-api.com/docs/free
const exchangeRateApi = `https://open.er-api.com/v6/latest/{currencyCode}`;

async function getExchange(
  fromCurrency: string,
  toCurrency: string
): Promise<{ value: number; date: Date }> {
  if (typeof fromCurrency !== "string" || typeof toCurrency !== "string") {
    throw new Error("Please input the right types of arguments.");
  }

  const fromCurrencyLc = fromCurrency.trim().toLowerCase();
  const toCurrencyLc = toCurrency.trim().toLowerCase();

  for (const urlTemplate of exchangeApiUrls) {
    try {
      const res = await axios.get(
        urlTemplate.replaceAll("{currencyCode}", fromCurrencyLc)
      );
      if (
        fromCurrencyLc in res.data &&
        res.data[fromCurrencyLc] &&
        toCurrencyLc in res.data[fromCurrencyLc] &&
        res.data[fromCurrencyLc][toCurrencyLc]
      ) {
        const exchange = res.data[fromCurrencyLc][toCurrencyLc];
        const date = moment.tz(res.data.date, "UTC").toDate();

        if (moment.tz("UTC").diff(date, "days", true) > 2) {
          // outdated
          continue;
        }

        // update db
        CurrencyExchange.updateExchange(
          fromCurrency,
          toCurrency,
          exchange,
          date
        ).catch((err) => console.error(err));

        return {
          value: exchange,
          date: date,
        };
      }
    } catch {
      // throw new Error("There was a problem fetching data");
    }
  }

  try {
    const res = await axios.get(
      exchangeRateApi.replaceAll("{currencyCode}", fromCurrency)
    );
    if (toCurrency in res.data.rates && res.data.rates[toCurrency]) {
      const exchange = res.data.rates[toCurrency];
      const date = new Date(res.data.time_last_update_unix);

      // update db
      CurrencyExchange.updateExchange(
        fromCurrency,
        toCurrency,
        exchange,
        date
      ).catch((err) => console.error(err));

      return {
        value: exchange,
        date: date,
      };
    }
  } catch {
    // throw new Error("There was a problem fetching data");
  }

  // fallback to db
  const doc = await CurrencyExchange.findExchange(fromCurrency, toCurrency);
  if (doc) {
    return {
      value: doc.value,
      date: doc.timestamp,
    };
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
    const jpyExchange = await getExchangeToJpyCache().wrap(
      currencymapEntry.code,
      () => getExchange(currencymapEntry.code, "JPY")
    );
    const jpyAmount = new Decimal(amount).mul(jpyExchange.value).toNumber();
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
