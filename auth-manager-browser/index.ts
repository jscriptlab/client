import { authorization } from "@jscriptlab/schema/src/auth";
import { objectId } from "@jscriptlab/schema/src/objectId";
import { IAuthManager } from "../src/Client";
import Exception from "../src/Exception";

export default class AuthManagerBrowser implements IAuthManager {
  readonly #tagLengthInBits = 128;
  #value: {
    key: Promise<CryptoKey>;
    id: objectId;
  } | null;
  public constructor() {
    this.#value = null;
  }
  public id() {
    return this.#value?.id ?? null;
  }
  public async hasKey(): Promise<boolean> {
    return this.#value !== null;
  }
  public async encrypt(data: Uint8Array, iv: Uint8Array) {
    const key = await this.#key();
    if (!key) {
      throw new Exception("no key defined to perform encryption");
    }
    return await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        tagLength: this.#tagLengthInBits,
        iv,
      },
      key,
      data
    );
  }
  public async decrypt(value: Uint8Array, iv: Uint8Array) {
    const key = await this.#key();
    if (!key) {
      throw new Exception("no key defined to perform decryption");
    }
    return await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        tagLength: this.#tagLengthInBits,
        iv,
      },
      key,
      value
    );
  }
  public setAuthorization(auth: authorization | null) {
    if (auth === null) {
      this.#value = null;
      return;
    }
    this.#value = {
      key: crypto.subtle.importKey(
        "raw",
        auth.key,
        {
          name: "AES-GCM",
          length: this.#tagLengthInBits,
        },
        false,
        ["encrypt", "decrypt"]
      ),
      id: auth.id,
    };
  }
  #key() {
    return this.#value?.key ?? null;
  }
}
