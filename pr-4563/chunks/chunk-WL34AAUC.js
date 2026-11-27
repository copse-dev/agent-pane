import {
  __esm
} from "./chunk-WW3EXSJD.js";

// packages/std/src/nullish.ts
function isDefined(value) {
  return value !== void 0;
}
function isNonNull(value) {
  return value !== null;
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
var init_nullish = __esm({
  "packages/std/src/nullish.ts"() {
  }
});

export {
  isDefined,
  isNonNull,
  isNonEmptyString,
  isNonBlankString,
  init_nullish
};
