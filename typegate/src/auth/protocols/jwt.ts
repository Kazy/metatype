// Copyright Metatype OÜ, licensed under the Elastic License 2.0.
// SPDX-License-Identifier: Elastic-2.0

import { Auth, AuthDS } from "../auth.ts";
import * as jwt from "jwt";
import { getLogger } from "../../log.ts";
import { SecretManager } from "../../typegraph.ts";

const logger = getLogger(import.meta.url);
const encoder = new TextEncoder();

export class JWTAuth implements Auth {
  static async init(
    typegraphName: string,
    auth: AuthDS,
    secretManager: SecretManager,
  ): Promise<Auth> {
    const { format, algorithm } = auth.auth_data;
    const sourceEnv = secretManager.secretOrFail(`${auth.name}_JWT`);
    const key = format === "jwk"
      ? JSON.parse(sourceEnv)
      : encoder.encode(sourceEnv);

    const signKey = await crypto.subtle.importKey(
      format as any,
      key,
      algorithm as unknown as
        | AlgorithmIdentifier
        | HmacImportParams
        | RsaHashedImportParams
        | EcKeyImportParams,
      false,
      ["verify"],
    );
    return new JWTAuth(typegraphName, signKey);
  }

  private constructor(
    public typegraphName: string,
    private signKey: CryptoKey,
  ) {}

  authMiddleware(_request: Request): Promise<Response> {
    const res = new Response("not found", {
      status: 404,
    });
    return Promise.resolve(res);
  }

  async tokenMiddleware(
    token: string,
    _url: URL,
  ): Promise<[Record<string, unknown>, Headers]> {
    try {
      const claims = await jwt.verify(token, this.signKey);
      return [claims, new Headers()];
    } catch (e) {
      logger.warning(`jwt auth failed: ${e}`);
      return [{}, new Headers()];
    }
  }
}
