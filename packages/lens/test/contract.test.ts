import { describe, expect, it } from "vitest";
import {
  LENS_BROWSER_PROJECTION_VERSION,
  LENS_CANONICALIZATION_PROFILE,
  LENS_CASE_SCHEMA_VERSION,
  TARGET_CORE_MUTATIONS,
} from "../src/index.js";

describe("@nec/lens contract freeze", () => {
  it("pins the public Lens contract without Core mutation", () => {
    expect(LENS_CASE_SCHEMA_VERSION).toBe("lens-case/v0.1");
    expect(LENS_BROWSER_PROJECTION_VERSION).toBe("lens-browser/v0.1");
    expect(LENS_CANONICALIZATION_PROFILE).toBe("hub-json-sorted-keys/v0.1");
    expect(TARGET_CORE_MUTATIONS).toBe(0);
  });
});
