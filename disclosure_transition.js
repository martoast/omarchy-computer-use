// A disclosure press is verified only by evidence that the disclosed content
// became available. Merely focusing the button is not a meaningful result.
export function diffDisclosureSignals(pre, post) {
  const changes = [];
  const before = new Set(pre?.linkKeys || []);
  const added = [...new Set(post?.linkKeys || [])].filter((key) => !before.has(key));
  if (added.length) changes.push(`new links: ${added.slice(0, 8).join(", ")}`);

  const stateNames = (states) => Array.isArray(states)
    ? states
    : states && typeof states === "object"
      ? Object.entries(states).filter(([, on]) => on === true).map(([name]) => name)
      : [];
  const a = new Set(stateNames(pre?.targetStates));
  const b = new Set(stateNames(post?.targetStates));
  if (!a.has("expanded") && b.has("expanded")) changes.push("target became expanded");
  return changes;
}
