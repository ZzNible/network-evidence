import { validateNeMapsCollectionV01 } from "./collection.js";
import { parseCaseHash } from "./ui-navigation.js";

const app = document.querySelector("#app");
const COLLECTION_URL = "./data/collection.json";
const MY_COLLECTION_URL = "./data/my-collection.json";
const STATUS_ORDER = ["supported", "contradicted", "insufficient", "ambiguous", "unavailable"];
const STATUS_SET = new Set(STATUS_ORDER);

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function link(className, text, href) {
  const item = node("a", className, text);
  item.href = href;
  return item;
}

function short(value, head = 10, tail = 8) {
  if (!value || value.length <= head + tail + 3) return value ?? "—";
  return value.slice(0, head) + "…" + value.slice(-tail);
}

function propositionStatus(proposition) {
  const assessment = proposition.assessments?.[0];
  if (assessment && STATUS_SET.has(assessment.value)) return assessment.value;
  if (proposition.availability === "unavailable") return "unavailable";
  return null;
}

function caseStatuses(item) {
  // Atlas badges summarize the distinct exported assessment values, not a case verdict.
  // A single proposition can carry several independent assessments, including disagreement.
  const found = new Set();
  for (const proposition of item.lens.propositions ?? []) {
    const assessments = proposition.assessments ?? [];
    for (const assessment of assessments) {
      if (STATUS_SET.has(assessment.value)) found.add(assessment.value);
    }
    if (!assessments.length && proposition.availability === "unavailable") {
      found.add("unavailable");
    }
  }
  return STATUS_ORDER.filter(value => found.has(value));
}

function caseCount(data) {
  return data.cases.length + (data.cases.length === 1 ? " case" : " cases");
}

function badge(value) {
  return node("span", "badge " + value, value);
}

function actionBlock(item) {
  const box = node("div", "action-id");
  box.append(node("strong", "", "Exact action"));
  box.append(node("div", "mono", item.exactAction.networkId));
  box.append(node("div", "mono", short(item.exactAction.id, 14, 12)));
  return box;
}


function caseHref(item, scope, view) {
  const prefix = scope === "mine" ? `#/mine/${item.id}` : `#/case/${item.id}`;
  return prefix + "/" + view;
}

function card(item, scope) {
  const article = node("article", "case-card");
  article.append(node("div", "case-kicker", item.display.networkLabel));
  article.append(node("h2", "", item.display.title));
  article.append(node("p", "shape", item.display.shape));
  article.append(actionBlock(item));

  const statuses = node("div", "status-row");
  statuses.ariaLabel = "Distinct proposition assessment verdicts, not a global case verdict";
  for (const value of caseStatuses(item)) statuses.append(badge(value));
  article.append(statuses);

  const actions = node("div", "card-actions");
  actions.append(link("button", "Lens", caseHref(item, scope, "lens")));
  actions.append(link("button", "Trail", caseHref(item, scope, "trail")));
  actions.append(link("button", "Exact action", caseHref(item, scope, "action")));
  article.append(actions);
  return article;
}

function libraryTabs(context, scope) {
  const nav = node("nav", "library-tabs");
  nav.ariaLabel = "Case collections";
  const labels = [
    ["mine", "My cases", context.mineError ? "rejected" : (context.mine?.cases.length ?? 0)],
    ["examples", "Examples", context.examples.cases.length],
  ];
  for (const [id, title, count] of labels) {
    const tab = link("library-tab" + (scope === id ? " active" : ""), title + " · " + count, "#/" + id);
    if (scope === id) tab.ariaCurrent = "page";
    nav.append(tab);
  }
  return nav;
}

