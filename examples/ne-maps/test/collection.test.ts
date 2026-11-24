import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serializeLensBrowserSafeV01, validateLensBrowserSafeCaseV01 } from "@nec/lens";

import { buildNeMapsCollectionV01, serializeNeMapsCollectionV01 } from "../build-collection.js";
import { NeMapsValidationError, validateNeMapsCollectionV01 } from "../collection.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = join(root, "../..");
const collectionBytes = readFileSync(join(root, "data/collection.json"), "utf8");
const collection = JSON.parse(collectionBytes);
const legacy = JSON.parse(readFileSync(join(root, "data/cases.json"), "utf8"));
const appSource = readFileSync(join(root, "app.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const HISTORICAL_IDS = ["f1", "f2", "f3"] as const;
const SYNTHETIC_ID = "synthetic-local-core-golden";
const lensValidator = { validateLens: (lens: unknown) => validateLensBrowserSafeCaseV01(lens) };

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const clone = () => structuredClone(collection);
const byId = (value: any, id: string) => value.cases.find((item: { id: string }) => item.id === id);
const withCases = (ids: readonly string[]) => ({ ...clone(), cases: ids.map((id) => structuredClone(byId(collection, id))) });

function rejects(mutate: (value: any) => void, pattern: RegExp): void {
  const value = clone();
  mutate(value);
  expect(() => validateNeMapsCollectionV01(value)).toThrow(NeMapsValidationError);
  expect(() => validateNeMapsCollectionV01(value)).toThrow(pattern);
}

// Minimal DOM stand-in: enough for app.js node()/link()/replaceChildren().
class FakeElement {
  className = "";
  href = "";
  tabIndex = 0;
  focused = false;
  focus() { this.focused = true; }
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  #text = "";
  constructor(readonly tagName: string) {}
  set textContent(value: string) {
    this.#text = String(value);
    this.children = [];
  }
  get textContent(): string {
    return this.#text + this.children.map((child) => child.textContent).join("");
  }
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.#text = "";
    this.children = nodes;
  }
  find(predicate: (el: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = predicate(this) ? [this] : [];
    for (const child of this.children) out.push(...child.find(predicate));
    return out;
  }
  texts(): string[] {
    return [this.#text, ...this.children.flatMap((child) => child.texts())].filter(Boolean);
  }
}

async function bootApp(data: unknown, ownCollection?: unknown, exampleStatus = 200) {
  const app = new FakeElement("main");
  const counter = new FakeElement("span");
  const listeners: Array<() => void> = [];
  const location = { hash: "" };
  const fetched: string[] = [];
  vi.stubGlobal("document", {
    querySelector: (selector: string) => (selector === "#app" ? app : selector === "#case-count" ? counter : null),
    createElement: (tag: string) => new FakeElement(tag),
  });
  vi.stubGlobal("window", { addEventListener: (type: string, fn: () => void) => type === "hashchange" && listeners.push(fn) });
  vi.stubGlobal("location", location);
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    if (url === "./data/collection.json" && exampleStatus !== 200) {
      return { ok: false, status: exampleStatus };
    }
    if (url === "./data/my-collection.json") {
      if (ownCollection === undefined) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => structuredClone(ownCollection) };
    }
    return { ok: true, status: 200, json: async () => structuredClone(data) };
  });
  vi.resetModules();
  await import(/* @vite-ignore */ new URL("../app.js", import.meta.url).href);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  const navigate = (hash: string) => {
    location.hash = hash;
    for (const fn of listeners) fn();
    return app;
  };
  return { app, counter, fetched, navigate };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ne-maps-case-collection/v0.1 runtime validator", () => {
  it("accepts the checked-in F1/F2/F3 + synthetic collection with the public @nec/lens validator", () => {
    expect(collection.schemaVersion).toBe("ne-maps-case-collection/v0.1");
    expect(collection.cases.map((item: { id: string }) => item.id)).toEqual([...HISTORICAL_IDS, SYNTHETIC_ID, "zksys-genesis-20261118"]);
    expect(() => validateNeMapsCollectionV01(clone())).not.toThrow();
    expect(() => validateNeMapsCollectionV01(clone(), lensValidator)).not.toThrow();
  });

  it("accepts F1/F2/F3 alone, explicit 1/2/4-case collections and reordered collections", () => {
    const shapes = [
      [...HISTORICAL_IDS],
      [SYNTHETIC_ID],
      ["f2"],
      ["f3", SYNTHETIC_ID],
      [SYNTHETIC_ID, "f3", "f2", "f1"],
      ["f2", SYNTHETIC_ID, "f1", "f3"],
    ];
    for (const ids of shapes) {
      const value = validateNeMapsCollectionV01(withCases(ids), lensValidator);
      expect(value.cases.map((item) => item.id)).toEqual(ids);
    }
  });

  it("rejects invalid or unsupported collection structure", () => {
    expect(() => validateNeMapsCollectionV01(legacy)).toThrow(/schemaVersion/);
    expect(() => validateNeMapsCollectionV01(null)).toThrow(/plain object/);
    expect(() => validateNeMapsCollectionV01([])).toThrow(/plain object/);
    rejects((v) => (v.schemaVersion = "ne-maps-case-collection/v0.2"), /schemaVersion/);
    rejects((v) => (v.TARGET_CORE_MUTATIONS = 1), /TARGET_CORE_MUTATIONS/);
    rejects((v) => (v.presentationClass = "static"), /unsupported field presentationClass/);
    rejects((v) => delete v.nonClaims, /nonClaims/);
    rejects((v) => (v.nonClaims = []), /nonClaims/);
    rejects((v) => (v.cases = []), /at least one case/);
    rejects((v) => (v.cases = { 0: v.cases[0] }), /cases must be an array/);
    rejects((v) => (v.cases = Array.from({ length: 65 }, (_, i) => ({ ...v.cases[0], id: `c${i}` }))), /case bound/);
    rejects((v) => (v.cases[1].id = v.cases[0].id), /duplicates f1/);
    rejects((v) => (v.sourceAuthority = { repository: "r" }), /sourceAuthority.commit/);
    rejects((v) => (v.publicSuite = { repository: "r", commit: "c", branch: "b" }), /unsupported field branch/);
  });

  it("rejects invalid or unsupported case structure", () => {
    rejects((v) => (v.cases[0].schemaVersion = "ne-maps/v0.1"), /cases\[0\]\.schemaVersion/);
    rejects((v) => delete v.cases[3].schemaVersion, /cases\[3\]\.schemaVersion/);
    rejects((v) => (v.cases[0].trailContextNote = "legacy top-level field"), /unsupported field trailContextNote/);
    rejects((v) => (v.cases[1].reviewedSelectorOutcomes = []), /unsupported field reviewedSelectorOutcomes/);
    for (const id of ["F1", "../f1", "", "a/b", "x".repeat(65)]) rejects((v) => (v.cases[0].id = id), /case id/);
    rejects((v) => delete v.cases[0].display.title, /display\.title/);
    rejects((v) => (v.cases[0].display.badge = "x"), /unsupported field badge/);
    rejects((v) => delete v.cases[0].exactAction.networkId, /exactAction\.networkId/);
    rejects((v) => (v.cases[0].exactAction.extra = { nested: true }), /exactAction\.extra/);
    rejects((v) => v.cases[0].trailPropositionOrder.push("p-not-in-lens"), /unknown proposition p-not-in-lens/);
    rejects((v) => v.cases[0].trailPropositionOrder.push(v.cases[0].trailPropositionOrder[0]), /duplicates p-execution/);
    rejects((v) => (v.cases[0].lens.schemaVersion = "lens-case/v0.2"), /lens\.schemaVersion/);
    rejects((v) => (v.cases[0].lens.TARGET_CORE_MUTATIONS = 1), /lens\.TARGET_CORE_MUTATIONS/);
    rejects((v) => (v.cases[2].lens.revisionDigest = { algorithm: "sha256" }), /withheld by browser policy/);
    rejects((v) => (v.cases[3].lens.artifacts[0].locatorRef = "file:///secret"), /locatorRef/);
    rejects((v) => v.cases[3].lens.propositions.push(v.cases[3].lens.propositions[0]), /duplicates network\.execution/);
    rejects((v) => (v.cases[1].extensions.reviewedSelectorOutcomes[0].verdict = "unavailable"), /reviewed selector verdict/);
    rejects((v) => (v.cases[1].extensions.reviewedSelectorOutcomes[0].note = "x"), /unsupported field note/);
    rejects((v) => (v.cases[0].extensions.trailContextNote = 7), /trailContextNote/);
    rejects((v) => (v.cases[3].extensions.provenance.extra = { url: "x" }), /provenance\.extra/);
  });

  it("rejects forbidden authority/ranking fields anywhere and unauthorized nested Lens fields via @nec/lens", () => {
    rejects((v) => (v.cases[0].extensions.caseVerdict = "supported"), /forbidden/);
    rejects((v) => (v.cases[3].lens.propositions[0].confidence = 0.9), /forbidden/);
    rejects((v) => (v.cases[2].extensions.ranking = [1]), /forbidden/);
    rejects((v) => (v.score = 1), /forbidden|unsupported/);
    expect(() => validateNeMapsCollectionV01(JSON.parse('{"__proto__":{}}'))).toThrow(NeMapsValidationError);

    // Maps' own render check is not the Lens authority: the public validator rejects nested leaks.
    const leak = clone();
    leak.cases[3].lens.propositions[0].rawSource = "unredacted";
    expect(() => validateNeMapsCollectionV01(structuredClone(leak))).not.toThrow();
    expect(() => validateNeMapsCollectionV01(leak, lensValidator)).toThrow(/@nec\/lens/);
  });

  it("tolerates unknown extension keys per contract without rendering them", async () => {
    const value = clone();
    value.cases[3].extensions.futurePresentationHint = "UNRENDERED-EXTENSION-MARKER";
    expect(() => validateNeMapsCollectionV01(value, lensValidator)).not.toThrow();
    const ui = await bootApp(value);
    for (const view of ["lens", "trail", "action"]) {
      expect(ui.navigate(`#/case/${SYNTHETIC_ID}/${view}`).textContent).not.toContain("UNRENDERED-EXTENSION-MARKER");
    }
  });
});

