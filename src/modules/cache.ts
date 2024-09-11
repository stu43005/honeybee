import NodeCache from "node-cache";

interface CacheItem<T = unknown> {
  timestamp: number;
  promise?: Promise<T>;
  data?: T;
}

export namespace HoneybeeCache {
  export interface Options extends NodeCache.Options {
    timeToLiveSeconds?: number;
    timeToFetchSeconds?: number;
  }
}

export class HoneybeeCache {
  private cache: NodeCache;

  private useClones: boolean;
  private timeToLiveSeconds: number;
  private timeToFetchSeconds: number;

  constructor(options?: HoneybeeCache.Options) {
    this.useClones = options?.useClones ?? true;
    this.timeToLiveSeconds = options?.timeToLiveSeconds ?? 600;
    this.timeToFetchSeconds = options?.timeToFetchSeconds ?? 60;

    this.cache = new NodeCache({
      ...options,
      stdTTL: Math.max(options?.stdTTL ?? 0, this.timeToLiveSeconds),
      useClones: false,
      deleteOnExpire: true,
    });
  }

  public async getOrFetch<T>(
    key: string,
    fetcher: () => Promise<T>
  ): Promise<T> {
    const fetchData = async () => {
      const item = this.cache.get<CacheItem<T>>(key) ?? {
        timestamp: 0,
      };
      if (item.promise !== undefined) {
        const data = await item.promise;
        return this.useClones ? structuredClone(data) : data;
      }
      try {
        item.promise = fetcher();
        this.cache.set(key, item);

        const data = await item.promise;
        item.timestamp = Date.now();
        item.promise = undefined;
        item.data = data;
        this.cache.set(key, item);
        return this.useClones ? structuredClone(data) : data;
      } catch (error) {
        item.promise = undefined;
        this.cache.set(key, item);
        throw error;
      }
    };

    const item = this.cache.get<CacheItem<T>>(key);
    if (item === undefined) {
      return fetchData();
    }
    if (item.data === undefined) {
      return fetchData();
    }
    if (item.timestamp + this.timeToLiveSeconds * 1000 < Date.now()) {
      return fetchData();
    }
    if (
      item.promise === undefined &&
      item.timestamp + this.timeToFetchSeconds * 1000 < Date.now()
    ) {
      fetchData().catch(() => void 0);
    }
    return this.useClones ? structuredClone(item.data) : item.data;
  }

  public set<T>(key: string, data: T): T {
    const item = this.cache.get<CacheItem<T>>(key) ?? {
      timestamp: 0,
    };
    item.timestamp = Date.now();
    item.promise = undefined;
    item.data = data;
    this.cache.set(key, item);
    return this.useClones ? structuredClone(data) : data;
  }

  public del(key: string): number {
    return this.cache.del(key);
  }
}