function renderAtlas(context, scope) {
  const wrap = node("section");
  wrap.append(libraryTabs(context, scope));
  const items = scope === "mine" ? (context.mine?.cases ?? []) : context.examples.cases;
  const message = scope === "mine"
    ? "Your application cases are loaded from a separate, optional browser-safe collection. Built-in example fixtures do not appear here."
    : "Reviewed historical and illustrative cases for offline exploration. These are not live observations or your application cases.";
  wrap.append(node("p", "collection-intro", message));
  if (scope === "mine" && context.mineError) {
    wrap.append(node("p", "error", "Application case collection rejected: " + context.mineError));
    return wrap;
  }
  if (!items.length) {
    const empty = node("section", "empty-collection");
    if (scope === "mine") {
      empty.append(node("h2", "", "No application cases loaded"));
      empty.append(node("p", "", "To display your own evidence, supply a validated ne-maps-case-collection/v0.1 at data/my-collection.json. Examples remain available in their own tab."));
      empty.append(link("back", "Explore reviewed examples", "#/examples"));
    } else {
      empty.append(node("h2", "", "No reviewed examples packaged"));
      empty.append(node("p", "", "This standalone application does not include the optional example collection. No example claims are inferred."));
      empty.append(link("back", "Back to my cases", "#/mine"));
    }
    wrap.append(empty);
    return wrap;
  }
  const activeCollection = scope === "mine" ? context.mine : context.examples;
  wrap.append(node("p", "collection-meta", caseCount({ cases: items }) + " · " + activeCollection.schemaVersion));
  const grid = node("div", "atlas-grid");
  for (const item of items) grid.append(card(item, scope));
  wrap.append(grid);
  return wrap;
}

function keyValueList(values) {
  const list = node("dl", "keyvals");
  for (const [key, value] of values) {
    const row = node("div", "keyval");
    row.append(node("dt", "", key));
    row.append(node("dd", "mono", String(value ?? "—")));
    list.append(row);
  }
  return list;
}

function assessmentMeta(assessment) {
  const bits = [];
  if (assessment?.evaluator?.type) bits.push("evaluator: " + assessment.evaluator.type);
  if (assessment?.basis?.length) bits.push("basis: " + assessment.basis.join(" + "));
  return bits.join(" · ");
}

function propositionEvidence(proposition) {
  const content = node("div", "proposition-evidence");
  const assessments = proposition.assessments ?? [];
  if (assessments.length) {
    for (const [index, assessment] of assessments.entries()) {
      if (assessments.length > 1) {
        content.append(node("p", "assessment-index mono", "Assessment " + (index + 1) + ": " + assessment.value));
      }
      const meta = assessmentMeta(assessment);
      if (meta) content.append(node("p", "assessment-meta mono", meta));
    }
  } else if (proposition.availability) {
    content.append(node("p", "", "availability: " + proposition.availability));
  } else {
    content.append(node("p", "", "No independent assessment in this projection."));
  }
  const limitations = [...new Set([
    ...(proposition.limitations ?? []),
    ...assessments.flatMap(assessment => assessment.limitations ?? []),
  ])];
  for (const limitation of limitations) content.append(node("p", "", "limit: " + limitation));
  return content;
}

function propositionItem(proposition) {
  const box = node("article", "item");
  const top = node("div", "item-top");
  const title = node("div");
  title.append(node("div", "case-kicker", proposition.domain ?? "proposition"));
  title.append(node("h3", "", proposition.statement ?? proposition.propositionId));
  top.append(title);
  const status = (proposition.assessments?.length ?? 0) > 1 ? null : propositionStatus(proposition);
  if (status) top.append(badge(status));
  box.append(top, propositionEvidence(proposition));
  return box;
}

function selectorPanel(item) {
  const outcomes = item.extensions?.reviewedSelectorOutcomes ?? [];
  if (!outcomes.length) return null;
  const box = node("section", "item");
  box.append(node("p", "meta-title", "Reviewed selector outcomes"));
  const stack = node("div", "stack");
  for (const outcome of outcomes) {
    const row = node("div", "item-top");
    row.append(node("span", "", outcome.label));
    row.append(badge(outcome.verdict));
    stack.append(row);
  }
  box.append(stack);
  box.append(node("p", "", "These are frozen reviewed Hub selector outcomes. Maps does not recompute them."));
  return box;
}