describe("F1/F2/F3 envelope migration preserves the reviewed semantics exactly", () => {
  const historicalSums = readFileSync(join(repo, "examples/historical-compat/data/SHA256SUMS"), "utf8");

  it.each(HISTORICAL_IDS)("%s nested Lens is byte/field-identical to the reviewed export and the LOT3 output", (id) => {
    const migrated = byId(collection, id);
    const reviewed = byId(legacy, id);
    const lot3Bytes = readFileSync(join(repo, `examples/historical-compat/data/${id}.lens-browser.json`), "utf8");
    expect(historicalSums).toContain(`${sha256(lot3Bytes)}  ${id}.lens-browser.json`);
    expect(migrated.lens).toStrictEqual(reviewed.lens);
    expect(JSON.stringify(migrated.lens)).toBe(JSON.stringify(reviewed.lens));
    expect(`${serializeLensBrowserSafeV01(migrated.lens)}\n`).toBe(lot3Bytes);
    expect(migrated.exactAction).toStrictEqual(reviewed.exactAction);
    expect(migrated.display).toStrictEqual(reviewed.display);
    expect(migrated.trailPropositionOrder).toStrictEqual(reviewed.trailPropositionOrder);
    expect(migrated.extensions.trailContextNote).toBe(reviewed.trailContextNote);
    expect(migrated.extensions.reviewedSelectorOutcomes).toStrictEqual(reviewed.reviewedSelectorOutcomes);
    expect(migrated.extensions.provenance.sourceAuthority).toContain(legacy.sourceAuthority.commit);
    expect(migrated.extensions.provenance.publicSuite).toContain(legacy.publicSuite.commit);
  });

  it("only moves legacy fields into versioned envelope/extensions and keeps every non-claim", () => {
    for (const reviewed of legacy.cases) {
      const migrated = byId(collection, reviewed.id);
      const { trailContextNote, reviewedSelectorOutcomes, ...rest } = reviewed;
      const { schemaVersion, extensions, ...envelope } = migrated;
      expect(schemaVersion).toBe("ne-maps-case/v0.1");
      expect(envelope).toStrictEqual(rest);
      expect(Object.keys(extensions).sort()).toEqual(
        ["provenance", ...(trailContextNote ? ["trailContextNote"] : []), ...(reviewedSelectorOutcomes ? ["reviewedSelectorOutcomes"] : [])].sort(),
      );
    }
    for (const claim of legacy.nonClaims) expect(collection.nonClaims).toContain(claim);
  });
});

