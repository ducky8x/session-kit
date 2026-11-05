import type { Keychain } from "../../src/secrets.ts";

/** A keychain that lives in memory. Tests set `failWith` to make every call fail. */
export class MemoryKeychain implements Keychain {
  reads = 0;
  failWith: Error | null = null;

  constructor(public token: string | null = null) {}

  async getToken(): Promise<string | null> {
    this.reads++;
    if (this.failWith) throw this.failWith;
    return this.token;
  }

  async setToken(token: string): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.token = token;
  }
}
