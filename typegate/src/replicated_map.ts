// Copyright Metatype OÜ, licensed under the Elastic License 2.0.
// SPDX-License-Identifier: Elastic-2.0

import { connect, Redis, RedisConnectOptions, XIdInput } from "redis";
import * as Sentry from "sentry";
import { getLogger } from "./log.ts";

const logger = getLogger("sync");

type SyncContext = {
  start: (cursor: XIdInput) => AsyncIterableIterator<Record<string, string>>;
  process: Promise<void>;
  cancel: () => Promise<void>;
};

const ADD = "add";
const RM = "rm";

// Deno Redis driver library does not support well txs (MULTI), prefer Lua scripts to avoid bugs
const addCmd = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('XADD', KEYS[2], 'MAXLEN', '~', '10000', '*', 'name', ARGV[1], 'event', '${ADD}', 'instance', ARGV[2])
`.trim();

const rmCmd = `
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('XADD', KEYS[2], 'MAXLEN', '~', '10000', '*', 'name', ARGV[1], 'event', '${RM}', 'instance', ARGV[2])
`.trim();

export class RedisReplicatedMap<T> {
  instance: string;
  redis: Redis;
  redisObs: Redis;
  memory: Map<string, T>;
  key: string;
  ekey: string;
  serializer: (elem: T) => Promise<string> | string;
  deserializer: (value: string) => Promise<T> | T;
  sync: SyncContext | null;

  private constructor(
    name: string,
    redis: Redis,
    redisObs: Redis,
    serializer: (elem: T) => Promise<string> | string,
    deserializer: (value: string) => Promise<T> | T,
  ) {
    this.instance = crypto.randomUUID();
    this.redis = redis;
    this.redisObs = redisObs;
    this.memory = new Map();
    this.key = name;
    this.ekey = `${name}_event`;
    this.serializer = serializer;
    this.deserializer = deserializer;
    this.sync = null;
  }

  static async init<T>(
    name: string,
    connection: RedisConnectOptions,
    serializer: (elem: T) => Promise<string> | string,
    deserializer: (value: string) => Promise<T> | T,
  ) {
    // needs two connections because
    // 1. xread with block delays other commands
    // 2. https://github.com/denodrivers/redis/issues/304

    const redis = await connect(connection);
    const redisObs = await connect(connection);
    return new RedisReplicatedMap<T>(
      name,
      redis,
      redisObs,
      serializer,
      deserializer,
    );
  }

  async startSync() {
    if (this.sync) {
      return;
    }
    const { key, redis, memory, deserializer } = this;
    this.sync = this.subscribe();

    const [lastMessage] = await redis.xrevrange(this.ekey, "+", "-", 1);
    const all = await redis.hgetall(key);
    for (let i = 0; i < all.length; i += 2) {
      const name = all[i];
      const payload = all[i + 1];
      logger.info(`reloaded addition: ${name}`);
      memory.set(name, await deserializer(payload));
    }

    for await (
      const { name, event, instance } of this.sync.start(
        lastMessage ? lastMessage.xid : 0,
      )
    ) {
      if (this.instance == instance) {
        continue;
      }
      if (event === ADD) {
        const payload = await redis.hget(key, name);
        if (!payload) {
          throw Error(`added message without payload ${name}`);
        }
        logger.info(`received addition: ${name}`);

        memory.set(name, await deserializer(payload));
      } else if (event === RM) {
        logger.info(`received removal: ${name}`);
        memory.delete(name);
      } else {
        throw Error(`unexpected message ${name} with ${event}`);
      }
    }
  }

  private subscribe(): SyncContext {
    const { ekey, redisObs } = this;

    let loop = true;
    let start: (
      cursor: XIdInput,
    ) => AsyncIterableIterator<Record<string, string>> = async function* () {};

    const process = new Promise<void>((resolve) => {
      start = async function* (cursor: XIdInput) {
        while (loop) {
          try {
            const [stream] = await redisObs.xread(
              [{ key: ekey, xid: cursor }],
              {
                block: 5000,
              },
            );
            if (!stream) {
              continue;
            }
            for (const { xid, fieldValues } of stream.messages) {
              yield fieldValues;
              cursor = xid;
            }
          } catch (error) {
            Sentry.captureException(error);
            logger.error(error);
          }
        }
        resolve();
      };
    });

    const cancel = (): Promise<void> => {
      loop = false;
      return process;
    };

    return { start, process, cancel };
  }

  async set(name: string, elem: T) {
    const { key, ekey, serializer } = this;

    this.memory.set(name, elem);
    logger.info(`sent addition: ${name}`);

    await this.redis.eval(
      addCmd,
      [key, ekey],
      [name, this.instance, await serializer(elem)],
    );
  }

  get(name: string): T | undefined {
    return this.memory.get(name);
  }

  has(name: string): boolean {
    return this.memory.has(name);
  }

  async delete(name: string): Promise<void> {
    const { key, ekey } = this;

    this.memory.delete(name);
    logger.info(`sent removal: ${name}`);

    await this.redis.eval(
      rmCmd,
      [key, ekey],
      [name, this.instance],
    );
  }
}
