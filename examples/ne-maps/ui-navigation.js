// Pure route parser. A legacy /case route always means the reviewed examples.
const VALID_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VIEWS = new Set(["lens", "trail", "action"]);

export function parseCaseHash(hash) {
  const text = typeof hash === "string" ? hash : "";
  const parts = text.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (!parts.length) return { kind: "atlas", scope: "mine" };
  if (parts.length === 1 && ["mine", "examples"].includes(parts[0])) {
    return { kind: "atlas", scope: parts[0] };
  }
  const [root, id, view] = parts;
  if (parts.length === 3 && ["mine", "examples", "case"].includes(root)
      && VALID_ID.test(id) && VIEWS.has(view)) {
    return { kind: "detail", scope: root === "mine" ? "mine" : "examples", caseId: id, view };
  }
  return { kind: "atlas", scope: "mine" };
}