describe("synthetic/local integrability case", () => {
  const synthetic = byId(collection, SYNTHETIC_ID);

  it("wraps the LOT2 Core -> Hub -> Lens fixture output unchanged and is labelled synthetic/local", () => {
    const fixtureBytes = readFileSync(join(repo, "examples/integrability-fixture/data/lens-browser.json"), "utf8");
    expect(`${serializeLensBrowserSafeV01(synthetic.lens)}\n`).toBe(fixtureBytes);
    expect(JSON.stringify(synthetic.lens)).toBe(fixtureBytes.trimEnd());
    expect(synthetic.extensions.provenance.fixtureSha256).toBe(sha256(fixtureBytes));
    expect(synthetic.display.networkLabel).toMatch(/^Synthetic \/ local fixture — not a network observation$/);
    expect(synthetic.display.title).toMatch(/Synthetic/);
    expect(synthetic.display.shape).toMatch(/Synthetic\/local/);
    expect(synthetic.exactAction.realityClass).toMatch(/synthetic\/local.*not observed on any network/);
    expect(synthetic.exactAction.id).toBe(synthetic.lens.coreResultPreservation.subject.txId);
    expect(synthetic.exactAction.networkId).toBe(synthetic.lens.coreResultPreservation.subject.networkId);
    expect(collection.nonClaims.some((claim: string) => /Synthetic\/local cases .* not network observations/.test(claim))).toBe(true);
  });

  it("renders Lens, Trail and Exact action through the generic app path", async () => {
    const ui = await bootApp(collection);
    expect(ui.fetched).toEqual(["./data/collection.json", "./data/my-collection.json"]);
    expect(ui.counter.textContent).toBe("0 application cases · 5 examples");
    expect(ui.app.find((el) => el.className === "case-card")).toHaveLength(0);
    expect(ui.app.texts()).toContain("No application cases loaded");
    ui.navigate("#/examples");
    const card = ui.app.find((el) => el.className === "case-card").find((el) => el.textContent.includes("Synthetic Core golden"))!;
    expect(card.texts()).toContain("Synthetic / local fixture — not a network observation");
    expect(card.find((el) => el.tagName === "a").map((el) => el.href)).toEqual([
      `#/case/${SYNTHETIC_ID}/lens`, `#/case/${SYNTHETIC_ID}/trail`, `#/case/${SYNTHETIC_ID}/action`,
    ]);

    const lens = ui.navigate(`#/case/${SYNTHETIC_ID}/lens`);
    expect(lens.texts()).toContain("Synthetic / local fixture — not a network observation · Lens");
    const propositionTitles = lens.find((el) => el.tagName === "h3").map((el) => el.textContent);
    expect(propositionTitles).toEqual(synthetic.lens.propositions.map((p: { statement: string }) => p.statement));
    expect(lens.find((el) => el.className === "badge supported")).toHaveLength(1);
    expect(lens.texts()).toEqual(expect.arrayContaining(["availability: unknown", "availability: not_applicable"]));

    const trail = ui.navigate(`#/case/${SYNTHETIC_ID}/trail`);
    const byStatement = new Map(synthetic.lens.propositions.map((p: { propositionId: string; statement: string }) => [p.propositionId, p.statement]));
    expect(trail.find((el) => el.tagName === "h3").map((el) => el.textContent)).toEqual(
      synthetic.trailPropositionOrder.map((id: string) => byStatement.get(id)),
    );

    const action = ui.navigate(`#/case/${SYNTHETIC_ID}/action`);
    const actionText = action.texts();
    expect(actionText).toEqual(expect.arrayContaining([synthetic.exactAction.id, synthetic.exactAction.realityClass, "Case provenance", "No relations exported in this projection."]));
  });

  it("renders historical selector outcomes and Trail context from extensions generically", async () => {
    const ui = await bootApp(collection);
    const f2 = ui.navigate("#/case/f2/lens");
    expect(f2.texts()).toContain("Reviewed selector outcomes");
    expect(f2.find((el) => el.className === "badge ambiguous")).toHaveLength(1);
    const f1 = ui.navigate("#/case/f1/trail");
    expect(f1.texts()).toContain(byId(collection, "f1").extensions.trailContextNote);
    expect(f1.find((el) => el.tagName === "h3")).toHaveLength(byId(collection, "f1").trailPropositionOrder.length);
  });
});

