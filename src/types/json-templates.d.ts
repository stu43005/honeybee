declare module "json-templates" {
  export type JsonTemplate<T> = {
    parameters: [{ key: string; defaultValue: string }];
  } & ((parameters?: object) => T);

  declare function parse<T extends string | object>(
    atemplate: T
  ): JsonTemplate<T>;
  export = parse;
}
