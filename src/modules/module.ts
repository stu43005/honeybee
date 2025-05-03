export interface Module {
  name: string;
  isInit?: boolean;
  init?(): Promise<void>;
  close?(signal: NodeJS.Signals): Promise<void>;
  healthCheck?(): Promise<boolean>;
}
