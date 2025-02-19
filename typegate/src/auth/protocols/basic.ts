// Copyright Metatype OÜ, licensed under the Elastic License 2.0.
// SPDX-License-Identifier: Elastic-2.0

import { Auth, AuthDS } from "../auth.ts";
import * as bcrypt from "bcrypt";
import * as _bcrypt from "_bcrypt"; // https://github.com/JamesBroadberry/deno-bcrypt/issues/31
import { SystemTypegraph } from "../../system_typegraphs.ts";
import { b64decode } from "../../utils.ts";
import { SecretManager } from "../../typegraph.ts";
import config from "../../config.ts";

export class BasicAuth implements Auth {
  static async init(
    typegraphName: string,
    auth: AuthDS,
    secretManager: SecretManager,
  ): Promise<Auth> {
    const tokens = new Map();
    for (const user of auth.auth_data.users as string[]) {
      const password = SystemTypegraph.check(typegraphName)
        ? config.tg_admin_password
        : secretManager.secretOrFail(`${auth.name}_${user}`);
      const token = await bcrypt.hash(password);
      tokens.set(user, token);
    }
    return Promise.resolve(new BasicAuth(typegraphName, tokens));
  }

  private constructor(
    public typegraphName: string,
    private hashes: Map<string, string>,
  ) {}

  authMiddleware(_request: Request): Promise<Response> {
    const res = new Response("not found", {
      status: 404,
    });
    return Promise.resolve(res);
  }

  async tokenMiddleware(
    jwt: string,
    _url: URL,
  ): Promise<[Record<string, unknown>, Headers]> {
    const [user, token] = b64decode(jwt).split(
      ":",
    );

    const hash = this.hashes.get(user);
    const claims = hash && await bcrypt.compare(token, hash)
      ? {
        user,
      }
      : {};

    return Promise.resolve([claims, new Headers()]);
  }
}