function detailShell(item, mode, scope) {
  const section = node("section", "detail-panel");
  const head = node("div", "detail-head");
  const title = node("div");
  title.append(node("div", "case-kicker", item.display.networkLabel + " · " + mode));
  title.append(node("h2", "detail-title", item.display.title));
  title.append(node("p", "shape", item.display.shape));
  head.append(title, link("back", "← Back to " + (scope === "mine" ? "my cases" : "examples"), scope === "mine" ? "#/mine" : "#/examples"));
  section.append(head);
  const nav = node("div", "card-actions detail-nav");
  nav.append(link("button", "Lens", caseHref(item, scope, "lens")));
  nav.append(link("button", "Trail", caseHref(item, scope, "trail")));
  nav.append(link("button", "Exact action", caseHref(item, scope, "action")));
  section.append(nav);
  return section;
}

function renderRelationDiagram(item) {
  const panel = node("section", "relation-panel");
  panel.append(node("h2", "relation-heading", "Declared evidence relations"));
  panel.append(node("p", "relation-disclaimer", "These links reproduce case relations. Direction is source → target, not a claim of chronology, causation, settlement or finality."));
  const graph = node("div", "relation-graph");
  const relations = item.lens.relations ?? [];
  if (!relations.length) graph.append(node("p", "relation-empty", "No relations exported in this case. Absence is not evidence of a link."));
  for (const relation of relations) {
    const edge = node("article", "relation-edge");
    const from = node("div", "relation-ref mono", relation.fromRef);
    from.title = relation.fromRef;
    const middle = node("div", "relation-type");
    middle.append(node("span", "relation-arrow", "→"));
    middle.append(node("span", "relation-name mono", relation.relationType));
    middle.append(node("span", "relation-basis mono", "basis: " + (relation.basis ?? "not supplied")));
    const to = node("div", "relation-ref mono", relation.toRef);
    to.title = relation.toRef;
    edge.append(from, middle, to);
    if (relation.limitations?.length) {
      const limits = node("details", "relation-limits");
      limits.append(node("summary", "", "Relation limitations"));
      for (const value of relation.limitations) limits.append(node("p", "", value));
      edge.append(limits);
    }
    graph.append(edge);
  }
  panel.append(graph);
  return panel;
}

function renderLens(item, scope) {
  const section = detailShell(item, "Lens", scope);
  section.append(node("p", "view-intro", "Evidence relationships and individual proposition assessments. Lens does not calculate an overall verdict."));
  section.append(renderRelationDiagram(item));

  const grid = node("div", "detail-grid");
  const left = node("div", "stack");
  left.append(node("h2", "section-label", "Propositions and evidence bases"));
  for (const proposition of item.lens.propositions ?? []) left.append(propositionItem(proposition));

  const right = node("aside", "stack");
  const exact = node("section", "item");
  exact.append(node("p", "meta-title", "Exact action handoff"));
  exact.append(keyValueList(Object.entries(item.exactAction)));
  right.append(exact);
  const selectors = selectorPanel(item);
  if (selectors) right.append(selectors);
  const limits = node("section", "item");
  limits.append(node("p", "meta-title", "Case limitations"));
  for (const value of item.lens.limitations ?? []) limits.append(node("p", "", value));
  right.append(limits);
  grid.append(left, right);
  section.append(grid);
  return section;
}

function renderTrail(item, scope) {
  const section = detailShell(item, "Trail", scope);
  section.append(node("p", "view-intro", "A guided reading order of existing propositions, not a verified chronological sequence or causal route. This is not a Hub-provided Trail route and creates neither a causal edge nor a stronger verdict."));
  if (item.extensions?.trailContextNote) section.append(node("div", "notice", item.extensions.trailContextNote));

  const byId = new Map((item.lens.propositions ?? []).map(p => [p.propositionId, p]));
  const ordered = node("ol", "trail-steps");
  const renderedIds = new Set();
  let stepNumber = 0;
  for (const id of item.trailPropositionOrder) {
    const proposition = byId.get(id);
    if (!proposition || renderedIds.has(id)) continue;
    renderedIds.add(id);
    stepNumber += 1;
    const step = node("li", "trail-step");
    step.append(node("div", "trail-number", String(stepNumber)));
    const body = node("div", "trail-body");
    const heading = node("div", "trail-heading");
    const title = node("div");
    title.append(node("div", "case-kicker", proposition.domain ?? "proposition"));
    title.append(node("h3", "", proposition.statement ?? proposition.propositionId));
    heading.append(title);
    const status = (proposition.assessments?.length ?? 0) > 1 ? null : propositionStatus(proposition);
    if (status) heading.append(badge(status));
    body.append(heading, propositionEvidence(proposition));
    step.append(body);
    ordered.append(step);
  }
  section.append(ordered);
  const omitted = [...byId.keys()].filter(id => !renderedIds.has(id)).length;
  if (omitted > 0) section.append(node("p", "trail-omitted", omitted + " additional Lens-only proposition(s) are intentionally outside this Trail."));
  return section;
}

