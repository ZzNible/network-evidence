import { describe, expect, it } from "vitest";
import {
  NE_MAPS_CASE_SCHEMA_VERSION,
  NE_MAPS_COLLECTION_SCHEMA_VERSION,
  TARGET_CORE_MUTATIONS,
} from "../contracts/case-envelope.js";

describe("NE Maps case-envelope contract freeze", () => {
  it("pins a versioned collection/case boundary without Core mutation", () => {
    expect(NE_MAPS_CASE_SCHEMA_VERSION).toBe("ne-maps-case/v0.1");
    expect(NE_MAPS_COLLECTION_SCHEMA_VERSION).toBe("ne-maps-case-collection/v0.1");
    expect(TARGET_CORE_MUTATIONS).toBe(0);
  });
});