describe("no structural exactly-three assumption", () => {
  it.each([
    [[SYNTHETIC_ID]],
    [["f3", "f1"]],
    [[...HISTORICAL_IDS]],
    [[SYNTHETIC_ID, "f3", "f2", "f1"]],
  ])("renders one card per case for %j", async (ids) => {
    const ui = await bootApp(withCases(ids));
    const cards = ui.navigate("#/examples").find((el) => el.className === "case-card");
    expect(cards.map((card) => card.find((el) => el.tagName === "h2")[0]!.textContent)).toEqual(
      ids.map((id) => byId(collection, id).display.title),
    );
    expect(ui.app.find((el) => el.className === "error")).toHaveLength(0);
  });

  it("fails closed in the UI on an invalid collection, including the legacy top-level export", async () => {
    for (const bad of [legacy, { ...clone(), cases: [] }, { ...clone(), schemaVersion: "x" }]) {
      const ui = await bootApp(bad);
      expect(ui.app.find((el) => el.className === "case-card")).toHaveLength(0);
      expect(ui.app.find((el) => el.className === "error")[0]!.textContent).toMatch(/could not load the case collection: ne-maps:/);
    }
  });

  it("app.js has no case-count, case-id, chain, resolver/RPC or verdict-computation logic", () => {
    expect(appSource).not.toMatch(/length\s*[!=]==?\s*3\b|\b3\s*[!=]==?\s*[\w.?]*length|cases\??\.?\[\d/);
    expect(appSource).not.toMatch(/\bf[123]\b|synthetic/i);
    expect(appSource).not.toMatch(/eip155|solana|sepolia|base mainnet|x402|erc-?4337|syscoin|zksys/i);
    expect(appSource).not.toMatch(/@nec\/|resolver|\brpc\b|eth_|https?:\/\//i);
    expect(appSource).not.toMatch(/caseVerdict|confidence|trustScore|score|rank/i);
    expect(appSource).not.toMatch(/\.(value|verdict|assessments|availability)\s*=[^=]/);
    expect(appSource.match(/fetch\(/g)).toHaveLength(2);
    expect(appSource).toContain("fetch(COLLECTION_URL");
    expect(appSource).toContain("fetch(MY_COLLECTION_URL");
    expect([...appSource.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1])).toEqual(["./collection.js", "./ui-navigation.js"]);
    expect(appSource).toContain("validateNeMapsCollectionV01(await response.json())");
    expect(indexHtml).toContain('<script type="module" src="./app.js"></script>');
    expect(indexHtml).not.toMatch(/3 reviewed cases/);
  });
});

describe("application-owned collection is isolated from examples", () => {
  it("shows every distinct per-proposition assessment value in atlas badges, without a global case verdict", async () => {
    // TEST-ONLY contradictory second assessment; this is not a network finding.
    const owned = withCases(["f2"]);
    const proposition = owned.cases[0].lens.propositions.find((p: any) => p.assessments?.length);
    expect(proposition).toBeDefined();
    const second = structuredClone(proposition.assessments[0]);
    second.assessmentId = "test-only-contradicted-second-assessment";
    second.value = "contradicted";
    second.limitations = ["TEST ONLY - conflicting display assessment, not a network observation"];
    proposition.assessments.push(second);

    const ui = await bootApp(collection, owned);
    expect(ui.counter.textContent).toBe("1 application case · 5 examples");
    const card = ui.app.find((el) => el.className === "case-card")[0]!;
    const statuses = card.find((el) => el.className === "status-row")[0]!;
    expect(statuses.find((el) => el.className.startsWith("badge ")).map((el) => el.textContent))
      .toEqual(["supported", "contradicted", "unavailable"]);
    const lens = ui.navigate("#/mine/f2/lens");
    expect(lens.texts()).toContain("Assessment 1: supported");
    expect(lens.texts()).toContain("Assessment 2: contradicted");
    const trail = ui.navigate("#/mine/f2/trail");
    expect(trail.texts()).toContain("Assessment 1: supported");
    expect(trail.texts()).toContain("Assessment 2: contradicted");
    expect(trail.textContent).toContain("TEST ONLY - conflicting display assessment");
  });

  it("restores keyboard focus to the main region after replacing a hash route", async () => {
    const ui = await bootApp(collection);
    expect(ui.app.focused).toBe(false);
    ui.navigate("#/examples");
    expect(ui.app.focused).toBe(true);
    expect(ui.app.tabIndex).toBe(-1);
    expect(ui.app.textContent).toContain("Synthetic Core golden");
    ui.navigate("#/case/f1/lens");
    expect(ui.app.textContent).toContain("Declared evidence relations");
  });

  it("defaults to no fixtures and renders user-supplied cases without cross-scope id collision", async () => {
    const owned = withCases(["f2"]);
    owned.cases[0].display.title = "My application case";
    const ui = await bootApp(collection, owned);
    expect(ui.app.find((el) => el.className === "case-card").map((el) => el.textContent)).toEqual([
      expect.stringContaining("My application case"),
    ]);
    const exampleAtlas = ui.navigate("#/examples");
    expect(exampleAtlas.find((el) => el.className === "case-card")).toHaveLength(5);
    const myDetail = ui.navigate("#/mine/f2/lens");
    expect(myDetail.textContent).toContain("My application case");
    const exampleDetail = ui.navigate("#/case/f2/lens");
    expect(exampleDetail.textContent).toContain("ERC-4337 — exact UserOperation");
    expect(exampleDetail.textContent).not.toContain("My application case");
  });

  it("rejects malformed application evidence without substituting reviewed examples", async () => {
    const ui = await bootApp(collection, { schemaVersion: "invalid", cases: [] });
    expect(ui.app.find((el) => el.className === "case-card")).toHaveLength(0);
    expect(ui.app.find((el) => el.className === "error")[0]!.textContent).toMatch(/Application case collection rejected: ne-maps:/);
    expect(ui.counter.textContent).toContain("Application collection rejected");
    expect(ui.navigate("#/examples").find((el) => el.className === "case-card")).toHaveLength(5);
  });

  it("shows the application cases even without the optional reviewed example collection", async () => {
    const own = withCases(["f2"]);
    own.cases[0].display.title = "App-only case";
    const ui = await bootApp(collection, own, 404);
    expect(ui.app.find((el) => el.className === "case-card")).toHaveLength(1);
    expect(ui.app.textContent).toContain("App-only case");
    expect(ui.navigate("#/examples").texts()).toContain("No reviewed examples packaged");
    expect(ui.navigate("#/mine/f2/action").textContent).toContain("App-only case");
  });

  it("does not mask errors other than missing reviewed examples", async () => {
    const ui = await bootApp(collection, withCases(["f2"]), 403);
    expect(ui.app.find((el) => el.className === "error")[0]!.textContent).toContain("reviewed example collection unavailable");
    expect(ui.app.find((el) => el.className === "case-card")).toHaveLength(0);
  });

  it("renders exactly declared Lens relations, existing Trail steps and omitted Lens-only context", async () => {
    const caseF1 = byId(collection, "f1");
    const ui = await bootApp(collection);
    const lens = ui.navigate("#/case/f1/lens");
    const edges = lens.find((el) => el.className === "relation-edge");
    expect(edges).toHaveLength(caseF1.lens.relations.length);
    for (const [index, relation] of caseF1.lens.relations.entries()) {
      const edge = edges[index]!;
      expect(edge.textContent).toContain(relation.fromRef);
      expect(edge.textContent).toContain(relation.toRef);
      expect(edge.textContent).toContain(relation.relationType);
    }
    const trail = ui.navigate("#/case/f1/trail");
    expect(trail.find((el) => el.className === "trail-step")).toHaveLength(caseF1.trailPropositionOrder.length);
    expect(trail.find((el) => el.className === "trail-number").map((el) => el.textContent))
      .toEqual(caseF1.trailPropositionOrder.map((_: unknown, index: number) => String(index + 1)));
    expect(trail.find((el) => el.className === "trail-omitted")).toHaveLength(1);
    expect(trail.textContent).toContain("not a Hub-provided Trail route");
    expect(trail.find((el) => el.className === "relation-edge")).toHaveLength(0);
  });

  it("presents every assessment in a test-only multi-assessment proposition without inventing a case verdict", async () => {
    const data = withCases(["f2"]);
    const proposition = data.cases[0].lens.propositions.find((p: any) => (p.assessments ?? []).length > 0)!;
    const second = structuredClone(proposition.assessments[0]);
    second.assessmentId = "test-only-second-assessment";
    second.basis = ["cryptographic_verification"];
    second.limitations = ["TEST-ONLY SECOND-ASSESSMENT-LIMIT"];
    proposition.assessments.push(second);
    const ui = await bootApp(data);
    const trail = ui.navigate("#/case/f2/trail");
    expect(trail.texts()).toContain("Assessment 1: supported");
    expect(trail.texts()).toContain("Assessment 2: supported");
    expect(trail.textContent).toContain("basis: cryptographic_verification");
    expect(trail.texts()).toContain("limit: TEST-ONLY SECOND-ASSESSMENT-LIMIT");
    expect(trail.find((el) => el.className === "trail-step")).toHaveLength(data.cases[0].trailPropositionOrder.length);
  });
});

describe("deterministic collection bytes", () => {
  it("rebuilds byte-identically from pinned inputs and matches COLLECTION.sha256", () => {
    const first = serializeNeMapsCollectionV01(buildNeMapsCollectionV01());
    const second = serializeNeMapsCollectionV01(buildNeMapsCollectionV01());
    expect(first).toBe(second);
    expect(first).toBe(collectionBytes);
    expect(readFileSync(join(root, "data/COLLECTION.sha256"), "utf8")).toBe(`${sha256(collectionBytes)}  collection.json\n`);
  });

  it("leaves the frozen reviewed legacy export and the LOT2/LOT3 fixtures pinned", () => {
    expect(sha256(readFileSync(join(root, "data/cases.json")))).toBe("eef096d0e774bef6ce2b9c111218b52be19d00613c75eb538ce8f936ccf580e1");
    const lot2 = readFileSync(join(repo, "examples/integrability-fixture/data/SHA256SUMS"), "utf8");
    expect(lot2).toContain("2daf7f598a5032ab786b698192ffd08c2142681ab7729f37936f7724185fc44f  lens-browser.json");
  });
});
