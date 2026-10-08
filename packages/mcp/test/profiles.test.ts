import { describe, expect, it } from "vitest";

import { CAPABILITY_NAMES } from "@nec/core";
import { opStackBeforeResolverManifest } from "@nec/resolver-opstack";
import { solanaBeforeResolverManifest } from "@nec/resolver-solana";
import { zksysBeforeResolverManifest } from "@nec/resolver-zksys";

import { fixedProfileEnvironments, networkProfilesInventory } from "../src/profiles.js";

const inventory = networkProfilesInventory();

function stringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringValues(item, out);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) stringValues(item, out);
  return out;
}

describe("list_network_profiles inventory", () => {
  it("is exactly the fixed public profile set, in fixed order", () => {
    expect(inventory.profiles.map((p) => [p.profileId, p.networkId, p.environment])).toEqual([
      ["base-mainnet", "eip155:8453", "mainnet"],
      ["base-sepolia", "eip155:84532", "testnet"],
      ["solana-mainnet", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "mainnet"],
      ["solana-devnet", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "testnet"],
      ["zksys-tanenbaum", "eip155:57057", "testnet"],
    ]);
    expect(inventory.inventoryOrder).toMatch(/no ranking/);
  });

  it("never reports anything as currently assessed, live or available", () => {
    expect(inventory.liveObservation).toBe(false);
    for (const profile of inventory.profiles) {
      expect(profile.currentStatus).toBe("not_assessed");
      expect(profile.capabilities.map((c) => c.capability)).toEqual([...CAPABILITY_NAMES]);
      for (const capability of profile.capabilities) {
        expect(capability.currentSupport).toBe("not_assessed");
        expect(capability.currentAvailability).toBe("not_assessed");
      }
    }
    const values = stringValues(inventory);
    for (const forbidden of ["available", "usable", "live", "online", "healthy", "eligible", "supported"]) {
      expect(values).not.toContain(forbidden);
    }
  });

  it("copies declared support and digests from the public resolver manifests", () => {
    const manifests = new Map([
      ["opstack", opStackBeforeResolverManifest()],
      ["solana", solanaBeforeResolverManifest()],
      ["zksys", zksysBeforeResolverManifest()],
    ]);
    for (const profile of inventory.profiles) {
      const manifest = manifests.get(profile.family)!;
      expect(profile.resolverManifest).toEqual({
        id: manifest.id,
        version: manifest.version,
        digest: manifest.digest,
        package: manifest.implementation.package,
      });
      expect(profile.capabilities.filter((c) => c.declaredByResolverManifest).map((c) => c.capability)).toEqual(
        CAPABILITY_NAMES.filter((name) => manifest.supportedCapabilities.includes(name)),
      );
    }
  });

  it("keeps zkSYS Tanenbaum testnet / historical replay only, with no zkSYS mainnet", () => {
    const zksys = inventory.profiles.filter((p) => p.family === "zksys");
    expect(zksys).toHaveLength(1);
    expect(zksys[0]!.environment).toBe("testnet");
    expect(zksys[0]!.chainId).toBe(57057);
    expect(zksys[0]!.acceptedObservationKinds).toEqual(["historical_replay"]);
    expect(zksys[0]!.doesNotEstablish).toEqual(expect.arrayContaining(["finality", "gateway_settlement"]));
    expect(inventory.profiles.some((p) => p.family === "zksys" && p.environment === "mainnet")).toBe(false);
    expect(fixedProfileEnvironments().get("eip155:57057")).toBe("testnet");
  });

  it("states the truth boundaries and finality non-claims", () => {
    const text = inventory.truthBoundaries.join("\n");
    expect(text).toMatch(/Current support is not current availability/);
    expect(text).toMatch(/Archived \(historical\) replay keeps current availability 'unknown'/);
    expect(text).toMatch(/no zkSYS mainnet profile/);
    expect(text).toMatch(/does not score, rank, recommend or choose/);
    const base = inventory.profiles[0]!;
    expect(base.doesNotEstablish).toEqual(expect.arrayContaining(["settlement", "withdrawal_finalization"]));
    expect(inventory.profiles[2]!.doesNotEstablish).toEqual(expect.arrayContaining(["settlement", "economic_irreversibility"]));
  });

  it("is deep-frozen", () => {
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.profiles[0]!.capabilities[0])).toBe(true);
  });
});
