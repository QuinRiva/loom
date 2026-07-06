import { AuthAdministrativeScopes } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const CLI_TOKEN_SECRET = "cli-token";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const stringToBytes = (value: string): Uint8Array => encoder.encode(value);
const bytesToString = (value: Uint8Array): string => decoder.decode(value);

export const provisionCliToken = Effect.fn("provisionCliToken")(function* () {
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const issued = yield* environmentAuth.issueSession({
    scopes: AuthAdministrativeScopes,
    label: "t3 cli (local)",
    ttl: Duration.days(365),
  });
  yield* secrets.set(CLI_TOKEN_SECRET, stringToBytes(issued.token));
});

export const readPreProvisionedCliToken = Effect.fn("readPreProvisionedCliToken")(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return Option.map(yield* secrets.get(CLI_TOKEN_SECRET), (value) => bytesToString(value).trim());
});
