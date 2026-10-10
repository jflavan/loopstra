import { ConfigSchema, type Config } from "../config";

/**
 * What the schema fills in for a key that is not in the file: setup writes a key only when the
 * answer differs from this. Both bots are listed so their token variables have defaults too.
 */
export const DEFAULTS: Config = ConfigSchema.parse({
  version: 1,
  commands: { test: "x" },
  chat: { transports: { slack: { channel: "x" }, discord: { channel: "x" } } },
});
