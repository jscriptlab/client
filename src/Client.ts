import { boundMethod } from "autobind-decorator";
import Long from "long";
import { EventEmitter } from "eventual-js";
import { ILogger } from "@jscriptlogger/lib";
import { Codec } from "jsbuffer/codec";
import {
  decodeServerMessageTrait,
  encodeClientMessageTrait,
  messageRequest,
} from "@jscriptlab/schema/src/protocol";
import { RequestResult } from "@jscriptlab/schema/src/__types__";
import { Request } from "@jscriptlab/schema/src/protocol/Request";
import { Result } from "@jscriptlab/schema/src/protocol/Result";
import { Error } from "@jscriptlab/schema/src/protocol/Error";
import { DateTime } from "luxon";
import { authorization } from "@jscriptlab/schema/src/auth";
import { messageAuthenticated } from "@jscriptlab/schema/src/index";
import { objectId } from "@jscriptlab/schema/src/objectId";
import Exception from "./Exception";
import { Update } from "@jscriptlab/schema/src/update";

export interface IWebSocketEventMap {
  close: ICloseEvent;
  error: unknown;
  message: {
    data: unknown;
  };
  open: unknown;
}

export interface IWebSocket {
  readyState: number;
  binaryType: string;
  send(data: ArrayBuffer): void;
  addEventListener<K extends keyof IWebSocketEventMap>(
    type: K,
    listener: (this: IWebSocket, ev: IWebSocketEventMap[K]) => void
  ): void;
  removeEventListener<K extends keyof IWebSocketEventMap>(
    type: K,
    listener: (this: IWebSocket, ev: IWebSocketEventMap[K]) => void
  ): void;
}

export interface ICloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface IWebSocketConstructor {
  CONNECTING: number;
  OPEN: number;
  CLOSING: number;
  CLOSED: number;
  new (url: string): IWebSocket;
}

export interface IPendingSentInformation {
  date: DateTime;
  expiresAt: DateTime;
}

function isPendingSentInformationExpired(input: IPendingSentInformation) {
  return DateTime.now().toMillis() >= input.expiresAt.toMillis();
}

interface IPending {
  requestId: Long;
  acknowledged: boolean;
  request: Request;
  maxRetryCount: number;
  retries: IPendingSentInformation[];
  sent: IPendingSentInformation | null;
  pendingSent: Promise<void>;
  resolve(resolve: Result | Error): void;
}

interface ITextDecoder {
  decode(value: Uint8Array): string;
}

interface ITextEncoder {
  encode(value: string): Uint8Array;
}

export interface IClientOptions {
  url: string;
  logger: ILogger;
  WebSocket: IWebSocketConstructor;
  getRandomValues(value: Uint8Array): Uint8Array;
  textDecoder: ITextDecoder;
  textEncoder: ITextEncoder;
  authManager: IAuthManager;
}

export interface IAuthManager {
  id(): Readonly<objectId> | null;
  hasKey(): Promise<boolean>;
  setAuthorization(auth: authorization): void;
  encrypt(value: Uint8Array, iv: Uint8Array): Promise<ArrayBuffer>;
  decrypt(value: Uint8Array, iv: Uint8Array): Promise<ArrayBuffer>;
}

export interface IClientEventMap {
  update: Update;
}

