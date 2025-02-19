// Copyright Metatype OÜ, licensed under the Elastic License 2.0.
// SPDX-License-Identifier: Elastic-2.0

import { Runtime } from "./Runtime.ts";
import { ComputeStage } from "../engine.ts";
import { Resolver, RuntimeInitParams } from "../types.ts";
import { iterParentStages, JSONValue, nativeResult } from "../utils.ts";
import * as native from "native";

const fieldSelectorResolver = (stage: ComputeStage) => {
  const resolver: Resolver = async ({ _: { parent }, ...args }) => {
    const field = parent[stage.props.node];
    return typeof field === "function" ? await field(args) : field;
  };
  return resolver;
};

interface Mask {
  [key: string]: Mask | true;
}

const pick = (
  obj: JSONValue,
  mask: Mask,
): JSONValue => {
  if (Array.isArray(obj)) {
    return obj.map((o) => pick(o, mask));
  }
  if (typeof obj === "object" && obj !== null) {
    for (const k of Object.keys(obj)) {
      const m = mask[k];
      if (m === undefined) {
        delete obj[k];
      } else if (m !== true) {
        pick(obj[k], m);
      }
    }
  }
  return obj;
};

const getMask = (stages: ComputeStage[]): Mask => {
  const ret: Mask = {};
  iterParentStages(stages, (stage, children) => {
    ret[stage.props.node] = children.length > 0 ? getMask(children) : true;
  });
  return ret;
};

export class S3Runtime extends Runtime {
  private constructor(
    private client: native.S3Client,
  ) {
    super();
  }

  static init(params: RuntimeInitParams): Runtime {
    const { args, secretManager } = params;

    const { host, region } = args;
    const client: native.S3Client = {
      region: region as string,
      access_key: secretManager.secretOrFail(
        args.access_key_secret as string,
      ),
      secret_key: secretManager.secretOrFail(
        args.secret_key_secret as string,
      ),
      endpoint: host as string,
    };
    return new S3Runtime(client);
  }

  async deinit(): Promise<void> {}

  materialize(
    stage: ComputeStage,
    waitlist: ComputeStage[],
    _verbose: boolean,
  ): ComputeStage[] {
    const name = stage.props.materializer?.name;
    const { bucket, content_type } = stage.props.materializer?.data ?? {};

    const sameRuntime = Runtime.collectRelativeStages(stage, waitlist);
    const mask = getMask(sameRuntime);

    const resolver: Resolver = (() => {
      if (name === "list") {
        return async ({ path }) => {
          const { items, prefix } = nativeResult(
            await native.s3_list(
              this.client,
              bucket as string,
              path,
            ),
          );
          return pick({ keys: items, prefix }, mask);
        };
      }

      if (name === "sign") {
        return async ({ length, path }) => {
          const params: native.S3Presigning = {
            bucket: bucket as string,
            key: path,
            content_type: content_type as string,
            content_length: length.toString(),
            expires: 60,
          };
          return nativeResult(await native.s3_presign_put(this.client, params))
            .res;
        };
      }

      return fieldSelectorResolver(stage);
    })();
    return [
      new ComputeStage({
        ...stage.props,
        resolver,
      }),
    ];
  }
}
