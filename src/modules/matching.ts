export type Query = Record<string, any> & Partial<FunctionArg>;

export type FunctionArg = {
  $eq: any;
  $ne: any;
  $gt: any;
  $gte: any;
  $lt: any;
  $lte: any;
  $all: ReadonlyArray<any>;
  $in: ReadonlyArray<any>;
  $nin: ReadonlyArray<any>;
  $size: number;
  $not: string | RegExp | Query;
  $and: ReadonlyArray<Query>;
  $or: ReadonlyArray<Query>;
  $nor: ReadonlyArray<Query>;
  $exists: boolean;
  $mod: [number, number];
  $regex: RegExp;
  $options: string;
  $elemMatch: Query;
};

const functions: {
  [fn: string]: (obj: any, value: any, query: Query) => boolean;
} = {
  $eq(obj: any, value: FunctionArg["$eq"]) {
    return obj === value;
  },
  $ne(obj: any, value: FunctionArg["$ne"]) {
    return obj !== value;
  },
  $gt(obj: any, value: FunctionArg["$gt"]) {
    return obj > value;
  },
  $gte(obj: any, value: FunctionArg["$gte"]) {
    return obj >= value;
  },
  $lt(obj: any, value: FunctionArg["$lt"]) {
    return obj < value;
  },
  $lte(obj: any, value: FunctionArg["$lte"]) {
    return obj <= value;
  },
  $all(obj: any, value: FunctionArg["$all"]) {
    if (!Array.isArray(value) || !Array.isArray(obj)) {
      return false;
    }
    for (const element of value) {
      if (obj.indexOf(element) === -1) {
        return false;
      }
    }
    return true;
  },
  $in(obj: any, value: FunctionArg["$in"]) {
    return value.indexOf(obj) !== -1;
  },
  $nin(obj: any, value: FunctionArg["$nin"]) {
    if (typeof obj === "undefined") {
      return true;
    }
    return value.indexOf(obj) === -1;
  },
  $size(array: any, length: FunctionArg["$size"]) {
    return array.length === length;
  },
  $not(obj: any, condition: FunctionArg["$not"]) {
    return !isMatching(obj, condition);
  },
  $and(obj: any, conditions: FunctionArg["$and"]) {
    for (const condition of conditions) {
      if (!isMatching(obj, condition)) {
        return false;
      }
    }
    return true;
  },
  $or(obj: any, conditions: FunctionArg["$or"]) {
    for (const condition of conditions) {
      if (isMatching(obj, condition)) {
        return true;
      }
    }
    return false;
  },
  $nor(obj: any, conditions: FunctionArg["$nor"]) {
    for (const condition of conditions) {
      if (isMatching(obj, condition)) {
        return false;
      }
    }
    return true;
  },
  $exists(obj: any, mustExist: FunctionArg["$exists"]) {
    return (typeof obj !== "undefined") === mustExist;
  },
  $mod(obj: any, [divisor, remainder]: FunctionArg["$mod"]) {
    return obj % divisor === remainder;
  },
  $regex(obj: any, regex: FunctionArg["$regex"], query) {
    const options = query.$options;
    return new RegExp(regex, options).test(obj);
  },
  $elemMatch(array: any, query: FunctionArg["$elemMatch"]) {
    for (const element of array) {
      if (isMatching(element, query)) {
        return true;
      }
    }
    return false;
  },
};

function matchArray(obj: any, query: ReadonlyArray<any>) {
  if (!Array.isArray(obj)) {
    return false;
  }
  if (obj.length !== query.length) {
    return false;
  }
  for (let i = 0; i < query.length; ++i) {
    if (obj[i] !== query[i]) {
      return false;
    }
  }
  return true;
}

function getDotNotationProp(obj: any, key: string) {
  const parts = key.split(".");
  while (parts.length && (obj = obj[parts.shift() ?? ""]));
  return obj;
}

function matchQueryObject(obj: any, query: Query) {
  for (const key in query) {
    if (Object.prototype.hasOwnProperty.call(functions, key)) {
      // Runs the match function.
      if (!functions[key](obj, query[key], query)) {
        return false;
      }
    } else {
      let value = obj[key];
      if (key.indexOf(".") !== -1) {
        value = getDotNotationProp(obj, key);
      }
      // Recursive run match for an attribute.
      if (!isMatching(value, query[key])) {
        return false;
      }
    }
  }
  return true;
}

export function isMatching(
  obj: any,
  query: string | Query | ReadonlyArray<any> | RegExp
): boolean {
  if (query instanceof RegExp) {
    return query.test(obj);
  }
  if (Array.isArray(query)) {
    return matchArray(obj, query);
  }
  if (typeof query === "object") {
    return matchQueryObject(obj, query);
  }
  return query === obj;
}
