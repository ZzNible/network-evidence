const app = document.querySelector("#app");
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
  const found = new Set();
  for (const proposition of item.lens.propositions ?? []) {
    const value = propositionStatus(proposition);
    if (value) found.add(value);
  }
  return STATUS_ORDER.filter(value => found.has(value));
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

function card(item) {
  const article = node("article", "case-card");
  article.append(node("div", "case-kicker", item.display.networkLabel));
  article.append(node("h2", "", item.display.title));
  article.append(node("p", "shape", item.display.shape));
  article.append(actionBlock(item));

  const statuses = node("div", "status-row");
  for (const value of caseStatuses(item)) statuses.append(badge(value));
  article.append(statuses);

  const actions = node("div", "card-actions");
  actions.append(link("button", "Lens", `#/case/${item.id}/lens`));
  actions.append(link("button", "Trail", `#/case/${item.id}/trail`));
  actions.append(link("button", "Exact action", `#/case/${item.id}/action`));
  article.append(actions);
  return article;
}

function renderAtlas(data) {
  const wrap = node("section");
  const intro = node("div", "notice", "Three stable v1 cases, rendered from browser-safe Lens projections. Maps changes presentation only; evidence authority remains with the pinned source outputs.");
  wrap.append(intro);
  const grid = node("div", "atlas-grid");
  grid.style.marginTop = "16px";
  for (const item of data.cases) grid.append(card(item));
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

function propositionItem(proposition) {
  const box = node("article", "item");
  const top = node("div", "item-top");
  const title = node("div");
  title.append(node("div", "case-kicker", proposition.domain ?? "proposition"));
  title.append(node("h3", "", proposition.statement ?? proposition.propositionId));
  top.append(title);
  const status = propositionStatus(proposition);
  if (status) top.append(badge(status));
  box.append(top);

  const assessment = proposition.assessments?.[0];
  if (assessment) {
    const meta = assessmentMeta(assessment);
    if (meta) box.append(node("p", "", meta));
  } else if (proposition.availability) {
    box.append(node("p", "", "availability: " + proposition.availability));
  } else {
    box.append(node("p", "", "No independent assessment in this projection."));
  }
  const limitations = [...new Set([...(proposition.limitations ?? []), ...(assessment?.limitations ?? [])])];
  for (const limitation of limitations) box.append(node("p", "", "limit: " + limitation));
  return box;
}

function selectorPanel(item) {
  if (!item.reviewedSelectorOutcomes?.length) return null;
  const box = node("section", "item");
  box.append(node("p", "meta-title", "Reviewed selector outcomes"));
  const stack = node("div", "stack");
  for (const outcome of item.reviewedSelectorOutcomes) {
    const row = node("div", "item-top");
    row.append(node("span", "", outcome.label));
    row.append(badge(outcome.verdict));
    stack.append(row);
  }
  box.append(stack);
  box.append(node("p", "", "These are frozen reviewed Hub selector outcomes. Maps does not recompute them."));
  return box;
}

function detailShell(item, mode) {
  const section = node("section", "detail-panel");
  const head = node("div", "detail-head");
  const title = node("div");
  title.append(node("div", "case-kicker", item.display.networkLabel + " · " + mode));
  title.append(node("h2", "detail-title", item.display.title));
  title.append(node("p", "shape", item.display.shape));
  head.append(title, link("back", "← Back to atlas", "#/"));
  section.append(head);

  const nav = node("div", "card-actions");
  nav.style.marginTop = "16px";
  nav.append(link("button", "Lens", `#/case/${item.id}/lens`));
  nav.append(link("button", "Trail", `#/case/${item.id}/trail`));
  nav.append(link("button", "Exact action", `#/case/${item.id}/action`));
  section.append(nav);
  return section;
}

function renderLens(item) {
  const section = detailShell(item, "Lens");
  const grid = node("div", "detail-grid");
  const left = node("div", "stack");
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

function renderTrail(item) {
  const section = detailShell(item, "Trail");
  section.append(node("div", "notice", "Trail ordering is Maps-authored navigation metadata over existing case propositions. It is not a Hub-provided Trail route and does not create a causal edge or stronger verdict."));
  if (item.trailContextNote) section.append(node("div", "notice", item.trailContextNote));
  const stack = node("div", "stack");
  stack.style.marginTop = "16px";
  const byId = new Map((item.lens.propositions ?? []).map(p => [p.propositionId, p]));
  for (const id of item.trailPropositionOrder) {
    const proposition = byId.get(id);
    if (proposition) stack.append(propositionItem(proposition));
  }
  section.append(stack);
  return section;
}

function renderAction(item) {
  const section = detailShell(item, "Exact action");
  const grid = node("div", "detail-grid");
  const left = node("section", "item");
  left.append(node("p", "meta-title", "Source-backed identity"));
  left.append(keyValueList(Object.entries(item.exactAction)));

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

function route(data) {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (!parts.length) return renderAtlas(data);
  if (parts[0] !== "case" || parts.length < 3) return renderAtlas(data);
  const item = data.cases.find(candidate => candidate.id === parts[1]);
  if (!item) return renderAtlas(data);
  if (parts[2] === "trail") return renderTrail(item);
  if (parts[2] === "action") return renderAction(item);
  return renderLens(item);
}

async function boot() {
  try {
    const response = await fetch("./data/cases.json", { cache: "no-store" });
    if (!response.ok) throw new Error("case data unavailable");
    const data = await response.json();
    if (data.TARGET_CORE_MUTATIONS !== 0 || data.cases?.length !== 3) throw new Error("unexpected case export");
    const render = () => app.replaceChildren(route(data));
    window.addEventListener("hashchange", render);
    render();
  } catch (error) {
    app.replaceChildren(node("p", "error", "NE Maps could not load the reviewed case export: " + error.message));
  }
}

boot();
