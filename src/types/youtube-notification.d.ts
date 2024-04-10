declare module "youtube-notification" {
  import EventEmitter from "events";
  import express from "express";

  export interface NotifierOptions {
    /** Your ip/domain name that will be used as a callback URL by the hub */
    hubCallback: string;
    /** The secret for the requests to hub */
    secret?: string;
    /** If you are going to use the Notifier with a middleware */
    middleware?: boolean;
    /** An open port on your system to listen on. Defaults to port 3000 or undefined */
    port?: number;
    /** The path on which server will interact with the hub */
    path?: string;
    /** The hub url. It is advised not to change this. */
    hubUrl?: string;
  }

  export interface IntentData {
    type: "subscribe" | "unsubscribe" | "denied";
    channel: string;
    lease_seconds?: number;
  }

  export interface NotifiedData {
    video: {
      id: string;
      title: string;
      link: string;
    };
    channel: {
      id: string;
      name: string;
      link: string;
    };
    published: Date;
    updated: Date;
  }

  export interface Events {
    denied: (data: IntentData) => void;
    subscribe: (data: IntentData) => void;
    unsubscribe: (data: IntentData) => void;
    notified: (data: NotifiedData) => void;
  }

  interface YouTubeNotifier {
    on<U extends keyof Events>(event: U, listener: Events[U]): this;
    once<U extends keyof Events>(event: U, listener: Events[U]): this;
    addListener<U extends keyof Events>(event: U, listener: Events[U]): this;
    off<U extends keyof Events>(event: U, listener: Events[U]): this;
    removeListener<U extends keyof Events>(event: U, listener: Events[U]): this;
    emit<U extends keyof Events>(
      event: U,
      ...args: Parameters<Events[U]>
    ): boolean;
  }

  class YouTubeNotifier extends EventEmitter {
    constructor(options?: NotifierOptions);
    setup(): void;
    listener(): (req: express.Request, res: express.Response) => void;
    subscribe(channels: string[] | string): void;
    unsubscribe(channels: string[] | string): void;
  }
  export = YouTubeNotifier;
}
