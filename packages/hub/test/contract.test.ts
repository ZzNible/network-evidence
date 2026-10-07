import { describe, expect, it } from "vitest";
import {
  HUB_ACCEPTED_WIRE_PROFILE,
  HUB_RECORD_SCHEMA_VERSION,
  TARGET_CORE_MUTATIONS,
} from "../src/index.js";

describe("@nec/hub contract freeze", () => {
  it("pins the minimal public contract versions without Core mutation", () => {
    expect(HUB_RECORD_SCHEMA_VERSION).toBe("hub-network-evidence-record/v0.1");
    expect(HUB_ACCEPTED_WIRE_PROFILE).toBe("nec-wire-json-v1");
    expect(TARGET_CORE_MUTATIONS).toBe(0);
  });
});
