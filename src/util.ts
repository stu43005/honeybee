interface Record {
  name: string;
  current: number | undefined;
  lastDelta: number;
  history: number[];
  updater: (...args: any) => any | Promise<any>;
}

export class DeltaCollection {
  private records: Record[] = [];
  private maxHistory: number;

  constructor(maxHistory: number = 50) {
    this.maxHistory = maxHistory;
  }

  addRecord(name: string, updater: Record["updater"]): Record {
    const record = {
      name,
      updater,
      current: undefined,
      lastDelta: 0,
      history: Array.from({ length: this.maxHistory }, () => 0),
    };
    this.records.push(record);
    return record;
  }

  async refresh() {
    for (const record of this.records) {
      const data = await Promise.resolve(record.updater());
      const lastDelta = data - (record.current ?? data);
      record.history.push(lastDelta);
      if (record.history.length > this.maxHistory) record.history.shift();
      record.current = data;
      record.lastDelta = lastDelta;
    }
    return this;
  }

  get(name: string): Record | undefined {
    return this.records.find((record) => record.name === name);
  }

  forEach(fn: (record: Record) => any) {
    for (const record of this.records) {
      fn(record);
    }
  }
}

export function groupBy<T, K extends keyof T, S extends Extract<T[K], string>>(
  lst: T[],
  key: K
) {
  return lst.reduce((result, o) => {
    const index = o[key] as S;
    if (!result[index]) result[index] = [];
    result[index].push(o as any);
    return result;
  }, {} as { [k in S]: (T extends { [s in K]: k } ? T : never)[] });
}

export function castBool(value: unknown) {
  const val = typeof value === "string" ? value.trim().toLowerCase() : value;

  switch (val) {
    case true:
    case "true":
    case 1:
    case "1":
    case "on":
    case "y":
    case "yes":
      return true;
    default:
      return false;
  }
}

export function setIfDefine(key: string, value: unknown) {
  if (typeof value !== "undefined" && value !== null) {
    return {
      [key]: value,
    };
  }
  return {};
}

export function promiseSettledCallback<T>(
  results: PromiseSettledResult<T>[],
  onFulfilled: (value: T) => void,
  onRejected: (reason: any) => void
) {
  for (const result of results) {
    if (result.status === "fulfilled") {
      onFulfilled(result.value);
    } else {
      onRejected(result.reason);
    }
  }
}

export function throttleWithReturnValue<T>(
  func: (...args: any[]) => T,
  delay: number
): (...args: any[]) => T {
  let lastCalledTime = 0;
  let lastResult: T;

  return function (this: any, ...args: any[]): T {
    const now = Date.now();
    if (now - lastCalledTime >= delay) {
      lastResult = func.apply(this, args);
      lastCalledTime = now;
    }
    return lastResult;
  };
}

export function secondsToHms(d: number) {
  const h = Math.floor(+d / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((+d % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor((+d % 3600) % 60)
    .toString()
    .padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export function flatObjectKey(obj: object): object {
  return Object.fromEntries(
    Object.entries(obj).flatMap(([key, value]) => {
      if (
        typeof value === "object" &&
        Object.keys(value).every((k) => !k.startsWith("$"))
      ) {
        const obj2 = flatObjectKey(value);
        return Object.entries(obj2).map(([key2, value2]) => [
          `${key}.${key2}`,
          value2,
        ]);
      }
      return [[key, value]];
    })
  );
}

export function pipeSignal(signal: AbortSignal, controller: AbortController) {
  if (signal.aborted) {
    controller.abort(signal.reason);
    return;
  }
  signal.addEventListener(
    "abort",
    async () => {
      controller.abort(signal.reason);
    },
    { once: true }
  );
}

/**
 * 在字串超過指定長度時，縮短字串並加上省略號。
 */
export function abbreviate(str: string, maxWidth: number) {
  if (typeof str !== 'string' || typeof maxWidth !== 'number') {
      throw new Error('Invalid arguments');
  }

  if (str.length <= maxWidth) {
      return str;
  }

  const ellipsis = '...';
  const cutoffLength = maxWidth - ellipsis.length;

  if (cutoffLength <= 0) {
      return ellipsis.substring(0, maxWidth);
  }

  return str.substring(0, cutoffLength) + ellipsis;
}