function renderAction(item, scope) {
  const section = detailShell(item, "Exact action", scope);
  const grid = node("div", "detail-grid");
  const left = node("section", "item");
  left.append(node("p", "meta-title", "Source-backed identity"));
  left.append(keyValueList(Object.entries(item.exactAction)));
  if (item.extensions?.provenance) {
    left.append(node("p", "meta-title", "Case provenance"));
    left.append(keyValueList(Object.entries(item.extensions.provenance)));
  }

  const right = node("section", "item");
  right.append(node("p", "meta-title", "Case relations"));
  if (!(item.lens.relations ?? []).length) {
    right.append(node("p", "", "No relations exported in this projection."));
  }
  for (const relation of item.lens.relations ?? []) {
    const row = node("article", "item");
    row.append(node("h3", "", relation.relationType));
    row.append(node("p", "mono", relation.fromRef + " → " + relation.toRef));
    row.append(node("p", "", "basis: " + (relation.basis ?? "not supplied")));
    for (const limitation of relation.limitations ?? []) row.append(node("p", "", "limit: " + limitation));
    right.append(row);
  }
  grid.append(left, right);
  section.append(grid);
  return section;
}


function route(context) {
  const state = parseCaseHash(location.hash);
  if (state.kind === "atlas") return renderAtlas(context, state.scope);
  if (state.kind !== "detail") return renderAtlas(context, "mine");
  const source = state.scope === "mine" ? context.mine : context.examples;
  const item = source?.cases.find(candidate => candidate.id === state.caseId);
  if (!item) return renderAtlas(context, state.scope);
  if (state.view === "trail") return renderTrail(item, state.scope);
  if (state.view === "action") return renderAction(item, state.scope);
  return renderLens(item, state.scope);
}

async function boot() {
  try {
    const response = await fetch(COLLECTION_URL, { cache: "no-store" });
    let examples = { schemaVersion: "ne-maps-case-collection/v0.1", cases: [] };
    if (response.status !== 404) {
      if (!response.ok) throw new Error("reviewed example collection unavailable");
      examples = validateNeMapsCollectionV01(await response.json());
    }
    let mine = null;
    let mineError = null;
    try {
      const own = await fetch(MY_COLLECTION_URL, { cache: "no-store" });
      if (own.status !== 404) {
        if (!own.ok) throw new Error("HTTP " + own.status);
        mine = validateNeMapsCollectionV01(await own.json());
      }
    } catch (error) {
      mineError = error.message;
    }

    const counter = document.querySelector("#case-count");
    const ownCount = mine?.cases.length ?? 0;
    const exampleCount = examples.cases.length;
    if (counter) counter.textContent = (mineError ? "Application collection rejected" : ownCount + (ownCount === 1 ? " application case" : " application cases")) + " · " + exampleCount + (exampleCount === 1 ? " example" : " examples");
    const context = { examples, mine, mineError };
    const render = () => app.replaceChildren(route(context));
    window.addEventListener("hashchange", () => {
      render();
      // Route replacement detaches the activated link. Keep keyboard/screen-reader
      // navigation within the new view, without adding a permanent Tab stop.
      app.tabIndex = -1;
      if (typeof app.focus === "function") app.focus();
    });
    render();
  } catch (error) {
    app.replaceChildren(node("p", "error", "NE Maps could not load the case collection: " + error.message));
  }
}

boot();
