// Durable site maps are committed navigation knowledge, not a place for
// shopper-specific values observed in live controls — nor for other shoppers'
// names: a review widget's controls carry the reviewer's name ("Yes: 0 people
// found this review by <name> helpful.", "Report review from <name>").
/** A CONTROL'S NAME that belongs to a review (a reviewer's name inside it, or the review widget itself) — for stores that keep names
 * without page rows, like site memory (site memory nav keys: "button::Yes: 0 people found this review by <name> helpful."). */
export const REVIEW_CONTROL_NAME_RE = /people (?:found|did not find) this review|review from |view more review text|verified (?:buyer|purchaser|purchase)|report review|was this review helpful|^helpful\??$|write a review|reviewer'?s? profile|\bby [^.]{1,40} helpful\b|report abuse of (?:question|answer)|(?:up|down)vote (?:question|answer)|^helpful answer\??$|^answer this question$|^submit answer$|^ask a question$|^(?:customer )?questions? (?:&|and) answers?$|^(?:asked|answered) by\b|^see .{1,40} profile\b/i;
const POSTAL_CODE = /\b\d{5}(?:-\d{4})?\b/;
const STREET_ADDRESS = /\b\d{1,6}\s+[A-Za-z0-9.' -]{1,60}\s(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|highway|hwy)\b/i;

export function isPrivateLocatorName(name) {
  const value = String(name || "");
  return POSTAL_CODE.test(value) || STREET_ADDRESS.test(value);
}

export function isReviewControlName(name) {
  return REVIEW_CONTROL_NAME_RE.test(String(name || ""));
}

/** Not to be remembered: a private locator or a review control. */
export const isUnrememberableName = (name) => isPrivateLocatorName(name) || isReviewControlName(name);

export function scrubPrivateLocators(map) {
  if (!map || typeof map !== "object") return map;
  for (const bucketName of ["nav", "fields"]) {
    const bucket = map[bucketName];
    if (!bucket || typeof bucket !== "object") continue;
    for (const [key, entry] of Object.entries(bucket)) {
      if (isUnrememberableName(entry?.name ?? key)) delete bucket[key];
    }
  }
  return map;
}