export default class Client extends EventEmitter<IClientEventMap> {
  readonly #WebSocket;
  readonly #url;
  readonly #textDecoder;
  readonly #textEncoder;
  readonly #logger;
  readonly #pending = new Map<string, IPending>();
  readonly #getRandomValues;
  readonly #codec;
  readonly #authManager;
  #session: {
    id: Long;
  } | null;
  #connection: IWebSocket | null;
  public constructor({
    url,
    WebSocket,
    logger,
    getRandomValues,
    textDecoder,
    textEncoder,
    authManager,
  }: IClientOptions) {
    super();
    this.#session = null;
    this.#connection = null;
    this.#url = url;
    this.#logger = logger;
    this.#getRandomValues = getRandomValues;
    this.#WebSocket = WebSocket;
    this.#textDecoder = textDecoder;
    this.#authManager = authManager;
    this.#textEncoder = textEncoder;
    this.#codec = new Codec({
      textDecoder: this.#textDecoder,
      textEncoder: this.#textEncoder,
    });
  }
  public sendMessage<T extends Request>(
    request: T,
    {
      maxRetryCount = 4,
    }: Partial<{
      maxRetryCount: number;
    }> = {}
  ) {
    return new Promise<RequestResult<T> | Error>((resolve) => {
      const requestId = this.#randomLong();
      const pending: IPending = {
        requestId,
        pendingSent: Promise.resolve(),
        request,
        maxRetryCount,
        retries: [],
        resolve: (value) => {
          resolve(value as RequestResult<T> | Error);
        },
        sent: null,
        acknowledged: false,
      };
      this.#pending.set(requestId.toString(), pending);
      this.#sendMessageRequest(pending);
    });
  }
  #checkPendingRequests() {
    for (const pending of this.#pending.values()) {
      this.#sendMessageRequest(pending);
    }
  }
  #isConnected() {
    return (
      this.#connection !== null &&
      this.#connection.readyState === this.#WebSocket.OPEN
    );
  }
  #sendMessageRequest(pending: IPending) {
    if (!this.#isConnected()) {
      this.#connect();
      return;
    }
    /**
     * if no session is created, create a new session
     */
    if (this.#session === null) {
      this.#session = {
        id: this.#randomLong(),
      };
    }
    /**
     * this means session that was created here will be used inside after
     * promise is resolved
     */
    const session = this.#session;
    /**
     * whether initial sent of the request was expired or not
     */
    const isExpired =
      pending.sent !== null &&
      DateTime.now().toMillis() >= pending.sent.expiresAt.toMillis();
    const encoded = this.#cloneUint8Array(
      this.#codec.encode(
        encodeClientMessageTrait,
        messageRequest({
          requestId: pending.requestId.toString(),
          request: pending.request,
          sessionId: this.#session.id.toString(),
        })
      )
    );
    const expirationDifference = {
      seconds: 10,
    };
    if (isExpired) {
      const lastRetry = pending.retries[pending.retries.length - 1];
      if (lastRetry && !isPendingSentInformationExpired(lastRetry)) {
        return;
      }
      /**
       * try sending the request again
       */
      if (this.#send(encoded)) {
        /**
         * if we could successfully write to the
         */
        pending.retries.push({
          date: DateTime.now(),
          expiresAt: DateTime.now().plus(expirationDifference),
        });
      }
      return;
    }
    if (pending.sent !== null) {
      return;
    }
    pending.pendingSent = pending.pendingSent.then(async () => {
      let isSent: boolean;
      const authId = this.#authManager.id();
      if ((await this.#authManager.hasKey()) && authId !== null) {
        const iv = this.#getRandomValues(new Uint8Array(8));
        try {
          const encrypted = new Uint8Array(
            await this.#authManager.encrypt(encoded, iv)
          );
          isSent = this.#send(
            this.#codec.encode(
              encodeClientMessageTrait,
              messageAuthenticated({
                authId,
                iv,
                sessionId: session.id.toString(),
                message: encrypted,
              })
            )
          );
        } catch (reason) {
          this.#logger.error("failed to encrypt encoded data: %o", reason);
          isSent = false;
        }
      } else {
        isSent = this.#send(encoded);
      }
      if (isSent) {
        const sentAt = DateTime.now();
        pending.sent = {
          date: sentAt,
          expiresAt: sentAt.plus(expirationDifference),
        };
      }
    });
  }

  #cloneUint8Array(val: Uint8Array) {
    const copy = new Uint8Array(val.byteLength);
    copy.set(val);
    return copy;
  }
  #send(value: Uint8Array) {
    if (
      this.#connection === null ||
      this.#connection.readyState !== this.#WebSocket.OPEN
    ) {
      return false;
    }
    this.#connection.send(value);
    return true;
  }
  #connect() {
    if (this.#connection !== null) {
      return;
    }
    this.#connection = new this.#WebSocket(this.#url);
    this.#connection.binaryType = "arraybuffer";
    this.#connection.addEventListener("close", this.onClose);
    this.#connection.addEventListener("error", this.onError);
    this.#connection.addEventListener("open", this.onOpen);
    this.#connection.addEventListener("message", this.onMessage);
  }
  @boundMethod private onError(...args: unknown[]) {
    this.#logger.error("received error event:", ...args);
  }
  @boundMethod private onOpen() {
    this.#checkPendingRequests();
  }
  @boundMethod private onClose(e: Readonly<ICloseEvent>) {
    this.#connection = null;
    this.#logger.error("received close event: %o", e);
    this.#connect();
  }
  @boundMethod private onMessage({ data }: { data: unknown }) {
    if (!(data instanceof ArrayBuffer)) {
      return;
    }
    this.#onReceiveArrayBuffer(data).catch((reason) => {
      this.#logger.error(
        "failed processing encoded message with error: %o",
        reason
      );
    });
  }
  async #onReceiveArrayBuffer(data: ArrayBuffer) {
    const result = this.#codec.decode(
      decodeServerMessageTrait,
      new Uint8Array(data)
    );
    if (result === null) {
      this.#logger.error("failed to decode: %o", new Uint8Array(data));
      return;
    }
    /**
     * process result
     */
    switch (result._name) {
      case "index.messageAuthenticated": {
        let arrayBuffer: ArrayBuffer;
        try {
          arrayBuffer = await this.#authManager.decrypt(
            result.message,
            result.iv
          );
        } catch (reason) {
          this.#logger.error("failed to decrypt authenticated message: %o", {
            reason,
            result,
          });
          throw new Exception("Failed to decrypt authenticated message");
        }
        /**
         * process decrypted array buffer
         */
        await this.#onReceiveArrayBuffer(arrayBuffer);
        break;
      }
      case "protocol.index.acknowledgeMessage": {
        const pending = this.#pending.get(result.messageId);
        if (!pending) {
          this.#logger.error(
            "failed to find request to mark it as acknowledged: %s",
            result.messageId
          );
          break;
        }
        if (pending.acknowledged) {
          this.#logger.error(
            "tried to acknowledge an already acknowledged request: %o",
            pending
          );
          break;
        }
        pending.acknowledged = true;
        break;
      }
      case "protocol.index.messageProtocolError":
        this.#logger.error("received protocol error: %o", result);
        break;
      case "protocol.index.messageResultError":
      case "protocol.index.messageResultSuccess": {
        const pending = this.#pending.get(result.requestId);
        if (!pending) {
          this.#logger.error("failed to find request: %s", result.requestId);
          break;
        }
        /**
         * remove pending request from pending map
         */
        this.#pending.delete(result.requestId);
        switch (result._name) {
          case "protocol.index.messageResultSuccess":
            pending.resolve(result.result);
            break;
          case "protocol.index.messageResultError":
            pending.resolve(result.error);
        }
        break;
      }
      case "update.Updates":
        for (const u of result.updates) {
          this.emit("update", u);
        }
        break;
      default:
        this.#logger.error("failed to process message: %o", result);
    }
  }
  #randomLong() {
    return Long.fromBytesLE(
      Array.from(this.#getRandomValues(new Uint8Array(8))),
      true
    );
  }
}
