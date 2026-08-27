/**
 * SOURCE CONFIGURATION boundary.
 *
 * A NEC evidentiary source is always an explicitly configured descriptor —
 * a request can NEVER carry an arbitrary RPC URL. The descriptor lives in
 * memory (typically inside `ResolverContext.sourceConfig`) and its endpoint
 * URL never enters any artifact, fixture or log: captures and observations
 * carry only `sourceId` / `sourceType` / `independenceGroup` /
 * `networkId` / `chainId`.
 *
 * One Viem public client is created per descriptor; `fallback([...])` is
 * deliberately never used, so provenance ("WHICH source produced this
 * observation") is always exact.
 */

import { assertIso8601, assertNetworkId, assertNecIdentifier, assertSafePositiveInteger } from "@nec/core";
import type { Iso8601, NetworkId } from "@nec/core";

import { NecResolverEvmError } from "./errors.js";

export interface EvmHttpTransportConfig {
  readonly kind: "http";
  /** Absolute http(s) endpoint; may carry credentials for LIVE use only. */
  readonly url: string;
}

/**
 * One configured evidentiary source. Secrets (API keys in URLs or headers)
 * are permitted ONLY here, transiently, for live acquisition.
 */
export interface EvmRpcSourceDescriptor {
  readonly sourceId: string;
  readonly sourceType: string;
  /** NEC network id, e.g. "eip155:11155111". */
  readonly networkId: NetworkId;
  /** Expected EIP-155 chain id; enforced against eth_chainId at acquisition. */
  readonly chainId: number;
  readonly transport: EvmHttpTransportConfig;
  /** Optional independence label (equal labels mean KNOWN dependence). */
  readonly independenceGroup?: string;
}

const URL_PATTERN = /^https?:\/\//i;

function exactKeys(value: object, keys: readonly string[], path: string): void {
  const allowed = new Set<string>(keys);
  // Reflect.ownKeys: symbol-keyed properties cannot carry hidden config
  // past this boundary.
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new NecResolverEvmError(
        "EVM_SOURCE_CONFIG_INVALID",
        `${path}.${String(key)}: symbol-keyed property rejected`,
      );
    }
    if (!allowed.has(key as string)) {
      throw new NecResolverEvmError(
        "EVM_SOURCE_CONFIG_INVALID",
        `${path}: unknown key ${JSON.stringify(key)}`,
      );
    }
  }
}

export function validateEvmRpcSourceDescriptor(value: unknown): asserts value is EvmRpcSourceDescriptor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new NecResolverEvmError("EVM_SOURCE_CONFIG_INVALID", "source must be a plain object");
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    throw new NecResolverEvmError("EVM_SOURCE_CONFIG_INVALID", "source must have a plain prototype");
  }
  const source = value as Record<string, unknown>;
  exactKeys(
    source,
    ["sourceId", "sourceType", "networkId", "chainId", "transport", "independenceGroup"],
    "source",
  );
  if (typeof source.sourceId !== "string") {
    throw new NecResolverEvmError("EVM_SOURCE_CONFIG_INVALID", "source.sourceId must be a string");
  }
  if (typeof source.sourceType !== "string") {
    throw new NecResolverEvmError("EVM_SOURCE_CONFIG_INVALID", "source.sourceType must be a string");
  }
  if (typeof source.networkId !== "string") {
    throw new NecResolverEvmError("EVM_SOURCE_CONFIG_INVALID", "source.networkId must be a string");
  }
  // Core grammar validators are authoritative for identifier/network
  // shapes; failures are re-typed into the resolver error surface.
  try {
    assertNecIdentifier(source.sourceId, "source.sourceId");
    assertNecIdentifier(source.sourceType, "source.sourceType");
    assertNetworkId(source.networkId, "source.networkId");
    assertSafePositiveInteger(source.chainId, "source.chainId");
    if (source.independenceGroup !== undefined) {
      if (typeof source.independenceGroup !== "string") {
        throw new NecResolverEvmError("EVM_SOURCE_CONFIG_INVALID", "source.independenceGroup must be a string");
      }
      assertNecIdentifier(source.independenceGroup, "source.independenceGroup");
    }
  } catch (error) {
    if (error instanceof NecResolverEvmError) throw error;
    throw new NecResolverEvmError("EVM_SOURCE_CONFIG_INVALID", (error as Error).message);
  }
  const transport = source.transport;
  if (transport === null || typeof transport !== "object" || Array.isArray(transport)) {
    throw new NecResolverEvmError("EVM_SOURCE_CONFIG_INVALID", "source.transport must be a plain object");
  }
  const transportProto = Object.getPrototypeOf(transport) as object | null;
  if (transportProto !== Object.prototype && transportProto !== null) {
    throw new NecResolverEvmError("EVM_SOURCE_CONFIG_INVALID", "source.transport must have a plain prototype");
  }
  const t = transport as Record<string, unknown>;
  exactKeys(t, ["kind", "url"], "source.transport");
  if (t.kind !== "http") {
    throw new NecResolverEvmError("EVM_SOURCE_CONFIG_INVALID", 'source.transport.kind must be "http"');
  }
  if (typeof t.url !== "string" || !URL_PATTERN.test(t.url)) {
    throw new NecResolverEvmError("EVM_SOURCE_CONFIG_INVALID", "source.transport.url must be an absolute http(s) URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(t.url);
  } catch {
    throw new NecResolverEvmError("EVM_SOURCE_CONFIG_INVALID", "source.transport.url is not a valid URL");
  }
  // Credentials-in-URL would leak into viem's Authorization header silently;
  // require explicit header configuration instead (not supported in v0.1).
  if (parsed.username !== "" || parsed.password !== "") {
    throw new NecResolverEvmError(
      "EVM_SOURCE_CONFIG_INVALID",
      "source.transport.url must not embed user credentials",
    );
  }
}

/** Provenance projection of a source — the ONLY part that ever leaves memory. */
export interface SourceProvenance {
  readonly sourceId: string;
  readonly sourceType: string;
  readonly independenceGroup?: string;
  readonly networkId: NetworkId;
  readonly chainId: number;
}

export function sourceProvenance(source: EvmRpcSourceDescriptor): SourceProvenance {
  return {
    sourceId: source.sourceId,
    sourceType: source.sourceType,
    ...(source.independenceGroup === undefined ? {} : { independenceGroup: source.independenceGroup }),
    networkId: source.networkId,
    chainId: source.chainId,
  };
}

/** Explicit acquisition clock — time NEVER comes from the wall clock. */
export interface AcquisitionClock {
  readonly now: Iso8601;
}

export function validateAcquisitionClock(now: unknown): asserts now is Iso8601 {
  if (typeof now !== "string") {
    throw new NecResolverEvmError("EVM_TIME_INVALID", "now must be an ISO-8601 UTC timestamp string");
  }
  try {
    assertIso8601(now, "now");
  } catch (error) {
    throw new NecResolverEvmError(
      "EVM_TIME_INVALID",
      `now must be exactly YYYY-MM-DDTHH:mm:ss.sssZ (${(error as Error).message})`,
    );
  }
}
