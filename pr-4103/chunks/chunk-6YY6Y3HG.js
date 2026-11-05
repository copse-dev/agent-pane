import {
  el,
  init_helpers
} from "./chunk-EMIRHVRH.js";
import {
  __esm
} from "./chunk-WW3EXSJD.js";

// src/renderer/dom/outline-icon.ts
function outlineIcon(label, paths, className) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", ICON_SIZE);
  svg.setAttribute("height", ICON_SIZE);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("data-icon", label);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
var SVG_NS, ICON_SIZE;
var init_outline_icon = __esm({
  "src/renderer/dom/outline-icon.ts"() {
    SVG_NS = "http://www.w3.org/2000/svg";
    ICON_SIZE = "16";
  }
});

// src/renderer/dom/icons.ts
function playIcon(className = DEFAULT) {
  return outlineIcon("play", ["m6 3 14 9-14 9V3Z"], className);
}
function chevronRightIcon(className = DEFAULT) {
  return outlineIcon("chevron-right", ["m9 18 6-6-6-6"], className);
}
function chevronDownIcon(className = DEFAULT) {
  return outlineIcon("chevron-down", ["m6 9 6 6 6-6"], className);
}
function clockIcon(className = DEFAULT) {
  return outlineIcon(
    "clock",
    ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z", "M12 6v6l4 2"],
    className
  );
}
function cornerDownLeftIcon(className = DEFAULT) {
  return outlineIcon("corner-down-left", ["m9 10-5 5 5 5", "M20 4v7a4 4 0 0 1-4 4H4"], className);
}
function chevronUpIcon(className = DEFAULT) {
  return outlineIcon("chevron-up", ["m18 15-6-6-6 6"], className);
}
function arrowLeftIcon(className = DEFAULT) {
  return outlineIcon("arrow-left", ["M19 12H5", "m12 19-7-7 7-7"], className);
}
function arrowRightIcon(className = DEFAULT) {
  return outlineIcon("arrow-right", ["M5 12h14", "m12 5 7 7-7 7"], className);
}
function refreshIcon(className = DEFAULT) {
  return outlineIcon(
    "refresh",
    [
      "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
      "M21 3v5h-5",
      "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
      "M8 16H3v5"
    ],
    className
  );
}
function externalLinkIcon(className = DEFAULT) {
  return outlineIcon(
    "external-link",
    ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
    className
  );
}
function closeIcon(className = DEFAULT) {
  return outlineIcon("close", ["M18 6 6 18", "m6 6 12 12"], className);
}
function plusIcon(className = DEFAULT) {
  return outlineIcon("plus", ["M5 12h14", "M12 5v14"], className);
}
function monitorIcon(className = DEFAULT) {
  return outlineIcon(
    "monitor",
    [
      "M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
      "M8 21h8",
      "M12 17v4"
    ],
    className
  );
}
function downloadIcon(className = DEFAULT) {
  return outlineIcon(
    "download",
    ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"],
    className
  );
}
function uploadIcon(className = DEFAULT) {
  return outlineIcon(
    "upload",
    ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m17 8-5-5-5 5", "M12 3v12"],
    className
  );
}
function maximizeIcon(className = DEFAULT) {
  return outlineIcon("maximize", ["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"], className);
}
function minimizeIcon(className = DEFAULT) {
  return outlineIcon("minimize", ["M4 14h6v6", "M20 10h-6V4", "M14 10l7-7", "M3 21l7-7"], className);
}
function moreHorizontalIcon(className = DEFAULT) {
  return outlineIcon("more-horizontal", ["M5 12h.01", "M12 12h.01", "M19 12h.01"], className);
}
function moreVerticalIcon(className = DEFAULT) {
  return outlineIcon("more-vertical", ["M12 5h.01", "M12 12h.01", "M12 19h.01"], className);
}
function runningStatusIcon(className = DEFAULT) {
  return outlineIcon("running-status", ["M5 12h.01", "M12 12h.01", "M19 12h.01"], className);
}
function checkIcon(className = DEFAULT) {
  return outlineIcon("check", ["M20 6 9 17l-5-5"], className);
}
function shieldIcon(className = DEFAULT) {
  return outlineIcon(
    "shield",
    [
      "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
    ],
    className
  );
}
function bellIcon(className = DEFAULT) {
  return outlineIcon(
    "bell",
    [
      "M10.27 21a2 2 0 0 0 3.46 0",
      "M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33"
    ],
    className
  );
}
function messageQuestionIcon(className = DEFAULT) {
  return outlineIcon(
    "message-circle-question",
    ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z", "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", "M12 17h.01"],
    className
  );
}
function banIcon(className = DEFAULT) {
  return outlineIcon(
    "ban",
    ["M4.93 4.93a10 10 0 1 0 14.14 14.14A10 10 0 0 0 4.93 4.93Z", "m4.93 4.93 14.14 14.14"],
    className
  );
}
function dotIcon(className = DEFAULT) {
  return outlineIcon("dot", ["M12 12h.01"], `${className} ui-icon-dot`);
}
function circleIcon(className = DEFAULT) {
  return outlineIcon("circle", ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"], className);
}
function spinnerIcon(className = DEFAULT) {
  return outlineIcon("loader-circle", ["M21 12a9 9 0 1 1-6.219-8.56"], className);
}
function minusIcon(className = DEFAULT) {
  return outlineIcon("minus", ["M5 12h14"], className);
}
function warningIcon(className = DEFAULT) {
  return outlineIcon(
    "triangle-alert",
    [
      "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z",
      "M12 9v4",
      "M12 17h.01"
    ],
    className
  );
}
function searchIcon(className = DEFAULT) {
  return outlineIcon(
    "search",
    ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "m21 21-4.35-4.35"],
    className
  );
}
function fileTextIcon(className = DEFAULT) {
  return outlineIcon(
    "file-text",
    [
      "M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z",
      "M14 2v6h6",
      "M8 13h8",
      "M8 17h8"
    ],
    className
  );
}
function imageIcon(className = DEFAULT) {
  return outlineIcon(
    "image",
    [
      "M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8.3",
      "m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21",
      "M14 19.5 16.5 17a2 2 0 0 1 2.8 0l1.7 1.7",
      "M9 9h.01"
    ],
    className
  );
}
function sparkleIcon(className = DEFAULT) {
  return outlineIcon(
    "sparkle",
    [
      "M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"
    ],
    className
  );
}
function zapIcon(className = DEFAULT) {
  return outlineIcon(
    "zap",
    [
      "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"
    ],
    className
  );
}
function gitBranchIcon(className = DEFAULT) {
  return outlineIcon(
    "git-branch",
    [
      "M6 3v12",
      "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
      "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
      "M15 6a9 9 0 0 0-9 9"
    ],
    className
  );
}
function gitPullRequestIcon(className = DEFAULT, conflicts = false) {
  return outlineIcon(
    "git-pull-request",
    [
      "M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
      conflicts ? "M3 3l6 6m0-6L3 9" : "M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
      "M13 6h3a2 2 0 0 1 2 2v7",
      "M6 9v12"
    ],
    className
  );
}
function gitMergeIcon(className = DEFAULT) {
  return outlineIcon(
    "git-merge",
    [
      "M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
      "M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
      "M6 21V9a9 9 0 0 0 9 9"
    ],
    className
  );
}
function penLineIcon(className = DEFAULT) {
  return outlineIcon(
    "pen-line",
    [
      "M12 20h9",
      "M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"
    ],
    className
  );
}
function slashIcon(className = DEFAULT) {
  return outlineIcon("slash", ["M20 4 4 20"], className);
}
function arrowUpRightIcon(className = DEFAULT) {
  return outlineIcon("arrow-up-right", ["M7 7h10v10", "M7 17 17 7"], className);
}
function squareIcon(className = DEFAULT) {
  return outlineIcon(
    "square",
    ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"],
    className
  );
}
function eraserIcon(className = DEFAULT) {
  return outlineIcon(
    "eraser",
    [
      "m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21",
      "M22 21H7",
      "m5 11 9 9"
    ],
    className
  );
}
function undoIcon(className = DEFAULT) {
  return outlineIcon(
    "undo",
    ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"],
    className
  );
}
function trashIcon(className = DEFAULT) {
  return outlineIcon(
    "trash",
    [
      "M3 6h18",
      "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
      "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
    ],
    className
  );
}
function historyIcon(className = DEFAULT) {
  return outlineIcon("history", ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5", "M12 7v5l3 2"], className);
}
var DEFAULT;
var init_icons = __esm({
  "src/renderer/dom/icons.ts"() {
    init_outline_icon();
    DEFAULT = "ui-icon";
  }
});

// src/renderer/ipc-error-message.ts
function unwrapIpcErrorText(text) {
  let message = text;
  for (; ; ) {
    const next = message.trimStart().replace(/^Error:\s*/, "").replace(/^Error invoking remote method '[^']*':\s*/, "");
    if (next === message) return message.trim();
    message = next;
  }
}
function ipcErrorMessage(err, fallback) {
  if (!(err instanceof Error)) return fallback;
  return unwrapIpcErrorText(err.message) || fallback;
}
function isUnavailableThreadCheckoutError(err) {
  return err instanceof Error && /^ThreadWorktree(?:OnBaseBranch|Detached)Error:/.test(unwrapIpcErrorText(err.message));
}
var init_ipc_error_message = __esm({
  "src/renderer/ipc-error-message.ts"() {
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/config.js
function activeConfig() {
  return active;
}
function setDefaultConfig(config) {
  if (scopeDepth > 0) {
    throw new Error("setDefaultConfig cannot be called during a render (inside a withConfig scope): the running render would be clobbered and the new defaults lost when its scope restores. Call it at setup time, or pass per-render config to the entry point.");
  }
  baseDefaults = { ...baseDefaults, ...config };
  active = baseDefaults;
}
function withConfig(config, fn) {
  const previous = active;
  active = { ...previous, ...config };
  scopeDepth++;
  try {
    return fn();
  } finally {
    scopeDepth--;
    active = previous;
  }
}
var baseDefaults, active, scopeDepth;
var init_config = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/config.js"() {
    baseDefaults = {};
    active = baseDefaults;
    scopeDepth = 0;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/entity-decoder.js
function replaceCodePoint(codePoint) {
  if (codePoint >= 55296 && codePoint <= 57343 || codePoint > 1114111)
    return 65533;
  return C1_REMAP.get(codePoint) ?? codePoint;
}
function decodeNumeric(token) {
  const isHex = token[2] === "x" || token[2] === "X";
  const digits = token.slice(isHex ? 3 : 2, -1);
  const codePoint = parseInt(digits, isHex ? 16 : 10);
  return String.fromCodePoint(replaceCodePoint(codePoint));
}
function decodeStrictWith(text, resolveNamed) {
  if (text.indexOf("&") === -1)
    return text;
  return text.replace(ENTITY_TOKEN_RE, (token) => {
    if (token[1] === "#")
      return decodeNumeric(token);
    return resolveNamed(token.slice(1, -1)) ?? token;
  });
}
function effectiveNamed() {
  const source = activeConfig().namedEntities;
  if (!source)
    return BUILTIN_NAMED_ENTITIES;
  if (source !== cachedNamedSource) {
    cachedNamedSource = source;
    cachedEffective = { ...BUILTIN_NAMED_ENTITIES, ...source };
  }
  return cachedEffective;
}
function builtinDecode(text) {
  const named = effectiveNamed();
  return decodeStrictWith(text, (name) => named[name]);
}
function decodeHtmlEntities(text) {
  return (activeConfig().entityDecoder ?? builtinDecode)(text);
}
var BUILTIN_NAMED_ENTITIES, C1_REMAP, ENTITY_TOKEN_RE, cachedNamedSource, cachedEffective;
var init_entity_decoder = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/entity-decoder.js"() {
    init_config();
    BUILTIN_NAMED_ENTITIES = Object.freeze({
      aacute: "\xE1",
      Aacute: "\xC1",
      acirc: "\xE2",
      Acirc: "\xC2",
      acute: "\xB4",
      aelig: "\xE6",
      AElig: "\xC6",
      agrave: "\xE0",
      Agrave: "\xC0",
      alefsym: "\u2135",
      alpha: "\u03B1",
      Alpha: "\u0391",
      amp: "&",
      and: "\u2227",
      ang: "\u2220",
      aring: "\xE5",
      Aring: "\xC5",
      asymp: "\u2248",
      atilde: "\xE3",
      Atilde: "\xC3",
      auml: "\xE4",
      Auml: "\xC4",
      bdquo: "\u201E",
      beta: "\u03B2",
      Beta: "\u0392",
      brvbar: "\xA6",
      bull: "\u2022",
      cap: "\u2229",
      ccedil: "\xE7",
      Ccedil: "\xC7",
      cedil: "\xB8",
      cent: "\xA2",
      chi: "\u03C7",
      Chi: "\u03A7",
      circ: "\u02C6",
      clubs: "\u2663",
      cong: "\u2245",
      copy: "\xA9",
      crarr: "\u21B5",
      cup: "\u222A",
      curren: "\xA4",
      dagger: "\u2020",
      Dagger: "\u2021",
      darr: "\u2193",
      dArr: "\u21D3",
      deg: "\xB0",
      delta: "\u03B4",
      Delta: "\u0394",
      diams: "\u2666",
      divide: "\xF7",
      eacute: "\xE9",
      Eacute: "\xC9",
      ecirc: "\xEA",
      Ecirc: "\xCA",
      egrave: "\xE8",
      Egrave: "\xC8",
      empty: "\u2205",
      emsp: "\u2003",
      ensp: "\u2002",
      epsilon: "\u03B5",
      Epsilon: "\u0395",
      equiv: "\u2261",
      eta: "\u03B7",
      Eta: "\u0397",
      eth: "\xF0",
      ETH: "\xD0",
      euml: "\xEB",
      Euml: "\xCB",
      euro: "\u20AC",
      exist: "\u2203",
      fnof: "\u0192",
      forall: "\u2200",
      frac12: "\xBD",
      frac14: "\xBC",
      frac34: "\xBE",
      frasl: "\u2044",
      gamma: "\u03B3",
      Gamma: "\u0393",
      ge: "\u2265",
      gt: ">",
      harr: "\u2194",
      hArr: "\u21D4",
      hearts: "\u2665",
      hellip: "\u2026",
      iacute: "\xED",
      Iacute: "\xCD",
      icirc: "\xEE",
      Icirc: "\xCE",
      iexcl: "\xA1",
      igrave: "\xEC",
      Igrave: "\xCC",
      image: "\u2111",
      infin: "\u221E",
      int: "\u222B",
      iota: "\u03B9",
      Iota: "\u0399",
      iquest: "\xBF",
      isin: "\u2208",
      iuml: "\xEF",
      Iuml: "\xCF",
      kappa: "\u03BA",
      Kappa: "\u039A",
      lambda: "\u03BB",
      Lambda: "\u039B",
      lang: "\u27E8",
      laquo: "\xAB",
      larr: "\u2190",
      lArr: "\u21D0",
      lceil: "\u2308",
      ldquo: "\u201C",
      le: "\u2264",
      lfloor: "\u230A",
      lowast: "\u2217",
      loz: "\u25CA",
      lrm: "\u200E",
      lsaquo: "\u2039",
      lsquo: "\u2018",
      lt: "<",
      macr: "\xAF",
      mdash: "\u2014",
      micro: "\xB5",
      middot: "\xB7",
      minus: "\u2212",
      mu: "\u03BC",
      Mu: "\u039C",
      nabla: "\u2207",
      nbsp: "\xA0",
      ndash: "\u2013",
      ne: "\u2260",
      ni: "\u220B",
      not: "\xAC",
      notin: "\u2209",
      nsub: "\u2284",
      ntilde: "\xF1",
      Ntilde: "\xD1",
      nu: "\u03BD",
      Nu: "\u039D",
      oacute: "\xF3",
      Oacute: "\xD3",
      ocirc: "\xF4",
      Ocirc: "\xD4",
      oelig: "\u0153",
      OElig: "\u0152",
      ograve: "\xF2",
      Ograve: "\xD2",
      oline: "\u203E",
      omega: "\u03C9",
      Omega: "\u03A9",
      omicron: "\u03BF",
      Omicron: "\u039F",
      oplus: "\u2295",
      or: "\u2228",
      ordf: "\xAA",
      ordm: "\xBA",
      oslash: "\xF8",
      Oslash: "\xD8",
      otilde: "\xF5",
      Otilde: "\xD5",
      otimes: "\u2297",
      ouml: "\xF6",
      Ouml: "\xD6",
      para: "\xB6",
      part: "\u2202",
      permil: "\u2030",
      perp: "\u22A5",
      phi: "\u03C6",
      Phi: "\u03A6",
      pi: "\u03C0",
      Pi: "\u03A0",
      piv: "\u03D6",
      plusmn: "\xB1",
      pound: "\xA3",
      prime: "\u2032",
      Prime: "\u2033",
      prod: "\u220F",
      prop: "\u221D",
      psi: "\u03C8",
      Psi: "\u03A8",
      quot: '"',
      radic: "\u221A",
      rang: "\u27E9",
      raquo: "\xBB",
      rarr: "\u2192",
      rArr: "\u21D2",
      rceil: "\u2309",
      rdquo: "\u201D",
      real: "\u211C",
      reg: "\xAE",
      rfloor: "\u230B",
      rho: "\u03C1",
      Rho: "\u03A1",
      rlm: "\u200F",
      rsaquo: "\u203A",
      rsquo: "\u2019",
      sbquo: "\u201A",
      scaron: "\u0161",
      Scaron: "\u0160",
      sdot: "\u22C5",
      sect: "\xA7",
      shy: "\xAD",
      sigma: "\u03C3",
      Sigma: "\u03A3",
      sigmaf: "\u03C2",
      sim: "\u223C",
      spades: "\u2660",
      sub: "\u2282",
      sube: "\u2286",
      sum: "\u2211",
      sup: "\u2283",
      sup1: "\xB9",
      sup2: "\xB2",
      sup3: "\xB3",
      supe: "\u2287",
      szlig: "\xDF",
      tau: "\u03C4",
      Tau: "\u03A4",
      there4: "\u2234",
      theta: "\u03B8",
      Theta: "\u0398",
      thetasym: "\u03D1",
      thinsp: "\u2009",
      thorn: "\xFE",
      THORN: "\xDE",
      tilde: "\u02DC",
      times: "\xD7",
      trade: "\u2122",
      uacute: "\xFA",
      Uacute: "\xDA",
      uarr: "\u2191",
      uArr: "\u21D1",
      ucirc: "\xFB",
      Ucirc: "\xDB",
      ugrave: "\xF9",
      Ugrave: "\xD9",
      uml: "\xA8",
      upsih: "\u03D2",
      upsilon: "\u03C5",
      Upsilon: "\u03A5",
      uuml: "\xFC",
      Uuml: "\xDC",
      weierp: "\u2118",
      xi: "\u03BE",
      Xi: "\u039E",
      yacute: "\xFD",
      Yacute: "\xDD",
      yen: "\xA5",
      yuml: "\xFF",
      Yuml: "\u0178",
      zeta: "\u03B6",
      Zeta: "\u0396",
      zwj: "\u200D",
      zwnj: "\u200C"
    });
    C1_REMAP = /* @__PURE__ */ new Map([
      [0, 65533],
      [128, 8364],
      [130, 8218],
      [131, 402],
      [132, 8222],
      [133, 8230],
      [134, 8224],
      [135, 8225],
      [136, 710],
      [137, 8240],
      [138, 352],
      [139, 8249],
      [140, 338],
      [142, 381],
      [145, 8216],
      [146, 8217],
      [147, 8220],
      [148, 8221],
      [149, 8226],
      [150, 8211],
      [151, 8212],
      [152, 732],
      [153, 8482],
      [154, 353],
      [155, 8250],
      [156, 339],
      [158, 382],
      [159, 376]
    ]);
    ENTITY_TOKEN_RE = /&(?:#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[a-zA-Z][a-zA-Z0-9]{0,31};)/g;
    cachedEffective = BUILTIN_NAMED_ENTITIES;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-code-spans.js
function nextCodeSpan(s, from) {
  let i = from;
  while (i < s.length && s[i] !== "`")
    i++;
  if (i >= s.length)
    return null;
  let j = i;
  while (j < s.length && s[j] === "`")
    j++;
  const runLen = j - i;
  let k = j;
  while (k < s.length) {
    if (s[k] !== "`") {
      k++;
      continue;
    }
    let m = k;
    while (m < s.length && s[m] === "`")
      m++;
    if (m - k === runLen) {
      return { type: "closed", open: i, contentStart: j, close: k, closeEnd: m, runLen };
    }
    k = m;
  }
  return { type: "unclosed", open: i, runLen };
}
function scanCodeSpans(s) {
  const mask = new Array(s.length).fill(false);
  let i = 0;
  while (i < s.length) {
    const span = nextCodeSpan(s, i);
    if (!span)
      break;
    if (span.type === "unclosed")
      return { mask, unresolvedAt: span.open };
    for (let p = span.open; p < span.closeEnd; p++)
      mask[p] = true;
    i = span.closeEnd;
  }
  return { mask, unresolvedAt: null };
}
function renderInlineCode(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "<") {
      const autolink = ANGLE_AUTOLINK_VERBATIM_RE.exec(text.slice(i))?.[0];
      if (autolink) {
        out += autolink;
        i += autolink.length;
        continue;
      }
    }
    if (text[i] !== "`") {
      out += text[i] ?? "";
      i++;
      continue;
    }
    const span = nextCodeSpan(text, i);
    if (!span) {
      out += text[i] ?? "";
      i++;
      continue;
    }
    if (span.type === "unclosed") {
      out += text.slice(span.open, span.open + span.runLen);
      i = span.open + span.runLen;
      continue;
    }
    let content = text.slice(span.contentStart, span.close).replace(/\n/g, " ");
    if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && /[^ ]/.test(content)) {
      content = content.slice(1, -1);
    }
    out += `<code>${content}</code>`;
    i = span.closeEnd;
  }
  return out;
}
var ANGLE_AUTOLINK_VERBATIM_RE;
var init_inline_code_spans = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-code-spans.js"() {
    ANGLE_AUTOLINK_VERBATIM_RE = /^<(?:[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[^<>\s@.]+(?:\.[^<>\s@.]+)+)>/;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/backslash-escapes.js
function isEscapablePunctuation(ch) {
  return /^[!-/:-@[-`{-~]$/.test(ch);
}
function encodeLiteralChar(ch) {
  return isEscapablePunctuation(ch) ? String.fromCharCode(ESCAPED_BASE + ch.charCodeAt(0)) : ch;
}
function trailingEntityHoldStart(s) {
  const window2 = Math.min(34, s.length);
  const m = INCOMPLETE_ENTITY_RE.exec(s.slice(s.length - window2));
  if (!m)
    return s.length;
  return s.length - window2 + m.index;
}
function encodeBackslashEscapes(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "`") {
      const span = nextCodeSpan(text, i);
      if (span && span.type === "closed" && span.open === i) {
        out += text.slice(i, span.closeEnd);
        i = span.closeEnd;
        continue;
      }
      const runEnd = span && span.type === "unclosed" && span.open === i ? i + span.runLen : i + 1;
      out += text.slice(i, runEnd);
      i = runEnd;
      continue;
    }
    if (ch === "<") {
      const verbatim = ANGLE_AUTOLINK_RE.exec(text.slice(i))?.[0] ?? RAW_TAG_LIKE_RE.exec(text.slice(i))?.[0];
      if (verbatim) {
        out += verbatim;
        i += verbatim.length;
        continue;
      }
    }
    if (ch === "&") {
      const candidate = ENTITY_CANDIDATE_RE.exec(text.slice(i))?.[0];
      if (candidate) {
        const decoded = decodeHtmlEntities(candidate);
        if (decoded !== candidate) {
          for (const c of decoded)
            out += encodeLiteralChar(c);
          i += candidate.length;
          continue;
        }
      }
    }
    const next = text[i + 1] ?? "";
    if (ch === "\\" && isEscapablePunctuation(next)) {
      out += String.fromCharCode(ESCAPED_BASE + next.charCodeAt(0));
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
function decodeEscapedPunctuation(html) {
  return html.replace(ENCODED_PUNCT_RE, (c) => {
    const ch = String.fromCharCode(c.charCodeAt(0) - ESCAPED_BASE);
    return DECODE_HTML_ESCAPES[ch] ?? ch;
  });
}
function decodeEscapedPunctuationRaw(text) {
  return text.replace(ENCODED_PUNCT_RE, (c) => String.fromCharCode(c.charCodeAt(0) - ESCAPED_BASE));
}
function canonicalizeEscapedPunctuation(text) {
  return encodeBackslashEscapes(text).replace(ENCODED_PUNCT_RE, (c) => `\\${String.fromCharCode(c.charCodeAt(0) - ESCAPED_BASE)}`);
}
var ESCAPED_BASE, ANGLE_AUTOLINK_RE, TAG_NAME, TAG_ATTR, RAW_TAG_LIKE_RE, ENTITY_CANDIDATE_RE, INCOMPLETE_ENTITY_RE, ENCODED_PUNCT_RE, DECODE_HTML_ESCAPES;
var init_backslash_escapes = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/backslash-escapes.js"() {
    init_entity_decoder();
    init_inline_code_spans();
    ESCAPED_BASE = 57344;
    ANGLE_AUTOLINK_RE = ANGLE_AUTOLINK_VERBATIM_RE;
    TAG_NAME = "[a-zA-Z][a-zA-Z0-9-]*";
    TAG_ATTR = `\\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s"'=<>\`]+|'[^']*'|"[^"]*"))?`;
    RAW_TAG_LIKE_RE = new RegExp(`^(?:<${TAG_NAME}(?:${TAG_ATTR})*\\s*/?>|</${TAG_NAME}\\s*>)`);
    ENTITY_CANDIDATE_RE = /^&(?:#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[a-zA-Z][a-zA-Z0-9]{0,31};)/;
    INCOMPLETE_ENTITY_RE = /&(?:#[0-9]{0,7}|#[xX][0-9a-fA-F]{0,6}|[a-zA-Z][a-zA-Z0-9]{0,31})?$/;
    ENCODED_PUNCT_RE = /[\uE021-\uE07E]/g;
    DECODE_HTML_ESCAPES = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/link-references.js
function isLinkReferencesEnabled() {
  return activeConfig().linkReferences !== false;
}
function normalizeReferenceLabel(label) {
  return label.replace(/\s+/g, " ").trim().toLowerCase().toUpperCase();
}
function hasUnescapedBrackets(raw) {
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[" || ch === "]")
      return true;
  }
  return false;
}
function isValidReferenceLabel(raw) {
  return raw.trim() !== "" && !hasUnescapedBrackets(raw);
}
function decodeEscapes(text) {
  return canonicalizeEscapedPunctuation(text);
}
function decodeDestinationEscapes(text) {
  return text.replace(/\\([!"#$%&'()*+,-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}
function decodeHtmlCharRefs(text) {
  return decodeHtmlEntities(text);
}
function percentEncodeHref(decoded) {
  let out = "";
  for (let i = 0; i < decoded.length; i++) {
    const ch = decoded.charAt(i);
    if (ch === "%" && /^%[0-9A-Fa-f]{2}/.test(decoded.slice(i, i + 3))) {
      out += decoded.slice(i, i + 3);
      i += 2;
      continue;
    }
    const cp = ch.codePointAt(0);
    if (cp === void 0)
      continue;
    if (cp < 128 && /[A-Za-z0-9\-._~:/?#@!$&'()*+,;=]/.test(ch)) {
      out += ch;
    } else {
      out += encodeURIComponent(ch);
    }
  }
  return out;
}
function encodeHrefForOutput(href) {
  return percentEncodeHref(decodeHtmlCharRefs(href));
}
function parseTitleToken(source, at) {
  const slice = source.slice(at);
  for (const re of TITLE_TOKEN_RES) {
    const m = re.exec(slice);
    if (m?.[1] !== void 0) {
      if (BLANK_LINE_RE.test(m[1]))
        return null;
      return {
        title: decodeHtmlCharRefs(decodeDestinationEscapes(m[1])),
        end: at + m[0].length
      };
    }
  }
  return null;
}
function skipTitleGap(source, from) {
  let i = from;
  let sawNewline = false;
  while (i < source.length) {
    const c = source[i];
    if (c === " " || c === "	")
      i++;
    else if (c === "\n" && !sawNewline) {
      sawNewline = true;
      i++;
    } else
      break;
  }
  return i === from ? null : i;
}
function parseBareDestination(source, start) {
  if (source[start] === "<") {
    let i2 = start + 1;
    while (i2 < source.length) {
      if (source[i2] === "\n")
        return null;
      if (source[i2] === "\\" && i2 + 1 < source.length) {
        i2 += 2;
        continue;
      }
      if (source[i2] === ">") {
        return { href: decodeDestinationEscapes(source.slice(start + 1, i2)), end: i2 + 1 };
      }
      i2++;
    }
    return null;
  }
  let i = start;
  let parenDepth = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\" && i + 1 < source.length) {
      i += 2;
      continue;
    }
    if (ch === "(")
      parenDepth++;
    else if (ch === ")") {
      if (parenDepth > 0)
        parenDepth--;
      else
        break;
    } else if (ch === " " || ch === "\n" || ch === "	") {
      if (parenDepth > 0)
        return null;
      break;
    }
    i++;
  }
  const raw = source.slice(start, i);
  if (raw === "")
    return null;
  return { href: decodeDestinationEscapes(raw), end: i };
}
function parseBracketedLabel(source, start) {
  if (source[start] !== "[")
    return null;
  let i = start + 1;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "\\" && i + 1 < source.length) {
      i += 2;
      continue;
    }
    if (ch === "[")
      depth++;
    else if (ch === "]")
      depth--;
    i++;
  }
  if (depth !== 0)
    return null;
  const label = source.slice(start + 1, i - 1);
  return { label, end: i };
}
function cleanLineEnd(source, from) {
  let i = from;
  while (i < source.length && (source[i] === " " || source[i] === "	"))
    i++;
  if (i >= source.length)
    return i;
  return source[i] === "\n" ? i + 1 : null;
}
function parseLinkReferenceDefinitionAt(source, start) {
  const labelPart = parseBracketedLabel(source, start);
  if (!labelPart || BLANK_LINE_RE.test(labelPart.label))
    return null;
  if (source[labelPart.end] !== ":")
    return null;
  let j = labelPart.end + 1;
  let sawNewline = false;
  while (j < source.length) {
    const c = source[j];
    if (c === " " || c === "	") {
      j++;
    } else if (c === "\n" && !sawNewline) {
      sawNewline = true;
      j++;
    } else {
      break;
    }
  }
  const dest = parseBareDestination(source, j);
  if (!dest)
    return null;
  const gap = skipTitleGap(source, dest.end);
  if (gap !== null) {
    const title = parseTitleToken(source, gap);
    if (title) {
      const end2 = cleanLineEnd(source, title.end);
      if (end2 !== null) {
        return { label: labelPart.label, href: dest.href, title: title.title, end: end2 };
      }
      if (!source.slice(dest.end, gap).includes("\n"))
        return null;
    }
  }
  const end = cleanLineEnd(source, dest.end);
  if (end === null)
    return null;
  return { label: labelPart.label, href: dest.href, end };
}
function parseLinkReferenceDefinitions(source) {
  const refs = /* @__PURE__ */ new Map();
  let lineStart = 0;
  while (lineStart < source.length) {
    let i = lineStart;
    let indent = 0;
    while (source[i] === " " && indent < 4) {
      i++;
      indent++;
    }
    if (indent <= 3 && source[i] === "[") {
      const def = parseLinkReferenceDefinitionAt(source, i);
      if (def && isValidReferenceLabel(def.label)) {
        const key = normalizeReferenceLabel(decodeEscapes(def.label));
        if (!refs.has(key)) {
          const entry = { href: def.href };
          if (def.title !== void 0)
            entry.title = def.title;
          refs.set(key, entry);
        }
        lineStart = def.end;
        continue;
      }
    }
    const nl = source.indexOf("\n", lineStart);
    if (nl === -1)
      break;
    lineStart = nl + 1;
  }
  return refs;
}
function lookupLinkReference(refs, label) {
  if (!isValidReferenceLabel(label))
    return void 0;
  return refs.get(normalizeReferenceLabel(decodeEscapes(label)));
}
function parseInlineLinkDestination(source, openParenIndex) {
  if (source[openParenIndex] !== "(")
    return null;
  let j = openParenIndex + 1;
  while (j < source.length && (source[j] === " " || source[j] === "	" || source[j] === "\n"))
    j++;
  if (source[j] === ")")
    return { href: "", end: j + 1 };
  const dest = parseBareDestination(source, j);
  if (!dest)
    return null;
  let end = dest.end;
  let title;
  const gap = skipTitleGap(source, dest.end);
  if (gap !== null) {
    const titlePart = parseTitleToken(source, gap);
    if (titlePart) {
      title = titlePart.title;
      end = titlePart.end;
    }
  }
  while (end < source.length && (source[end] === " " || source[end] === "	" || source[end] === "\n")) {
    end++;
  }
  if (source[end] !== ")")
    return null;
  return {
    href: dest.href,
    end: end + 1,
    ...title !== void 0 ? { title } : {}
  };
}
function parseReferenceLabel(source, openBracketIndex, fallbackLabel) {
  if (source[openBracketIndex] !== "[")
    return null;
  if (source[openBracketIndex + 1] === "]") {
    return { label: fallbackLabel, end: openBracketIndex + 2 };
  }
  const parsed = parseBracketedLabel(source, openBracketIndex);
  if (!parsed)
    return null;
  return { label: parsed.label, end: parsed.end };
}
var TITLE_TOKEN_RES, BLANK_LINE_RE;
var init_link_references = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/link-references.js"() {
    init_entity_decoder();
    init_backslash_escapes();
    init_config();
    TITLE_TOKEN_RES = [/^"((?:\\.|[^"\\])*)"/, /^'((?:\\.|[^'\\])*)'/, /^\(((?:\\.|[^()\\])*)\)/];
    BLANK_LINE_RE = /\n[ \t]*\n/;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/block-patterns.js
function leadingIndentWidth(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === " ")
      col++;
    else if (ch === "	")
      col += 4 - col % 4;
    else
      break;
  }
  return col;
}
function stripFourColumnIndent(line) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < 4) {
    const ch = line[i];
    if (ch === " ") {
      col++;
      i++;
      continue;
    }
    if (ch === "	") {
      const advance = 4 - col % 4;
      if (col + advance > 4)
        return " ".repeat(col + advance - 4) + line.slice(i + 1);
      col += advance;
      i++;
      continue;
    }
    break;
  }
  return line.slice(i);
}
function expandWhitespaceRun(text, i, col) {
  let out = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === " ") {
      out += " ";
      col++;
      i++;
    } else if (ch === "	") {
      const advance = 4 - col % 4;
      out += " ".repeat(advance);
      col += advance;
      i++;
    } else
      break;
  }
  return { out, i, col };
}
function expandLeadingTabs(line) {
  const lead = expandWhitespaceRun(line, 0, 0);
  return lead.out + line.slice(lead.i);
}
function expandListPrefixTabs(line) {
  const lead = expandWhitespaceRun(line, 0, 0);
  const marker = /^(?:\d{1,9}[.)]|[-*+])/.exec(line.slice(lead.i))?.[0];
  if (!marker)
    return lead.out + line.slice(lead.i);
  const after = expandWhitespaceRun(line, lead.i + marker.length, lead.col + marker.length);
  return lead.out + marker + after.out + line.slice(after.i);
}
function stripBlockquoteMarker(line) {
  const m = /^ {0,3}>/.exec(line);
  if (!m)
    return line;
  const rest = line.slice(m[0].length);
  if (!/^[\t ]/.test(rest))
    return rest;
  const expanded = expandWhitespaceRun(rest, 0, m[0].length);
  return expanded.out.slice(1) + rest.slice(expanded.i);
}
function dropTrailingNewline(slice) {
  return slice.endsWith("\n") ? slice.slice(0, -1) : slice;
}
function stripAtxClosingHashes(title) {
  if (/^#+\s*$/.test(title))
    return "";
  return title.replace(/(?<!\\)\s+#+\s*$/, "").trimEnd();
}
function fenceMarker(line) {
  const m = line.match(FENCE_OPEN_RE);
  const marker = m?.[1] ?? m?.[3];
  if (!marker)
    return null;
  return { marker, len: marker.length, info: ((m?.[1] ? m[2] : m?.[4]) ?? "").trim() };
}
function fenceOpenIndent(open) {
  return open.match(/^ {0,3}/)?.[0].length ?? 0;
}
function stripLeadingSpaces(line, max) {
  let i = 0;
  while (i < max && line[i] === " ")
    i++;
  return line.slice(i);
}
function fenceInfoLanguage(info) {
  const firstWord = info.trim().split(/\s+/)[0] ?? "";
  if (!firstWord)
    return "";
  return decodeHtmlEntities(firstWord.replace(FENCE_INFO_BACKSLASH_RE, "$1"));
}
function fenceCloses(marker, len, line) {
  const m = line.match(FENCE_CLOSE_RE);
  if (!m?.[1] || m[1][0] !== marker[0])
    return false;
  return m[1].length >= len;
}
function parseFenceSlice(slice) {
  const lines = dropTrailingNewline(slice).split("\n");
  const open = lines[0] ?? "";
  const openFence = fenceMarker(open);
  const marker = openFence?.marker ?? "```";
  const lang = fenceInfoLanguage(openFence?.info ?? "");
  const indent = fenceOpenIndent(open);
  let closeIndex = lines.length - 1;
  while (closeIndex > 0) {
    const line = lines[closeIndex] ?? "";
    if (fenceCloses(marker, marker.length, line)) {
      break;
    }
    closeIndex--;
  }
  const contentEnd = closeIndex > 0 ? closeIndex : lines.length;
  const contentLines = lines.slice(1, contentEnd);
  const code = contentLines.map((line) => stripLeadingSpaces(line, indent)).join("\n");
  return { lang, code: contentLines.length > 0 ? `${code}
` : code };
}
function parseOpenFenceContent(source) {
  const lines = source.split("\n");
  const open = lines[0] ?? "";
  const openFence = fenceMarker(open);
  if (!openFence)
    return null;
  const lang = fenceInfoLanguage(openFence.info);
  const indent = fenceOpenIndent(open);
  let bodyLines = lines.slice(1);
  const last = bodyLines.at(-1) ?? "";
  if (bodyLines.length > 0 && fenceCloses(openFence.marker, openFence.len, last)) {
    bodyLines = bodyLines.slice(0, -1);
  }
  return { lang, code: bodyLines.map((line) => stripLeadingSpaces(line, indent)).join("\n") };
}
var FENCE_OPEN_RE, FENCE_CLOSE_RE, ATX_HEADING_DETECT_RE, ATX_HEADING_CAPTURE_RE, BLOCKQUOTE_DETECT_RE, FENCE_INFO_BACKSLASH_RE;
var init_block_patterns = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/block-patterns.js"() {
    init_entity_decoder();
    FENCE_OPEN_RE = /^ {0,3}(?:(`{3,})([^\n`]*)|(~{3,})([^\n]*?))\s*$/;
    FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;
    ATX_HEADING_DETECT_RE = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
    ATX_HEADING_CAPTURE_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/;
    BLOCKQUOTE_DETECT_RE = /^ {0,3}> ?/;
    FENCE_INFO_BACKSLASH_RE = /\\([!-/:-@[-`{-~])/g;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/html-policy.js
function getHtmlPolicy() {
  return activeConfig().htmlPolicy ?? "passthrough";
}
var init_html_policy = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/html-policy.js"() {
    init_config();
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/escape.js
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}
function isSanctionedRendererTag(tag) {
  if (EVENT_HANDLER_ATTR_RE.test(tag))
    return false;
  const rawUrl = URL_ATTR_RE.exec(tag)?.[1];
  if (rawUrl === void 0)
    return true;
  const url = decodeHtmlCharRefs(decodeEscapedPunctuationRaw(decodeEscapedHref(rawUrl))).trim();
  return !DANGEROUS_HREF_SCHEME_RE.test(url);
}
function narrowAnchor(tag) {
  const body = ANCHOR_OPEN_TAG_RE.exec(tag)?.[1];
  if (body === void 0 || !QUOTED_HREF_RE.test(body))
    return null;
  if (!isSanctionedRendererTag(tag))
    return null;
  const kept = [];
  let hasHref = false;
  for (const [, rawName = "", value] of body.matchAll(TAG_ATTR_RE)) {
    const name = rawName.toLowerCase();
    if (!SAFE_ANCHOR_ATTR_NAME_RE.test(name))
      continue;
    if (name === "href") {
      if (value === void 0)
        continue;
      hasHref = true;
    }
    kept.push(value === void 0 ? name : `${name}="${value}"`);
  }
  return hasHref ? `<a ${kept.join(" ")}>` : null;
}
function safeRawTag(part, policy) {
  if (policy === "passthrough")
    return PASSTHROUGH_TAG_RE.test(part) ? part : null;
  if (SAFE_OUTER_TAG_RE.test(part) && isSanctionedRendererTag(part))
    return part;
  const narrowed = narrowAnchor(part);
  if (narrowed !== null)
    return narrowed;
  const keep = policy === "escape-all" ? BR_TAG_RE.test(part) : BENIGN_RAW_INLINE_TAG_RE.test(part);
  return keep ? part : null;
}
function escapeHtmlOutsideSafeTags(html) {
  const policy = getHtmlPolicy();
  return html.split(/(<[^>]+>)/g).map((part) => part.startsWith("<") ? safeRawTag(part, policy) ?? escapeHtml(part) : escapeHtml(part)).join("");
}
function rawHtmlTagHoldStart(s, mask) {
  for (let i = s.lastIndexOf("<"); i >= 0; i = s.lastIndexOf("<", i - 1)) {
    if (mask[i])
      continue;
    const segment = s.slice(i);
    if (segment.includes(">"))
      return s.length;
    return /^<(?:[a-zA-Z/!]|$)/.test(segment) ? i : s.length;
  }
  return s.length;
}
function escapeHtmlTextNodes(html) {
  return html.split(/(<code>[\s\S]*?<\/code>)/g).map((segment, index) => {
    if (index % 2 === 1) {
      const match = segment.match(/^(<code>)([\s\S]*?)(<\/code>)$/);
      if (!match)
        return segment;
      return `${match[1] ?? ""}${escapeHtml(match[2] ?? "")}${match[3] ?? ""}`;
    }
    return escapeHtmlOutsideSafeTags(segment);
  }).join("");
}
function escapeMermaidHtml(text) {
  return text.replace(/[&<"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}
function decodeEscapedHref(raw) {
  return raw.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function stripIncompleteSafeEntities(text) {
  const amp = text.lastIndexOf("&");
  if (amp === -1)
    return text;
  const suffix = text.slice(amp);
  if (COMPLETE_SAFE_MARKDOWN_ENTITY_RE.test(suffix))
    return text;
  const lower = suffix.toLowerCase();
  if (KNOWN_SAFE_ENTITIES.some((entity) => entity.startsWith(lower) && lower.length < entity.length)) {
    return text.slice(0, amp);
  }
  return text;
}
function decodeSafeMarkdownEntities(text) {
  const stripped = stripIncompleteSafeEntities(text);
  return stripped.replace(SAFE_MARKDOWN_ENTITY_RE, () => "\xA0");
}
var HTML_ESCAPES, SAFE_OUTER_TAG_RE, BENIGN_RAW_INLINE_TAG_RE, BR_TAG_RE, EVENT_HANDLER_ATTR_RE, URL_ATTR_RE, DANGEROUS_HREF_SCHEME_RE, PASSTHROUGH_TAG_RE, SAFE_ANCHOR_ATTR_NAME_RE, TAG_ATTR_RE, ANCHOR_OPEN_TAG_RE, QUOTED_HREF_RE, SAFE_MARKDOWN_ENTITY_SOURCE, SAFE_MARKDOWN_ENTITY_RE, COMPLETE_SAFE_MARKDOWN_ENTITY_RE, KNOWN_SAFE_ENTITIES;
var init_escape = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/escape.js"() {
    init_backslash_escapes();
    init_html_policy();
    init_link_references();
    HTML_ESCAPES = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    SAFE_OUTER_TAG_RE = /^(?:<a(?:\s+href="[^"]*")(?:\s+(?:(?:title|target|rel|class)="[^"]*"|data-[a-z0-9-]+(?:="[^"]*")?))*\s*>|<\/(?:a|code|em|strong)>|<(?:code|em|strong)\b[^>]*>|<img\b[^>]*\bdata-md-rendered="1"[^>]*\/?>)$/i;
    BENIGN_RAW_INLINE_TAG_RE = /^<\/?(?:b|i|u|s|del|ins|sub|sup|kbd|mark|br)\s*\/?>$/i;
    BR_TAG_RE = /^<br\s*\/?>$/i;
    EVENT_HANDLER_ATTR_RE = /\son[a-z]+\s*=/i;
    URL_ATTR_RE = /\b(?:href|src)\s*=\s*"([^"]*)"/i;
    DANGEROUS_HREF_SCHEME_RE = /^(?:javascript|data|vbscript):/i;
    PASSTHROUGH_TAG_RE = /^<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>$/;
    SAFE_ANCHOR_ATTR_NAME_RE = /^(?:href|title|target|rel|class|data-[a-z0-9-]+)$/i;
    TAG_ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
    ANCHOR_OPEN_TAG_RE = /^<a\s+([^>]*?)\s*>$/i;
    QUOTED_HREF_RE = /\bhref\s*=\s*"/i;
    SAFE_MARKDOWN_ENTITY_SOURCE = "&(?:amp;)?(?:nbsp|#160|#x0*a0);";
    SAFE_MARKDOWN_ENTITY_RE = new RegExp(SAFE_MARKDOWN_ENTITY_SOURCE, "gi");
    COMPLETE_SAFE_MARKDOWN_ENTITY_RE = new RegExp(`^${SAFE_MARKDOWN_ENTITY_SOURCE}$`, "i");
    KNOWN_SAFE_ENTITIES = [
      "&nbsp;",
      "&#160;",
      "&#xa0;",
      "&amp;nbsp;",
      "&amp;#160;",
      "&amp;#xa0;"
    ];
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/math-block.js
function onelineMathBody(trimmed, delimiter) {
  const [open, close] = delimiter === "dollar" ? ["$$", "$$"] : ["\\[", "\\]"];
  if (!trimmed.startsWith(open) || !trimmed.endsWith(close))
    return null;
  if (trimmed.length < open.length + close.length + 1)
    return null;
  const body = trimmed.slice(open.length, -close.length);
  return body.trim() === "" ? null : body;
}
function mathBlockDelimiterLine(line) {
  const m = MATH_OPEN_PREFIX_RE.exec(line);
  if (!m)
    return null;
  const delimiter = m[1] === "$$" ? "dollar" : "bracket";
  if (delimiter === "dollar" ? MATH_DOLLAR_LINE_RE.test(line) : MATH_BRACKET_OPEN_LINE_RE.test(line)) {
    return { delimiter, oneline: false };
  }
  if (onelineMathBody(line.trim(), delimiter) !== null)
    return { delimiter, oneline: true };
  return null;
}
function mathBlockOpenCandidate(line) {
  const complete = mathBlockDelimiterLine(line);
  if (complete)
    return complete;
  const m = MATH_OPEN_PREFIX_RE.exec(line);
  if (!m)
    return null;
  const delimiter = m[1] === "$$" ? "dollar" : "bracket";
  const trimmed = line.trim();
  const close = delimiter === "dollar" ? "$$" : "\\]";
  if (trimmed.length >= 4 && trimmed.endsWith(close) && onelineMathBody(trimmed, delimiter) === null) {
    return null;
  }
  return { delimiter, oneline: false };
}
function mathBlockCloses(delimiter, line) {
  return delimiter === "dollar" ? MATH_DOLLAR_LINE_RE.test(line) : MATH_BRACKET_CLOSE_LINE_RE.test(line);
}
function parseMathBlockSlice(slice) {
  const lines = dropTrailingNewline(slice).split("\n");
  const first = lines[0] ?? "";
  const start = mathBlockDelimiterLine(first) ?? mathBlockOpenCandidate(first);
  if (start?.oneline)
    return onelineMathBody(first.trim(), start.delimiter) ?? "";
  let end = lines.length;
  const last = lines.at(-1);
  if (start && lines.length > 1 && last !== void 0 && mathBlockCloses(start.delimiter, last)) {
    end = lines.length - 1;
  }
  return lines.slice(1, end).join("\n");
}
function parseOpenMathBlock(source) {
  const lines = source.split("\n");
  const first = lines[0] ?? "";
  const start = mathBlockOpenCandidate(first);
  if (!start)
    return source;
  if (lines.length === 1) {
    if (start.oneline)
      return onelineMathBody(first.trim(), start.delimiter) ?? "";
    if (mathBlockDelimiterLine(first))
      return "";
    const body = first.trim().slice(2);
    return body.replace(start.delimiter === "dollar" ? PARTIAL_DOLLAR_CLOSER_RE : PARTIAL_BRACKET_CLOSER_RE, "").trim();
  }
  let end = lines.length;
  const last = lines.at(-1) ?? "";
  const partialCloserLine = start.delimiter === "dollar" ? PARTIAL_DOLLAR_CLOSER_LINE_RE : PARTIAL_BRACKET_CLOSER_LINE_RE;
  if (end > 1 && partialCloserLine.test(last) && last.trim() !== "")
    end = lines.length - 1;
  return lines.slice(1, end).join("\n");
}
function mathBlockHtml(source, extraClass = "") {
  const cls = extraClass ? ` ${extraClass}` : "";
  return `<div class="math-block math-block--pending${cls}"><pre class="math">${escapeHtml(source)}</pre></div>`;
}
function syncFormingMathBlockDom(container, source, formingClass) {
  let block = container.querySelector(`.math-block.${formingClass}`);
  if (!block) {
    container.replaceChildren();
    block = document.createElement("div");
    block.className = `math-block math-block--pending ${formingClass}`;
    const pre2 = document.createElement("pre");
    pre2.className = "math";
    block.append(pre2);
    container.append(block);
  }
  const pre = block.querySelector("pre.math");
  if (pre)
    pre.textContent = source;
}
var MATH_DOLLAR_LINE_RE, MATH_BRACKET_OPEN_LINE_RE, MATH_BRACKET_CLOSE_LINE_RE, MATH_OPEN_PREFIX_RE, PARTIAL_DOLLAR_CLOSER_RE, PARTIAL_BRACKET_CLOSER_RE, PARTIAL_DOLLAR_CLOSER_LINE_RE, PARTIAL_BRACKET_CLOSER_LINE_RE;
var init_math_block = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/math-block.js"() {
    init_block_patterns();
    init_escape();
    MATH_DOLLAR_LINE_RE = /^ {0,3}\$\$\s*$/;
    MATH_BRACKET_OPEN_LINE_RE = /^ {0,3}\\\[\s*$/;
    MATH_BRACKET_CLOSE_LINE_RE = /^ {0,3}\\\]\s*$/;
    MATH_OPEN_PREFIX_RE = /^ {0,3}(\$\$|\\\[)/;
    PARTIAL_DOLLAR_CLOSER_RE = /\${1,2}\s*$/;
    PARTIAL_BRACKET_CLOSER_RE = /\\\]?\s*$/;
    PARTIAL_DOLLAR_CLOSER_LINE_RE = /^ {0,3}\$\s*$/;
    PARTIAL_BRACKET_CLOSER_LINE_RE = /^ {0,3}\\\s*$/;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/footnotes.js
function isFootnotesEnabled() {
  return activeConfig().footnotes !== false;
}
function isFootnoteDefLine(text) {
  return isFootnotesEnabled() && FOOTNOTE_DEF_LINE_RE.test(text);
}
function normalizeFootnoteLabel(label) {
  return normalizeReferenceLabel(decodeEscapes(label));
}
function parseFootnoteDefSlice(slice) {
  const lines = dropTrailingNewline(slice).split("\n");
  const first = lines[0] ?? "";
  const m = FOOTNOTE_DEF_LINE_RE.exec(first);
  if (!m?.[1])
    return null;
  const content = [
    first.slice(m[0].length).trimStart(),
    ...lines.slice(1).map((line) => stripFourColumnIndent(line))
  ];
  while (content.length && (content.at(-1) ?? "").trim() === "")
    content.pop();
  return { label: m[1], content: content.join("\n") };
}
function createFootnoteContext(defs) {
  return {
    defs,
    idPrefix: activeConfig().footnoteIdPrefix ?? "",
    order: [],
    numbers: /* @__PURE__ */ new Map(),
    slugs: /* @__PURE__ */ new Map(),
    usedSlugs: /* @__PURE__ */ new Set(),
    refCounts: /* @__PURE__ */ new Map(),
    usedRefIds: /* @__PURE__ */ new Set(),
    firstRefIds: /* @__PURE__ */ new Map()
  };
}
function reseatFootnoteContext(defs, from) {
  return {
    defs,
    idPrefix: from.idPrefix,
    order: [...from.order],
    numbers: new Map(from.numbers),
    slugs: new Map(from.slugs),
    usedSlugs: new Set(from.usedSlugs),
    refCounts: /* @__PURE__ */ new Map(),
    usedRefIds: /* @__PURE__ */ new Set(),
    firstRefIds: new Map(from.firstRefIds)
  };
}
function setActiveFootnoteContext(ctx) {
  activeFootnotes = ctx;
}
function getActiveFootnoteContext() {
  return activeFootnotes;
}
function assignSlug(ctx, key, label, n) {
  const base = decodeEscapes(label).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || String(n);
  let slug = base;
  for (let i = 2; ctx.usedSlugs.has(slug); i++)
    slug = `${base}-${String(i)}`;
  ctx.usedSlugs.add(slug);
  ctx.slugs.set(key, slug);
  return slug;
}
function footnoteRefHtml(ctx, label) {
  const key = normalizeFootnoteLabel(label);
  const def = ctx.defs.get(key);
  if (!def)
    return null;
  let n = ctx.numbers.get(key);
  let slug = ctx.slugs.get(key);
  if (n === void 0 || slug === void 0) {
    n = ctx.order.length + 1;
    ctx.numbers.set(key, n);
    ctx.order.push(key);
    slug = assignSlug(ctx, key, def.label, n);
  }
  const nsSlug = `${ctx.idPrefix}${slug}`;
  let count = (ctx.refCounts.get(key) ?? 0) + 1;
  let refId = count === 1 ? `fnref-${nsSlug}` : `fnref-${nsSlug}-${String(count)}`;
  while (ctx.usedRefIds.has(refId)) {
    count++;
    refId = `fnref-${nsSlug}-${String(count)}`;
  }
  ctx.refCounts.set(key, count);
  ctx.usedRefIds.add(refId);
  if (!ctx.firstRefIds.has(key))
    ctx.firstRefIds.set(key, refId);
  return `<sup class="footnote-ref"><a href="#fn-${nsSlug}" id="${refId}" data-footnote-ref aria-describedby="${ctx.idPrefix}footnote-label">${String(n)}</a></sup>`;
}
function renderFootnoteRefs(text, emit) {
  if (!text.includes("[^"))
    return text;
  const ctx = activeFootnotes;
  return text.replace(FOOTNOTE_REF_RE, (match, label, offset) => {
    const html = ctx ? footnoteRefHtml(ctx, label) : null;
    if (html !== null)
      return emit(html);
    const next = text[offset + match.length];
    if (next === "(" || next === "[")
      return match;
    return emit(`<span class="footnote-ref-unresolved">${escapeHtml(match)}</span>`);
  });
}
function footnoteRefLabelsIn(text) {
  if (!text.includes("[^"))
    return [];
  const labels = [];
  for (const m of text.matchAll(FOOTNOTE_REF_RE)) {
    labels.push(normalizeFootnoteLabel(m[1]));
  }
  return labels;
}
function footnoteHoldStart(s, mask) {
  if (!isFootnotesEnabled())
    return s.length;
  for (let i = s.length - 2; i >= 0; i--) {
    if (s[i] !== "[" || s[i + 1] !== "^" || mask[i])
      continue;
    let backslashes = 0;
    for (let k = i - 1; k >= 0 && s[k] === "\\"; k--)
      backslashes++;
    if (backslashes % 2 === 1)
      continue;
    return /[\s\]]/.test(s.slice(i + 2)) ? s.length : i;
  }
  return s.length;
}
function isPendingFootnoteDefLine(pending) {
  if (!isFootnotesEnabled())
    return false;
  return /^ {0,3}\[\^(?:[^\s\]]*$|[^\s\]]+\](?::|$))/.test(pending);
}
var FOOTNOTE_DEF_LINE_RE, FOOTNOTE_REF_RE, activeFootnotes;
var init_footnotes = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/footnotes.js"() {
    init_block_patterns();
    init_escape();
    init_link_references();
    init_config();
    FOOTNOTE_DEF_LINE_RE = /^ {0,3}\[\^([^\s\]]+)\]:/;
    FOOTNOTE_REF_RE = /\[\^([^\s\]]+)\]/g;
    activeFootnotes = null;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/math-syntax.js
function isMathSyntaxEnabled() {
  return activeConfig().mathSyntax ?? false;
}
var init_math_syntax = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/math-syntax.js"() {
    init_config();
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/block-tokenizer.js
function parseOrderedListMarker(line) {
  const m = line.match(ORDERED_LIST_MARKER_RE);
  if (!m?.[1])
    return null;
  return parseInt(m[1], 10);
}
function orderedListMarkerDelimiter(line) {
  const m = line.match(ORDERED_LIST_MARKER_RE);
  const d = m?.[2];
  if (d === "." || d === ")")
    return d;
  return null;
}
function isUnorderedListItemLine(line) {
  return UNORDERED_LIST_ITEM_RE.test(line);
}
function isListItemLine(line) {
  return isUnorderedListItemLine(line) || parseOrderedListMarker(line) !== null;
}
function unorderedListMarkerChar(line) {
  const m = line.match(/^ {0,3}([-*+])(?:\s|$)/);
  const ch = m?.[1];
  if (ch === "-" || ch === "*" || ch === "+")
    return ch;
  return null;
}
function isEmptyListItemLine(line) {
  const m = line.match(EMPTY_LIST_ITEM_RE);
  if (!m)
    return false;
  return line.slice(m[0].length).trim() === "";
}
function listItemContentColumn(line) {
  const m = expandListPrefixTabs(line).match(/^( {0,3})(\d{1,9}[.)]|[-*+])( *)(.*)$/);
  if (!m)
    return Infinity;
  const indent = m[1]?.length ?? 0;
  const markerWidth = m[2]?.length ?? 0;
  const spaces = m[3]?.length ?? 0;
  const hasContent = (m[4]?.length ?? 0) > 0;
  const n = hasContent && spaces >= 1 && spaces <= 4 ? spaces : 1;
  return indent + markerWidth + n;
}
function lazyContinuationIndent(line) {
  return leadingIndentWidth(line);
}
function orderedMarkerContinuesParagraph(prevLine, line) {
  const num = parseOrderedListMarker(line);
  if (num === null)
    return false;
  if (num === 1)
    return false;
  return prevLine.trimEnd().length > 0;
}
function isLazyUnorderedContinuation(itemStartLine, line) {
  if (isListItemLine(line))
    return false;
  return lazyContinuationIndent(line) >= listItemContentColumn(itemStartLine);
}
function isLazyListContinuation(itemStartLine, line) {
  return isLazyUnorderedContinuation(itemStartLine, line);
}
function lineContainsPipeCellDelimiter(line) {
  return line.includes("|") && line.trim() !== "";
}
function isProseMetadataPipeLine(line) {
  if (!lineContainsPipeCellDelimiter(line))
    return false;
  const trimmed = line.trimStart();
  if (/\*\*[^*\n]+:\*\*/.test(trimmed))
    return true;
  if (/&nbsp;/i.test(trimmed))
    return true;
  return false;
}
function hasMatchingDelimiterRow(headerLine, nextLine) {
  if (nextLine === void 0)
    return false;
  if (!TABLE_SEP_RE.test(nextLine))
    return false;
  return tableColumnsMatch(headerLine, nextLine);
}
function isGfmTableRowLine(line, nextLine) {
  if (!lineContainsPipeCellDelimiter(line))
    return false;
  if (isProseMetadataPipeLine(line) && !hasMatchingDelimiterRow(line, nextLine))
    return false;
  const trimmed = line.trimStart();
  if (trimmed.startsWith("|"))
    return true;
  return splitTableRow(trimmed).length >= 2;
}
function isTableRow(line, nextLine) {
  return isGfmTableRowLine(line, nextLine);
}
function tableColumnsMatch(headerLine, sepLine) {
  return splitTableRow(headerLine).length === splitTableRow(sepLine).length;
}
function isMathBlockInterruptLine(line) {
  return isMathSyntaxEnabled() && mathBlockDelimiterLine(line) !== null;
}
function endsTableBody(line) {
  if (line.trim() === "")
    return true;
  return ATX_HEADING_DETECT_RE.test(line) || THEMATIC_BREAK_RE.test(line) || FENCE_OPEN_RE.test(line) || isMathBlockInterruptLine(line) || LIST_ITEM_RE.test(line) || BLOCKQUOTE_RE.test(line);
}
function isPartialTableSeparatorLine(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("-"))
    return false;
  return /^\|?\s*:?-{1,}/.test(trimmed);
}
function isPotentialTableStart(lines, i) {
  const line = lines[i];
  const next = lines[i + 1];
  if (!line || !isTableRow(line.text, next?.text))
    return false;
  if (next && TABLE_SEP_RE.test(next.text)) {
    return next.terminated ? tableColumnsMatch(line.text, next.text) : true;
  }
  if (next && isPartialTableSeparatorLine(next.text))
    return true;
  if (next && isTableRow(next.text, lines[i + 2]?.text))
    return true;
  return line.text.trimStart().startsWith("|");
}
function scanLines(source) {
  const lines = [];
  let i = 0;
  while (i <= source.length) {
    const start = i;
    const end = source.indexOf("\n", i);
    if (end === -1) {
      if (start < source.length) {
        lines.push({ text: source.slice(start), start, end: source.length, terminated: false });
      }
      break;
    }
    lines.push({ text: source.slice(start, end), start, end: end + 1, terminated: true });
    i = end + 1;
  }
  return lines;
}
function pushBlock(blocks, kind, status, start, end) {
  if (end <= start)
    return;
  blocks.push({ kind, status, start, end });
}
function tryFootnoteDefBlock(lines, i) {
  const startLine = lines[i];
  if (!startLine || !isFootnoteDefLine(startLine.text))
    return null;
  let j = i + 1;
  while (j < lines.length) {
    const next = lines[j];
    if (!next)
      break;
    if (next.text.trim() === "") {
      let k = j + 1;
      while (k < lines.length && lines[k]?.text.trim() === "")
        k++;
      const after = lines[k];
      if (after && leadingIndentWidth(after.text) >= 4) {
        j = k + 1;
        continue;
      }
      break;
    }
    if (leadingIndentWidth(next.text) >= 4) {
      j++;
      continue;
    }
    if (isFootnoteDefLine(next.text) || ATX_HEADING_DETECT_RE.test(next.text) || LIST_ITEM_RE.test(next.text) || BLOCKQUOTE_RE.test(next.text) || fenceMarker(next.text) || isMathBlockInterruptLine(next.text) || THEMATIC_BREAK_RE.test(next.text)) {
      break;
    }
    j++;
  }
  return j;
}
function tryLinkRefDefBlock(lines, i) {
  if (!isLinkReferencesEnabled())
    return null;
  const startLine = lines[i];
  if (!startLine || !/^ {0,3}\[/.test(startLine.text))
    return null;
  if (isFootnoteDefLine(startLine.text))
    return null;
  let buf = "";
  let runLines = 0;
  for (let j = i; j < lines.length; j++) {
    const line = lines[j];
    if (!line || line.text.trim() === "")
      break;
    if (j > i && (ATX_HEADING_DETECT_RE.test(line.text) || LIST_ITEM_RE.test(line.text) || BLOCKQUOTE_RE.test(line.text) || fenceMarker(line.text) || isMathBlockInterruptLine(line.text) || THEMATIC_BREAK_RE.test(line.text))) {
      break;
    }
    buf += line.text;
    if (line.terminated)
      buf += "\n";
    runLines++;
  }
  let offset = 0;
  let consumedLines = 0;
  while (offset < buf.length && consumedLines < runLines) {
    let k = offset;
    let indent = 0;
    while (buf[k] === " " && indent < 4) {
      k++;
      indent++;
    }
    if (indent > 3 || buf[k] !== "[")
      break;
    if (buf[k + 1] === "^" && isFootnoteDefLine(buf.slice(offset)))
      break;
    const def = parseLinkReferenceDefinitionAt(buf, k);
    if (!def || !isValidReferenceLabel(def.label))
      break;
    const segment = buf.slice(offset, def.end);
    consumedLines += (segment.match(/\n/g)?.length ?? 0) + (segment.endsWith("\n") ? 0 : 1);
    offset = def.end;
  }
  if (consumedLines === 0)
    return null;
  return i + consumedLines;
}
function lastLinkRefDefStart(runText) {
  let offset = 0;
  let lastStart = 0;
  while (offset < runText.length) {
    let k = offset;
    let indent = 0;
    while (runText[k] === " " && indent < 4) {
      k++;
      indent++;
    }
    if (indent > 3 || runText[k] !== "[")
      break;
    if (runText[k + 1] === "^" && isFootnoteDefLine(runText.slice(offset)))
      break;
    const def = parseLinkReferenceDefinitionAt(runText, k);
    if (!def || !isValidReferenceLabel(def.label))
      break;
    lastStart = offset;
    offset = def.end;
  }
  return lastStart;
}
function endsInOpenParagraph(fragment) {
  const last = tokenizeBlocks(fragment).at(-1);
  if (!last)
    return false;
  if (last.kind === "paragraph")
    return true;
  return endsInOpenParagraphNested(fragment, last);
}
function strippedQuoteTailState(fragment) {
  const last = tokenizeBlocks(fragment).at(-1);
  if (!last)
    return { endsOpen: false, flatParagraph: false };
  if (last.kind === "paragraph")
    return { endsOpen: true, flatParagraph: true };
  return { endsOpen: endsInOpenParagraphNested(fragment, last), flatParagraph: false };
}
function endsInOpenParagraphNested(fragment, last) {
  if (last.kind === "blockquote") {
    const inner = fragment.slice(last.start, last.end).split("\n").map((l) => stripBlockquoteMarker(l)).join("\n");
    return endsInOpenParagraph(inner);
  }
  if (last.kind === "list_item") {
    const lines = fragment.slice(last.start, last.end).split("\n");
    const col = listItemContentColumn(lines[0] ?? "");
    const inner = lines.map((l, idx) => {
      if (idx === 0)
        return l.slice(Math.min(col, l.length));
      const indent = /^ */.exec(l)?.[0].length ?? 0;
      return l.slice(Math.min(col, indent));
    }).join("\n");
    return endsInOpenParagraph(inner);
  }
  return false;
}
function startsLinkRefDef(s) {
  if (!isLinkReferencesEnabled())
    return false;
  let i = 0;
  while (i < 3 && s[i] === " ")
    i++;
  if (s[i] !== "[")
    return false;
  if (s[i + 1] === "^" && isFootnotesEnabled())
    return false;
  const label = parseBracketedLabel(s, i);
  if (!label || label.label.trim() === "")
    return false;
  return s[label.end] === ":";
}
function keepsFlatParagraphOpen(s) {
  if (s.trim() === "")
    return false;
  if (leadingIndentWidth(s) >= 4)
    return false;
  return !(SETEXT_UNDERLINE_RE.test(s) || ATX_HEADING_DETECT_RE.test(s) || THEMATIC_BREAK_RE.test(s) || LIST_ITEM_RE.test(s) || BLOCKQUOTE_RE.test(s) || fenceMarker(s) !== null || isMathBlockInterruptLine(s) || isFootnoteDefLine(s) || startsLinkRefDef(s) || isTableRow(s));
}
function breaksUnorderedListItem(lines, itemStart, j) {
  const itemStartLine = lines[itemStart]?.text ?? "";
  const col = listItemContentColumn(itemStartLine);
  const next = lines[j];
  if (!next)
    return true;
  if (next.text.trim() === "" && j === itemStart + 1 && isEmptyListItemLine(itemStartLine)) {
    return true;
  }
  if (next.text.trim() === "") {
    let k = j + 1;
    while (k < lines.length && lines[k]?.text.trim() === "")
      k++;
    const after = lines[k];
    if (!after)
      return true;
    if (lazyContinuationIndent(after.text) >= col)
      return false;
    if (isListItemLine(after.text))
      return true;
    return !isLazyUnorderedContinuation(itemStartLine, after.text);
  }
  if (lazyContinuationIndent(next.text) >= col && next.text.trim() !== "")
    return false;
  if (isListItemLine(next.text))
    return true;
  if (ATX_HEADING_DETECT_RE.test(next.text) || THEMATIC_BREAK_RE.test(next.text) || fenceMarker(next.text) || isMathBlockInterruptLine(next.text) || BLOCKQUOTE_RE.test(next.text) || isFootnoteDefLine(next.text) || tryLinkRefDefBlock(lines, j) !== null || isTableRow(next.text, lines[j + 1]?.text) && lines[j + 1] && TABLE_SEP_RE.test(lines[j + 1]?.text ?? "")) {
    return true;
  }
  return false;
}
function tokenizeBlocks(source) {
  const lines = scanLines(source);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line)
      break;
    if (line.text.trim() === "") {
      pushBlock(blocks, "blank", line.terminated ? "complete" : "open", line.start, line.end);
      i++;
      continue;
    }
    if (leadingIndentWidth(line.text) >= 4 && line.text.trim() !== "") {
      let j2 = i + 1;
      let lastContent = i;
      while (j2 < lines.length) {
        const next = lines[j2];
        if (!next)
          break;
        if (next.text.trim() === "") {
          j2++;
          continue;
        }
        if (leadingIndentWidth(next.text) >= 4) {
          lastContent = j2;
          j2++;
          continue;
        }
        break;
      }
      const last2 = lines[lastContent] ?? line;
      const terminatorSeen = j2 < lines.length && lines[j2] !== void 0;
      const status2 = !last2.terminated ? "open" : terminatorSeen ? "complete" : "open";
      pushBlock(blocks, "indented_code", status2, line.start, last2.end);
      i = lastContent + 1;
      continue;
    }
    const fence = fenceMarker(line.text);
    if (fence) {
      const fenceStart = line.start;
      let j2 = i + 1;
      let closed = false;
      while (j2 < lines.length) {
        const next = lines[j2];
        if (next && fenceCloses(fence.marker, fence.len, next.text)) {
          closed = true;
          pushBlock(blocks, "fence", "complete", fenceStart, next.end);
          i = j2 + 1;
          break;
        }
        j2++;
      }
      if (!closed) {
        const end = lines.at(-1)?.end ?? source.length;
        pushBlock(blocks, "fence", "open", fenceStart, end);
        break;
      }
      continue;
    }
    const math = !isMathSyntaxEnabled() ? null : line.terminated ? mathBlockDelimiterLine(line.text) : mathBlockOpenCandidate(line.text);
    if (math) {
      if (!line.terminated) {
        pushBlock(blocks, "math_block", "open", line.start, line.end);
        break;
      }
      if (math.oneline) {
        pushBlock(blocks, "math_block", "complete", line.start, line.end);
        i++;
        continue;
      }
      let j2 = i + 1;
      let closed = false;
      while (j2 < lines.length) {
        const next = lines[j2];
        if (next && mathBlockCloses(math.delimiter, next.text)) {
          closed = true;
          pushBlock(blocks, "math_block", "complete", line.start, next.end);
          i = j2 + 1;
          break;
        }
        j2++;
      }
      if (!closed) {
        const end = lines.at(-1)?.end ?? source.length;
        pushBlock(blocks, "math_block", "open", line.start, end);
        break;
      }
      continue;
    }
    if (ATX_HEADING_DETECT_RE.test(line.text)) {
      const status2 = line.terminated ? "complete" : "ambiguous";
      pushBlock(blocks, "atx_heading", status2, line.start, line.end);
      i++;
      continue;
    }
    if (THEMATIC_BREAK_RE.test(line.text)) {
      const status2 = line.terminated ? "complete" : "ambiguous";
      pushBlock(blocks, "thematic_break", status2, line.start, line.end);
      i++;
      continue;
    }
    const footnoteEnd = tryFootnoteDefBlock(lines, i);
    if (footnoteEnd !== null) {
      const last2 = lines[footnoteEnd - 1] ?? line;
      const status2 = last2.terminated ? "complete" : "open";
      pushBlock(blocks, "footnote_def", status2, line.start, last2.end);
      i = footnoteEnd;
      continue;
    }
    const linkRefEnd = tryLinkRefDefBlock(lines, i);
    if (linkRefEnd !== null) {
      const last2 = lines[linkRefEnd - 1] ?? line;
      const status2 = last2.terminated ? "complete" : "open";
      pushBlock(blocks, "link_ref_def", status2, line.start, last2.end);
      i = linkRefEnd;
      continue;
    }
    if (isListItemLine(line.text)) {
      const isOrdered = parseOrderedListMarker(line.text) !== null;
      const itemStart = line.start;
      let j2 = i + 1;
      while (j2 < lines.length) {
        if (isOrdered) {
          const next = lines[j2];
          if (!next)
            break;
          if (next.text.trim() !== "" && lazyContinuationIndent(next.text) >= listItemContentColumn(line.text)) {
            j2++;
            continue;
          }
          if (isListItemLine(next.text))
            break;
          if (next.text.trim() === "") {
            j2++;
            continue;
          }
          if ((lines[j2 - 1]?.text.trim() ?? "") === "" && leadingIndentWidth(next.text) >= 4) {
            break;
          }
          if (ATX_HEADING_DETECT_RE.test(next.text) || THEMATIC_BREAK_RE.test(next.text) || fenceMarker(next.text) || isMathBlockInterruptLine(next.text) || BLOCKQUOTE_RE.test(next.text) || isFootnoteDefLine(next.text) || tryLinkRefDefBlock(lines, j2) !== null || isTableRow(next.text, lines[j2 + 1]?.text) && lines[j2 + 1] && TABLE_SEP_RE.test(lines[j2 + 1]?.text ?? "")) {
            break;
          }
          j2++;
          continue;
        }
        if (breaksUnorderedListItem(lines, i, j2))
          break;
        j2++;
      }
      const last2 = lines[j2 - 1] ?? line;
      const status2 = last2.terminated ? "complete" : "open";
      pushBlock(blocks, "list_item", status2, itemStart, last2.end);
      i = j2;
      continue;
    }
    if (BLOCKQUOTE_RE.test(line.text)) {
      const bqStart = line.start;
      const strippedInner = [stripBlockquoteMarker(line.text)];
      let endsOpenCache = null;
      let flatParagraphTail = keepsFlatParagraphOpen(strippedInner[0] ?? "");
      if (flatParagraphTail)
        endsOpenCache = true;
      const noteInner = (s) => {
        endsOpenCache = flatParagraphTail && keepsFlatParagraphOpen(s) ? true : null;
        flatParagraphTail = endsOpenCache === true;
        strippedInner.push(s);
      };
      let j2 = i + 1;
      while (j2 < lines.length) {
        const next = lines[j2];
        if (!next)
          break;
        if (next.text.trim() === "")
          break;
        if (!BLOCKQUOTE_RE.test(next.text)) {
          if (ATX_HEADING_DETECT_RE.test(next.text) || LIST_ITEM_RE.test(next.text) || fenceMarker(next.text) || isMathBlockInterruptLine(next.text) || THEMATIC_BREAK_RE.test(next.text)) {
            break;
          }
          if (endsOpenCache === null) {
            const st = strippedQuoteTailState(strippedInner.join("\n") + "\n");
            endsOpenCache = st.endsOpen;
            flatParagraphTail = st.flatParagraph;
          }
          if (!endsOpenCache)
            break;
        }
        noteInner(stripBlockquoteMarker(next.text));
        j2++;
      }
      const last2 = lines[j2 - 1] ?? line;
      const status2 = last2.terminated ? "complete" : "open";
      pushBlock(blocks, "blockquote", status2, bqStart, last2.end);
      i = j2;
      continue;
    }
    const nextTableLine = lines[i + 1];
    if (isTableRow(line.text, nextTableLine?.text)) {
      const nextLine2 = nextTableLine;
      if (nextLine2 && TABLE_SEP_RE.test(nextLine2.text) && tableColumnsMatch(line.text, nextLine2.text)) {
        const tableStart = line.start;
        let j2 = i + 2;
        while (j2 < lines.length) {
          const row = lines[j2];
          if (!row || endsTableBody(row.text))
            break;
          j2++;
        }
        const last2 = lines[j2 - 1] ?? lines[i + 1] ?? line;
        const lastRow = lines[j2 - 1];
        const status2 = lastRow && !lastRow.terminated && j2 === lines.length ? "open" : "complete";
        pushBlock(blocks, "table", status2, tableStart, last2.end);
        i = j2;
        continue;
      }
      if (isPotentialTableStart(lines, i)) {
        const tableStart = line.start;
        let j2 = i + 1;
        while (j2 < lines.length) {
          const nl = lines[j2];
          if (!nl)
            break;
          if (nl.terminated && TABLE_SEP_RE.test(nl.text))
            break;
          if (!isTableRow(nl.text) && !isPartialTableSeparatorLine(nl.text) && nl.text.trim() !== "") {
            break;
          }
          j2++;
        }
        const last2 = lines[j2 - 1] ?? line;
        const status2 = last2.terminated && j2 > i + 1 ? "open" : last2.terminated ? "ambiguous" : "open";
        pushBlock(blocks, "table", status2, tableStart, last2.end);
        i = j2;
        continue;
      }
    }
    const nextLine = lines[i + 1];
    if (nextLine && SETEXT_UNDERLINE_RE.test(nextLine.text)) {
      if (!nextLine.terminated) {
        pushBlock(blocks, "paragraph", line.terminated ? "complete" : "open", line.start, line.end);
        pushBlock(blocks, "thematic_break", "ambiguous", nextLine.start, nextLine.end);
        i += 2;
        continue;
      }
      pushBlock(blocks, "setext_heading", "complete", line.start, nextLine.end);
      i += 2;
      continue;
    }
    if (!line.terminated && i === lines.length - 1) {
      pushBlock(blocks, "paragraph", "open", line.start, line.end);
      break;
    }
    const paraStart = line.start;
    let j = i + 1;
    let setextUnderline = null;
    while (j < lines.length) {
      const next = lines[j];
      if (!next || next.text.trim() === "")
        break;
      if (next.terminated && SETEXT_UNDERLINE_RE.test(next.text)) {
        setextUnderline = next;
        break;
      }
      if (ATX_HEADING_DETECT_RE.test(next.text) || THEMATIC_BREAK_RE.test(next.text) || LIST_ITEM_RE.test(next.text) && // An empty list item cannot interrupt a paragraph (#285).
      !isEmptyListItemLine(next.text) && !orderedMarkerContinuesParagraph(lines[j - 1]?.text ?? "", next.text) || BLOCKQUOTE_RE.test(next.text) || fenceMarker(next.text) || isMathBlockInterruptLine(next.text) || // NOTE: a link reference definition cannot interrupt a paragraph
      // (spec 213) — a `[label]: dest` line here is a lazy continuation.
      // A FOOTNOTE definition can (cmark-gfm parses it as a container
      // start), so `text[^1]\n[^1]: note` resolves without a blank line.
      isFootnoteDefLine(next.text) || isTableRow(next.text, lines[j + 1]?.text) && lines[j + 1] && TABLE_SEP_RE.test(lines[j + 1]?.text ?? "")) {
        break;
      }
      j++;
    }
    if (setextUnderline) {
      pushBlock(blocks, "setext_heading", "complete", paraStart, setextUnderline.end);
      i = j + 1;
      continue;
    }
    const last = lines[j - 1] ?? line;
    const status = last.terminated ? "complete" : "open";
    pushBlock(blocks, "paragraph", status, paraStart, last.end);
    i = j;
  }
  return blocks;
}
function collectLinkReferenceDefinitions(source, tokens) {
  const refs = /* @__PURE__ */ new Map();
  if (!isLinkReferencesEnabled())
    return refs;
  const blocks = tokens ?? tokenizeBlocks(source);
  const merge = (found) => {
    for (const [key, ref] of found) {
      if (!refs.has(key))
        refs.set(key, ref);
    }
  };
  for (const token of blocks) {
    if (token.kind === "link_ref_def") {
      merge(parseLinkReferenceDefinitions(source.slice(token.start, token.end)));
    } else if (token.kind === "blockquote") {
      const inner = source.slice(token.start, token.end).split("\n").map((line) => stripBlockquoteMarker(line.trim())).join("\n");
      merge(collectLinkReferenceDefinitions(inner));
    }
  }
  return refs;
}
function collectFootnoteDefinitions(source, tokens) {
  const defs = /* @__PURE__ */ new Map();
  if (!isFootnotesEnabled())
    return defs;
  const blocks = tokens ?? tokenizeBlocks(source);
  for (const token of blocks) {
    if (token.kind !== "footnote_def")
      continue;
    const def = parseFootnoteDefSlice(source.slice(token.start, token.end));
    if (!def)
      continue;
    const key = normalizeFootnoteLabel(def.label);
    if (!defs.has(key))
      defs.set(key, def);
  }
  return defs;
}
function streamingHoldStart(blocks) {
  let commitEnd = 0;
  for (const block of blocks) {
    if (block.status !== "complete")
      return block.start;
    commitEnd = block.end;
  }
  return commitEnd;
}
function completeEndsInOpenTable(complete, tokens) {
  const blocks = tokens ?? tokenizeBlocks(complete);
  const last = blocks.at(-1);
  return last?.kind === "table" && last.status === "complete";
}
function pendingLineBelongsInTable(complete, pending, completeTokens) {
  return pending.includes("|") && completeEndsInOpenTable(complete, completeTokens);
}
function getIncompleteTableSource(content, tokens) {
  const blocks = tokens ?? tokenizeBlocks(content);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.kind === "table" && block.status !== "complete") {
      return content.slice(block.start, block.end);
    }
  }
  return null;
}
function getIncompleteFenceSource(content, tokens) {
  const blocks = tokens ?? tokenizeBlocks(content);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.kind === "fence" && block.status !== "complete") {
      return content.slice(block.start, block.end);
    }
  }
  return null;
}
function getIncompleteMathSource(content, tokens) {
  const blocks = tokens ?? tokenizeBlocks(content);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.kind === "math_block" && block.status !== "complete") {
      return content.slice(block.start, block.end);
    }
  }
  return null;
}
function splitTableRow(line) {
  const s = line.trim();
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && (s[i + 1] === "|" || s[i + 1] === "\\")) {
      cur += s[i + 1] === "|" ? "|" : "\\\\";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  if (cells.length > 1 && cells[0].trim() === "" && s.startsWith("|"))
    cells.shift();
  if (cells.length > 1 && cells.at(-1).trim() === "" && s.endsWith("|"))
    cells.pop();
  return cells.map((c) => c.trim());
}
function parseTableAlignments(sepLine) {
  return splitTableRow(sepLine).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right)
      return "center";
    if (right)
      return "right";
    if (left)
      return "left";
    return null;
  });
}
function isAmbiguousBlockLine(line) {
  const trimmed = line.trimStart();
  if (trimmed === "")
    return false;
  if (/^ {4}/.test(line))
    return true;
  if (ATX_HEADING_DETECT_RE.test(line))
    return true;
  if (THEMATIC_BREAK_RE.test(line))
    return true;
  if (FENCE_OPEN_RE.test(line))
    return true;
  if (isMathSyntaxEnabled() && mathBlockOpenCandidate(line) !== null)
    return true;
  if (LIST_ITEM_RE.test(line))
    return true;
  if (BLOCKQUOTE_RE.test(line))
    return true;
  if (isGfmTableRowLine(line))
    return true;
  return false;
}
var THEMATIC_BREAK_RE, UNORDERED_LIST_ITEM_RE, ORDERED_LIST_MARKER_RE, LIST_ITEM_RE, EMPTY_LIST_ITEM_RE, BLOCKQUOTE_RE, SETEXT_UNDERLINE_RE, TABLE_SEP_RE;
var init_block_tokenizer = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/block-tokenizer.js"() {
    init_link_references();
    init_block_patterns();
    init_math_block();
    init_footnotes();
    init_math_syntax();
    THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
    UNORDERED_LIST_ITEM_RE = /^ {0,3}[-*+](?:[ \t]|$)/;
    ORDERED_LIST_MARKER_RE = /^ {0,3}(\d{1,9})([.)])(?:[ \t]|$)/;
    LIST_ITEM_RE = /^ {0,3}(?:(?:[-*+])(?:[ \t]|$)|(?:\d{1,9}[.)](?:[ \t]|$)))/;
    EMPTY_LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
    BLOCKQUOTE_RE = /^ {0,3}> ?/;
    SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)\s*$/;
    TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/alerts.js
function alertTypeFromMarker(bodyLine) {
  const word = ALERT_MARKER_RE.exec(bodyLine.trim())?.[1]?.toLowerCase();
  if (word !== void 0 && word in ALERT_TITLES)
    return word;
  return null;
}
function alertTitle(type) {
  return ALERT_TITLES[type];
}
function alertBlockquoteClass(type) {
  return `markdown-alert markdown-alert-${type}`;
}
function isFormingAlertMarker(body) {
  return /^\[$|^\[![A-Za-z]*$/.test(body.trim());
}
function pendingBlockquoteAlertType(pendingLine) {
  return alertTypeFromMarker(stripBlockquoteMarker(pendingLine));
}
var ALERT_TITLES, ALERT_MARKER_RE;
var init_alerts = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/alerts.js"() {
    init_block_patterns();
    ALERT_TITLES = {
      note: "Note",
      tip: "Tip",
      important: "Important",
      warning: "Warning",
      caution: "Caution"
    };
    ALERT_MARKER_RE = /^\[!([A-Za-z]+)\]$/;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/fence-handlers.js
function normalizeFenceLang(lang) {
  return lang.trim().toLowerCase();
}
function overrideHandlers() {
  const source = activeConfig().fenceHandlers;
  if (!source)
    return void 0;
  if (source !== cachedOverrideSource) {
    cachedOverrideSource = source;
    cachedOverrideMap = /* @__PURE__ */ new Map();
    for (const [lang, handler] of Object.entries(source)) {
      cachedOverrideMap.set(normalizeFenceLang(lang), handler);
    }
  }
  return cachedOverrideMap;
}
function getFenceHandler(lang) {
  const key = normalizeFenceLang(lang);
  const overrides = overrideHandlers();
  if (overrides?.has(key))
    return overrides.get(key) ?? null;
  return BUILTIN_FENCE_HANDLERS.get(key) ?? null;
}
var FORMING_FENCE_PRE_CLASS, mermaidFenceHandler, mathFenceHandler, BUILTIN_FENCE_HANDLERS, cachedOverrideSource, cachedOverrideMap;
var init_fence_handlers = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/fence-handlers.js"() {
    init_config();
    init_escape();
    init_math_block();
    FORMING_FENCE_PRE_CLASS = "stream-fence-forming";
    mermaidFenceHandler = {
      render(code) {
        const body = escapeMermaidHtml(code.trimEnd());
        return `<div class="mermaid-diagram mermaid-diagram--pending"><pre class="mermaid">${body}</pre></div>`;
      },
      forming: {
        html(code) {
          const body = escapeMermaidHtml(code);
          return `<div class="mermaid-diagram mermaid-diagram--pending ${FORMING_FENCE_PRE_CLASS}"><pre class="mermaid">${body}</pre></div>`;
        },
        sync(container, code) {
          let diagram = container.querySelector(`.mermaid-diagram.${FORMING_FENCE_PRE_CLASS}`);
          if (!diagram) {
            container.replaceChildren();
            diagram = document.createElement("div");
            diagram.className = `mermaid-diagram mermaid-diagram--pending ${FORMING_FENCE_PRE_CLASS}`;
            const pre2 = document.createElement("pre");
            pre2.className = "mermaid";
            diagram.append(pre2);
            container.append(diagram);
          }
          const pre = diagram.querySelector("pre.mermaid");
          if (pre)
            pre.textContent = code;
        }
      }
    };
    mathFenceHandler = {
      render(code) {
        return mathBlockHtml(code.trimEnd());
      },
      forming: {
        html(code) {
          return mathBlockHtml(code, FORMING_FENCE_PRE_CLASS);
        },
        sync(container, code) {
          syncFormingMathBlockDom(container, code, FORMING_FENCE_PRE_CLASS);
        }
      }
    };
    BUILTIN_FENCE_HANDLERS = /* @__PURE__ */ new Map([
      ["mermaid", mermaidFenceHandler],
      ["math", mathFenceHandler]
    ]);
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/highlight.js
function lookup(table, key) {
  return Object.hasOwn(table, key) ? table[key] : void 0;
}
function resolveLanguage(lang, highlighter) {
  const key = lang.trim().toLowerCase();
  if (!key)
    return null;
  const canonical = lookup(LANG_SYNONYMS, key) ?? key;
  if (canonical === "plaintext")
    return null;
  if (highlighter?.supports?.(canonical))
    return canonical;
  const resolved = lookup(LANG_FALLBACKS, canonical) ?? canonical;
  return KNOWN_LANGUAGES.has(resolved) ? resolved : null;
}
function highlightFenceCode(code, lang) {
  if (code === "")
    return "";
  if (code.trim() === "")
    return escapeHtml(code);
  const highlighter = activeConfig().codeHighlighter;
  const language = resolveLanguage(lang, highlighter);
  if (!highlighter)
    return escapeHtml(code);
  if (language)
    return highlighter.highlight(code, language);
  if (!lang.trim())
    return highlighter.highlightAuto(code);
  return escapeHtml(code);
}
function fenceCodeClass(lang) {
  const language = resolveLanguage(lang, activeConfig().codeHighlighter);
  const label = language ?? (lang.trim() ? lang.trim().toLowerCase() : "text");
  return `hljs lang-${escapeHtml(label)}`;
}
var KNOWN_LANGUAGES, LANG_SYNONYMS, LANG_FALLBACKS;
var init_highlight = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/highlight.js"() {
    init_config();
    init_escape();
    KNOWN_LANGUAGES = /* @__PURE__ */ new Set([
      "typescript",
      "javascript",
      "bash",
      "shell",
      "json",
      "python",
      "css",
      "xml",
      "markdown",
      "yaml",
      "rust",
      "go",
      "sql"
    ]);
    LANG_SYNONYMS = {
      ts: "typescript",
      js: "javascript",
      mjs: "javascript",
      cjs: "javascript",
      sh: "bash",
      zsh: "bash",
      py: "python",
      yml: "yaml",
      md: "markdown",
      rs: "rust",
      text: "plaintext",
      plaintext: "plaintext"
    };
    LANG_FALLBACKS = {
      tsx: "typescript",
      jsx: "javascript",
      html: "xml",
      htm: "xml"
    };
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/indented-html.js
function leadingSpaces(line) {
  return line.match(/^ */)?.[0].length ?? 0;
}
function dedentBlock(content) {
  const lines = content.split("\n");
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === "")
      continue;
    min = Math.min(min, leadingSpaces(line));
  }
  if (!Number.isFinite(min) || min === 0)
    return content;
  return lines.map((line) => line.slice(Math.min(min, leadingSpaces(line)))).join("\n");
}
function isIndentedHtmlBlock(content) {
  const first = dedentBlock(content).split("\n").find((line) => line.trim() !== "");
  return first !== void 0 && HTML_BLOCK_START_RE.test(first);
}
var HTML_BLOCK_TAGS, HTML_BLOCK_START_RE;
var init_indented_html = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/indented-html.js"() {
    HTML_BLOCK_TAGS = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
    HTML_BLOCK_START_RE = new RegExp(`^</?(?:${HTML_BLOCK_TAGS})(?:[\\s/>]|$)`, "i");
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/raw-images.js
function parseHtmlAttributes(tag) {
  const attrs = {};
  const decodedTag = decodeEscapedHref(tag);
  for (const match of decodedTag.matchAll(/\b([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = match[1];
    if (name === void 0)
      continue;
    attrs[name.toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  return attrs;
}
function extractRawImages(text) {
  const renderer = activeConfig().rawImageRenderer;
  if (!renderer)
    return { text, images: [] };
  const images = [];
  const out = text.replace(RAW_IMAGE_RE, (tag) => {
    const replacement = renderer({ tag, attrs: parseHtmlAttributes(tag) });
    if (replacement == null)
      return tag;
    const index = images.push(replacement) - 1;
    return `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;
  });
  return { text: out, images };
}
function restoreRawImages(text, images) {
  if (images.length === 0)
    return text;
  return text.replace(PLACEHOLDER_RE, (_match, index) => images[Number(index)] ?? "");
}
var RAW_IMAGE_RE, PLACEHOLDER_OPEN, PLACEHOLDER_CLOSE, PLACEHOLDER_RE;
var init_raw_images = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/raw-images.js"() {
    init_config();
    init_escape();
    RAW_IMAGE_RE = /(?:<img\b[\s\S]*?\/?>|&lt;img\b[\s\S]*?\/?&gt;)/gi;
    PLACEHOLDER_OPEN = "\uFFF9";
    PLACEHOLDER_CLOSE = "\uFFFB";
    PLACEHOLDER_RE = /￹(\d+)￻/g;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/autolink-syntax.js
function isEmailAutolinksEnabled() {
  return activeConfig().emailAutolinks ?? true;
}
var init_autolink_syntax = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/autolink-syntax.js"() {
    init_config();
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/workspace-link-href.js
function workspaceLinkTargetFromHref(raw) {
  let pathPart = raw.trim();
  if (pathPart === "" || pathPart.startsWith("#") || pathPart.startsWith("//"))
    return null;
  if (URL_SCHEME_RE.test(pathPart))
    return null;
  const hashIdx = pathPart.indexOf("#");
  if (hashIdx >= 0)
    pathPart = pathPart.slice(0, hashIdx);
  if (pathPart === "")
    return null;
  let line;
  let column;
  const lineMatch = pathPart.match(/:(\d{1,9})(?::(\d{1,9}))?$/);
  if (lineMatch?.[1] && pathPart.includes("/")) {
    const suffix = lineMatch[0];
    const pathOnly = pathPart.slice(0, pathPart.length - suffix.length);
    if (pathOnly !== "" && !pathOnly.endsWith(":")) {
      pathPart = pathOnly;
      line = Number(lineMatch[1]);
      if (lineMatch[2] !== void 0)
        column = Number(lineMatch[2]);
    }
  }
  let normalized = pathPart;
  if (normalized.startsWith("./"))
    normalized = normalized.slice(2);
  if (normalized.startsWith("/"))
    normalized = normalized.slice(1);
  if (normalized === "" || normalized.includes("\\"))
    return null;
  if (normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return {
    candidate: normalized,
    ...line !== void 0 ? { line } : {},
    ...column !== void 0 ? { column } : {}
  };
}
function isWorkspaceMarkdownLinkHref(raw) {
  const target = workspaceLinkTargetFromHref(raw);
  if (!target)
    return false;
  const segments = target.candidate.split("/");
  if (segments.length === 1 && COMMONMARK_FIXTURE_SINGLE_SEGMENTS.has(segments[0] ?? "")) {
    return false;
  }
  return true;
}
var URL_SCHEME_RE, COMMONMARK_FIXTURE_SINGLE_SEGMENTS;
var init_workspace_link_href = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/workspace-link-href.js"() {
    URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
    COMMONMARK_FIXTURE_SINGLE_SEGMENTS = /* @__PURE__ */ new Set(["uri", "url"]);
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-links.js
function lookupWithRenderedLabels(refs, label, renderForMatch) {
  const direct = lookupLinkReference(refs, label);
  if (direct || !renderForMatch || !label.includes("<") || !isValidReferenceLabel(label)) {
    return direct;
  }
  let index = renderedLabelIndexCache.get(refs);
  if (!index) {
    index = /* @__PURE__ */ new Map();
    for (const [key, ref] of refs) {
      const renderedKey = normalizeReferenceLabel(decodeEscapes(renderForMatch(key)));
      if (!index.has(renderedKey))
        index.set(renderedKey, ref);
    }
    renderedLabelIndexCache.set(refs, index);
  }
  return index.get(normalizeReferenceLabel(decodeEscapes(label)));
}
function activeSafeHrefSchemes() {
  const source = activeConfig().safeHrefSchemes;
  if (source == null)
    return DEFAULT_SAFE_HREF_SCHEMES_SET;
  if (source !== cachedSchemesSource) {
    cachedSchemesSource = source;
    cachedSchemes = new Set(Array.from(source, (scheme) => scheme.toLowerCase()));
  }
  return cachedSchemes;
}
function isAllowedHref(href) {
  const scheme = HREF_SCHEME_RE.exec(href)?.[1];
  return scheme === void 0 || activeSafeHrefSchemes().has(scheme.toLowerCase());
}
function safeLinkHref(raw) {
  const href = decodeHtmlCharRefs(decodeEscapedPunctuationRaw(decodeEscapedHref(raw))).trim();
  if (!isAllowedHref(href))
    return null;
  return percentEncodeHref(href);
}
function renderAnchor(label, href, title) {
  const decoration = {
    href,
    // `exactOptionalPropertyTypes`: omit `title` rather than pass an explicit undefined.
    ...title === void 0 ? {} : { title }
  };
  const decorator = activeConfig().linkDecorator ?? neutralLinkDecorator;
  const attrs = decorator(decoration);
  return `<a href="${escapeHtml(href)}"${attrs}>${label}</a>`;
}
function renderedLink(label, href, title) {
  return renderAnchor(label, href, title);
}
function imageAltText(renderedLabel) {
  return renderedLabel.replace(/<img\b[^>]*?\salt="([^"]*)"[^>]*>/gi, (_match, nested) => decodeEscapedHref(nested)).replace(/<[^>]*>/g, "");
}
function renderedImage(alt, src, title) {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(imageAltText(alt))}"${titleAttr} data-md-rendered="1" />`;
}
function renderLinkLabel(label, refs, renderLabel) {
  return renderLabel(label, refs);
}
function labelContainsNestedLink(label, refs) {
  if (RENDERED_ANCHOR_RE.test(label))
    return true;
  let i = 0;
  while (i < label.length) {
    if (label[i] === "!" && label[i + 1] === "[") {
      const image = tryParseLinkOrImage(label, i, refs, (inner) => inner);
      if (image) {
        i = image.end;
        continue;
      }
    }
    if (label[i] === "[") {
      const parsed = tryParseLinkOrImage(label, i, refs, (inner) => inner, { linksOnly: true });
      if (parsed)
        return true;
    }
    i++;
  }
  return false;
}
function linkOrImageStartsAt(text, start, refs = /* @__PURE__ */ new Map()) {
  return tryParseLinkOrImage(text, start, refs, (label) => label) !== null;
}
function linkOrImageEndAt(text, start, refs = /* @__PURE__ */ new Map()) {
  return tryParseLinkOrImage(text, start, refs, (label) => label)?.end ?? null;
}
function parseBracketedLabelOutsideInlineCode(text, start) {
  if (text[start] !== "[")
    return null;
  const shieldRanges = inlineShieldRanges(text);
  let i = start + 1;
  let depth = 1;
  while (i < text.length && depth > 0) {
    const shieldRange = rangeAt(i, shieldRanges);
    if (shieldRange) {
      i = shieldRange.end;
      continue;
    }
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === "[")
      depth++;
    else if (ch === "]")
      depth--;
    i++;
  }
  if (depth !== 0)
    return null;
  return { label: text.slice(start + 1, i - 1), end: i };
}
function tryParseLinkOrImage(text, start, refs, renderLabel, options = {}) {
  const image = !options.linksOnly && text[start] === "!" && text[start + 1] === "[";
  const bracketStart = image ? start + 1 : start;
  if (text[bracketStart] !== "[")
    return null;
  const labelPart = parseBracketedLabelOutsideInlineCode(text, bracketStart);
  if (!labelPart)
    return null;
  const j = labelPart.end;
  if (text[j] === "(") {
    const dest = parseInlineLinkDestination(text, j);
    if (dest) {
      const href2 = safeLinkHref(dest.href);
      if (href2 === null)
        return null;
      if (!image && labelContainsNestedLink(labelPart.label, refs))
        return null;
      const label2 = renderLinkLabel(labelPart.label, refs, renderLabel);
      const html2 = image ? renderedImage(label2, href2, dest.title) : renderedLink(label2, href2, dest.title);
      return { html: html2, end: dest.end };
    }
  }
  if (text[j] === "[") {
    const refLabel = parseReferenceLabel(text, j, labelPart.label);
    if (!refLabel)
      return null;
    const ref2 = lookupWithRenderedLabels(refs, refLabel.label, options.renderForMatch);
    if (!ref2)
      return null;
    const href2 = safeLinkHref(ref2.href);
    if (href2 === null)
      return null;
    if (!image && labelContainsNestedLink(labelPart.label, refs))
      return null;
    const label2 = renderLinkLabel(labelPart.label, refs, renderLabel);
    const html2 = image ? renderedImage(label2, href2, ref2.title) : renderedLink(label2, href2, ref2.title);
    return { html: html2, end: refLabel.end };
  }
  const ref = lookupWithRenderedLabels(refs, labelPart.label, options.renderForMatch);
  if (!ref)
    return null;
  const href = safeLinkHref(ref.href);
  if (href === null)
    return null;
  if (!image && labelContainsNestedLink(labelPart.label, refs))
    return null;
  const label = renderLinkLabel(labelPart.label, refs, renderLabel);
  const html = image ? renderedImage(label, href, ref.title) : renderedLink(label, href, ref.title);
  return { html, end: labelPart.end };
}
function renderInlineLinks(text, refs, renderLabel, renderForMatch) {
  const shieldRanges = inlineShieldRanges(text);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const shieldRange = rangeAt(i, shieldRanges);
    if (shieldRange) {
      out += text.slice(i, shieldRange.end);
      i = shieldRange.end;
      continue;
    }
    const imageAt = text[i] === "!" && text[i + 1] === "[";
    const linkAt = text[i] === "[";
    if (imageAt || linkAt) {
      const parsed = tryParseLinkOrImage(text, i, refs, renderLabel, { renderForMatch });
      if (parsed) {
        out += parsed.html;
        i = parsed.end;
        continue;
      }
    }
    out += text[i] ?? "";
    i++;
  }
  return out;
}
function inlineShieldRanges(text) {
  const ranges = [];
  for (const match of text.matchAll(INLINE_SHIELD_RE)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}
function rangeAt(index, ranges) {
  return ranges.find((range) => index >= range.start && index < range.end);
}
var renderedLabelIndexCache, DEFAULT_SAFE_HREF_SCHEMES, HREF_SCHEME_RE, DEFAULT_SAFE_HREF_SCHEMES_SET, cachedSchemesSource, cachedSchemes, neutralLinkDecorator, appLinkDecorator, RENDERED_ANCHOR_RE, INLINE_SHIELD_RE;
var init_inline_links = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-links.js"() {
    init_backslash_escapes();
    init_config();
    init_escape();
    init_workspace_link_href();
    init_link_references();
    renderedLabelIndexCache = /* @__PURE__ */ new WeakMap();
    DEFAULT_SAFE_HREF_SCHEMES = [
      "http",
      "https",
      "mailto",
      "tel",
      "sms",
      "ftp",
      "ftps"
    ];
    HREF_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
    DEFAULT_SAFE_HREF_SCHEMES_SET = new Set(DEFAULT_SAFE_HREF_SCHEMES);
    cachedSchemes = DEFAULT_SAFE_HREF_SCHEMES_SET;
    neutralLinkDecorator = ({ title }) => title ? ` title="${escapeHtml(title)}"` : "";
    appLinkDecorator = ({ href, title }) => {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return isWorkspaceMarkdownLinkHref(href) ? ` class="workspace-markdown-link" data-workspace-link="true"${titleAttr}` : ` target="_blank" rel="noopener noreferrer" data-browser-link="true"${titleAttr}`;
    };
    RENDERED_ANCHOR_RE = /<a\b[\s\S]*?<\/a>/i;
    INLINE_SHIELD_RE = /<code>[\s\S]*?<\/code>|<a\b[\s\S]*?<\/a>|<img\b[^>]*>/g;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-passes.js
function getInlinePasses(stage) {
  const passes = activeConfig().inlinePasses ?? NO_PASSES;
  if (stage === void 0)
    return passes;
  return passes.filter((pass) => (pass.stage ?? "before-links") === stage);
}
function beginInlinePassRender(text) {
  emitted.clear();
  nextEmitId = 0;
  return text.replace(TOKEN_CHAR_RE, "");
}
function restoreInlinePassHtml(text) {
  if (emitted.size === 0)
    return text;
  return text.replace(TOKEN_RE, (_match, id) => emitted.get(Number(id)) ?? "");
}
var NO_PASSES, TOKEN_OPEN, TOKEN_CLOSE, TOKEN_RE, TOKEN_CHAR_RE, emitted, nextEmitId, inlinePassContext;
var init_inline_passes = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-passes.js"() {
    init_config();
    NO_PASSES = [];
    TOKEN_OPEN = "\uE100";
    TOKEN_CLOSE = "\uE101";
    TOKEN_RE = /\uE100(\d+)\uE101/g;
    TOKEN_CHAR_RE = /[\uE100\uE101]/g;
    emitted = /* @__PURE__ */ new Map();
    nextEmitId = 0;
    inlinePassContext = {
      emit(html) {
        const id = nextEmitId++;
        emitted.set(id, html);
        return `${TOKEN_OPEN}${id}${TOKEN_CLOSE}`;
      }
    };
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-math.js
function inlineHtmlMask(text) {
  const mask = new Array(text.length).fill(false);
  for (const match of text.matchAll(INLINE_HTML_SHIELD_RE)) {
    for (let i = match.index; i < match.index + match[0].length; i++)
      mask[i] = true;
  }
  return mask;
}
function isContentBarrier(ch) {
  return ch === "\n" || ch === "\uFFFE";
}
function isAsciiDigit(ch) {
  return ch >= "0" && ch <= "9";
}
function isWhitespaceChar(ch) {
  return ch === "" || /\s/.test(ch);
}
function mathInlineHtml(source) {
  return `<span class="math-inline math-inline--pending">${escapeHtml(source)}</span>`;
}
function emitMathSpan(rawContent) {
  return inlinePassContext.emit(mathInlineHtml(canonicalizeEscapedPunctuation(rawContent)));
}
function findDollarClose(text, openEnd, runLen, mask) {
  let k = openEnd;
  while (k < text.length) {
    const ch = text[k] ?? "";
    if (mask[k] || isContentBarrier(ch))
      return -1;
    if (ch === "$") {
      let runEnd = k;
      while (runEnd < text.length && text[runEnd] === "$" && !mask[runEnd])
        runEnd++;
      if (runEnd - k === runLen)
        return k;
      k = runEnd;
      continue;
    }
    k++;
  }
  return -1;
}
function findParenClose(text, openEnd, mask) {
  for (let k = openEnd; k < text.length; k++) {
    const ch = text[k] ?? "";
    if (mask[k] || isContentBarrier(ch))
      return -1;
    if (ch === ESCAPED_RPAREN)
      return k;
  }
  return -1;
}
function dollarGuardsPass(text, openEnd, close, runLen) {
  if (!/\S/.test(text.slice(openEnd, close)))
    return false;
  if (runLen === 2)
    return true;
  if (isWhitespaceChar(text[openEnd] ?? ""))
    return false;
  if (isWhitespaceChar(text[close - 1] ?? ""))
    return false;
  if (isAsciiDigit(text[close + runLen] ?? ""))
    return false;
  return true;
}
function renderInlineMathSpans(text, linkRefs = /* @__PURE__ */ new Map()) {
  if (!isMathSyntaxEnabled())
    return text;
  if (!text.includes("$") && !text.includes(ESCAPED_LPAREN))
    return text;
  const mask = maskLinkSpans(text, inlineHtmlMask(text), linkRefs);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (mask[i]) {
      out += ch;
      i++;
      continue;
    }
    if (ch === ESCAPED_LPAREN) {
      const close = findParenClose(text, i + 1, mask);
      if (close !== -1 && /\S/.test(text.slice(i + 1, close))) {
        out += emitMathSpan(text.slice(i + 1, close));
        i = close + 1;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === "$") {
      let runEnd = i;
      while (runEnd < text.length && text[runEnd] === "$" && !mask[runEnd])
        runEnd++;
      const runLen = runEnd - i;
      if (runLen <= 2) {
        const close = findDollarClose(text, runEnd, runLen, mask);
        if (close !== -1 && dollarGuardsPass(text, runEnd, close, runLen)) {
          out += emitMathSpan(text.slice(runEnd, close));
          i = close + runLen;
          continue;
        }
      }
      out += text.slice(i, runEnd);
      i = runEnd;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
function isEscapedAt(s, i) {
  let backslashes = 0;
  for (let k = i - 1; k >= 0 && s[k] === "\\"; k--)
    backslashes++;
  return backslashes % 2 === 1;
}
function findRawDollarClose(s, openEnd, runLen, mask) {
  let k = openEnd;
  while (k < s.length) {
    const ch = s[k] ?? "";
    if (mask[k] || isContentBarrier(ch))
      return -1;
    if (ch === "$" && !isEscapedAt(s, k)) {
      let runEnd = k;
      while (runEnd < s.length && s[runEnd] === "$" && !mask[runEnd])
        runEnd++;
      if (runEnd - k === runLen && dollarGuardsPass(s, openEnd, k, runLen))
        return k;
      k = runEnd;
      continue;
    }
    k++;
  }
  return -1;
}
function findRawParenClose(s, openEnd, mask) {
  for (let k = openEnd; k < s.length - 1; k++) {
    const ch = s[k] ?? "";
    if (mask[k] || isContentBarrier(ch))
      return -1;
    if (ch === "\\" && s[k + 1] === ")" && !isEscapedAt(s, k))
      return k;
  }
  return -1;
}
function mathHoldStart(s, mask) {
  if (!isMathSyntaxEnabled())
    return s.length;
  let i = 0;
  while (i < s.length) {
    if (mask[i]) {
      i++;
      continue;
    }
    const ch = s[i] ?? "";
    if (ch === "\\" && s[i + 1] === "(" && !isEscapedAt(s, i)) {
      const close = findRawParenClose(s, i + 2, mask);
      if (close === -1)
        return i;
      i = close + 2;
      continue;
    }
    if (ch === "$" && !isEscapedAt(s, i)) {
      let runEnd = i;
      while (runEnd < s.length && s[runEnd] === "$" && !mask[runEnd])
        runEnd++;
      const runLen = runEnd - i;
      if (runLen > 2) {
        i = runEnd;
        continue;
      }
      const close = findRawDollarClose(s, runEnd, runLen, mask);
      if (close !== -1) {
        i = close + runLen;
        continue;
      }
      if (runLen === 2)
        return i;
      const next = s[runEnd] ?? "";
      if (runEnd === s.length) {
        if (!isAsciiDigit(s[i - 1] ?? ""))
          return i;
      } else if (!isWhitespaceChar(next) && !isAsciiDigit(next)) {
        return i;
      }
      i = runEnd;
      continue;
    }
    i++;
  }
  return s.length;
}
var ESCAPED_LPAREN, ESCAPED_RPAREN;
var init_inline_math = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-math.js"() {
    init_backslash_escapes();
    init_escape();
    init_inline_emphasis();
    init_inline_passes();
    init_math_syntax();
    ESCAPED_LPAREN = "\uE028";
    ESCAPED_RPAREN = "\uE029";
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-strikethrough.js
function inlineHtmlMask2(text) {
  const mask = new Array(text.length).fill(false);
  for (const match of text.matchAll(INLINE_HTML_SHIELD_RE)) {
    for (let i = match.index; i < match.index + match[0].length; i++)
      mask[i] = true;
  }
  return mask;
}
function readTildeRuns(s, mask) {
  const runs = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "~" || mask[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] === "~" && !mask[j])
      j++;
    const len = j - i;
    if (len === 2) {
      const prev = i > 0 ? s[i - 1] ?? "" : "";
      const next = j < s.length ? s[j] ?? "" : "";
      runs.push({
        start: i,
        end: j,
        canOpen: isLeftFlanking(prev, next),
        canClose: isRightFlanking(prev, next)
      });
    }
    i = j;
  }
  return runs;
}
function pairTildeRuns(runs) {
  const stack = [];
  const matches = [];
  for (const run of runs) {
    if (run.canClose && stack.length > 0) {
      const opener = stack.pop();
      if (opener)
        matches.push({ open: opener.start, close: run.start });
      continue;
    }
    if (run.canOpen)
      stack.push(run);
  }
  return { matches, open: stack };
}
function renderStrikethrough(text) {
  if (!text.includes("~~"))
    return text;
  const mask = inlineHtmlMask2(text);
  const { matches } = pairTildeRuns(readTildeRuns(text, mask));
  if (matches.length === 0)
    return text;
  const openAt = new Set(matches.map((m) => m.open));
  const closeAt = new Set(matches.map((m) => m.close));
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (openAt.has(i)) {
      out += "<del>";
      i += 2;
      continue;
    }
    if (closeAt.has(i)) {
      out += "</del>";
      i += 2;
      continue;
    }
    out += text[i] ?? "";
    i++;
  }
  return out;
}
function strikethroughHoldStart(s, mask) {
  const { matches, open } = pairTildeRuns(readTildeRuns(s, mask));
  let cut = s.length;
  const firstOpen = open[0];
  if (firstOpen)
    cut = Math.min(cut, firstOpen.start);
  if (s.length > 0 && s[s.length - 1] === "~" && !mask[s.length - 1]) {
    let t = s.length;
    while (t > 0 && s[t - 1] === "~" && !mask[t - 1])
      t--;
    const runLen = s.length - t;
    if (runLen === 1 || runLen === 2 && !matches.some((m) => m.close === t)) {
      cut = Math.min(cut, t);
    }
  }
  return cut;
}
var init_inline_strikethrough = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-strikethrough.js"() {
    init_inline_emphasis();
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-emphasis.js
function isFlankingWhitespace(ch) {
  return ch === "" || ch === HARD_BREAK_SENTINEL || /\s/.test(ch);
}
function isFlankingPunctuation(ch) {
  if (ch === "" || !UNICODE_PUNCTUATION_RE.test(ch))
    return false;
  const exclusion = activeConfig().flankingPunctuationExclusion;
  if (exclusion != null && exclusion(ch))
    return false;
  return true;
}
function isLeftFlanking(prev, next) {
  return !isFlankingWhitespace(next) && (!isFlankingPunctuation(next) || isFlankingWhitespace(prev) || isFlankingPunctuation(prev));
}
function isRightFlanking(prev, next) {
  return !isFlankingWhitespace(prev) && (!isFlankingPunctuation(prev) || isFlankingWhitespace(next) || isFlankingPunctuation(next));
}
function readDelimiterRun(s, i, limit, mask, linkRefs, mode) {
  const ch = s[i];
  if (ch === void 0 || ch !== "*" && ch !== "_" || mask[i])
    return null;
  let j = i;
  while (j < limit && s[j] === ch && !mask[j])
    j++;
  const len = j - i;
  const prev = i > 0 ? s[i - 1] ?? "" : "";
  const next = j < s.length ? s[j] ?? "" : "";
  const lf = isLeftFlanking(prev, next);
  const rf = isRightFlanking(prev, next);
  const linkBeatsEmphasis = mode === "hold" && ch === "*" && lf && next === "[" && linkOrImageStartsAt(s, j, linkRefs);
  const canOpen = ch === "*" ? lf && !linkBeatsEmphasis : lf && (!rf || isFlankingPunctuation(prev));
  const canClose = ch === "*" ? rf : rf && (!lf || isFlankingPunctuation(next));
  return { char: ch, start: i, end: j, len, canOpen, canClose };
}
function findMatchingOpener(stack, ch, allowed) {
  for (let t = stack.length - 1; t >= 0; t--) {
    const open = stack[t];
    if (open?.char === ch && (!allowed || allowed(open)))
      return t;
  }
  return -1;
}
function emphasisSpansNewline(s) {
  const { mask } = scanCodeSpans(s);
  const matches = scanDelimiterMatches(s, mask, /* @__PURE__ */ new Map());
  return matches.some((m) => s.slice(m.openIndex, m.closeIndex + m.closeLen).includes("\n"));
}
function emphasisMatchAllowed(open, closeLen, canOpen, canClose) {
  if (!(canOpen || canClose))
    return true;
  if (closeLen % 3 === 0)
    return true;
  return (open.len + closeLen) % 3 !== 0;
}
function handleCloseRemainder(s, stack, matches, ch, closeStart, used, closeLen) {
  const remainder = closeLen - used;
  if (remainder <= 0)
    return;
  const remIndex = closeStart + used;
  const remPrev = remIndex > 0 ? s[remIndex - 1] ?? "" : "";
  const remNext = remIndex + remainder < s.length ? s[remIndex + remainder] ?? "" : "";
  const remLf = isLeftFlanking(remPrev, remNext);
  const remRf = isRightFlanking(remPrev, remNext);
  const remCanOpen = ch === "*" ? remLf : remLf && (!remRf || isFlankingPunctuation(remPrev));
  const remCanClose = ch === "*" ? remRf : remRf && (!remLf || isFlankingPunctuation(remNext));
  const remMatched = remCanClose ? findMatchingOpener(stack, ch, (open) => emphasisMatchAllowed(open, remainder, remCanOpen, open.canClose)) : -1;
  const remOpen = remMatched >= 0 ? stack[remMatched] : void 0;
  if (remOpen) {
    const remOpenRunLen = remOpen.len;
    const remUsed = Math.min(remOpen.len, remainder);
    const remPrefix = remOpenRunLen - remUsed;
    matches.push({
      openIndex: remOpen.index + remPrefix,
      closeIndex: remIndex,
      openLen: remUsed,
      closeLen: remUsed,
      openRunLen: remOpenRunLen,
      char: ch
    });
    stack.length = remMatched;
    if (remPrefix > 0) {
      stack.push({
        index: remOpen.index,
        char: ch,
        len: remPrefix,
        canClose: remOpen.canClose
      });
    }
    const remRemainder = remainder - remUsed;
    if (remRemainder > 0 && remCanOpen) {
      stack.push({
        index: remIndex + remUsed,
        char: ch,
        len: remRemainder,
        canClose: remRf
      });
    }
  } else if (remCanOpen) {
    stack.push({ index: remIndex, char: ch, len: remainder, canClose: remRf });
  }
}
function walkEmphasisDelimiters(s, limit, mask, mode, linkRefs) {
  const matches = [];
  const stack = [];
  let trailingConsumed = false;
  let i = 0;
  while (i < limit) {
    const run = readDelimiterRun(s, i, limit, mask, linkRefs, mode);
    if (!run) {
      i++;
      continue;
    }
    const { char: ch, start, end: j, len, canOpen, canClose } = run;
    const matched = canClose ? findMatchingOpener(stack, ch, mode === "render" ? (open2) => emphasisMatchAllowed(open2, len, canOpen, open2.canClose) : void 0) : -1;
    const open = matched >= 0 ? stack[matched] : void 0;
    if (open) {
      const openRunLen = open.len;
      const used = Math.min(open.len, len);
      const remainingPrefixLen = openRunLen - used;
      if (mode === "render") {
        matches.push({
          openIndex: open.index + remainingPrefixLen,
          closeIndex: start,
          openLen: used,
          closeLen: used,
          openRunLen,
          char: ch
        });
      }
      stack.length = matched;
      if (remainingPrefixLen > 0) {
        stack.push({
          index: open.index,
          char: ch,
          len: remainingPrefixLen,
          canClose: open.canClose
        });
      }
      if (mode === "render") {
        handleCloseRemainder(s, stack, matches, ch, start, used, len);
      } else if (j === s.length) {
        trailingConsumed = true;
      }
    } else if (canOpen) {
      stack.push({ index: start, char: ch, len, canClose });
    }
    i = j;
  }
  return { matches, stack, trailingConsumed };
}
function scanDelimiterMatches(s, mask, linkRefs) {
  return walkEmphasisDelimiters(s, s.length, mask, "render", linkRefs).matches;
}
function trailingDelimiterStart(s, mask) {
  let tStart = s.length;
  while (tStart > 0 && (s[tStart - 1] === "*" || s[tStart - 1] === "_") && !mask[tStart - 1]) {
    tStart--;
  }
  return tStart;
}
function wrapEmphasis(inner, openLen, closeLen) {
  const used = Math.min(openLen, closeLen);
  if (used === 0)
    return inner;
  let out = inner;
  let remaining = used;
  while (remaining >= 2) {
    out = `<strong>${out}</strong>`;
    remaining -= 2;
  }
  if (remaining >= 1) {
    out = `<em>${out}</em>`;
  }
  return out;
}
function matchEnd(m) {
  return m.closeIndex + m.closeLen;
}
function isNestedIn(child, parent) {
  const childEnd = matchEnd(child);
  const parentEnd = matchEnd(parent);
  if (childEnd > parentEnd)
    return false;
  if (child.openIndex >= parent.openIndex && childEnd <= parentEnd)
    return true;
  return child.openIndex < parent.openIndex && childEnd > parent.openIndex;
}
function findRootMatches(matches) {
  const sorted = [...matches].sort((a, b) => matchEnd(b) - matchEnd(a) || a.openIndex - b.openIndex);
  const roots = [];
  for (const m of sorted) {
    if (!roots.some((root) => isNestedIn(m, root)))
      roots.push(m);
  }
  return roots.sort((a, b) => a.openIndex - b.openIndex);
}
function assembleMatch(s, m, allMatches) {
  const contentStart = m.openIndex + m.openLen;
  const contentEnd = m.closeIndex;
  const descendants = allMatches.filter((c) => c !== m && isNestedIn(c, m));
  const children = findRootMatches(descendants);
  let out = "";
  let cursor = contentStart;
  for (const child of children) {
    out += s.slice(cursor, child.openIndex);
    out += assembleMatch(s, child, allMatches);
    cursor = matchEnd(child);
  }
  out += s.slice(cursor, contentEnd);
  return wrapEmphasis(out.replace(/\n/g, " "), m.openLen, m.closeLen);
}
function maskLinkSpans(s, mask, linkRefs) {
  let extended = null;
  let i = 0;
  while (i < s.length) {
    if (mask[i]) {
      i++;
      continue;
    }
    if (s[i] === "[" || s[i] === "!" && s[i + 1] === "[") {
      const end = linkOrImageEndAt(s, i, linkRefs);
      if (end !== null) {
        extended ??= [...mask];
        for (let k = i; k < end; k++)
          extended[k] = true;
        i = end;
        continue;
      }
    }
    i++;
  }
  return extended ?? mask;
}
function renderEmphasisSegment(s, mask, linkRefs) {
  const matches = scanDelimiterMatches(s, maskLinkSpans(s, mask, linkRefs), linkRefs);
  if (matches.length === 0)
    return s;
  const roots = findRootMatches(matches);
  let out = "";
  let i = 0;
  let rootIdx = 0;
  while (i < s.length) {
    const root = roots[rootIdx];
    if (root && i === root.openIndex) {
      out += assembleMatch(s, root, matches);
      i = matchEnd(root);
      rootIdx++;
      continue;
    }
    const next = root ? root.openIndex : s.length;
    out += s.slice(i, next);
    i = next;
  }
  return out;
}
function pendingHoldIndex(s) {
  const { mask, unresolvedAt } = scanCodeSpans(s);
  const limit = unresolvedAt ?? s.length;
  const { stack, trailingConsumed } = walkEmphasisDelimiters(s, limit, mask, "hold", /* @__PURE__ */ new Map());
  let cut = s.length;
  if (unresolvedAt !== null)
    cut = Math.min(cut, unresolvedAt);
  const firstOpen = stack[0];
  if (firstOpen)
    cut = Math.min(cut, firstOpen.index);
  if (!trailingConsumed) {
    cut = Math.min(cut, trailingDelimiterStart(s, mask));
  }
  const entityStart = trailingEntityHoldStart(s);
  if (entityStart < cut && !mask[entityStart])
    cut = entityStart;
  cut = Math.min(cut, strikethroughHoldStart(s, mask));
  cut = Math.min(cut, mathHoldStart(s, mask));
  cut = Math.min(cut, footnoteHoldStart(s, mask));
  if (getHtmlPolicy() === "passthrough") {
    cut = Math.min(cut, rawHtmlTagHoldStart(s, mask));
  }
  for (const pass of getInlinePasses()) {
    if (pass.holdStart)
      cut = Math.min(cut, pass.holdStart(s, mask));
  }
  return cut;
}
function inlineHtmlMask3(text) {
  const mask = new Array(text.length).fill(false);
  for (const match of text.matchAll(INLINE_HTML_SHIELD_RE)) {
    for (let i = match.index; i < match.index + match[0].length; i++)
      mask[i] = true;
  }
  return mask;
}
function renderEmphasisOutsideInlineHtml(text, linkRefs = /* @__PURE__ */ new Map()) {
  return renderEmphasisSegment(text, inlineHtmlMask3(text), linkRefs);
}
var UNICODE_PUNCTUATION_RE, HARD_BREAK_SENTINEL, INLINE_HTML_SHIELD_RE;
var init_inline_emphasis = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-emphasis.js"() {
    init_backslash_escapes();
    init_config();
    init_escape();
    init_footnotes();
    init_html_policy();
    init_inline_code_spans();
    init_inline_links();
    init_inline_math();
    init_inline_passes();
    init_inline_strikethrough();
    UNICODE_PUNCTUATION_RE = /[\p{P}\p{S}]/u;
    HARD_BREAK_SENTINEL = "\uFFFE";
    INLINE_HTML_SHIELD_RE = /(<code>[\s\S]*?<\/code>|<a\b[\s\S]*?<\/a>|<img\b[^>]*>)/g;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-autolinks.js
function autolinkHref(raw) {
  if (!isAllowedHref(raw))
    return null;
  return encodeHrefForOutput(raw);
}
function renderedAutolink(label, href) {
  return `<a href="${escapeHtml(href)}">${label}</a>`;
}
function tryAngleAutolink(text, start) {
  if (text[start] !== "<")
    return null;
  const slice = text.slice(start);
  const uri = URI_AUTOLINK_RE.exec(slice);
  if (uri?.[1] !== void 0) {
    const href = autolinkHref(uri[1]);
    if (href === null)
      return null;
    return { html: renderedAutolink(uri[1], href), end: start + uri[0].length };
  }
  const email = EMAIL_AUTOLINK_RE.exec(slice);
  if (email?.[1] !== void 0) {
    const href = autolinkHref(`mailto:${email[1]}`);
    if (href === null)
      return null;
    return { html: renderedAutolink(email[1], href), end: start + email[0].length };
  }
  return null;
}
function renderAngleAutolinks(text) {
  return text.split(INLINE_HTML_SHIELD_RE).map((segment, index) => {
    if (index % 2 === 1)
      return segment;
    let out = "";
    let i = 0;
    while (i < segment.length) {
      const parsed = tryAngleAutolink(segment, i);
      if (parsed) {
        out += parsed.html;
        i = parsed.end;
        continue;
      }
      out += segment[i] ?? "";
      i++;
    }
    return out;
  }).join("");
}
var URI_AUTOLINK_RE, EMAIL_AUTOLINK_RE;
var init_inline_autolinks = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-autolinks.js"() {
    init_escape();
    init_inline_emphasis();
    init_inline_links();
    init_link_references();
    URI_AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/;
    EMAIL_AUTOLINK_RE = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-spans.js
function applyInlinePasses(t, stage) {
  const passes = getInlinePasses(stage);
  if (passes.length === 0)
    return t;
  for (const pass of passes) {
    t = t.split(INLINE_HTML_SHIELD_RE).map((segment, index) => index % 2 === 1 ? segment : pass.apply(segment, inlinePassContext)).join("");
  }
  return t;
}
function applyFootnoteRefs(t) {
  if (!isFootnotesEnabled() || !t.includes("[^"))
    return t;
  return t.split(INLINE_HTML_SHIELD_RE).map((segment, index) => index % 2 === 1 ? segment : renderFootnoteRefs(segment, (html) => inlinePassContext.emit(html))).join("");
}
function renderInlineSpansBeforeLinks(t, linkRefs) {
  t = encodeBackslashEscapes(t);
  t = renderInlineCode(t);
  t = renderAngleAutolinks(t);
  t = renderInlineMathSpans(t, linkRefs);
  t = renderEmphasisOutsideInlineHtml(t, linkRefs);
  t = renderStrikethrough(t);
  t = applyFootnoteRefs(t);
  t = applyInlinePasses(t, "before-links");
  return t;
}
function renderNestedInlineSpans(t, linkRefs) {
  t = renderInlineSpansBeforeLinks(t, linkRefs);
  t = renderInlineLinks(t, linkRefs, renderNestedInlineSpans, (label) => renderInlineSpansBeforeLinks(label, linkRefs));
  t = renderStrongAroundCode(t);
  t = renderStrongWithInlineHtml(t);
  t = renderExtendedAutolinks(t);
  t = applyInlinePasses(t, "after-links");
  return t;
}
function renderInlineSpans(t, linkRefs = /* @__PURE__ */ new Map()) {
  t = beginInlinePassRender(t);
  return decodeEscapedPunctuation(restoreInlinePassHtml(escapeHtmlTextNodes(renderNestedInlineSpans(t, linkRefs))));
}
function renderStrongAroundCode(text) {
  return text.replace(/\*\*(<code>[\s\S]*?<\/code>)\*\*/g, "<strong>$1</strong>");
}
function renderStrongWithInlineHtml(text) {
  return text.replace(/\*\*(?=\S)([^*\n]*<(?:code|a|img)\b[\s\S]*?(?:<\/(?:code|a)>|<img\b[^>]*>)[^*\n]*)\*\*/g, "<strong>$1</strong>");
}
function renderedBareLink(label, href) {
  return renderAnchor(label, href);
}
function splitBareUrlAtCjkBoundary(rawUrl) {
  const boundary = activeConfig().bareUrlCjkBoundary;
  if (boundary != null) {
    for (let i = 0; i < rawUrl.length; i++) {
      if (boundary(rawUrl[i] ?? ""))
        return { url: rawUrl.slice(0, i), tail: rawUrl.slice(i) };
    }
  }
  return { url: rawUrl, tail: "" };
}
function mapOutsideInlineHtml(text, fn) {
  return text.split(INLINE_HTML_SHIELD_RE).map((segment, index) => index % 2 === 1 ? segment : fn(segment)).join("");
}
function renderExtendedAutolinks(text) {
  const withUrls = mapOutsideInlineHtml(text, linkifyWwwAndUrlAutolinks);
  return isEmailAutolinksEnabled() ? mapOutsideInlineHtml(withUrls, linkifyEmailAutolinks) : withUrls;
}
function isExtendedAutolinkBoundary(prev) {
  return prev === void 0 || /\s/.test(prev) || prev === "*" || prev === "_" || prev === "~" || prev === "(" || prev === ">";
}
function wwwDomainIsValid(domain) {
  const segments = domain.split(".");
  return !segments.slice(-2).some((segment) => segment.includes("_"));
}
function trimAutolinkTail(link) {
  let end = link.length;
  let open = 0;
  let close = 0;
  for (let i = 0; i < link.length; i++) {
    if (link[i] === "(")
      open++;
    else if (link[i] === ")")
      close++;
  }
  while (end > 0) {
    const c = link[end - 1] ?? "";
    if (AUTOLINK_TRAILING_PUNCTUATION.has(c)) {
      end--;
      continue;
    }
    if (c === ")") {
      if (close <= open)
        break;
      close--;
      end--;
      continue;
    }
    if (c === ";") {
      let scan = end - 2;
      while (scan > 0 && /[A-Za-z]/.test(link[scan] ?? ""))
        scan--;
      if (scan < end - 2 && link[scan] === "&") {
        end = scan;
        continue;
      }
      end--;
      continue;
    }
    break;
  }
  return link.slice(0, end);
}
function buildExtendedAutolink(segment, start, schemePrefix) {
  let run = start;
  while (run < segment.length && !/\s/.test(segment[run] ?? "") && segment[run] !== "<")
    run++;
  const raw = segment.slice(start, run);
  const { url: beforeCjk, tail: cjkTail } = splitBareUrlAtCjkBoundary(raw);
  const url = trimAutolinkTail(beforeCjk);
  if (url === "")
    return null;
  const trailing = beforeCjk.slice(url.length);
  const href = safeLinkHref(schemePrefix + url);
  if (!href)
    return null;
  return { html: `${renderedBareLink(url, href)}${trailing}${cjkTail}`, end: run };
}
function linkifyWwwAndUrlAutolinks(segment) {
  let out = "";
  let i = 0;
  while (i < segment.length) {
    if (isExtendedAutolinkBoundary(i === 0 ? void 0 : segment[i - 1])) {
      const rest = segment.slice(i);
      const urlScheme = URL_SCHEME_RE2.exec(rest);
      if (urlScheme) {
        const after = segment[i + urlScheme[0].length];
        const schemedDomain = /^[A-Za-z0-9._-]+/.exec(rest.slice(urlScheme[0].length))?.[0] ?? "";
        if (after !== void 0 && !/\s/.test(after) && after !== "<" && schemedDomain !== "" && wwwDomainIsValid(schemedDomain)) {
          const built = buildExtendedAutolink(segment, i, "");
          if (built) {
            out += built.html;
            i = built.end;
            continue;
          }
        }
      } else {
        const www = WWW_DOMAIN_RE.exec(rest);
        if (www && wwwDomainIsValid(www[0])) {
          const built = buildExtendedAutolink(segment, i, "http://");
          if (built) {
            out += built.html;
            i = built.end;
            continue;
          }
        }
      }
    }
    out += segment[i] ?? "";
    i++;
  }
  return out;
}
function matchEmailAutolink(segment, at) {
  let start = at;
  while (start > 0 && EMAIL_LOCAL_CHAR_RE.test(segment[start - 1] ?? ""))
    start--;
  if (start === at)
    return { match: null, scanEnd: at + 1 };
  let dotCount = 0;
  let end = at;
  while (end < segment.length) {
    const c = segment[end] ?? "";
    if (/[A-Za-z0-9]/.test(c)) {
      end++;
    } else if (c === "@") {
      if (end > at)
        break;
      end++;
    } else if (c === "." && end < segment.length - 1 && /[A-Za-z0-9]/.test(segment[end + 1] ?? "")) {
      dotCount++;
      end++;
    } else if (c === "-" || c === "_") {
      end++;
    } else {
      break;
    }
  }
  const last = segment[end - 1] ?? "";
  if (end - at < 2 || dotCount === 0 || !/[A-Za-z]/.test(last) && last !== ".") {
    return { match: null, scanEnd: end };
  }
  const email = segment.slice(start, end);
  const href = safeLinkHref(`mailto:${email}`);
  if (!href)
    return { match: null, scanEnd: end };
  return { match: { html: renderedBareLink(email, href), start, end }, scanEnd: end };
}
function linkifyEmailAutolinks(segment) {
  if (!segment.includes("@"))
    return segment;
  let out = "";
  let emitted2 = 0;
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === "@") {
      const { match, scanEnd } = matchEmailAutolink(segment, i);
      if (match) {
        out += segment.slice(emitted2, match.start) + match.html;
        i = match.end;
        emitted2 = match.end;
        continue;
      }
      i = Math.max(i + 1, scanEnd);
      continue;
    }
    i++;
  }
  return out + segment.slice(emitted2);
}
var URL_SCHEME_RE2, WWW_DOMAIN_RE, AUTOLINK_TRAILING_PUNCTUATION, EMAIL_LOCAL_CHAR_RE;
var init_inline_spans = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/inline-spans.js"() {
    init_autolink_syntax();
    init_backslash_escapes();
    init_config();
    init_escape();
    init_inline_autolinks();
    init_inline_code_spans();
    init_inline_emphasis();
    init_inline_links();
    init_inline_math();
    init_inline_passes();
    init_inline_strikethrough();
    init_footnotes();
    URL_SCHEME_RE2 = /^(?:https?|ftp):\/\//i;
    WWW_DOMAIN_RE = /^www(?:\.[A-Za-z0-9_-]+)+/i;
    AUTOLINK_TRAILING_PUNCTUATION = /* @__PURE__ */ new Set(["?", "!", ".", ",", ":", "*", "_", "~", "'", '"']);
    EMAIL_LOCAL_CHAR_RE = /[A-Za-z0-9.+_-]/;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/render-prose-inline.js
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}
function markHardBreaks(text) {
  const { mask } = scanCodeSpans(text);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "<" && !mask[i]) {
      const tag = RAW_TAG_LIKE_RE.exec(text.slice(i))?.[0];
      if (tag) {
        out += tag;
        i += tag.length;
        continue;
      }
    }
    if (ch !== "\n" || mask[i] || i === text.length - 1) {
      out += ch;
      i++;
      continue;
    }
    let runStart = i;
    while (runStart > 0 && text[runStart - 1] === " " && !mask[runStart - 1])
      runStart--;
    const spaces = i - runStart;
    let breaks = spaces >= 2;
    if (spaces === 0) {
      while (runStart > 0 && text[runStart - 1] === "\\" && !mask[runStart - 1])
        runStart--;
      const backslashes = i - runStart;
      if (backslashes > 0 && backslashes % 2 === 1) {
        breaks = true;
        runStart = i - 1;
      } else {
        runStart = i;
      }
    }
    if (!breaks) {
      out += ch;
      i++;
      continue;
    }
    out = out.slice(0, out.length - (i - runStart)) + HARD_BREAK;
    i++;
    while (i < text.length && (text[i] === " " || text[i] === "	"))
      i++;
  }
  return out;
}
function mapTextOutsideHtmlTags(text, mapSegment) {
  const parts = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      parts.push(mapSegment(text.slice(i)));
      break;
    }
    if (lt > i)
      parts.push(mapSegment(text.slice(i, lt)));
    const gt = text.indexOf(">", lt);
    if (gt === -1) {
      parts.push(text.slice(lt));
      break;
    }
    parts.push(text.slice(lt, gt + 1));
    i = gt + 1;
  }
  return parts.join("");
}
function applyLineBreaks(text, softBreak) {
  return mapTextOutsideHtmlTags(text, (segment) => {
    let body = segment;
    if (softBreak === "space")
      body = body.replace(/\n/g, " ");
    else if (softBreak === "br")
      body = body.replace(/\n/g, "<br>");
    return body.replaceAll(HARD_BREAK, "<br>");
  });
}
function renderProseInline(text, options = {}) {
  const { softBreak = "newline", linkRefs = /* @__PURE__ */ new Map() } = options;
  const body = markHardBreaks(decodeSafeMarkdownEntities(stripHtmlComments(text)));
  const { text: withoutImages, images } = extractRawImages(body);
  const rendered = renderInlineSpans(withoutImages, linkRefs);
  return restoreRawImages(applyLineBreaks(rendered, softBreak), images);
}
function renderProseBlock(text, linkRefs, softBreak = "newline") {
  if (stripHtmlComments(text).trim() === "")
    return "";
  return renderProseInline(text, { softBreak, linkRefs });
}
var HARD_BREAK;
var init_render_prose_inline = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/render-prose-inline.js"() {
    init_backslash_escapes();
    init_escape();
    init_raw_images();
    init_inline_code_spans();
    init_inline_spans();
    HARD_BREAK = "\uFFFE";
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/table-wrapper.js
function resolveTableWrapper() {
  const value = activeConfig().tableWrapper;
  if (!value)
    return null;
  const options = value === true ? {} : value;
  return { className: options.className || "table-wrapper", label: options.label ?? "Table" };
}
function wrapTableHtml(tableHtml) {
  const wrapper = resolveTableWrapper();
  if (!wrapper)
    return tableHtml;
  return `<div class="${escapeHtml(wrapper.className)}" role="region" aria-label="${escapeHtml(wrapper.label)}" tabindex="0">${tableHtml}</div>`;
}
function createTableWrapperElement(wrapper) {
  const div = document.createElement("div");
  div.setAttribute("class", wrapper.className);
  div.setAttribute("role", "region");
  div.setAttribute("aria-label", wrapper.label);
  div.setAttribute("tabindex", "0");
  return div;
}
function withTableWrapperGate(config, hostAttr = []) {
  const wrapper = resolveTableWrapper();
  if (!wrapper)
    return config;
  const strip = ["role", "tabindex"].filter((name) => !hostAttr.includes(name));
  const gate = config.onElement;
  return {
    ...config,
    allowedAttr: [...config.allowedAttr, ...strip],
    onElement(node, tagName) {
      if (tagName === "div" && node.getAttribute("class") === wrapper.className && node.childElementCount === 1 && node.firstElementChild?.tagName === "TABLE") {
        node.setAttribute("role", "region");
        node.setAttribute("aria-label", wrapper.label);
        node.setAttribute("tabindex", "0");
      } else {
        for (const name of strip)
          node.removeAttribute?.(name);
      }
      gate?.(node, tagName);
    }
  };
}
var init_table_wrapper = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/table-wrapper.js"() {
    init_config();
    init_escape();
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/render-blocks.js
function renderFencedBlock(lang, code, forming = false) {
  const handler = getFenceHandler(lang);
  if (handler) {
    return forming && handler.forming ? handler.forming.html(code, lang) : handler.render(code, lang);
  }
  const body = highlightFenceCode(code, lang);
  const cls = forming ? ` class="${FORMING_FENCE_PRE_CLASS}"` : "";
  return `<pre${cls}><code class="${fenceCodeClass(lang)}">${body}</code></pre>`;
}
function onlyWhitespaceAfter(source, from) {
  for (let i = from; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c !== 32 && c !== 10 && c !== 9 && c !== 13)
      return false;
  }
  return true;
}
function renderIndentedCode(slice) {
  const lines = dropTrailingNewline(slice).split("\n");
  while (lines.length && (lines.at(-1) ?? "").trim() === "")
    lines.pop();
  const code = lines.map((l) => stripFourColumnIndent(l)).join("\n");
  if (code.trim() === "")
    return "";
  return `<pre><code>${escapeHtml(code)}
</code></pre>`;
}
function stripParagraphIndent(text) {
  return text.split("\n").map((line) => line.replace(/^ {0,3}(?=\S)/, "")).join("\n");
}
function parseTaskListMarker(inner) {
  const m = TASK_LIST_MARKER_RE.exec(inner);
  if (!m)
    return null;
  const checked = (m[1] ?? "") !== " ";
  let rest = inner.slice(m[0].length);
  if (rest.startsWith(" "))
    rest = rest.slice(1);
  return { checked, rest };
}
function taskCheckboxHtml(checked) {
  const label = checked ? "Completed task" : "Incomplete task";
  return `<input type="checkbox" class="task-list-item-checkbox" disabled${checked ? " checked" : ""} aria-label="${label}">`;
}
function dedentListItemContent(slice) {
  const lines = dropTrailingNewline(slice).split("\n");
  const first = lines.find((l) => l.trim() !== "") ?? "";
  const col = listItemContentColumn(first);
  const dedented = [];
  lines.forEach((rawLine, index) => {
    const line = index === 0 ? expandListPrefixTabs(rawLine) : expandLeadingTabs(rawLine);
    if (index === 0) {
      dedented.push(line.slice(Math.min(col, line.length)));
      return;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent >= col) {
      dedented.push(line.slice(col));
      return;
    }
    const stripped = line.slice(indent);
    const prev = dedented.at(-1);
    if (stripped.trim() !== "" && prev !== void 0 && prev.trim() !== "" && isAmbiguousBlockLine(stripped)) {
      dedented[dedented.length - 1] = `${prev} ${stripped}`;
      return;
    }
    dedented.push(stripped);
  });
  return dedented.join("\n");
}
function renderListItemContent(slice, listLoose, linkRefs, formingTail = false) {
  let inner = dedentListItemContent(slice);
  if (inner.trim() === "")
    return { html: "", task: null, suppressed: false };
  const task = parseTaskListMarker(inner);
  if (task)
    inner = task.rest;
  const html = renderBlocks(inner, tokenizeBlocks(inner), {
    linkRefs,
    tightParagraphs: !listLoose,
    formingTail
  });
  const suppressed = html === "" && task === null && stripHtmlComments(inner).trim() === "";
  return { html, task, suppressed };
}
function renderListItem(item) {
  if (item.suppressed)
    return "";
  if (item.task) {
    const box = taskCheckboxHtml(item.task.checked);
    const gap = item.html === "" ? "" : " ";
    return `<li class="task-list-item">${box}${gap}${item.html}</li>`;
  }
  return `<li>${item.html}</li>`;
}
function renderParagraph(slice, linkRefs, tight = false) {
  const body = stripParagraphIndent(dropTrailingNewline(slice));
  const rendered = renderProseBlock(body, linkRefs, tight ? "space" : "newline");
  if (rendered === "")
    return "";
  return tight ? rendered : `<p>${rendered}</p>`;
}
function renderAtxHeading(slice, linkRefs) {
  const line = dropTrailingNewline(slice).split("\n")[0] ?? "";
  const m = line.match(ATX_HEADING_CAPTURE_RE);
  if (!m?.[1])
    return renderParagraph(slice, linkRefs);
  const level = m[1].length;
  const text = stripAtxClosingHashes((m[2] ?? "").trimEnd());
  return `<h${String(level)}>${renderProseBlock(text, linkRefs)}</h${String(level)}>`;
}
function renderSetextHeading(slice, linkRefs) {
  const lines = dropTrailingNewline(slice).split("\n");
  const text = lines.slice(0, -1).map((l) => l.trim()).join("\n");
  const underline = lines.at(-1) ?? "";
  const level = underline.trim().startsWith("=") ? 1 : 2;
  return `<h${String(level)}>${renderProseBlock(text, linkRefs)}</h${String(level)}>`;
}
function alignAttr(align) {
  return align ? ` align="${align}"` : "";
}
function renderTable(slice, linkRefs) {
  const table = renderTableElement(slice, linkRefs);
  return table && wrapTableHtml(table);
}
function renderTableElement(slice, linkRefs) {
  const lines = dropTrailingNewline(slice).split("\n").filter((l) => l.trim() !== "");
  const header = lines[0];
  if (!header)
    return "";
  const headerCells = splitTableRow(header);
  const colCount = headerCells.length;
  const aligns = lines[1] ? parseTableAlignments(lines[1]) : [];
  const alignOf = (col) => aligns[col] ?? null;
  const thead = `<thead><tr>${headerCells.map((c, col) => `<th${alignAttr(alignOf(col))}>${renderProseBlock(c, linkRefs)}</th>`).join("")}</tr></thead>`;
  const bodyRows = lines.slice(2);
  if (bodyRows.length === 0)
    return `<table>${thead}</table>`;
  const tbody = `<tbody>${bodyRows.map((row) => {
    const cells = splitTableRow(row);
    const normalized = Array.from({ length: colCount }, (_unused, col) => cells[col] ?? "");
    return `<tr>${normalized.map((c, col) => `<td${alignAttr(alignOf(col))}>${renderProseBlock(c, linkRefs)}</td>`).join("")}</tr>`;
  }).join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}
function stripBlockquoteSource(slice) {
  const out = [];
  for (const line of slice.split("\n")) {
    if (BLOCKQUOTE_DETECT_RE.test(line)) {
      out.push(stripBlockquoteLine(line));
      continue;
    }
    const prev = out.at(-1);
    if (line.trim() !== "" && prev !== void 0 && prev.trim() !== "") {
      out[out.length - 1] = `${prev} ${line.trim()}`;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}
function stripAlertMarker(innerSource) {
  const nl = innerSource.indexOf("\n");
  const first = nl === -1 ? innerSource : innerSource.slice(0, nl);
  const rest = nl === -1 ? "" : innerSource.slice(nl + 1);
  const afterMarker = first.trimStart().replace(/^\[![A-Za-z]+\]/, "").trimStart();
  if (afterMarker === "")
    return rest;
  return rest === "" ? afterMarker : `${afterMarker}
${rest}`;
}
function renderBlockquote(slice, linkRefs, formingTail = false) {
  const firstLine = slice.split("\n")[0] ?? "";
  const alertType = alertTypeFromMarker(stripBlockquoteMarker(firstLine));
  const innerSource = stripBlockquoteSource(slice);
  if (alertType) {
    const body = stripAlertMarker(innerSource);
    const title = `<p class="markdown-alert-title">${alertTitle(alertType)}</p>`;
    const content = body.trim() === "" ? "" : `
${renderBlocksFromSource(body, linkRefs, formingTail)}`;
    return `<blockquote class="${alertBlockquoteClass(alertType)}">${title}${content}</blockquote>`;
  }
  if (innerSource.trim() === "")
    return "<blockquote></blockquote>";
  return `<blockquote>${renderBlocksFromSource(innerSource, linkRefs, formingTail)}</blockquote>`;
}
function isOrderedListSlice(slice) {
  const first = slice.split("\n").find((l) => l.trim() !== "") ?? "";
  return parseOrderedListMarker(first) !== null;
}
function sliceUnorderedMarkerChar(slice) {
  const first = slice.split("\n").find((l) => l.trim() !== "") ?? "";
  return unorderedListMarkerChar(first);
}
function orderedListStart(slice) {
  const first = slice.split("\n").find((l) => l.trim() !== "") ?? "";
  return parseOrderedListMarker(first) ?? 1;
}
function orderedListDelimiter(slice) {
  const first = slice.split("\n").find((l) => l.trim() !== "") ?? "";
  return orderedListMarkerDelimiter(first);
}
function listGroupSignature(firstSlice) {
  const ordered = isOrderedListSlice(firstSlice);
  return {
    ordered,
    markerChar: ordered ? null : sliceUnorderedMarkerChar(firstSlice),
    delimiter: ordered ? orderedListDelimiter(firstSlice) : null,
    start: ordered ? orderedListStart(firstSlice) : 1
  };
}
function listSliceContinuesGroup(sig, slice) {
  if (isOrderedListSlice(slice) !== sig.ordered)
    return false;
  if (sig.ordered)
    return orderedListDelimiter(slice) === sig.delimiter;
  return sliceUnorderedMarkerChar(slice) === sig.markerChar;
}
function listItemSliceIsMultiParagraph(slice) {
  const tokens = tokenizeBlocks(dedentListItemContent(slice));
  let seenBlock = false;
  let blankSince = false;
  for (const token of tokens) {
    if (token.kind === "blank") {
      if (seenBlock)
        blankSince = true;
      continue;
    }
    if (seenBlock && blankSince)
      return true;
    seenBlock = true;
  }
  return false;
}
function scanListGroup(source, tokens, start) {
  const firstToken = tokens[start];
  const firstSlice = firstToken ? source.slice(firstToken.start, firstToken.end) : "";
  const sig = listGroupSignature(firstSlice);
  const itemTokens = [];
  let loose = false;
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token)
      break;
    if (token.kind === "blank") {
      let k = i + 1;
      while (tokens[k]?.kind === "blank")
        k++;
      const next = tokens[k];
      if (next?.kind === "list_item" && listSliceContinuesGroup(sig, source.slice(next.start, next.end))) {
        loose = true;
        i = k;
        continue;
      }
      break;
    }
    if (token.kind !== "list_item")
      break;
    const slice = source.slice(token.start, token.end);
    if (!listSliceContinuesGroup(sig, slice))
      break;
    if (listItemSliceIsMultiParagraph(slice))
      loose = true;
    if (/\n[ \t]*\n$/.test(slice)) {
      const after = tokens[i + 1];
      if (after?.kind === "list_item" && listSliceContinuesGroup(sig, source.slice(after.start, after.end))) {
        loose = true;
      }
    }
    itemTokens.push(token);
    i++;
  }
  return { sig, itemTokens, loose, next: i };
}
function renderListItemsSlice(source, itemTokens, loose, linkRefs, formingTail = false) {
  const items = itemTokens.map((t) => renderListItemContent(source.slice(t.start, t.end), loose, linkRefs, formingTail && onlyWhitespaceAfter(source, t.end)));
  return {
    itemsHtml: items.map(renderListItem).join(""),
    anyTask: items.some((it) => it.task !== null)
  };
}
function listGroupOpenTag(sig, anyTask) {
  if (sig.ordered) {
    return `<ol${sig.start === 1 ? "" : ` start="${String(sig.start)}"`}>`;
  }
  return `<ul${anyTask ? ' class="contains-task-list"' : ""}>`;
}
function listGroupCloseTag(sig) {
  return sig.ordered ? "</ol>" : "</ul>";
}
function collectListGroup(source, tokens, start, linkRefs, formingTail) {
  const scan = scanListGroup(source, tokens, start);
  const { itemsHtml, anyTask } = renderListItemsSlice(source, scan.itemTokens, scan.loose, linkRefs, formingTail);
  return {
    html: `${listGroupOpenTag(scan.sig, anyTask)}${itemsHtml}${listGroupCloseTag(scan.sig)}`,
    next: scan.next
  };
}
function collectBlockquoteGroup(source, tokens, start, linkRefs, formingTail) {
  const token = tokens[start];
  if (!token || token.kind !== "blockquote")
    return { html: "", next: start + 1 };
  return {
    html: renderBlockquote(source.slice(token.start, token.end), linkRefs, formingTail && onlyWhitespaceAfter(source, token.end)),
    next: start + 1
  };
}
function renderSingleBlock(source, token, linkRefs, tightParagraphs, htmlFromIndent, indentedCode, formingTail) {
  const slice = source.slice(token.start, token.end);
  const forming = formingTail && token.status !== "complete" && onlyWhitespaceAfter(source, token.end);
  switch (token.kind) {
    case "indented_code":
      if (!indentedCode) {
        return renderParagraph(dedentBlock(dropTrailingNewline(slice)), linkRefs, false);
      }
      if (htmlFromIndent && isIndentedHtmlBlock(dropTrailingNewline(slice))) {
        return renderParagraph(dedentBlock(dropTrailingNewline(slice)), linkRefs, false);
      }
      return renderIndentedCode(slice);
    case "fence": {
      const { lang, code } = parseFenceSlice(slice);
      return renderFencedBlock(lang, code, forming);
    }
    // Display math (#70): `$$ … $$` / `\[ … \]` emits the same inert pending
    // scaffolding as a ```math fence; `hydratePendingMath` upgrades it after
    // the sink sanitizer (the mermaid two-phase shape).
    case "math_block": {
      return mathBlockHtml(parseMathBlockSlice(slice).trim(), forming ? FORMING_FENCE_PRE_CLASS : "");
    }
    case "atx_heading":
      return renderAtxHeading(slice, linkRefs);
    case "setext_heading":
      return renderSetextHeading(slice, linkRefs);
    case "thematic_break":
      return "<hr>";
    case "table":
      return renderTable(slice, linkRefs);
    /* c8 ignore start -- unreachable in practice: renderBlocks routes
       blockquote / list_item groups and skips blank / link_ref_def tokens before
       ever calling renderSingleBlock, and every BlockToken kind is enumerated
       above, so `default` never runs. Kept so the dispatch is total. */
    case "blockquote":
      return renderBlockquote(slice, linkRefs);
    case "list_item":
      return renderListItem(renderListItemContent(slice, false, linkRefs));
    case "link_ref_def":
    case "footnote_def":
    case "blank":
      return "";
    /* c8 ignore stop */
    case "paragraph":
      return renderParagraph(slice, linkRefs, tightParagraphs);
    /* c8 ignore next 2 -- unreachable: all kinds are enumerated above */
    default:
      return renderParagraph(slice, linkRefs, tightParagraphs);
  }
}
function renderBlocksToParts(source, tokens, options = {}) {
  const linkRefs = options.linkRefs ?? /* @__PURE__ */ new Map();
  const tightParagraphs = options.tightParagraphs ?? false;
  const htmlFromIndent = options.htmlFromIndent ?? false;
  const indentedCode = options.indentedCode ?? true;
  const formingTail = options.formingTail ?? false;
  if (blockNestingDepth >= MAX_BLOCK_NESTING_DEPTH) {
    const literal = escapeHtml(dropTrailingNewline(source));
    if (literal.trim() === "")
      return [];
    return [{ start: 0, end: source.length, html: `<p>${literal}</p>` }];
  }
  blockNestingDepth++;
  try {
    return renderBlockParts(source, tokens, linkRefs, tightParagraphs, htmlFromIndent, indentedCode, formingTail);
  } finally {
    blockNestingDepth--;
  }
}
function renderBlockParts(source, tokens, linkRefs, tightParagraphs, htmlFromIndent, indentedCode, formingTail) {
  const parts = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token)
      break;
    if (token.kind === "blank" || token.kind === "link_ref_def" || token.kind === "footnote_def") {
      i++;
      continue;
    }
    if (token.kind === "list_item") {
      const group = collectListGroup(source, tokens, i, linkRefs, formingTail);
      const end = tokens[group.next - 1]?.end ?? token.end;
      if (group.html)
        parts.push({ start: token.start, end, html: group.html });
      i = group.next;
      continue;
    }
    if (token.kind === "blockquote") {
      const group = collectBlockquoteGroup(source, tokens, i, linkRefs, formingTail);
      const end = tokens[group.next - 1]?.end ?? token.end;
      if (group.html)
        parts.push({ start: token.start, end, html: group.html });
      i = group.next;
      continue;
    }
    const underline = tokens[i + 1];
    if (token.kind === "paragraph" && underline && underline.kind === "thematic_break" && underline.status === "ambiguous" && SETEXT_UNDERLINE_SLICE_RE.test(source.slice(underline.start, underline.end))) {
      parts.push({
        start: token.start,
        end: underline.end,
        html: renderSetextHeading(source.slice(token.start, underline.end), linkRefs)
      });
      i += 2;
      continue;
    }
    const html = renderSingleBlock(source, token, linkRefs, tightParagraphs, htmlFromIndent, indentedCode, formingTail);
    if (html)
      parts.push({ start: token.start, end: token.end, html });
    i++;
  }
  return parts;
}
function renderBlocks(source, tokens, options = {}) {
  const parts = renderBlocksToParts(source, tokens, options);
  const htmls = new Array(parts.length);
  for (let i = 0; i < parts.length; i++)
    htmls[i] = parts[i]?.html ?? "";
  return htmls.join("\n");
}
function renderBlocksFromSource(source, linkRefs = /* @__PURE__ */ new Map(), formingTail = false) {
  return renderBlocks(source, tokenizeBlocks(source), { linkRefs, formingTail });
}
function appendFootnoteBackref(bodyHtml, backref) {
  if (bodyHtml === "")
    return `<p>${backref}</p>`;
  if (bodyHtml.endsWith("</p>")) {
    return `${bodyHtml.slice(0, -"</p>".length)} ${backref}</p>`;
  }
  return `${bodyHtml}
<p>${backref}</p>`;
}
function renderFootnoteSection(ctx, linkRefs) {
  return wrapFootnoteSection(renderFootnoteSectionItems(ctx, linkRefs), ctx.idPrefix);
}
function wrapFootnoteSection(items, idPrefix = "") {
  if (items.length === 0)
    return "";
  return `<section class="footnotes" data-footnotes><h2 id="${idPrefix}footnote-label" class="sr-only">Footnotes</h2><ol>${items.join("")}</ol></section>`;
}
function renderFootnoteSectionItems(ctx, linkRefs, startIndex = 0) {
  const items = [];
  for (let i = startIndex; i < ctx.order.length; i++) {
    const key = ctx.order[i];
    const def = key === void 0 ? void 0 : ctx.defs.get(key);
    const slug = key === void 0 ? void 0 : ctx.slugs.get(key);
    const refId = key === void 0 ? void 0 : ctx.firstRefIds.get(key);
    const n = key === void 0 ? void 0 : ctx.numbers.get(key);
    if (def === void 0 || slug === void 0 || refId === void 0 || n === void 0)
      continue;
    const body = renderBlocksFromSource(def.content, linkRefs);
    const backref = `<a href="#${refId}" class="footnote-backref" data-footnote-backref aria-label="Back to reference ${String(n)}">\u21A9</a>`;
    items.push(`<li id="fn-${ctx.idPrefix}${slug}">${appendFootnoteBackref(body, backref)}</li>`);
  }
  return items;
}
var MAX_BLOCK_NESTING_DEPTH, blockNestingDepth, stripBlockquoteLine, TASK_LIST_MARKER_RE, SETEXT_UNDERLINE_SLICE_RE;
var init_render_blocks = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/render-blocks.js"() {
    init_alerts();
    init_block_patterns();
    init_block_tokenizer();
    init_escape();
    init_fence_handlers();
    init_highlight();
    init_indented_html();
    init_math_block();
    init_render_prose_inline();
    init_table_wrapper();
    MAX_BLOCK_NESTING_DEPTH = 100;
    blockNestingDepth = 0;
    stripBlockquoteLine = stripBlockquoteMarker;
    TASK_LIST_MARKER_RE = /^\[([ xX])\](?=\s|$)/;
    SETEXT_UNDERLINE_SLICE_RE = /^ {0,3}(?:=+|-+)[ \t]*\n?$/;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/link-image-policy.js
function resolvedPolicy() {
  const source = activeConfig().linkImagePolicy ?? null;
  if (source !== cachedPolicySource) {
    cachedPolicySource = source;
    cachedResolved = source === null ? null : {
      linkPrefixes: canonicalizePrefixes(source.allowedLinkPrefixes),
      imagePrefixes: canonicalizePrefixes(source.allowedImagePrefixes),
      defaultOrigin: source.defaultOrigin,
      allowDataImages: source.allowDataImages ?? true,
      blockedLinkClass: source.blockedLinkClass ?? DEFAULT_BLOCKED_LINK_CLASS,
      blockedImageClass: source.blockedImageClass ?? DEFAULT_BLOCKED_IMAGE_CLASS
    };
  }
  return cachedResolved;
}
function canonicalize(value, base) {
  let url;
  try {
    url = base === void 0 ? new URL(value) : new URL(value, base);
  } catch {
    return null;
  }
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  return url.href;
}
function canonicalizePrefixes(prefixes) {
  const out = [];
  for (const prefix of prefixes) {
    const canonical = canonicalize(prefix);
    if (canonical !== null)
      out.push(canonical);
  }
  return out;
}
function isUnderAllowedPrefix(canonical, prefixes) {
  return prefixes.some((prefix) => canonical.startsWith(prefix));
}
function resolveHref(raw, defaultOrigin) {
  const absolute = canonicalize(raw);
  if (absolute !== null)
    return { canonical: absolute, wasRelative: false };
  if (defaultOrigin === "")
    return null;
  const resolved = canonicalize(raw, defaultOrigin);
  if (resolved === null)
    return null;
  return { canonical: resolved, wasRelative: true };
}
function addBlockedClass(node, className) {
  node.classList.add(className);
}
function enforceLink(node, policy) {
  const href = node.getAttribute("href");
  if (href === null)
    return;
  const resolved = resolveHref(href, policy.defaultOrigin);
  if (resolved !== null && isUnderAllowedPrefix(resolved.canonical, policy.linkPrefixes)) {
    if (resolved.wasRelative)
      node.setAttribute("href", resolved.canonical);
    return;
  }
  if (policy.defaultOrigin === "")
    node.removeAttribute("href");
  else
    node.setAttribute("href", policy.defaultOrigin);
  addBlockedClass(node, policy.blockedLinkClass);
}
function enforceImage(node, policy) {
  const src = node.getAttribute("src");
  if (src === null || src === "")
    return;
  const resolved = resolveHref(src, policy.defaultOrigin);
  const isDataImage = resolved !== null && !resolved.wasRelative && isDataUrl(resolved.canonical);
  const allowed = isDataImage ? policy.allowDataImages : resolved !== null && isUnderAllowedPrefix(resolved.canonical, policy.imagePrefixes);
  if (allowed) {
    if (resolved !== null && resolved.wasRelative)
      node.setAttribute("src", resolved.canonical);
    return;
  }
  node.removeAttribute("src");
  addBlockedClass(node, policy.blockedImageClass);
}
function isDataUrl(canonical) {
  return canonical.slice(0, 5).toLowerCase() === "data:";
}
function applyLinkImagePolicy(node, tagName) {
  const policy = resolvedPolicy();
  if (!policy)
    return;
  if (tagName === "a")
    enforceLink(node, policy);
  else if (tagName === "img")
    enforceImage(node, policy);
}
var DEFAULT_BLOCKED_LINK_CLASS, DEFAULT_BLOCKED_IMAGE_CLASS, cachedPolicySource, cachedResolved;
var init_link_image_policy = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/link-image-policy.js"() {
    init_config();
    DEFAULT_BLOCKED_LINK_CLASS = "blocked-link";
    DEFAULT_BLOCKED_IMAGE_CLASS = "blocked-image";
    cachedResolved = null;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/data-attributes.js
var DATA_ATTR_NAME_SOURCE, DATA_ATTR_NAME_RE;
var init_data_attributes = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/data-attributes.js"() {
    DATA_ATTR_NAME_SOURCE = "data-[a-z0-9-]+";
    DATA_ATTR_NAME_RE = /* @__PURE__ */ new RegExp(`^${DATA_ATTR_NAME_SOURCE}$`, "i");
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/sanitize-browser.js
function isBrowserSanitizerSupported() {
  return typeof document !== "undefined" && typeof Element.prototype.setHTML === "function";
}
function unwrap(el2) {
  const parent = el2.parentNode;
  if (parent) {
    while (el2.firstChild)
      parent.insertBefore(el2.firstChild, el2);
  }
  el2.remove();
}
function enforceSanitizerAllowlist(root, config) {
  const allowedTags = new Set(config.allowedTags.map((t) => t.toLowerCase()));
  const allowedAttr = new Set(config.allowedAttr.map((a) => a.toLowerCase()));
  for (const el2 of Array.from(root.querySelectorAll("*"))) {
    if (!root.contains(el2))
      continue;
    const tag = el2.tagName.toLowerCase();
    if (!allowedTags.has(tag)) {
      if (DROP_CONTENT_TAGS.has(tag))
        el2.remove();
      else
        unwrap(el2);
      continue;
    }
    for (const attr of Array.from(el2.attributes)) {
      const name = attr.name.toLowerCase();
      if (!allowedAttr.has(name) && !DATA_ATTR_NAME_RE.test(name))
        el2.removeAttribute(attr.name);
    }
    config.onElement?.(el2, tag);
  }
}
function sanitizeIntoElement(target, html, config) {
  const el2 = target;
  try {
    el2.setHTML(html, {
      sanitizer: { elements: config.allowedTags, attributes: config.allowedAttr }
    });
  } catch {
    el2.setHTML(html);
  }
  enforceSanitizerAllowlist(target, config);
}
var DROP_CONTENT_TAGS, browserSanitizerBackend;
var init_sanitize_browser = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/sanitize-browser.js"() {
    init_data_attributes();
    DROP_CONTENT_TAGS = /* @__PURE__ */ new Set(["script", "style", "noscript", "template", "title"]);
    browserSanitizerBackend = {
      sanitize(html, config) {
        const host = document.createElement("div");
        sanitizeIntoElement(host, html, config);
        return host.innerHTML;
      },
      // Node path: `setHTML` parses and sanitizes (it is a Trusted Types-exempt
      // safe sink), so a sink write needs one parse and no serialize. The parse
      // happens in a detached <div> host — the same context the string path uses —
      // and the nodes are then moved into the target, so both paths treat
      // context-sensitive fragments identically instead of the live target's tag
      // changing what the fragment parser keeps.
      sanitizeInto(target, html, config) {
        const host = target.ownerDocument.createElement("div");
        sanitizeIntoElement(host, html, config);
        target.replaceChildren(...Array.from(host.childNodes));
      }
    };
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/sanitize.js
function getSanitizerBackend() {
  return activeConfig().sanitizerBackend ?? null;
}
function isolatedFootnoteId(value) {
  const bare = value.startsWith(CONTENT_ID_PREFIX) ? value.slice(CONTENT_ID_PREFIX.length) : value;
  return FOOTNOTE_ID_RE.test(bare) ? CONTENT_ID_PREFIX + bare : null;
}
function isolateNamedProperties(node) {
  node.removeAttribute("name");
  const id = node.getAttribute("id");
  if (id !== null) {
    const isolated = isolatedFootnoteId(id);
    if (isolated === null)
      node.removeAttribute("id");
    else
      node.setAttribute("id", isolated);
  }
  const href = node.getAttribute("href");
  if (href?.startsWith("#")) {
    let fragment = href.slice(1);
    try {
      fragment = decodeURIComponent(fragment);
    } catch {
    }
    const isolated = isolatedFootnoteId(fragment);
    if (isolated !== null)
      node.setAttribute("href", "#" + isolated);
  }
  for (const attr of ["aria-describedby", "aria-labelledby"]) {
    const value = node.getAttribute(attr);
    if (value !== null) {
      node.setAttribute(attr, value.replace(/[^\t\n\f\r ]+/g, (token) => isolatedFootnoteId(token) ?? token));
    }
  }
}
function gateElement(node, tagName) {
  if (typeof node.getAttribute !== "function")
    return;
  if (tagName === "input") {
    if (node.getAttribute("type") !== "checkbox") {
      node.remove();
      return;
    }
    node.setAttribute("disabled", "");
    isolateNamedProperties(node);
    return;
  }
  applyLinkImagePolicy(node, tagName);
  activeConfig().sanitizeExtension?.onElement?.(node, tagName);
  isolateNamedProperties(node);
}
function resolveBackend() {
  const backend = getSanitizerBackend();
  if (backend)
    return backend;
  if (isBrowserSanitizerSupported())
    return browserSanitizerBackend;
  throw new Error('No HTML sanitizer backend is available. Pass `sanitizerBackend` in the render config, or install one process-wide with `setDefaultConfig({ sanitizerBackend })` \u2014 e.g. `import { dompurifyBackend } from "@copse/streaming-markdown/sanitizers/dompurify"` in Node/jsdom or older browsers \u2014 or run where the native Sanitizer API (Element.setHTML) exists.');
}
function normalizeDoubleEncodedNbsp(root) {
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node;
    const replaced = text.data.replace(DOUBLE_ENCODED_NBSP_DATA_RE, "\xA0");
    if (replaced !== text.data)
      text.data = replaced;
  }
  for (const el2 of root.querySelectorAll("*")) {
    for (const attr of Array.from(el2.attributes)) {
      const replaced = attr.value.replace(DOUBLE_ENCODED_NBSP_DATA_RE, "\xA0");
      if (replaced !== attr.value)
        el2.setAttribute(attr.name, replaced);
    }
  }
}
function buildSanitizerConfig() {
  const extension = activeConfig().sanitizeExtension;
  const allowedTags = extension?.allowedTags ? [...ALLOWED_TAGS, ...extension.allowedTags] : ALLOWED_TAGS;
  const allowedAttr = extension?.allowedAttr ? [...ALLOWED_ATTR, ...extension.allowedAttr] : ALLOWED_ATTR;
  return withTableWrapperGate({ allowedTags, allowedAttr, onElement: gateElement }, extension?.allowedAttr);
}
function asSanitizedHtml(html) {
  return html;
}
function sanitizeRenderedMarkdown(html) {
  const sanitized = resolveBackend().sanitize(html, buildSanitizerConfig());
  return asSanitizedHtml(sanitized.replace(DOUBLE_ENCODED_NBSP_RE, "\xA0"));
}
function sanitizeRenderedMarkdownInto(target, html) {
  const backend = resolveBackend();
  if (!backend.sanitizeInto)
    return false;
  backend.sanitizeInto(target, html, buildSanitizerConfig());
  if (html.includes("&"))
    normalizeDoubleEncodedNbsp(target);
  return true;
}
var ALLOWED_TAGS, ALLOWED_ATTR, FOOTNOTE_ID_RE, CONTENT_ID_PREFIX, DOUBLE_ENCODED_NBSP_RE, DOUBLE_ENCODED_NBSP_DATA_RE, SHOW_TEXT;
var init_sanitize = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/sanitize.js"() {
    init_config();
    init_link_image_policy();
    init_sanitize_browser();
    init_table_wrapper();
    ALLOWED_TAGS = [
      "a",
      "p",
      "br",
      "hr",
      "strong",
      "em",
      "code",
      "pre",
      "span",
      "div",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "blockquote",
      // Benign raw inline HTML the renderer passes through unescaped (see
      // BENIGN_RAW_INLINE_TAG_RE in escape.ts) — attribute-less phrasing tags only.
      "b",
      "i",
      "u",
      "s",
      "del",
      "ins",
      "sub",
      "sup",
      "kbd",
      "mark",
      // GFM task-list checkboxes (#614). The renderer only ever emits the fixed,
      // read-only form `<input type="checkbox" disabled [checked]>` inside an
      // `<li class="task-list-item">`. Only `type`/`checked`/`disabled` are allowed
      // below, and the core element gate drops any non-checkbox `<input>`, so no
      // interactive/form payload can survive.
      "input",
      // GFM footnotes (#72): the trailing `<section class="footnotes">` wrapper.
      "section"
    ];
    ALLOWED_ATTR = [
      "href",
      "target",
      "rel",
      "class",
      // GFM table column alignment (`<th align>`/`<td align>`) — presentational, no XSS surface.
      "align",
      // Task-list checkbox attributes (#614) — read-only booleans, no XSS surface.
      "type",
      "checked",
      "disabled",
      // GFM footnote anchors (#72): `id="fn-…"`/`id="fnref-…"` jump targets, plus the
      // section's `id="footnote-label"` heading. The element gate strips other IDs
      // and isolates accepted IDs and their references in `user-content-`.
      "id",
      // GFM footnote / task-list accessibility hooks (#216/#217): `aria-label` on
      // task checkboxes and backrefs, `aria-describedby` linking a ref to the
      // footnotes heading. (The `data-footnote*` semantic markers GitHub emits need
      // no entry — see the generic `data-*` note above.)
      "aria-label",
      "aria-describedby"
    ];
    FOOTNOTE_ID_RE = /^(?:fn(?:ref)?-[A-Za-z0-9_-]+|[A-Za-z0-9_-]*footnote-label)$/;
    CONTENT_ID_PREFIX = "user-content-";
    DOUBLE_ENCODED_NBSP_RE = /&amp;(?:nbsp|#160|#x0*a0);/gi;
    DOUBLE_ENCODED_NBSP_DATA_RE = /&(?:nbsp|#160|#x0*a0);/gi;
    SHOW_TEXT = 4;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/renderer.js
function topLevelRenderOpts() {
  return { htmlFromIndent: true, indentedCode: activeConfig().indentedCode !== false };
}
function committedRenderOpts(formingTail) {
  return { ...topLevelRenderOpts(), formingTail };
}
function scopedConfig(options) {
  const { tokens, ...config } = options;
  return config;
}
function renderMarkdown(raw, options = {}) {
  return withConfig(scopedConfig(options), () => sanitizeRenderedMarkdown(renderMarkdownCore(raw, options)));
}
function renderCommittedMarkdownUnsafe(raw, tokens, formingTail) {
  return renderMarkdownCore(raw, { tokens }, formingTail);
}
function renderMarkdownCore(raw, options, formingTail = false) {
  const tokens = options.tokens ?? tokenizeBlocks(raw);
  const linkRefs = collectLinkReferenceDefinitions(raw, tokens);
  const renderOpts = { linkRefs, ...committedRenderOpts(formingTail) };
  const footnoteDefs = collectFootnoteDefinitions(raw, tokens);
  if (footnoteDefs.size === 0)
    return renderBlocks(raw, tokens, renderOpts);
  const footnotes = createFootnoteContext(footnoteDefs);
  const previousFootnotes = getActiveFootnoteContext();
  setActiveFootnoteContext(footnotes);
  try {
    const body = renderBlocks(raw, tokens, renderOpts);
    const section = renderFootnoteSection(footnotes, linkRefs);
    if (section === "")
      return body;
    return body === "" ? section : `${body}
${section}`;
  } finally {
    setActiveFootnoteContext(previousFootnotes);
  }
}
var init_renderer = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/renderer.js"() {
    init_block_tokenizer();
    init_footnotes();
    init_config();
    init_render_blocks();
    init_sanitize();
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/render-pending-line.js
function revealFormingLink(text) {
  if (!text.includes("["))
    return text;
  const { mask } = scanCodeSpans(text);
  let open = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== "[" || mask[i])
      continue;
    let backslashes = 0;
    for (let k = i - 1; k >= 0 && text[k] === "\\"; k--)
      backslashes++;
    if (backslashes % 2 === 1)
      continue;
    open = i;
    break;
  }
  if (open === -1)
    return text;
  const isImage = open > 0 && text[open - 1] === "!";
  const startIdx = isImage ? open - 1 : open;
  if (COMPLETE_LINK_AT_START_RE.test(text.slice(startIdx)))
    return text;
  const afterBracket = text.slice(open + 1);
  const closeRel = afterBracket.indexOf("]");
  if (closeRel === -1) {
    return text.slice(0, startIdx) + afterBracket;
  }
  const label = afterBracket.slice(0, closeRel);
  const afterClose = afterBracket.slice(closeRel + 1);
  if (afterClose.startsWith("(")) {
    return text.slice(0, startIdx) + label;
  }
  return text;
}
function isIncompleteListMarkerPrefix(pending) {
  return /^ {0,3}-(?=[^\s-\n])/.test(pending) || /^ {0,3}\*(?!\*)(?=[^\s\n])/.test(pending) || /^ {0,3}\+(?=[^\s\n])/.test(pending);
}
function matchPendingListMarker(pending) {
  return pending.match(TOP_LEVEL_LIST_MARKER_RE);
}
function dedentLazyContinuation(text, itemFirstLine) {
  const col = listItemContentColumn(itemFirstLine);
  return text.split("\n").map((line) => {
    const indent = line.match(/^ */)?.[0].length ?? 0;
    return line.slice(Math.min(indent, col));
  }).join("\n");
}
function stripParagraphIndent2(text) {
  return text.split("\n").map((line) => line.replace(/^ {0,3}(?=\S)/, "")).join("\n");
}
function pendingListMarkerLength(pending) {
  const match = matchPendingListMarker(pending);
  return match ? match[0].length : null;
}
function pendingListOrderedMarker(pending) {
  const match = pending.match(/^ {0,3}(\d{1,9})[.)]\s/);
  return match?.[1] ?? null;
}
function listPendingIndent(pending) {
  return pending.match(/^ */)?.[0].length ?? 0;
}
function pendingAtxHeadingLevel(pending) {
  const match = pending.match(ATX_HEADING_CAPTURE_RE);
  return match?.[1] ? match[1].length : null;
}
function pendingAtxHeadingTitle(pending) {
  const match = pending.match(ATX_HEADING_CAPTURE_RE);
  if (!match?.[1])
    return "";
  return stripAtxClosingHashes((match[2] ?? "").trimEnd());
}
function isPendingBlockquoteLine(pending) {
  return BLOCKQUOTE_DETECT_RE.test(pending);
}
function pendingBlockquoteBody(pending) {
  return stripBlockquoteMarker(pending);
}
function isListContinuationPending(pending, openListItemFirstLine2) {
  return openListItemFirstLine2 !== void 0 && openListItemFirstLine2 !== "" && isLazyListContinuation(openListItemFirstLine2, pending);
}
function isPlainParagraphPendingLine(pending, openListItemFirstLine2) {
  return pending !== "" && !isListContinuationPending(pending, openListItemFirstLine2) && matchPendingListMarker(pending) === null && !isIncompleteListMarkerPrefix(pending) && !isPendingFootnoteDefLine(pending) && pendingAtxHeadingLevel(pending) === null && !isPendingBlockquoteLine(pending) && !isAmbiguousBlockLine(pending);
}
function renderStreamingInline(text) {
  return renderProseInline(revealFormingLink(text));
}
function formingInlineCodeHtml(held) {
  const span = nextCodeSpan(held, 0);
  if (!span || span.type !== "unclosed" || span.open !== 0)
    return "";
  const content = held.slice(span.open + span.runLen).replace(/\n/g, " ");
  if (content === "")
    return "";
  return `<code class="stream-forming-inline-code">${escapeHtml(content)}</code>`;
}
function renderStreamingInlinePending(text) {
  const hold = pendingHoldIndex(text);
  const visible = text.slice(0, hold);
  const formingCode = formingInlineCodeHtml(text.slice(hold));
  if (!visible && !formingCode)
    return "";
  return renderStreamingInline(visible) + formingCode;
}
function renderPendingLine(pending, options = {}) {
  if (!pending)
    return "";
  const { openListItemFirstLine: openListItemFirstLine2 } = options;
  if (isListContinuationPending(pending, openListItemFirstLine2)) {
    const hold = pendingHoldIndex(pending);
    const visible = pending.slice(0, hold);
    const formingCode = formingInlineCodeHtml(pending.slice(hold));
    if (!visible && !formingCode)
      return "";
    const dedented = dedentLazyContinuation(visible, openListItemFirstLine2 ?? "");
    return renderStreamingInline(dedented) + formingCode;
  }
  const listMatch = matchPendingListMarker(pending);
  if (listMatch) {
    const hold = pendingHoldIndex(pending);
    const visible = pending.slice(0, hold);
    const formingCode = formingInlineCodeHtml(pending.slice(hold));
    if (!visible && !formingCode)
      return "";
    const markerLen = listMatch[0].length;
    if (visible.length <= markerLen && !formingCode)
      return "";
    return renderStreamingInline(visible.slice(markerLen)) + formingCode;
  }
  if (isIncompleteListMarkerPrefix(pending)) {
    return "";
  }
  if (isPendingFootnoteDefLine(pending)) {
    return "";
  }
  if (pendingAtxHeadingLevel(pending) !== null) {
    const title = pendingAtxHeadingTitle(pending);
    if (!title)
      return "";
    const hold = pendingHoldIndex(title);
    const visible = title.slice(0, hold);
    const formingCode = formingInlineCodeHtml(title.slice(hold));
    if (!visible && !formingCode)
      return "";
    return renderStreamingInline(visible) + formingCode;
  }
  if (isPendingBlockquoteLine(pending)) {
    const body = pendingBlockquoteBody(pending);
    const alertType = alertTypeFromMarker(body);
    if (alertType)
      return escapeHtml(alertTitle(alertType));
    if (isFormingAlertMarker(body))
      return "";
    if (!body.trim())
      return "";
    const hold = pendingHoldIndex(body);
    const visible = body.slice(0, hold);
    const formingCode = formingInlineCodeHtml(body.slice(hold));
    if (!visible && !formingCode)
      return "";
    return renderStreamingInline(visible) + formingCode;
  }
  if (isAmbiguousBlockLine(pending)) {
    const hold = pendingHoldIndex(pending);
    const visible = pending.slice(0, hold);
    const formingCode = formingInlineCodeHtml(pending.slice(hold));
    if (!visible && !formingCode)
      return "";
    return escapeHtml(decodeSafeMarkdownEntities(visible)) + formingCode;
  }
  return renderStreamingInlinePending(stripParagraphIndent2(pending));
}
var COMPLETE_LINK_AT_START_RE, TOP_LEVEL_LIST_MARKER_RE;
var init_render_pending_line = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/render-pending-line.js"() {
    init_alerts();
    init_block_patterns();
    init_block_tokenizer();
    init_escape();
    init_footnotes();
    init_inline_code_spans();
    init_inline_emphasis();
    init_render_prose_inline();
    COMPLETE_LINK_AT_START_RE = /^!?\[[^\]]*\]\([^)]*\)/;
    TOP_LEVEL_LIST_MARKER_RE = /^ {0,3}(?:(?:[-*+])(?:\s|$)|(?:\d{1,9}[.)]\s))/;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/streaming-split.js
function splitAtLastNewline(content) {
  const lastNl = content.lastIndexOf("\n");
  if (lastNl === -1)
    return { complete: "", pending: content };
  return {
    complete: content.slice(0, lastNl + 1),
    pending: content.slice(lastNl + 1)
  };
}
function splitOpenBlockAtLastNewline(block, content, extras = {}) {
  const openText = content.slice(block.start);
  const { complete: lineComplete, pending } = splitAtLastNewline(openText);
  return {
    complete: content.slice(0, block.start) + lineComplete,
    pending,
    ...extras
  };
}
function splitOpenParagraph(block, content) {
  const openText = content.slice(block.start);
  const inlineHold = pendingHoldIndex(openText);
  if (emphasisSpansNewline(openText) && inlineHold >= openText.length) {
    return {
      complete: content.slice(0, block.start),
      pending: content.slice(block.start)
    };
  }
  if (inlineHold < openText.length) {
    const cut = block.start + inlineHold;
    const held = openText.slice(inlineHold);
    const codeSpan = nextCodeSpan(held, 0);
    const inlineCodeContinuation = codeSpan?.type === "unclosed" && codeSpan.open === 0;
    return {
      complete: content.slice(0, cut),
      pending: content.slice(cut),
      // pendingHoldIndex cuts exactly at an unresolved code opener when code
      // is the earliest hold. The forming preview can then remain inline with
      // the safe paragraph prefix instead of appearing as a sibling block.
      ...inlineCodeContinuation ? { inlineCodeContinuation: true } : {}
    };
  }
  const split = splitOpenBlockAtLastNewline(block, content);
  if (split.pending !== "" && split.complete.length > block.start) {
    split.paragraphContinuation = true;
  }
  return split;
}
function openListItemFirstLine(block, content) {
  const slice = content.slice(block.start);
  const nl = slice.indexOf("\n");
  return nl === -1 ? slice : slice.slice(0, nl);
}
function splitOpenListItem(block, content) {
  return splitOpenBlockAtLastNewline(block, content, {
    openListItemFirstLine: openListItemFirstLine(block, content)
  });
}
function splitOpenLinkRefRun(block, content) {
  const cut = block.start + lastLinkRefDefStart(content.slice(block.start, block.end));
  return {
    complete: content.slice(0, cut),
    pending: content.slice(cut)
  };
}
function splitOpenTable(block, content) {
  const openText = content.slice(block.start);
  const lines = openText.split("\n");
  const sepLine = lines[1];
  if (!sepLine || !TABLE_SEP_RE.test(sepLine)) {
    return {
      complete: content.slice(0, block.start),
      pending: openText
    };
  }
  const headerSepEnd = (lines[0]?.length ?? 0) + 1 + sepLine.length;
  const afterSep = openText.slice(headerSepEnd);
  if (!afterSep.startsWith("\n") && lines.length <= 2) {
    return {
      complete: content.slice(0, block.start),
      pending: openText
    };
  }
  return splitOpenBlockAtLastNewline(block, content);
}
function splitForStreamingFrom(content, blocks) {
  return { ...splitForStreamingCore(content, blocks), blocks };
}
function splitForStreamingCore(content, blocks) {
  const firstOpen = blocks.find((b) => b.status !== "complete");
  if (!firstOpen) {
    return splitAtLastNewline(content);
  }
  if (firstOpen.kind === "paragraph") {
    return splitOpenParagraph(firstOpen, content);
  }
  if (firstOpen.kind === "list_item") {
    return splitOpenListItem(firstOpen, content);
  }
  if (firstOpen.kind === "table") {
    return splitOpenTable(firstOpen, content);
  }
  if (firstOpen.kind === "link_ref_def") {
    return splitOpenLinkRefRun(firstOpen, content);
  }
  if (firstOpen.kind === "blockquote") {
    return splitOpenBlockAtLastNewline(firstOpen, content);
  }
  const holdStart = streamingHoldStart(blocks);
  return {
    complete: content.slice(0, holdStart),
    pending: content.slice(holdStart)
  };
}
function committedTailContinues(complete, blocks) {
  const len = complete.length;
  if (len === 0)
    return false;
  let continues = true;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const token = blocks[i];
    if (!token || token.end <= len)
      break;
    if (token.start < len)
      return true;
    if (token.kind !== "blank")
      continues = false;
  }
  return continues;
}
var init_streaming_split = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/streaming-split.js"() {
    init_block_tokenizer();
    init_inline_code_spans();
    init_inline_emphasis();
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/incremental-scan.js
function canExtendAcrossBlank(kind) {
  return kind === "list_item" || kind === "indented_code" || kind === "blockquote" || kind === "footnote_def";
}
function endsWithBlankLine(source, start, end) {
  if (end <= start || source[end - 1] !== "\n")
    return false;
  let p = end - 2;
  while (p >= start && source[p] !== "\n")
    p--;
  for (let k = p + 1; k < end - 1; k++) {
    const c = source[k];
    if (c !== " " && c !== "	" && c !== "\r")
      return false;
  }
  return true;
}
function advanceSafeBoundary(source, tokens, fromIdx, fromOffset, lastNonBlankKind) {
  let tokenCount = fromIdx;
  let offset = fromOffset;
  let lastKind = lastNonBlankKind;
  let pending = null;
  for (let i = fromIdx; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token)
      break;
    if (token.kind === "blank") {
      if (token.status !== "complete")
        continue;
      if (lastKind === null || !canExtendAcrossBlank(lastKind)) {
        tokenCount = i + 1;
        offset = token.end;
        pending = null;
      } else {
        pending = { tokenCount: i + 1, offset: token.end };
      }
      continue;
    }
    if (pending && token.status === "complete") {
      tokenCount = pending.tokenCount;
      offset = pending.offset;
      pending = null;
    }
    lastKind = token.kind;
    if (token.status === "complete" && canExtendAcrossBlank(token.kind) && endsWithBlankLine(source, token.start, token.end)) {
      pending = { tokenCount: i + 1, offset: token.end };
    }
  }
  return { tokenCount, offset, lastNonBlankKind: lastKind };
}
var IncrementalSourceScanner;
var init_incremental_scan = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/incremental-scan.js"() {
    init_block_tokenizer();
    IncrementalSourceScanner = class {
      tokens = [];
      /** Cached tokens `[0, safeTokenCount)` are final for any future suffix. */
      safeTokenCount = 0;
      /** Source offset of the safe boundary; scans resume here. */
      safeOffset = 0;
      /** The exact source bytes of `[0, safeOffset)` — the rewrite guard. */
      safePrefix = "";
      /** Nearest non-blank kind before the safe boundary (boundary-rule input). */
      lastNonBlankKind = null;
      /** Link-reference definitions found in `[0, safeOffset)` (first-wins). */
      refs = /* @__PURE__ */ new Map();
      /** Footnote definitions found in `[0, safeOffset)` (first-wins, #72). */
      fnDefs = /* @__PURE__ */ new Map();
      /**
       * The exact source of the latest {@link advance} — lets the definition views
       * ({@link linkRefs} / {@link footnoteDefs}) reuse `tokens` for their suffix
       * scans instead of re-tokenizing the tail a second (and third) time per
       * commit, which showed up in the #154 code-block scaling guard.
       */
      lastSource = "";
      /**
       * Diagnostic: total characters actually re-tokenized across all calls. The
       * #30 invariant is that this stays O(n) over a whole append-only stream —
       * a deterministic, timing-free regression test reads it.
       */
      scannedChars = 0;
      /**
       * Diagnostic: number of full-prefix rewrite-guard comparisons (`startsWith`)
       * actually executed. The long-document invariant (ADR 0004 Phase 3) is at
       * most ONE per scanner call — the definition views must ride {@link advance}'s
       * verification via the `source === lastSource` identity fast path instead of
       * re-running their own. Each check is O(prefix), so a second one per call
       * showed up as a super-linear term on multi-hundred-kB streams.
       */
      prefixChecks = 0;
      /** Diagnostic: total bytes those rewrite-guard comparisons scanned (informational). */
      prefixBytesCompared = 0;
      /**
       * Diagnostic: suffix tokens built across all advances. O(new bytes) per
       * append-only stream while the safe boundary tracks the tail — the token
       * companion to {@link scannedChars}, read by the Phase 3 doubling guard.
       */
      suffixTokensScanned = 0;
      resetCache() {
        this.tokens = [];
        this.safeTokenCount = 0;
        this.safeOffset = 0;
        this.safePrefix = "";
        this.lastNonBlankKind = null;
        this.refs = /* @__PURE__ */ new Map();
        this.fnDefs = /* @__PURE__ */ new Map();
        this.lastSource = "";
      }
      /**
       * Tokenize `source`, reusing every token before the safe boundary. The
       * result is byte-identical to `tokenizeBlocks(source)`.
       */
      tokenize(source) {
        return this.advance(source).tokens;
      }
      /**
       * Tokenize `source` and report the sealed-block delta (ADR 0004 Phase 1).
       * `tokens` is byte-identical to `tokenizeBlocks(source)`; `sealed` are the
       * tokens the safe boundary advanced past since the previous call, together
       * with the definitions those tokens sealed. See {@link ScanAdvance} for the
       * monotonicity contract.
       */
      advance(source) {
        let reset = false;
        this.prefixChecks++;
        this.prefixBytesCompared += this.safeOffset;
        if (!source.startsWith(this.safePrefix)) {
          this.resetCache();
          reset = true;
        }
        const prevSafeTokenCount = this.safeTokenCount;
        const suffix = source.slice(this.safeOffset);
        this.scannedChars += suffix.length;
        const suffixTokens = tokenizeBlocks(suffix);
        this.suffixTokensScanned += suffixTokens.length;
        const tokens = this.tokens;
        tokens.length = this.safeTokenCount;
        if (this.safeOffset === 0) {
          for (const t of suffixTokens)
            tokens.push(t);
        } else {
          for (const t of suffixTokens) {
            tokens.push({
              kind: t.kind,
              status: t.status,
              start: t.start + this.safeOffset,
              end: t.end + this.safeOffset
            });
          }
        }
        const advanced = advanceSafeBoundary(source, tokens, this.safeTokenCount, this.safeOffset, this.lastNonBlankKind);
        const sealedLinkRefs = /* @__PURE__ */ new Map();
        const sealedFootnoteDefs = /* @__PURE__ */ new Map();
        if (advanced.offset > this.safeOffset) {
          const sealedTokens = tokens.slice(this.safeTokenCount, advanced.tokenCount);
          for (const [label, ref] of collectLinkReferenceDefinitions(source, sealedTokens)) {
            if (!this.refs.has(label)) {
              this.refs.set(label, ref);
              sealedLinkRefs.set(label, ref);
            }
          }
          for (const [label, def] of collectFootnoteDefinitions(source, sealedTokens)) {
            if (!this.fnDefs.has(label)) {
              this.fnDefs.set(label, def);
              sealedFootnoteDefs.set(label, def);
            }
          }
        }
        this.safeTokenCount = advanced.tokenCount;
        this.safeOffset = advanced.offset;
        this.lastNonBlankKind = advanced.lastNonBlankKind;
        this.safePrefix = source.slice(0, this.safeOffset);
        this.tokens = tokens;
        this.lastSource = source;
        return {
          tokens,
          sealed: tokens.slice(prevSafeTokenCount, this.safeTokenCount),
          formingFrom: this.safeTokenCount,
          sealedLinkRefs,
          sealedFootnoteDefs,
          reset,
          verifiedUpTo: this.safeOffset
        };
      }
      /**
       * Link-reference definitions of `source`, equal to
       * `collectLinkReferenceDefinitions(source)`. Must be called with the same
       * string as the latest {@link tokenize} call (the cache is keyed to it);
       * anything else falls back to a full scan.
       */
      linkRefs(source) {
        const isLatest = source === this.lastSource;
        if (!isLatest) {
          this.prefixChecks++;
          this.prefixBytesCompared += this.safeOffset;
          if (!source.startsWith(this.safePrefix)) {
            return collectLinkReferenceDefinitions(source);
          }
        }
        const merged = new Map(this.refs);
        const suffixRefs = isLatest ? collectLinkReferenceDefinitions(source, this.tokens.slice(this.safeTokenCount)) : collectLinkReferenceDefinitions(source.slice(this.safeOffset));
        for (const [label, ref] of suffixRefs) {
          if (!merged.has(label))
            merged.set(label, ref);
        }
        return merged;
      }
      /**
       * Footnote definitions of `source`, equal to
       * `collectFootnoteDefinitions(source)` — the cached sealed-prefix map merged
       * first-wins with a suffix scan, exactly like {@link linkRefs}. Replaces the
       * per-update whole-token-array collection in the DOM commit path (the
       * footnote share of #21 limitation K). Must be called with the same string
       * as the latest {@link tokenize}/{@link advance} call; anything else falls
       * back to a full scan.
       */
      footnoteDefs(source) {
        const isLatest = source === this.lastSource;
        if (!isLatest) {
          this.prefixChecks++;
          this.prefixBytesCompared += this.safeOffset;
          if (!source.startsWith(this.safePrefix)) {
            return collectFootnoteDefinitions(source);
          }
        }
        const merged = new Map(this.fnDefs);
        const suffixDefs = isLatest ? collectFootnoteDefinitions(source, this.tokens.slice(this.safeTokenCount)) : collectFootnoteDefinitions(source.slice(this.safeOffset));
        for (const [label, def] of suffixDefs) {
          if (!merged.has(label))
            merged.set(label, def);
        }
        return merged;
      }
    };
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/dom-scan.js
function childMatches(el2, tagName, cls) {
  return (tagName === null || el2.tagName === tagName) && (cls === null || el2.classList.contains(cls));
}
function firstDirectChild(host, tagName, cls) {
  for (let el2 = host.firstElementChild; el2; el2 = el2.nextElementSibling) {
    if (childMatches(el2, tagName, cls))
      return el2;
  }
  return null;
}
function lastDirectChild(host, tagName, cls) {
  for (let el2 = host.lastElementChild; el2; el2 = el2.previousElementSibling) {
    if (childMatches(el2, tagName, cls))
      return el2;
  }
  return null;
}
function findDescendantByClass(root, cls, tagName) {
  for (let el2 = root.firstElementChild; el2; el2 = el2.nextElementSibling) {
    if (childMatches(el2, tagName ?? null, cls))
      return el2;
    const nested = findDescendantByClass(el2, cls, tagName);
    if (nested)
      return nested;
  }
  return null;
}
var init_dom_scan = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/dom-scan.js"() {
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/html-sink.js
function resolvePolicy() {
  const hostPolicy = activeConfig().trustedTypesPolicy;
  if (hostPolicy)
    return hostPolicy;
  const trustedTypes = globalThis.trustedTypes;
  if (defaultPolicy === void 0 || defaultPolicyFactory !== trustedTypes) {
    defaultPolicy = null;
    defaultPolicyFactory = trustedTypes;
    if (trustedTypes) {
      try {
        defaultPolicy = trustedTypes.createPolicy("streaming-markdown", {
          createHTML: (sanitized) => sanitized
        });
      } catch {
      }
    }
  }
  return defaultPolicy;
}
function blessSanitizedHtml(sanitized) {
  const policy = resolvePolicy();
  return policy ? policy.createHTML(sanitized) : sanitized;
}
function setSanitizedHtml(el2, html) {
  if (html === "") {
    el2.replaceChildren();
    return;
  }
  if (sanitizeRenderedMarkdownInto(el2, html))
    return;
  setPresanitizedHtml(el2, sanitizeRenderedMarkdown(html));
}
function setPresanitizedHtml(el2, sanitizedHtml) {
  if (sanitizedHtml === "") {
    el2.replaceChildren();
    return;
  }
  el2.innerHTML = blessSanitizedHtml(sanitizedHtml);
}
function setHostTrustedHtml(el2, html) {
  if (html === "") {
    el2.replaceChildren();
    return;
  }
  el2.innerHTML = html;
}
var defaultPolicy, defaultPolicyFactory;
var init_html_sink = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/html-sink.js"() {
    init_config();
    init_sanitize();
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/math.js
function readMathSource(el2) {
  return (el2.querySelector("pre.math") ?? el2).textContent ?? "";
}
function markError(el2, kind) {
  el2.classList.remove(`${kind}--pending`);
  el2.classList.add(`${kind}--error`);
}
async function hydratePendingMath(root, options = {}) {
  const renderer = options.renderer;
  if (!renderer)
    return 0;
  const targets = [];
  if (root.matches(PENDING_MATH_SELECTOR))
    targets.push(root);
  targets.push(...root.querySelectorAll(PENDING_MATH_SELECTOR));
  let rendered = 0;
  for (const el2 of targets) {
    const kind = el2.classList.contains("math-block") ? "math-block" : "math-inline";
    const source = readMathSource(el2);
    if (source.trim() === "")
      continue;
    let html;
    try {
      ;
      ({ html } = await renderer.render(source, { displayMode: kind === "math-block" }));
    } catch {
      markError(el2, kind);
      continue;
    }
    try {
      setHostTrustedHtml(el2, options.transformHtml ? options.transformHtml(html) : html);
    } catch {
      markError(el2, kind);
      continue;
    }
    el2.classList.remove(`${kind}--pending`);
    el2.classList.add(`${kind}--rendered`);
    rendered++;
  }
  return rendered;
}
var PENDING_MATH_SELECTOR;
var init_math = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/math.js"() {
    init_html_sink();
    PENDING_MATH_SELECTOR = ".math-block.math-block--pending, .math-inline.math-inline--pending";
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/mermaid-source.js
function decodeMermaidHtmlEntities(text) {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function normalizeMermaidTypography(source) {
  return source.replace(/\u201c|\u201d/g, '"').replace(/\u2018|\u2019/g, "'").replace(/\r\n/g, "\n");
}
function labelNeedsQuotes(label) {
  if (/[()]/.test(label))
    return true;
  if (/[+/:,&#|]/.test(label))
    return true;
  if (/[^\w \t.-]/.test(label))
    return true;
  return false;
}
function stabilizeMermaidSource(source) {
  return source.replace(/^(\s*(?:subgraph\s+)?[\w-]+)\[([^\]"(][^\]]*)\]/gm, (match, prefix, label) => {
    if (label.startsWith("("))
      return match;
    if (!labelNeedsQuotes(label))
      return match;
    const safe = label.replace(/"/g, "'");
    return `${prefix}["${safe}"]`;
  });
}
function stabilizeMermaidSourceAggressive(source) {
  return source.replace(/^(\s*(?:subgraph\s+)?[\w-]+)\[([^\]"(][^\]]*)\]/gm, (match, prefix, label) => {
    if (label.startsWith("("))
      return match;
    const safe = label.replace(/"/g, "'");
    return `${prefix}["${safe}"]`;
  });
}
function mermaidSourceCandidates(raw) {
  const normalized = normalizeMermaidTypography(decodeMermaidHtmlEntities(raw).trimEnd());
  const gentle = stabilizeMermaidSource(normalized);
  const aggressive = stabilizeMermaidSourceAggressive(stabilizeMermaidSource(normalized));
  return [...new Set([gentle, aggressive].filter(Boolean))];
}
var init_mermaid_source = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/mermaid-source.js"() {
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/mermaid.js
function readDiagramSource(container) {
  return container.querySelector("pre.mermaid")?.textContent ?? "";
}
function markRendered(container, svg) {
  container.classList.remove("mermaid-diagram--pending");
  container.classList.add("mermaid-diagram--rendered");
  setHostTrustedHtml(container, svg);
}
function markError2(container) {
  container.classList.remove("mermaid-diagram--pending");
  container.classList.add("mermaid-diagram--error");
}
async function hydratePendingDiagrams(root, options = {}) {
  const renderer = options.renderer;
  if (!renderer)
    return 0;
  const containers = [];
  if (root.matches(PENDING_DIAGRAM_SELECTOR))
    containers.push(root);
  containers.push(...root.querySelectorAll(PENDING_DIAGRAM_SELECTOR));
  let rendered = 0;
  for (const container of containers) {
    const rawSource = readDiagramSource(container);
    if (rawSource.trim() === "")
      continue;
    let ok = false;
    for (const candidate of mermaidSourceCandidates(rawSource)) {
      let svg;
      try {
        ;
        ({ svg } = await renderer.render(candidate));
      } catch {
        continue;
      }
      try {
        markRendered(container, options.transformSvg ? options.transformSvg(svg) : svg);
        ok = true;
        rendered++;
      } catch {
      }
      break;
    }
    if (!ok)
      markError2(container);
  }
  return rendered;
}
var PENDING_DIAGRAM_SELECTOR;
var init_mermaid = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/mermaid.js"() {
    init_mermaid_source();
    init_html_sink();
    PENDING_DIAGRAM_SELECTOR = ".mermaid-diagram.mermaid-diagram--pending";
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/streaming-table-dom.js
function tableLines(source) {
  const trimmed = dropTrailingNewline(source);
  if (trimmed === "")
    return [];
  return trimmed.split("\n");
}
function renderStreamingTableCell(raw) {
  const visible = renderStreamingInlinePending(raw);
  return visible ? sanitizeRenderedMarkdown(visible) : "";
}
function setStreamingCellContent(cell, raw) {
  setPresanitizedHtml(cell, renderStreamingTableCell(raw));
}
function ensureRow(parent, index) {
  return parent.rows[index] ?? parent.insertRow();
}
function syncRowCells(row, cells, tag) {
  while (row.cells.length < cells.length) {
    row.appendChild(document.createElement(tag));
  }
  while (row.cells.length > cells.length) {
    row.lastElementChild?.remove();
  }
  cells.forEach((raw, i) => {
    const cell = row.cells[i];
    if (cell)
      setStreamingCellContent(cell, raw);
  });
}
function syncFormingTableDom(container, source) {
  const lines = tableLines(source);
  if (lines.length === 0) {
    container.replaceChildren();
    return;
  }
  const parent = formingTableParent(container);
  const existing = firstDirectChild(parent, "TABLE", FORMING_TABLE_CLASS);
  let table;
  if (existing instanceof Element && existing.tagName === "TABLE") {
    table = existing;
  } else {
    parent.replaceChildren();
    table = document.createElement("table");
    table.className = FORMING_TABLE_CLASS;
    table.append(document.createElement("thead"), document.createElement("tbody"));
    parent.appendChild(table);
  }
  const thead = table.tHead ?? table.createTHead();
  const tbody = table.tBodies[0] ?? table.createTBody();
  tbody.replaceChildren();
  const headerLine = lines[0];
  if (!headerLine)
    return;
  syncRowCells(ensureRow(thead, 0), splitTableRow(headerLine), "th");
  const sepLine = lines[1];
  if (!sepLine)
    return;
  if (!TABLE_SEP_RE.test(sepLine)) {
    const sepRow = tbody.insertRow();
    sepRow.className = SEPARATOR_ROW_CLASS;
    const colCount = Math.max(thead.rows[0]?.cells.length ?? 1, splitTableRow(sepLine).length, 1);
    syncRowCells(sepRow, Array.from({ length: colCount }, () => sepLine.trim()), "td");
    return;
  }
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.includes("|"))
      continue;
    const row = tbody.insertRow();
    if (i === lines.length - 1 && !source.endsWith("\n")) {
      row.className = PENDING_ROW_CLASS;
    }
    syncRowCells(row, splitTableRow(line), "td");
  }
}
function formingTableParent(container) {
  const wrapper = resolveTableWrapper();
  if (!wrapper)
    return container;
  const first = container.firstElementChild;
  if (first?.getAttribute("class") === wrapper.className)
    return first;
  const div = createTableWrapperElement(wrapper);
  container.replaceChildren(div);
  return div;
}
function syncPendingTableRowDom(table, pendingRow) {
  const cells = splitTableRow(pendingRow);
  const headerCols = table.tHead?.rows[0]?.cells.length;
  const colCount = headerCols ?? Math.max(cells.length, 1);
  let tbody = table.tBodies[0];
  if (!tbody) {
    tbody = table.createTBody();
  }
  let row = findPendingRow(table);
  if (!(row instanceof Element) || row.tagName !== "TR") {
    row = tbody.insertRow();
    row.className = PENDING_ROW_CLASS;
  }
  syncRowCells(row, Array.from({ length: colCount }, (_, i) => cells[i] ?? ""), "td");
}
function clearFormingTableDom(container) {
  container.replaceChildren();
}
function findPendingRow(table) {
  for (const tbody of table.tBodies) {
    const row = lastDirectChild(tbody, "TR", PENDING_ROW_CLASS);
    if (row)
      return row;
  }
  return null;
}
function removePendingTableRow(table) {
  findPendingRow(table)?.remove();
}
var FORMING_TABLE_CLASS, PENDING_ROW_CLASS, SEPARATOR_ROW_CLASS;
var init_streaming_table_dom = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/streaming-table-dom.js"() {
    init_dom_scan();
    init_block_tokenizer();
    init_block_patterns();
    init_render_pending_line();
    init_sanitize();
    init_html_sink();
    init_table_wrapper();
    FORMING_TABLE_CLASS = "stream-table-forming";
    PENDING_ROW_CLASS = "stream-pending-row";
    SEPARATOR_ROW_CLASS = "stream-table-separator-pending";
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/streaming-fence-dom.js
function syncFormingFenceDom(container, source) {
  const parsed = parseOpenFenceContent(source);
  if (!parsed) {
    container.replaceChildren();
    return;
  }
  const { lang, code } = parsed;
  const handler = getFenceHandler(lang);
  if (handler) {
    if (handler.forming?.sync) {
      handler.forming.sync(container, code, lang);
      return;
    }
    setSanitizedHtml(container, renderFencedBlock(lang, code, true));
    return;
  }
  let pre = firstDirectChild(container, "PRE", FORMING_FENCE_PRE_CLASS);
  if (!pre) {
    container.replaceChildren();
    pre = document.createElement("pre");
    pre.className = FORMING_FENCE_PRE_CLASS;
    const codeEl2 = document.createElement("code");
    pre.append(codeEl2);
    container.append(pre);
  }
  const first = pre.firstElementChild;
  const codeEl = first && first.tagName === "CODE" ? first : null;
  if (codeEl) {
    codeEl.className = fenceCodeClass(lang);
    setSanitizedHtml(codeEl, highlightFenceCode(code, lang));
  }
}
function clearFormingFenceDom(container) {
  container.replaceChildren();
}
var init_streaming_fence_dom = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/streaming-fence-dom.js"() {
    init_block_patterns();
    init_fence_handlers();
    init_dom_scan();
    init_highlight();
    init_render_blocks();
    init_html_sink();
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/streaming-math-dom.js
function syncFormingMathDom(container, source) {
  syncFormingMathBlockDom(container, parseOpenMathBlock(source), FORMING_FENCE_PRE_CLASS);
}
var init_streaming_math_dom = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/streaming-math-dom.js"() {
    init_fence_handlers();
    init_math_block();
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/streaming-dom-morph.js
function attributesEqual(a, b) {
  const aAttrs = a.attributes;
  const bAttrs = b.attributes;
  if (aAttrs.length !== bAttrs.length)
    return false;
  for (let i = 0; i < aAttrs.length; i++) {
    const aAttr = aAttrs[i];
    const bAttr = bAttrs[i];
    if (!aAttr || !bAttr)
      return false;
    if (aAttr.name !== bAttr.name || aAttr.value !== bAttr.value)
      return false;
  }
  return true;
}
function isFormingPromotion(node, next) {
  const cls = node.getAttribute("class");
  if (!cls)
    return false;
  const rest = ` ${cls} `.replace(` ${FORMING_FENCE_PRE_CLASS} `, " ").trim();
  if (rest === cls || next.getAttribute("class") !== (rest || null))
    return false;
  if (node.attributes.length !== next.attributes.length + (rest ? 0 : 1))
    return false;
  for (const attr of Array.from(next.attributes)) {
    if (attr.name !== "class" && node.getAttribute(attr.name) !== attr.value)
      return false;
  }
  return true;
}
function canReuse(node, next) {
  if (node.nodeType !== next.nodeType)
    return false;
  if (node.nodeType === ELEMENT_NODE) {
    return node.tagName === next.tagName && (attributesEqual(node, next) || isFormingPromotion(node, next));
  }
  if (node.nodeType === TEXT_NODE)
    return true;
  if (node.nodeType === COMMENT_NODE)
    return true;
  return false;
}
function morphChildren(parent, template, offset = 0, trimTrailing = true) {
  const nextChildren = Array.from(template.childNodes);
  for (let i = 0; i < nextChildren.length; i++) {
    const next = nextChildren[i];
    if (!next)
      continue;
    const current = parent.childNodes[offset + i];
    if (!current) {
      parent.appendChild(next);
      continue;
    }
    if (canReuse(current, next)) {
      if (current.nodeType === ELEMENT_NODE) {
        syncAttributes(current, next);
        morphChildren(current, next);
      } else if (current.nodeType === TEXT_NODE || current.nodeType === COMMENT_NODE) {
        if (current.data !== next.data) {
          ;
          current.data = next.data;
        }
      }
    } else {
      parent.replaceChild(next, current);
    }
  }
  if (trimTrailing) {
    while (parent.childNodes.length > offset + nextChildren.length) {
      parent.lastChild?.remove();
    }
  }
}
function morphInnerHtml(container, html) {
  morphInnerHtmlFrom(container, 0, html);
}
function morphInnerHtmlFrom(container, startIndex, html) {
  if (html === "") {
    while (container.childNodes.length > startIndex)
      container.lastChild?.remove();
    return 0;
  }
  const template = container.cloneNode(false);
  setPresanitizedHtml(template, html);
  const count = template.childNodes.length;
  morphChildren(container, template, startIndex);
  return count;
}
function morphInnerHtmlRangeFrom(container, startIndex, html) {
  if (html === "")
    return 0;
  const template = container.cloneNode(false);
  setPresanitizedHtml(template, html);
  const count = template.childNodes.length;
  morphChildren(container, template, startIndex, false);
  return count;
}
function morphElementChildrenFrom(el2, template, offset) {
  morphChildren(el2, template, offset);
}
function syncAttributes(el2, template) {
  if (attributesEqual(el2, template))
    return;
  while (el2.attributes.length > 0) {
    const attr = el2.attributes[0];
    if (!attr)
      break;
    el2.removeAttribute(attr.name);
  }
  for (let i = 0; i < template.attributes.length; i++) {
    const attr = template.attributes[i];
    if (attr)
      el2.setAttribute(attr.name, attr.value);
  }
}
var TEXT_NODE, ELEMENT_NODE, COMMENT_NODE;
var init_streaming_dom_morph = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/streaming-dom-morph.js"() {
    init_fence_handlers();
    init_html_sink();
    TEXT_NODE = 3;
    ELEMENT_NODE = 1;
    COMMENT_NODE = 8;
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/streaming-frozen-tail.js
function settleClassOf(kind) {
  switch (kind) {
    case "fence":
    case "math_block":
    case "atx_heading":
    case "setext_heading":
    case "thematic_break":
      return "immutable";
    case "paragraph":
    case "table":
      return "settled-after-blank";
    case "list_item":
    case "blockquote":
    case "indented_code":
      return "grouping";
    // A footnote definition can absorb later lines across a blank run (a
    // 4-column-indented continuation), so a trailing one is never settled. It
    // renders nothing in the body; the footnote-incremental path (#110) owns the
    // reference upgrades and the trailing section once a definition is committed.
    case "footnote_def":
      return "grouping";
    case "blank":
    case "link_ref_def":
      return "separator";
  }
}
function settledTailStart(tokens) {
  let i = tokens.length - 1;
  let blankFollows = false;
  while (i >= 0) {
    const token = tokens[i];
    if (!token)
      return tokens.length;
    if (settleClassOf(token.kind) === "separator" && token.status === "complete") {
      blankFollows = true;
      i--;
      continue;
    }
    break;
  }
  if (i < 0)
    return tokens.length;
  const last = tokens[i];
  if (!last)
    return tokens.length;
  const cls = settleClassOf(last.kind);
  const settled = last.status === "complete" && (cls === "immutable" || cls === "settled-after-blank" && blankFollows);
  if (settled)
    return i + 1;
  if (cls !== "grouping")
    return i;
  let s = i;
  while (s - 1 >= 0) {
    const prev = tokens[s - 1];
    if (prev && (prev.kind === last.kind || prev.kind === "blank")) {
      s--;
      continue;
    }
    break;
  }
  while (s < i && tokens[s]?.kind === "blank")
    s++;
  return s;
}
function lowerBound(tokens, offset) {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    const tok = tokens[mid];
    if (tok && tok.start < offset)
      lo = mid + 1;
    else
      hi = mid;
  }
  return lo;
}
function tokenStraddles(tokens, offset) {
  const idx = lowerBound(tokens, offset);
  const prev = idx > 0 ? tokens[idx - 1] : void 0;
  return prev !== void 0 && prev.end > offset;
}
function filterRenderTokens(tokens) {
  return tokens.filter((t) => t.kind !== "blank" && t.kind !== "link_ref_def" && t.kind !== "footnote_def");
}
function sameRenderTokens(a, b) {
  if (a.length !== b.length)
    return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || x.kind !== y.kind || x.start !== y.start || x.end !== y.end)
      return false;
  }
  return true;
}
function serializeLinkRefs(refs) {
  if (refs.size === 0)
    return "";
  const entries = [];
  for (const [label, ref] of refs) {
    entries.push(JSON.stringify([label, ref.href, ref.title ?? ""]));
  }
  return entries.sort().join("\n");
}
function hasUnbalancedBenignRawInline(html) {
  for (const tag of BENIGN_BALANCED_TAGS) {
    const opens = html.match(new RegExp(`<${tag}(?=[\\s/>])`, "gi"))?.length ?? 0;
    if (opens === 0)
      continue;
    const closes = html.match(new RegExp(`</${tag}>`, "gi"))?.length ?? 0;
    if (opens !== closes)
      return true;
  }
  return false;
}
function hasUnbalancedRawHtml(html) {
  const balance = /* @__PURE__ */ new Map();
  for (let m = HTML_TAG_SCAN_RE.exec(html); m; m = HTML_TAG_SCAN_RE.exec(html)) {
    const name = (m[2] ?? "").toLowerCase();
    if (VOID_HTML_TAGS.has(name) || m[3] === "/")
      continue;
    balance.set(name, (balance.get(name) ?? 0) + (m[1] === "/" ? -1 : 1));
  }
  for (const net of balance.values())
    if (net !== 0)
      return true;
  return false;
}
function hasUnfreezableRawHtml(html) {
  const policy = getHtmlPolicy();
  if (policy === "escape-all")
    return false;
  return policy === "passthrough" ? hasUnbalancedRawHtml(html) : hasUnbalancedBenignRawInline(html);
}
function openElementChainAtEof(rawHtml) {
  const ParserCtor = document.defaultView?.DOMParser;
  if (!ParserCtor)
    return null;
  const parser = new ParserCtor();
  const alone = parser.parseFromString(`<body>${rawHtml}</body>`, "text/html");
  const probed = parser.parseFromString(`<body>${rawHtml}${PROBE_HTML}</body>`, "text/html");
  if (probed.body.innerHTML === alone.body.innerHTML + PROBE_HTML)
    return [];
  const probes = probed.body.getElementsByTagName(PROBE_TAG);
  const canary = probes[probes.length - 1];
  if (!canary)
    return null;
  const chain = [];
  for (let el2 = canary.parentElement; el2 && el2 !== probed.body; el2 = el2.parentElement) {
    chain.unshift(el2.tagName);
  }
  return chain.length > 0 ? chain : null;
}
function sourceMentionsLabel(source, labels) {
  if (!source.includes("["))
    return false;
  const spanRe = /\[((?:\\[\s\S]|[^\[\]\\])*)\]/g;
  for (let m = spanRe.exec(source); m; m = spanRe.exec(source)) {
    const span = m[1] ?? "";
    if (span.trim() === "")
      continue;
    if (labels.has(normalizeReferenceLabel(span)))
      return true;
    if (span.includes("\\") && labels.has(normalizeReferenceLabel(span.replace(/\\([\s\S])/g, "$1")))) {
      return true;
    }
  }
  return false;
}
function hasOpenDetailsElement(html) {
  if (!html.includes("<details"))
    return false;
  const opens = html.match(DETAILS_OPEN_RE)?.length ?? 0;
  const closes = html.match(DETAILS_CLOSE_RE)?.length ?? 0;
  return opens > closes;
}
function detailsBalance(html) {
  if (!html.includes("<details") && !html.includes("</details"))
    return 0;
  const opens = html.match(DETAILS_OPEN_RE)?.length ?? 0;
  const closes = html.match(DETAILS_CLOSE_RE)?.length ?? 0;
  return opens - closes;
}
var INTRA_LIST_MIN_ITEMS, MAX_LINK_REF_PATCH_PARTS, MAY_HOLD_FENCE_RE, BENIGN_BALANCED_TAGS, VOID_HTML_TAGS, HTML_TAG_SCAN_RE, SAFE_REROOT_TAGS, PROBE_TAG, PROBE_HTML, DETAILS_OPEN_RE, DETAILS_CLOSE_RE, FrozenTailRenderer;
var init_streaming_frozen_tail = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/streaming-frozen-tail.js"() {
    init_block_tokenizer();
    init_render_blocks();
    init_footnotes();
    init_fence_handlers();
    init_html_policy();
    init_link_references();
    init_sanitize();
    init_html_sink();
    init_renderer();
    init_streaming_dom_morph();
    INTRA_LIST_MIN_ITEMS = 4;
    MAX_LINK_REF_PATCH_PARTS = 8;
    MAY_HOLD_FENCE_RE = /```|~~~|\$\$|\\\[/;
    BENIGN_BALANCED_TAGS = ["b", "i", "u", "s", "del", "ins", "sub", "sup", "kbd", "mark"];
    VOID_HTML_TAGS = /* @__PURE__ */ new Set([
      "area",
      "base",
      "br",
      "col",
      "embed",
      "hr",
      "img",
      "input",
      "link",
      "meta",
      "param",
      "source",
      "track",
      "wbr"
    ]);
    HTML_TAG_SCAN_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*?)?(\/?)>/g;
    SAFE_REROOT_TAGS = /* @__PURE__ */ new Set(["DETAILS", "DIV", "SECTION", "ARTICLE", "ASIDE", "MAIN", "NAV", "FIGURE"]);
    PROBE_TAG = "sm-open-chain-probe";
    PROBE_HTML = `<${PROBE_TAG}>zz</${PROBE_TAG}>`;
    DETAILS_OPEN_RE = /<details(?=[\s>])/gi;
    DETAILS_CLOSE_RE = /<\/details>/gi;
    FrozenTailRenderer = class {
      /** Source offset; DOM for `[0, frozenEnd)` is final and never re-rendered. */
      frozenEnd = 0;
      /** Exact source text of `[0, frozenEnd)` — guards non-append-only updates. */
      frozenSource = "";
      /** Whether any frozen block rendered non-empty HTML (drives the `'\n'` seam). */
      frozenHasHtml = false;
      /** Counted number of `completedEl` children that are frozen. */
      frozenNodeCount = 0;
      /** Serialized committed link-ref map at the last commit (invalidation guard). */
      lastLinkRefKey = "";
      /** The committed link-ref map behind {@link lastLinkRefKey} (delta diffing). */
      lastLinkRefs = /* @__PURE__ */ new Map();
      /**
       * Normalized bracketed spans seen in FROZEN source (accumulated per delta,
       * O(delta) each commit). Over-approximates the reference labels the frozen
       * region could contain; a new definition whose label is not in here cannot
       * change frozen output, so its arrival skips the limitation-J full morph.
       */
      frozenLabelCandidates = /* @__PURE__ */ new Set();
      /**
       * Whether the committed render leaves a `<details>` open (#600). Read by the
       * streaming renderer to hold the pending tail so a collapsed body is not
       * flashed as a sibling after the element. Recomputed on every commit path: the
       * full-morph and footnote rebuilds compute it from the whole unsanitized
       * render, and the incremental fast path computes it from the unsettled tail
       * (the frozen prefix and delta are always balanced, so the tail carries any
       * lone-open `<details>` — #138).
       */
      committedHasOpenDetails = false;
      /**
       * Diagnostic: cumulative count of HTML characters this renderer has produced
       * (delta + tail per commit, or the whole document on a full-morph fallback).
       * The invariant #21 protects is that this stays O(n) over a whole stream, not
       * O(n²); a deterministic, timing-free perf-regression test reads it. Never
       * consumed by production code.
       */
      renderedChars = 0;
      /**
       * Diagnostic: cumulative count of sanitized-HTML characters the generic
       * commit path actually fed to a parse + DOM diff (the delta and tail range
       * morphs, and full-morph fallbacks). Rendering a string is cheap; sanitizing,
       * parsing, and diffing it is the per-commit DOM cost the tail memo removes —
       * so this staying well below {@link renderedChars} on a steady stream proves
       * the memo engages (ADR 0004 Phase 2). Never consumed by production code.
       */
      parsedChars = 0;
      /**
       * Diagnostic: commits whose newly-settled delta was adopted in place whole —
       * its blocks were committed to the DOM last frame as the tail, from the same
       * rendered string at the same position, so the live nodes are already
       * byte-correct and the frozen boundary advanced over them without a
       * sanitize + parse + diff. Never consumed by production code.
       */
      deltaCommitsSkipped = 0;
      /**
       * Diagnostic: commits whose delta EXTENDED the memoized tail — its first
       * top-level part rendered byte-identically to last frame's tail, so those
       * live nodes were adopted and only the remaining (genuinely new) parts were
       * sanitized + parsed + morphed. Never consumed by production code.
       */
      deltaPrefixesAdopted = 0;
      /**
       * Diagnostic: commits whose settling delta was adopted WITHOUT even
       * re-rendering it (ADR 0004 Phase 2 sealed-commit path): the delta's render
       * tokens, source bytes, and link-ref map matched the memoized tail by span,
       * so the block provably renders byte-identically to the string already in
       * the DOM — sealed blocks render to DOM exactly once. A strict subset of
       * {@link deltaCommitsSkipped} (which also counts render-then-byte-compare
       * adoptions). Never consumed by production code.
       */
      deltaRendersSkipped = 0;
      /**
       * Diagnostic: commits that skipped the O(prefix) frozen-source byte
       * comparison because the driving {@link ScanAdvance} had already verified
       * the prefix (`verifiedUpTo` at or past the frozen boundary, no reset since
       * the boundary was recorded). Never consumed by production code.
       */
      prefixChecksSkipped = 0;
      /**
       * Diagnostic: commits whose tail rendered byte-identically to the previous
       * commit's (same root, boundary, and seam), so the live tail nodes were kept
       * verbatim without a sanitize + parse + diff. Never consumed by production
       * code.
       */
      tailMorphsSkipped = 0;
      /**
       * Diagnostic: commits where a newly-arrived link-reference definition whose
       * label IS referenced by frozen content (limitation J) was absorbed as a
       * targeted per-part patch — re-rendering and morphing only the frozen
       * top-level parts whose source contains a matching bracketed span — instead
       * of a full-document morph. Never consumed by production code.
       */
      linkRefPatchCommits = 0;
      /**
       * Ordered records of the frozen top-level parts — each part's source span
       * and raw rendered HTML (null for a part sealed out of intra-list mode,
       * whose exact whole-group render was never produced) — so a late link-ref
       * definition can re-render and morph ONLY the parts whose source contains a
       * matching bracketed span (limitation J, ADR 0004 Phase 2). The part→node
       * mapping is not stored: it is re-derived (and verified) at patch time from
       * the frozen region's layout, which the generic commit path guarantees is
       * strictly alternating — one element per part, one '\n' seam text node
       * between parts (and one before part 0 iff earlier frozen output existed).
       * Any commit that can break that layout (re-root frames, a delta whose
       * parts were unavailable) sets {@link frozenPartsReliable} false, and the
       * patch falls back to today's full morph.
       */
      frozenParts = [];
      /** False when the frozen region's node layout can't be trusted for patching. */
      frozenPartsReliable = true;
      /**
       * Memo of the last generic-path tail commit (ADR 0004 Phase 2). Records the
       * RAW rendered tail string, the exact position it was morphed at, and the
       * parse's top-level node count, establishing the invariant the skips rely
       * on: the live children `[atNodeCount, atNodeCount + nodeCount)` of `root`
       * serialize exactly as `parse(sanitize(lead + rawHtml))` until the next
       * commit. `parts`/`balanced` gate the partial (extension) adoption: it
       * needs the memo to be a single top-level group whose raw tags are balanced,
       * so per-fragment sanitization composes across the adoption boundary —
       * exactly the existing frozen-boundary assumption, at the same granularity.
       * Anything that mutates the committed subtree outside the generic path
       * (full morph, re-root frames, intra-list mode, footnote mode, out-of-band
       * hydration via {@link invalidateDomMemo}) nulls it — a stale memo must
       * never be trusted, a missing one only costs a re-parse.
       *
       * The span fields (`srcStart`/`srcText`/`renderTokens`/`parts`/
       * `linkRefKey`) additionally let the NEXT commit adopt the memoized nodes
       * without re-rendering the settling delta at all (the sealed-commit path,
       * ADR 0004 Phase 2): when the delta's render tokens equal `renderTokens`
       * over unchanged source bytes under an unchanged link-ref map, the render
       * is a pure function of inputs proven identical, so `rawHtml` — and
       * therefore the live DOM — already IS what a fresh render would produce.
       * This rests on the same determinism assumption the frozen prefix itself
       * rests on (re-rendering identical committed source under this renderer's
       * frozen config yields identical bytes); a backend that mutated its output
       * mid-stream would already diverge the never-re-rendered frozen region.
       */
      tailMemo = null;
      /**
       * Prefix length of the last advance-driven commit's source that the driving
       * scanner promises to re-verify (or report `reset`) on its next advance —
       * see {@link ScanAdvance.verifiedUpTo}. While the frozen boundary sits at
       * or below it, the per-commit O(prefix) `startsWith` re-check is redundant
       * and is skipped ({@link prefixChecksSkipped}); any commit not driven by an
       * advance zeroes it, so direct callers keep today's full check.
       */
      prefixVerifiedUpTo = 0;
      /** This commit's `formingTail` (see {@link update}); every render here uses it. */
      formingTail = false;
      /** Whether {@link formingTail} differs from the previous commit's. */
      formingTailChanged = false;
      /**
       * Drop the DOM-trust memo after out-of-band mutation of committed nodes —
       * math/diagram hydration rewrites scaffold elements in place, which the
       * morphs used to absorb as ordinary diff noise. Idempotent and cheap; when
       * unsure whether committed DOM was touched, call it.
       */
      invalidateDomMemo() {
        this.tailMemo = null;
      }
      // ---- Re-rooted append frames (ADR 0004 Phase 2) ------------------------
      // While committed raw HTML leaves a safe container element open (an unclosed
      // `<details>`/`<div>`/… under the passthrough policy), the whole-string
      // parse nests ALL later content inside that element. This used to be
      // unfreezable — every subsequent commit fell back to a full-document morph,
      // the O(n²) cliff of docs/decisions/0004. Instead the commit path re-roots:
      // the open element becomes the append target, later blocks freeze INSIDE it
      // exactly as at the top level (`frozenNodeCount`/`frozenHasHtml` describe
      // the innermost frame while frames are open; each frame saves the outer
      // level's values). A matching close tag — or any structural surprise —
      // falls back to one full morph; the then-balanced region freezes wholesale
      // through the ordinary path afterwards.
      /** Innermost-last stack of live open container elements being appended into. */
      openFrames = [];
      /** Top-level child of `completedEl` containing every open frame (stale-trim anchor). */
      frameAnchor = null;
      /**
       * Net `<details>` opens minus closes across the frozen RAW render. The #138
       * pending-tail hold must track the *unsanitized* whole render (the string
       * emitter re-checks it every frame; the sink may unwrap the element), and
       * with frozen deltas never re-rendered this running balance is that check.
       */
      frozenDetailsBalance = 0;
      resetFrames() {
        this.openFrames = [];
        this.frameAnchor = null;
        this.frozenDetailsBalance = 0;
      }
      /** The element commits currently append into: the innermost open frame, else `completedEl`. */
      commitRoot(completedEl) {
        return this.openFrames[this.openFrames.length - 1]?.el ?? completedEl;
      }
      /**
       * True when `deltaHtml`/`tailHtml` mention a close tag for any open frame.
       * Conservative by string scan: even a balanced same-tag pair trips it (the
       * cost is one full morph + re-derivation, never wrong output). A real close
       * means later content pops OUT of the frame — per-fragment parsing drops the
       * stray close instead, so the framed fast path must not run.
       */
      frameCloseAppeared(deltaHtml, tailHtml) {
        for (const frame of this.openFrames) {
          const close = `</${frame.tag.toLowerCase()}`;
          if (deltaHtml.toLowerCase().includes(close) || tailHtml.toLowerCase().includes(close))
            return true;
        }
        return false;
      }
      /**
       * Fold the bracketed spans of newly frozen `source` into the candidate set
       * (escape-aware, whitespace/case-normalized like reference labels, plus a
       * backslash-stripped variant — over-approximation only ever costs an
       * unnecessary full morph, never wrong output). O(newly frozen bytes), so it
       * totals O(n) over a stream.
       */
      accumulateLabelCandidates(source) {
        if (!source.includes("["))
          return;
        const spanRe = /\[((?:\\[\s\S]|[^\[\]\\])*)\]/g;
        for (let m = spanRe.exec(source); m; m = spanRe.exec(source)) {
          const span = m[1] ?? "";
          if (span.trim() === "")
            continue;
          this.frozenLabelCandidates.add(normalizeReferenceLabel(span));
          if (span.includes("\\")) {
            this.frozenLabelCandidates.add(normalizeReferenceLabel(span.replace(/\\([\s\S])/g, "$1")));
          }
        }
      }
      /**
       * True when the committed link-ref map changed purely by ADDING labels,
       * none of which matches a bracketed span ever frozen — so the frozen DOM
       * provably cannot change and the limitation-J full morph is unnecessary.
       * Removals and value changes are never inert.
       */
      linkRefDeltaIsInert(linkRefs) {
        if (linkRefs.size < this.lastLinkRefs.size)
          return false;
        for (const [label, ref] of this.lastLinkRefs) {
          const next = linkRefs.get(label);
          if (!next || next.href !== ref.href || (next.title ?? "") !== (ref.title ?? ""))
            return false;
        }
        for (const label of linkRefs.keys()) {
          if (!this.lastLinkRefs.has(label) && this.frozenLabelCandidates.has(label))
            return false;
        }
        return true;
      }
      /**
       * Targeted limitation-J patch (ADR 0004 Phase 2): the committed link-ref
       * map changed in a way that may rewrite frozen content — a definition
       * arrived for a referenced label, or a still-streaming definition run
       * retreated out of `complete` (removals) or re-parsed with a new value.
       * A block's render depends on the map only through the labels of its own
       * bracketed spans, so re-render and morph in place ONLY the frozen
       * top-level parts whose source contains a span matching a CHANGED label,
       * leaving every other frozen node untouched — a definition-bearing document
       * (CHANGELOG-style: definitions at the bottom, referenced above) stops
       * paying a full-document morph per definition line.
       *
       * Returns false — the caller full-morphs, today's exact behaviour — on ANY
       * doubt: intra-list / re-root / unreliable-part state, a frozen region
       * whose live layout does not verify as strictly alternating (one element
       * per part, one '\n' seam between parts), a patched part that does not
       * re-render to exactly one element, or a citing set too large for per-part
       * work to beat one whole-document morph. On success the caller continues
       * the ordinary commit under the new map (the delta and tail render with it
       * anyway).
       */
      patchFrozenLinkRefs(completedEl, complete, tokens, linkRefs) {
        if (!this.frozenPartsReliable || this.listSig !== null || this.openFrames.length > 0) {
          return false;
        }
        const changedLabels = /* @__PURE__ */ new Set();
        for (const [label, ref] of linkRefs) {
          const prev = this.lastLinkRefs.get(label);
          if (!prev || prev.href !== ref.href || (prev.title ?? "") !== (ref.title ?? "")) {
            changedLabels.add(label);
          }
        }
        for (const label of this.lastLinkRefs.keys()) {
          if (!linkRefs.has(label))
            changedLabels.add(label);
        }
        const parts = this.frozenParts;
        if (parts.length === 0)
          return this.frozenNodeCount === 0;
        const leadOffset = this.frozenNodeCount - (2 * parts.length - 1);
        if (leadOffset !== 0 && leadOffset !== 1)
          return false;
        const children = completedEl.childNodes;
        for (let i = 0; i < this.frozenNodeCount; i++) {
          const node = children[i];
          if (!node)
            return false;
          const isSeamSlot = (i - leadOffset) % 2 !== 0 || leadOffset === 1 && i === 0;
          if (isSeamSlot) {
            if (node.nodeType !== 3 || node.textContent !== "\n")
              return false;
          } else if (!(node instanceof HTMLElement)) {
            return false;
          }
        }
        const affected = [];
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (part && sourceMentionsLabel(complete.slice(part.start, part.end), changedLabels)) {
            affected.push(i);
          }
        }
        if (affected.length > MAX_LINK_REF_PATCH_PARTS)
          return false;
        for (const i of affected) {
          const part = parts[i];
          if (!part)
            return false;
          const from = lowerBound(tokens, part.start);
          const to = lowerBound(tokens, part.end);
          const rendered = renderBlocksToParts(complete, tokens.slice(from, to), {
            linkRefs,
            ...committedRenderOpts(this.formingTail)
          });
          if (rendered.length !== 1)
            return false;
          const newHtml = rendered[0]?.html ?? "";
          if (newHtml === part.rawHtml)
            continue;
          if (newHtml === "" || hasUnfreezableRawHtml(newHtml))
            return false;
          const host = completedEl.cloneNode(false);
          const sanitized = sanitizeRenderedMarkdown(newHtml);
          this.renderedChars += newHtml.length;
          this.parsedChars += sanitized.length;
          setPresanitizedHtml(host, sanitized);
          const template = host.firstElementChild;
          if (host.childNodes.length !== 1 || !(template instanceof HTMLElement))
            return false;
          const live = children[leadOffset + 2 * i];
          if (!(live instanceof HTMLElement))
            return false;
          if (live.tagName === template.tagName) {
            syncAttributes(live, template);
            morphElementChildrenFrom(live, template, 0);
          } else {
            completedEl.replaceChild(template, live);
          }
          part.rawHtml = newHtml;
        }
        if (affected.length > 0)
          this.linkRefPatchCommits++;
        return true;
      }
      // ---- Intra-list freezing (#29) ----------------------------------------
      // When the trailing group is a long, still-open, signature-uniform list, the
      // whole group would otherwise stay in the tail and be re-rendered per commit
      // (O(n²) for list-shaped output). Instead, settled items freeze INSIDE the
      // shared <ul>/<ol>: `frozenEnd` then points at an item-token boundary within
      // the group, the list element itself stays live (its attributes may still
      // change), and per-commit work is the unfrozen item slice only.
      /** Signature of the active shared trailing list; null = intra-list inactive. */
      listSig = null;
      /** Number of leading `<li>` children of the shared list that are frozen. */
      listFrozenLis = 0;
      /** Child index of the shared list element within `completedEl`. */
      listElIndex = 0;
      /** Source offset where the shared trailing list group begins (its part record on seal). */
      listStart = 0;
      /** Looseness baked into the frozen items (a flip forces a full morph). */
      listLoose = false;
      /** Task-list evidence seen so far (drives the `<ul>` class; monotonic). */
      listHasTask = false;
      resetListState() {
        this.listSig = null;
        this.listFrozenLis = 0;
        this.listElIndex = 0;
        this.listStart = 0;
        this.listLoose = false;
        this.listHasTask = false;
      }
      // ---- Footnote incremental rendering (#110) ----------------------------
      // A footnote-bearing document used to force a full `morphInnerHtml(render(
      // complete))` on every commit (any `[^` in the buffer tripped the freeze
      // guard), making footnote streaming O(n²). That is wasteful: a new footnote
      // definition only upgrades the specific `[^label]` references it resolves
      // (inline, never restructuring their block) and grows the trailing footnotes
      // section. This mode renders the body as per-block parts and the section as
      // per-`<li>` items, keeping a DOM handle to each, and re-morphs ONLY the parts
      // whose reference numbering changed plus the new/changed section items.
      //
      // Active only once at least one footnote DEFINITION is committed (before that,
      // references are literal and the ordinary frozen-tail path is byte-identical).
      // Any structural surprise (new/removed body block, section first appearing,
      // reorder that can't map, raw-HTML imbalance) falls back to a full rebuild,
      // and a rebuild that can't re-capture the node mapping gives up to the plain
      // full-morph path — so output is always correct, only sometimes slower.
      /** Whether footnote-incremental bookkeeping currently mirrors `completedEl`. */
      fnActive = false;
      /** A mapping guard failed irrecoverably; always full-morph until `reset`. */
      fnGaveUp = false;
      /** Committed source at the last footnote commit (append-only prefix guard). */
      fnSource = "";
      /** Serialized link-ref map at the last footnote commit. */
      fnLinkRefKey = "";
      /** Rendered body parts with the live DOM element each occupies. */
      fnBodyParts = [];
      /** The live `<ol>` inside the footnotes section (null = no section yet). */
      fnSectionOl = null;
      /** Last-rendered footnote section `<li>` HTML strings (change-detection). */
      fnSectionItems = [];
      // Persisted state for the append-only fast path (#133): when definitions
      // stream in over a fixed body in first-use order, a commit re-renders only the
      // one newly-resolved reference block and appends only the new section item(s),
      // instead of re-rendering the whole document every commit (the O(n²) driver).
      /** The context carried across commits — its numbering/slugs stay authoritative. */
      fnCtx = null;
      /** Normalized `[^label]` refs per body part (raw-source scan, over-approximate). */
      fnPartLabels = [];
      /** Distinct body labels in first-use (scan) order. */
      fnBodyOrder = [];
      /** How many times each body label is referenced (single-use gates the fast path). */
      fnBodyCount = /* @__PURE__ */ new Map();
      /** Source offset where the body ends; new content past it disqualifies the fast path. */
      fnBodyEnd = 0;
      resetFootnoteState() {
        this.fnActive = false;
        this.fnGaveUp = false;
        this.fnSource = "";
        this.fnLinkRefKey = "";
        this.fnBodyParts = [];
        this.fnSectionOl = null;
        this.fnSectionItems = [];
        this.fnCtx = null;
        this.fnPartLabels = [];
        this.fnBodyOrder = [];
        this.fnBodyCount = /* @__PURE__ */ new Map();
        this.fnBodyEnd = 0;
      }
      reset() {
        this.frozenEnd = 0;
        this.frozenSource = "";
        this.frozenHasHtml = false;
        this.frozenNodeCount = 0;
        this.lastLinkRefKey = "";
        this.lastLinkRefs = /* @__PURE__ */ new Map();
        this.frozenLabelCandidates.clear();
        this.committedHasOpenDetails = false;
        this.tailMemo = null;
        this.prefixVerifiedUpTo = 0;
        this.frozenParts = [];
        this.frozenPartsReliable = true;
        this.resetListState();
        this.resetFootnoteState();
        this.resetFrames();
      }
      /**
       * Reconcile `completedEl` so it serializes byte-identically to
       * `sanitizeRenderedMarkdown(renderCommittedMarkdownUnsafe(complete, tokens, formingTail))`,
       * freezing the settled prefix and re-rendering only the tail group. `tokens` must be
       * `tokenizeBlocks(complete)` (threaded from the caller, Layer 1), and
       * `providedLinkRefs` / `providedFootnoteDefs`, when given, must equal
       * `collectLinkReferenceDefinitions(complete)` /
       * `collectFootnoteDefinitions(complete)` (threaded from the caller's
       * incremental scanner, #30 / ADR 0004 Phase 1 — saves the per-commit
       * O(prefix) definition scans).
       *
       * `advance`, when given, must be the {@link ScanAdvance} the caller's OWN
       * scanner returned for exactly this `complete` (one advance per commit, the
       * production shape in streaming.ts). Its `reset`/`verifiedUpTo` contract
       * lets this commit skip the O(prefix) frozen-source byte re-check — the
       * event stream carries the append-only proof, so the per-update prefix
       * decision degrades to a fallback trigger (ADR 0004 Phase 2). Without it
       * (direct callers, tests) every commit keeps today's full check.
       *
       * `formingTail` is the caller's `committedTailContinues(complete, blocks)`:
       * when set, a fence still open at the end of `complete` (nested in the
       * trailing list item / blockquote) renders in its forming shape.
       */
      update(completedEl, complete, tokens, providedLinkRefs, providedFootnoteDefs, advance, formingTail = false) {
        this.formingTailChanged = formingTail !== this.formingTail;
        this.formingTail = formingTail;
        if (complete === "") {
          if (completedEl.childNodes.length > 0)
            completedEl.replaceChildren();
          this.reset();
          return;
        }
        this.committedHasOpenDetails = this.frozenDetailsBalance > 0;
        const linkRefs = providedLinkRefs ?? collectLinkReferenceDefinitions(complete, tokens);
        const linkRefKey = serializeLinkRefs(linkRefs);
        const tailStart = settledTailStart(tokens);
        const tailToken = tokens[tailStart];
        const settledOffset = tailToken ? tailToken.start : complete.length;
        const footnoteDefs = providedFootnoteDefs ?? collectFootnoteDefinitions(complete, tokens);
        if (footnoteDefs.size > 0) {
          this.commitWithFootnotes(completedEl, complete, tokens, linkRefs, linkRefKey, footnoteDefs);
          return;
        }
        if (this.fnActive || this.fnGaveUp)
          this.resetFootnoteState();
        const prefixVerified = advance !== void 0 && !advance.reset && this.frozenEnd <= this.prefixVerifiedUpTo;
        this.prefixVerifiedUpTo = advance !== void 0 && !advance.reset ? advance.verifiedUpTo : 0;
        if (prefixVerified)
          this.prefixChecksSkipped++;
        if (!prefixVerified && !complete.startsWith(this.frozenSource) || tokenStraddles(tokens, this.frozenEnd)) {
          this.fullMorph(completedEl, complete, tokens, linkRefKey, linkRefs);
          return;
        }
        if (linkRefKey !== this.lastLinkRefKey && !this.linkRefDeltaIsInert(linkRefs)) {
          if (!this.patchFrozenLinkRefs(completedEl, complete, tokens, linkRefs)) {
            this.fullMorph(completedEl, complete, tokens, linkRefKey, linkRefs);
            return;
          }
        }
        if (this.listSig) {
          const outcome = this.commitSharedList(completedEl, complete, tokens, linkRefs, linkRefKey);
          if (outcome === "fallback") {
            this.fullMorph(completedEl, complete, tokens, linkRefKey, linkRefs);
            return;
          }
          if (outcome === "handled")
            return;
        }
        let renderEnd = 0;
        for (let i = lowerBound(tokens, Math.max(settledOffset, this.frozenEnd)) - 1; i >= 0; i--) {
          const token = tokens[i];
          if (!token)
            break;
          if (settleClassOf(token.kind) !== "separator") {
            renderEnd = token.end;
            break;
          }
        }
        const advanceTo = Math.max(Math.min(settledOffset, renderEnd), this.frozenEnd);
        const deltaFrom = lowerBound(tokens, this.frozenEnd);
        const deltaTo = lowerBound(tokens, advanceTo);
        const deltaTokens = tokens.slice(deltaFrom, deltaTo);
        const tailTokens = tokens.slice(deltaTo);
        const tailRenderTokens = filterRenderTokens(tailTokens);
        const tailInfoOf = (parts) => {
          const first = tailRenderTokens[0];
          const last = tailRenderTokens[tailRenderTokens.length - 1];
          return {
            parts,
            renderTokens: tailRenderTokens,
            srcStart: first?.start ?? 0,
            srcText: first && last ? complete.slice(first.start, last.end) : "",
            linkRefKey
          };
        };
        const memo = this.tailMemo;
        const deltaRenderTokens = filterRenderTokens(deltaTokens);
        if (memo !== null && this.openFrames.length === 0 && deltaRenderTokens.length > 0 && memo.root === completedEl && memo.atNodeCount === this.frozenNodeCount && memo.lead === (this.frozenHasHtml ? "\n" : "") && memo.linkRefKey === linkRefKey && sameRenderTokens(memo.renderTokens, deltaRenderTokens) && complete.startsWith(memo.srcText, memo.srcStart) && !hasUnfreezableRawHtml(memo.rawHtml) && // A nested fence that was still forming at the last commit rendered its
        // forming shape; now that later content follows, the same tokens over the
        // same bytes render it closed (by its container), so the memoized render
        // is not what a fresh render would produce. (A literal class name in code
        // text only declines the adoption: slower, never different.)
        !memo.rawHtml.includes(FORMING_FENCE_PRE_CLASS)) {
          const tailParts = renderBlocksToParts(complete, tailTokens, {
            linkRefs,
            ...committedRenderOpts(this.formingTail)
          });
          const tailHtml = tailParts.map((p) => p.html).join("\n");
          this.renderedChars += tailHtml.length;
          this.frozenNodeCount += memo.nodeCount;
          this.frozenHasHtml = true;
          for (const part of memo.parts) {
            this.frozenParts.push({ start: part.start, end: part.end, rawHtml: part.html });
          }
          this.deltaCommitsSkipped++;
          this.deltaRendersSkipped++;
          this.tailMemo = null;
          this.commitRanges(completedEl, "", tailHtml, [], tailInfoOf(tailParts));
          this.frozenDetailsBalance += detailsBalance(memo.rawHtml);
          this.committedHasOpenDetails = this.frozenDetailsBalance > 0 || hasOpenDetailsElement(tailHtml);
        } else {
          const deltaParts = deltaTokens.length ? renderBlocksToParts(complete, deltaTokens, {
            linkRefs,
            ...committedRenderOpts(this.formingTail)
          }) : [];
          const tailParts = tailTokens.length ? renderBlocksToParts(complete, tailTokens, {
            linkRefs,
            ...committedRenderOpts(this.formingTail)
          }) : [];
          const deltaHtml = deltaParts.map((p) => p.html).join("\n");
          const tailHtml = tailParts.map((p) => p.html).join("\n");
          if (this.openFrames.length > 0 && this.frameCloseAppeared(deltaHtml, tailHtml)) {
            this.fullMorph(completedEl, complete, tokens, linkRefKey, linkRefs);
            return;
          }
          let rerootChain = null;
          if (deltaHtml !== "" && hasUnfreezableRawHtml(deltaHtml)) {
            const chain = getHtmlPolicy() === "passthrough" ? openElementChainAtEof(deltaHtml) : null;
            if (chain === null || chain.length > 0 && !chain.every((tag) => SAFE_REROOT_TAGS.has(tag))) {
              this.fullMorph(completedEl, complete, tokens, linkRefKey, linkRefs);
              return;
            }
            if (chain.length > 0)
              rerootChain = chain;
          }
          this.renderedChars += deltaHtml.length + tailHtml.length;
          const root = this.commitRoot(completedEl);
          if (this.frameAnchor) {
            while (completedEl.lastChild && completedEl.lastChild !== this.frameAnchor) {
              completedEl.lastChild.remove();
            }
          }
          if (rerootChain) {
            const sanitizedDelta = deltaHtml !== "" ? sanitizeRenderedMarkdown(deltaHtml) : "";
            const sanitizedTail = tailHtml !== "" ? sanitizeRenderedMarkdown(tailHtml) : "";
            const survivors = sanitizedDelta !== "" ? this.survivingChain(root, sanitizedDelta, rerootChain) : [];
            if (survivors.length > 0) {
              if (!this.commitWithReroot(completedEl, root, survivors, sanitizedDelta, sanitizedTail, tailHtml !== "")) {
                this.fullMorph(completedEl, complete, tokens, linkRefKey, linkRefs);
                return;
              }
            } else {
              this.commitRanges(root, deltaHtml, tailHtml, null, tailInfoOf(tailParts), sanitizedDelta, sanitizedTail);
            }
          } else {
            this.commitRanges(root, deltaHtml, tailHtml, deltaParts, tailInfoOf(tailParts));
          }
          this.frozenDetailsBalance += detailsBalance(deltaHtml);
          this.committedHasOpenDetails = this.frozenDetailsBalance > 0 || hasOpenDetailsElement(tailHtml);
        }
        if (advanceTo > this.frozenEnd) {
          this.accumulateLabelCandidates(complete.slice(this.frozenEnd, advanceTo));
        }
        this.frozenEnd = advanceTo;
        this.frozenSource = complete.slice(0, advanceTo);
        this.lastLinkRefKey = linkRefKey;
        this.lastLinkRefs = linkRefs;
        if (this.openFrames.length === 0) {
          this.maybeActivateIntraList(completedEl, complete, tokens, tailStart);
        }
      }
      /**
       * The generic two-range commit: reconcile the newly-settled delta at
       * `[frozenNodeCount, …)` of `root`, advance the boundary over it, then
       * reconcile the tail after it. Two range morphs — delta, then tail — so the
       * delta parses exactly once: its morph template doubles as the frozen node
       * count (gap C), where the old joint morph needed a second, count-only parse
       * of the sanitized delta on every commit (~26% of the commit path). The
       * split parse yields the joint morph's exact node sequence: top-level parts
       * end in elements, so text cannot merge across the boundary, and each '\n'
       * seam stays its own text node. Blocks settling this commit keep their node
       * identity — the delta range morph reuses them in place and never trims —
       * and the tail morph's trailing trim preserves the sweep semantics (gaps
       * B/E).
       *
       * On top of that, the tail memo (ADR 0004 Phase 2) removes the remaining
       * redundant parses of a steady stream:
       *
       *  - **Delta adopt-in-place**: the blocks settling this commit usually ARE
       *    last frame's tail — rendered from the same string, morphed at the same
       *    position of the same root, with the same '\n' seam. When the memo
       *    proves that byte-exactly, the live nodes are already what the delta
       *    morph would produce, so the frozen boundary just advances over the
       *    memoized node count: no sanitize, no parse, no diff.
       *  - **Delta extension adoption**: more often the settling group grew
       *    before it settled, and the delta's FIRST top-level part alone equals
       *    the memoized tail (the group as last committed) while later parts are
       *    new. The memoized nodes are adopted the same way and only the
       *    remaining parts are sanitized + parsed + morphed — reproducing, byte
       *    for byte, the two commits today's path would have produced had the
       *    stream settled the tail first and the rest one commit later. That
       *    partition is only taken when both halves are independently freezable
       *    (the memo part is a single group with balanced raw tags — so the rest
       *    is balanced too, by additivity — under a delta that already passed the
       *    raw-HTML guard), the exact per-fragment-sanitize assumption the frozen
       *    boundary itself rests on, at the same top-level group granularity.
       *  - **Tail reuse**: a commit that re-renders the tail byte-identically
       *    (e.g. only blanks or inert definitions committed) keeps the live tail
       *    nodes verbatim; only the trailing trim (stale block-level pending
       *    elements from the previous frame) still runs.
       *
       * Every skip demands EXACT equality of the raw strings, root identity, node
       * position, and seam — any mismatch, and any commit path other than this
       * one, falls back to the full sanitize + parse + morph, so a missed skip is
       * only ever slower, never different. The memo's DOM-trust invariant (the
       * recorded region is untouched between commits) is upheld by the callers:
       * the streaming renderer sweeps its pending-tail artifacts before every
       * commit and invalidates on hydration ({@link invalidateDomMemo}).
       *
       * `deltaParts` must be the delta's per-part split (joining to `deltaHtml`)
       * from a delta that passed the raw-HTML guard, or null to disable the
       * partial adoption (the re-rooted flattened path, whose delta is known
       * unbalanced). `presanitizedDelta`/`presanitizedTail` forward sanitizations
       * the re-root probe already paid for; when null they are computed only on a
       * memo miss.
       */
      commitRanges(root, deltaHtml, tailHtml, deltaParts, tailInfo, presanitizedDelta = null, presanitizedTail = null) {
        if (deltaHtml !== "") {
          const lead = this.frozenHasHtml ? "\n" : "";
          const memo2 = this.tailMemo;
          const adoptable = memo2 !== null && memo2.root === root && memo2.atNodeCount === this.frozenNodeCount && memo2.lead === lead;
          if (adoptable && memo2.rawHtml === deltaHtml) {
            this.frozenNodeCount += memo2.nodeCount;
            this.deltaCommitsSkipped++;
          } else if (adoptable && memo2.parts.length === 1 && memo2.balanced && deltaParts !== null && deltaParts.length > 1 && deltaParts[0]?.html === memo2.rawHtml) {
            this.frozenNodeCount += memo2.nodeCount;
            const rest = deltaParts.slice(1).map((p) => p.html).join("\n");
            const html = asSanitizedHtml("\n" + sanitizeRenderedMarkdown(rest));
            this.parsedChars += html.length;
            this.frozenNodeCount += morphInnerHtmlRangeFrom(root, this.frozenNodeCount, html);
            this.deltaPrefixesAdopted++;
          } else {
            const sanitized = presanitizedDelta ?? sanitizeRenderedMarkdown(deltaHtml);
            const html = asSanitizedHtml(lead + sanitized);
            this.parsedChars += html.length;
            this.frozenNodeCount += morphInnerHtmlRangeFrom(root, this.frozenNodeCount, html);
          }
          this.frozenHasHtml = true;
          this.tailMemo = null;
          if (deltaParts !== null) {
            for (const part of deltaParts) {
              this.frozenParts.push({ start: part.start, end: part.end, rawHtml: part.html });
            }
          } else {
            this.frozenPartsReliable = false;
          }
        }
        const tailLead = this.frozenHasHtml && tailHtml !== "" ? "\n" : "";
        const memo = this.tailMemo;
        if (memo && tailHtml !== "" && memo.root === root && memo.atNodeCount === this.frozenNodeCount && memo.lead === tailLead && memo.rawHtml === tailHtml) {
          while (root.childNodes.length > this.frozenNodeCount + memo.nodeCount) {
            root.lastChild?.remove();
          }
          memo.srcStart = tailInfo.srcStart;
          memo.srcText = tailInfo.srcText;
          memo.renderTokens = tailInfo.renderTokens;
          memo.parts = tailInfo.parts;
          memo.linkRefKey = tailInfo.linkRefKey;
          this.tailMorphsSkipped++;
        } else if (tailHtml !== "") {
          const sanitized = presanitizedTail ?? sanitizeRenderedMarkdown(tailHtml);
          const html = asSanitizedHtml(tailLead + sanitized);
          this.parsedChars += html.length;
          const nodeCount = morphInnerHtmlFrom(root, this.frozenNodeCount, html);
          this.tailMemo = {
            root,
            atNodeCount: this.frozenNodeCount,
            lead: tailLead,
            rawHtml: tailHtml,
            nodeCount,
            balanced: tailInfo.parts.length === 1 && !hasUnfreezableRawHtml(tailHtml),
            srcStart: tailInfo.srcStart,
            srcText: tailInfo.srcText,
            renderTokens: tailInfo.renderTokens,
            parts: tailInfo.parts,
            linkRefKey: tailInfo.linkRefKey
          };
        } else {
          morphInnerHtmlFrom(root, this.frozenNodeCount, "");
          this.tailMemo = null;
        }
      }
      /**
       * The subsequence of `chain` (raw open elements at the delta's EOF,
       * outermost first) that survives sanitization, walked along the rightmost
       * path of the sanitized delta fragment. Elements the sanitizer unwrapped are
       * skipped — their children sit in place at the enclosing level, exactly as
       * the whole-string sanitize leaves them.
       */
      survivingChain(root, sanitizedDelta, chain) {
        const probe = root.cloneNode(false);
        setPresanitizedHtml(probe, sanitizedDelta);
        const survivors = [];
        let cursor = probe;
        for (const tag of chain) {
          const nextEl = cursor.lastElementChild;
          if (nextEl && nextEl.tagName === tag) {
            survivors.push(tag);
            cursor = nextEl;
          }
        }
        return survivors;
      }
      /**
       * Commit a delta that leaves `chain` (outermost first, all
       * {@link SAFE_REROOT_TAGS}, sanitizer-surviving) open at its EOF: morph the
       * delta into the current root, walk the freshly-appended DOM down the chain
       * pushing a frame per element, then morph the tail INSIDE the innermost
       * frame — where the whole-string parse puts it. Returns false when the live
       * DOM does not match the probed chain (caller full-morphs; correctness over
       * speed).
       */
      commitWithReroot(completedEl, root, chain, sanitizedDelta, sanitizedTail, rawTailNonEmpty) {
        this.tailMemo = null;
        this.frozenPartsReliable = false;
        const lead = this.frozenHasHtml ? "\n" : "";
        this.parsedChars += lead.length + sanitizedDelta.length;
        morphInnerHtmlFrom(root, this.frozenNodeCount, asSanitizedHtml(lead + sanitizedDelta));
        let container = root;
        for (const tag of chain) {
          const nextEl = container.lastElementChild;
          if (!(nextEl instanceof HTMLElement) || nextEl.tagName !== tag)
            return false;
          this.openFrames.push({
            el: nextEl,
            tag,
            outerFrozenNodeCount: this.frozenNodeCount,
            outerFrozenHasHtml: this.frozenHasHtml
          });
          container = nextEl;
        }
        this.frameAnchor ??= completedEl.lastChild;
        this.frozenNodeCount = container.childNodes.length;
        this.frozenHasHtml = true;
        if (rawTailNonEmpty)
          this.parsedChars += 1 + sanitizedTail.length;
        morphInnerHtmlFrom(container, this.frozenNodeCount, rawTailNonEmpty ? asSanitizedHtml("\n" + sanitizedTail) : "");
        return true;
      }
      /**
       * Arm intra-list freezing when the generic commit just rendered a trailing
       * group that qualifies: a signature-uniform list, starting at the frozen
       * boundary, still open (nothing after it but blanks), with enough items to be
       * worth per-item bookkeeping. Pure state initialization — no DOM work, and no
       * items are frozen yet: the next commit's shared-list pass freezes them
       * through the normal path (including the raw-inline balance check).
       */
      maybeActivateIntraList(completedEl, complete, tokens, tailStart) {
        const first = tokens[tailStart];
        if (!first || first.kind !== "list_item" || first.start < this.frozenEnd)
          return;
        const scan = scanListGroup(complete, tokens, tailStart);
        if (scan.itemTokens.length < INTRA_LIST_MIN_ITEMS)
          return;
        for (let i = scan.next; i < tokens.length; i++) {
          if (tokens[i]?.kind !== "blank")
            return;
        }
        const lastIdx = completedEl.childNodes.length - 1;
        const el2 = completedEl.childNodes[lastIdx];
        if (!(el2 instanceof HTMLElement) || el2.tagName !== (scan.sig.ordered ? "OL" : "UL"))
          return;
        this.listSig = scan.sig;
        this.listFrozenLis = 0;
        this.listElIndex = lastIdx;
        this.listStart = first.start;
        this.listLoose = scan.loose;
        this.listHasTask = false;
        this.tailMemo = null;
      }
      /**
       * Per-commit reconcile while intra-list freezing is active. Freezes every
       * settled unfrozen item (all but the last, or all when the group just ended)
       * into the shared list element, morphs the unfrozen item slice in place, and
       * syncs the element's own attributes. Returns:
       *  - 'handled' — the list is still the open trailing group; commit complete.
       *  - 'sealed'  — the group ended; the list is now a fully frozen top-level
       *    node and the caller's generic path must process what follows it.
       *  - 'fallback' — a guard tripped (tight→loose flip against frozen items,
       *    signature break the caller can't see, or a DOM shape mismatch); the
       *    caller full-morphs, which also resets all intra-list state.
       */
      commitSharedList(completedEl, complete, tokens, linkRefs, linkRefKey) {
        const sig = this.listSig;
        if (!sig)
          return "fallback";
        const wantTag = sig.ordered ? "OL" : "UL";
        const listEl = completedEl.childNodes[this.listElIndex];
        if (!(listEl instanceof HTMLElement) || listEl.tagName !== wantTag)
          return "fallback";
        const unfrozenItems = [];
        let looseEvidence = false;
        let blankPending = false;
        let seenItem = this.listFrozenLis > 0;
        let ended = false;
        for (let i = lowerBound(tokens, this.frozenEnd); i < tokens.length; i++) {
          const token = tokens[i];
          if (!token)
            break;
          if (token.kind === "blank") {
            if (seenItem)
              blankPending = true;
            continue;
          }
          if (token.kind === "list_item" && listSliceContinuesGroup(sig, complete.slice(token.start, token.end))) {
            seenItem = true;
            if (blankPending)
              looseEvidence = true;
            blankPending = false;
            if (listItemSliceIsMultiParagraph(complete.slice(token.start, token.end))) {
              looseEvidence = true;
            }
            unfrozenItems.push(token);
            continue;
          }
          ended = true;
          break;
        }
        const currentLoose = this.listLoose || looseEvidence;
        if (currentLoose !== this.listLoose) {
          if (this.listFrozenLis > 0)
            return "fallback";
          this.listLoose = currentLoose;
        }
        const freezeCount = ended ? unfrozenItems.length : Math.max(0, unfrozenItems.length - 1);
        const deltaItems = unfrozenItems.slice(0, freezeCount);
        const tailItems = unfrozenItems.slice(freezeCount);
        const delta = renderListItemsSlice(complete, deltaItems, this.listLoose, linkRefs, this.formingTail);
        if (delta.itemsHtml !== "" && hasUnfreezableRawHtml(delta.itemsHtml))
          return "fallback";
        const tail = renderListItemsSlice(complete, tailItems, this.listLoose, linkRefs, this.formingTail);
        this.renderedChars += delta.itemsHtml.length + tail.itemsHtml.length;
        const hasTask = this.listHasTask || delta.anyTask || tail.anyTask;
        const open = listGroupOpenTag(sig, hasTask);
        const close = listGroupCloseTag(sig);
        const templateHost = completedEl.cloneNode(false);
        this.parsedChars += open.length + delta.itemsHtml.length + tail.itemsHtml.length + close.length;
        setSanitizedHtml(templateHost, `${open}${delta.itemsHtml}${tail.itemsHtml}${close}`);
        const templateList = templateHost.firstElementChild;
        if (!(templateList instanceof HTMLElement) || templateList.tagName !== wantTag) {
          return "fallback";
        }
        syncAttributes(listEl, templateList);
        morphElementChildrenFrom(listEl, templateList, this.listFrozenLis);
        if (freezeCount > 0) {
          const countHost = completedEl.cloneNode(false);
          setSanitizedHtml(countHost, `${open}${delta.itemsHtml}${close}`);
          this.listFrozenLis += countHost.firstElementChild?.childNodes.length ?? 0;
          const lastFrozen = deltaItems[deltaItems.length - 1];
          if (lastFrozen) {
            this.accumulateLabelCandidates(complete.slice(this.frozenEnd, lastFrozen.end));
            this.frozenEnd = lastFrozen.end;
            this.frozenSource = complete.slice(0, this.frozenEnd);
          }
        }
        this.listHasTask = hasTask;
        this.lastLinkRefKey = linkRefKey;
        this.lastLinkRefs = linkRefs;
        if (ended) {
          this.frozenParts.push({ start: this.listStart, end: this.frozenEnd, rawHtml: null });
          this.frozenNodeCount = this.listElIndex + 1;
          this.frozenHasHtml = true;
          this.resetListState();
          return "sealed";
        }
        while (completedEl.childNodes.length > this.listElIndex + 1) {
          completedEl.lastChild?.remove();
        }
        return "handled";
      }
      /**
       * Commit a footnote-bearing document (#110). Reuses the incremental body/
       * section mapping when it still mirrors `completedEl`; otherwise rebuilds it
       * from a full render (re-capturing node handles), and gives up to the plain
       * full-morph path only if that re-capture is impossible. A still-forming
       * `<details>` (exotic combined with footnotes) always full-morphs so its
       * open-element flag stays correct.
       */
      commitWithFootnotes(completedEl, complete, tokens, linkRefs, linkRefKey, footnoteDefs) {
        this.tailMemo = null;
        if (this.fnGaveUp || this.openFrames.length > 0 || complete.includes("<details")) {
          this.fullMorph(completedEl, complete, tokens, linkRefKey, linkRefs);
          return;
        }
        const canReuse2 = this.fnActive && this.fnLinkRefKey === linkRefKey && complete.startsWith(this.fnSource);
        if (canReuse2 && this.fnIncremental(completedEl, complete, tokens, linkRefs, footnoteDefs)) {
          this.fnSource = complete;
          this.fnLinkRefKey = linkRefKey;
          return;
        }
        this.fnRebuild(completedEl, complete, tokens, linkRefs, linkRefKey, footnoteDefs);
      }
      /** Render body parts + section items under a fresh footnote context. */
      renderFootnoteFrame(complete, tokens, linkRefs, footnoteDefs) {
        const ctx = createFootnoteContext(footnoteDefs);
        const previous = getActiveFootnoteContext();
        setActiveFootnoteContext(ctx);
        try {
          const parts = renderBlocksToParts(complete, tokens, {
            linkRefs,
            ...committedRenderOpts(this.formingTail)
          });
          const items = renderFootnoteSectionItems(ctx, linkRefs);
          return { parts, items, ctx };
        } finally {
          setActiveFootnoteContext(previous);
        }
      }
      /**
       * Capture the per-body-part reference scan and the persisted context after a
       * full frame render, arming the append-only fast path (#133). Called from both
       * `fnRebuild` and the full incremental path so the fast path can resume after
       * either.
       */
      captureFootnoteFastState(complete, parts, ctx) {
        this.fnCtx = ctx;
        this.fnPartLabels = parts.map((p) => footnoteRefLabelsIn(complete.slice(p.start, p.end)));
        this.fnBodyOrder = [];
        this.fnBodyCount = /* @__PURE__ */ new Map();
        const seen = /* @__PURE__ */ new Set();
        for (const labels of this.fnPartLabels) {
          for (const label of labels) {
            this.fnBodyCount.set(label, (this.fnBodyCount.get(label) ?? 0) + 1);
            if (!seen.has(label)) {
              seen.add(label);
              this.fnBodyOrder.push(label);
            }
          }
        }
        this.fnBodyEnd = parts.length > 0 ? parts[parts.length - 1]?.end ?? 0 : 0;
      }
      /**
       * Full render + morph + re-capture of the per-block / per-item node mapping.
       * Byte-identical to `renderMarkdownCore` (body parts joined with '\n', then the
       * section). On success `fnActive` is armed for incremental commits; if the
       * captured element count doesn't match the rendered parts (raw-HTML stripping
       * changed the node shape), it gives up to plain full-morph for this stream.
       */
      fnRebuild(completedEl, complete, tokens, linkRefs, linkRefKey, footnoteDefs) {
        const { parts, items, ctx } = this.renderFootnoteFrame(complete, tokens, linkRefs, footnoteDefs);
        const body = parts.map((p) => p.html).join("\n");
        const section = wrapFootnoteSection(items, ctx.idPrefix);
        const rawHtml = section === "" ? body : body === "" ? section : `${body}
${section}`;
        this.committedHasOpenDetails = hasOpenDetailsElement(rawHtml);
        const html = sanitizeRenderedMarkdown(rawHtml);
        this.renderedChars += html.length;
        this.parsedChars += html.length;
        morphInnerHtml(completedEl, html);
        this.frozenEnd = 0;
        this.frozenSource = "";
        this.frozenHasHtml = false;
        this.frozenNodeCount = 0;
        this.frozenParts = [];
        this.frozenPartsReliable = true;
        this.resetListState();
        this.lastLinkRefKey = linkRefKey;
        this.lastLinkRefs = linkRefs;
        this.frozenLabelCandidates.clear();
        const els = Array.from(completedEl.children);
        const expected = parts.length + (section === "" ? 0 : 1);
        const sectionOl = section === "" ? null : els[els.length - 1]?.querySelector("ol") ?? null;
        if (els.length !== expected || section !== "" && !sectionOl) {
          this.resetFootnoteState();
          this.fnGaveUp = true;
          return;
        }
        this.fnBodyParts = parts.map((p, i) => ({ ...p, el: els[i] }));
        this.fnSectionItems = items;
        this.fnSectionOl = sectionOl;
        this.fnActive = true;
        this.fnGaveUp = false;
        this.fnSource = complete;
        this.fnLinkRefKey = linkRefKey;
        this.captureFootnoteFastState(complete, parts, ctx);
      }
      /**
       * Incremental footnote commit. Tries the append-only fast path first (#133);
       * otherwise falls back to a full frame render + per-part diff-morph (the path
       * that handles renumbering, repeated references, and nested footnotes). Returns
       * false — signalling a rebuild — on any structural change neither path can
       * express: a different body-part count or boundary, a raw-HTML imbalance, a tag
       * change, or the section appearing/disappearing/shrinking.
       */
      fnIncremental(completedEl, complete, tokens, linkRefs, footnoteDefs) {
        const fast = this.fnFastCommit(completedEl, complete, tokens, linkRefs, footnoteDefs);
        if (fast !== "skip")
          return fast === "done";
        const { parts, items, ctx } = this.renderFootnoteFrame(complete, tokens, linkRefs, footnoteDefs);
        if (parts.length !== this.fnBodyParts.length)
          return false;
        for (let i = 0; i < parts.length; i++) {
          const cached = this.fnBodyParts[i];
          const part = parts[i];
          if (!cached || !part || cached.start !== part.start || cached.end !== part.end)
            return false;
        }
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const cached = this.fnBodyParts[i];
          if (!part || !cached || part.html === cached.html)
            continue;
          if (part.html !== "" && hasUnfreezableRawHtml(part.html))
            return false;
          if (!this.morphPartElement(completedEl, cached.el, part.html))
            return false;
          cached.html = part.html;
          this.renderedChars += part.html.length;
        }
        if (!this.syncFootnoteSection(completedEl, items))
          return false;
        this.captureFootnoteFastState(complete, parts, ctx);
        return true;
      }
      /**
       * The append-only fast path (#133): when definitions stream in over a fixed
       * body in first-use order, each with a single, non-nested reference, re-render
       * only the newly-resolved reference block(s) and append only the new section
       * item(s) — turning the per-commit O(n) full re-render into O(delta). Returns
       * `'skip'` (defer to the full path) on anything it can't safely express, or
       * `'rebuild'` when a morph guard fails mid-commit.
       */
      fnFastCommit(completedEl, complete, tokens, linkRefs, footnoteDefs) {
        const persisted = this.fnCtx;
        if (!persisted)
          return "skip";
        const last = this.fnBodyParts.at(-1);
        if (last && (last.html.includes(FORMING_FENCE_PRE_CLASS) || this.formingTailChanged && MAY_HOLD_FENCE_RE.test(complete.slice(last.start, last.end)))) {
          return "skip";
        }
        for (const token of tokens) {
          if (token.end <= this.fnBodyEnd)
            continue;
          if (token.kind !== "footnote_def" && token.kind !== "blank" && token.kind !== "link_ref_def") {
            return "skip";
          }
        }
        const resolvedNow = this.fnBodyOrder.filter((label) => footnoteDefs.has(label));
        const prev = persisted.order;
        if (resolvedNow.length < prev.length)
          return "skip";
        for (let i = 0; i < prev.length; i++)
          if (resolvedNow[i] !== prev[i])
            return "skip";
        const newLabels = resolvedNow.slice(prev.length);
        for (const label of resolvedNow)
          if ((this.fnBodyCount.get(label) ?? 0) !== 1)
            return "skip";
        for (const def of footnoteDefs.values())
          if (def.content.includes("[^"))
            return "skip";
        if (newLabels.length === 0)
          return "done";
        const ctx = reseatFootnoteContext(footnoteDefs, persisted);
        const newSet = new Set(newLabels);
        let appendedItems;
        const previous = getActiveFootnoteContext();
        setActiveFootnoteContext(ctx);
        try {
          for (let i = 0; i < this.fnPartLabels.length; i++) {
            const labels = this.fnPartLabels[i];
            const cached = this.fnBodyParts[i];
            if (!labels || !cached || !labels.some((label) => newSet.has(label)))
              continue;
            const partTokens = tokens.filter((t) => t.start >= cached.start && t.end <= cached.end);
            const html = renderBlocksToParts(complete, partTokens, {
              linkRefs,
              ...committedRenderOpts(this.formingTail)
            }).map((p) => p.html).join("\n");
            if (html !== "" && hasUnfreezableRawHtml(html))
              return "rebuild";
            if (!this.morphPartElement(completedEl, cached.el, html))
              return "rebuild";
            cached.html = html;
            this.renderedChars += html.length;
          }
          appendedItems = renderFootnoteSectionItems(ctx, linkRefs, this.fnSectionItems.length);
        } finally {
          setActiveFootnoteContext(previous);
        }
        if (!this.syncFootnoteSection(completedEl, [...this.fnSectionItems, ...appendedItems])) {
          return "rebuild";
        }
        this.fnCtx = ctx;
        return "done";
      }
      /**
       * Reconcile one body part's element in place against freshly rendered HTML,
       * preserving the element's identity (a footnote reference upgrade is an inline
       * change within the block). Returns false — signalling a rebuild — if the part
       * no longer sanitizes to a single element of the same tag.
       */
      morphPartElement(completedEl, el2, partHtml) {
        const host = completedEl.cloneNode(false);
        this.parsedChars += partHtml.length;
        setPresanitizedHtml(host, sanitizeRenderedMarkdown(partHtml));
        const template = host.firstElementChild;
        if (host.childNodes.length !== 1 || !(template instanceof HTMLElement) || template.tagName !== el2.tagName) {
          return false;
        }
        syncAttributes(el2, template);
        morphElementChildrenFrom(el2, template, 0);
        return true;
      }
      /**
       * Reconcile the footnotes section incrementally: morph the `<ol>` children
       * from the first changed item onward, freezing the identical leading items
       * (the common append-only case parses just the one new/last item). Returns
       * false — signalling a rebuild — when the section must appear, disappear, or
       * its item shape can't be mapped.
       */
      syncFootnoteSection(completedEl, items) {
        const prev = this.fnSectionItems;
        if (items.length === 0)
          return this.fnSectionOl === null;
        if (!this.fnSectionOl)
          return false;
        let firstChanged = 0;
        const min = Math.min(prev.length, items.length);
        while (firstChanged < min && prev[firstChanged] === items[firstChanged])
          firstChanged++;
        if (firstChanged === prev.length && prev.length === items.length)
          return true;
        const host = completedEl.cloneNode(false);
        this.parsedChars += items.slice(firstChanged).join("").length;
        setSanitizedHtml(host, `<ol>${items.slice(firstChanged).join("")}</ol>`);
        const templateOl = host.firstElementChild;
        if (!(templateOl instanceof HTMLElement) || templateOl.tagName !== "OL")
          return false;
        morphElementChildrenFrom(this.fnSectionOl, templateOl, firstChanged);
        this.fnSectionItems = items;
        this.renderedChars += items.slice(firstChanged).join("").length;
        return true;
      }
      fullMorph(completedEl, complete, tokens, linkRefKey, linkRefs) {
        const rawHtml = renderCommittedMarkdownUnsafe(complete, tokens, this.formingTail);
        this.committedHasOpenDetails = hasOpenDetailsElement(rawHtml);
        const html = sanitizeRenderedMarkdown(rawHtml);
        this.renderedChars += html.length;
        this.parsedChars += html.length;
        this.tailMemo = null;
        this.frozenParts = [];
        this.frozenPartsReliable = true;
        morphInnerHtml(completedEl, html);
        this.frozenEnd = 0;
        this.frozenSource = "";
        this.frozenHasHtml = false;
        this.frozenNodeCount = 0;
        this.lastLinkRefKey = linkRefKey;
        this.lastLinkRefs = new Map(linkRefs);
        this.frozenLabelCandidates.clear();
        this.resetListState();
        this.resetFootnoteState();
        this.resetFrames();
      }
    };
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/streaming.js
function trailingFootnotesSection(completedEl) {
  const last = completedEl.lastElementChild;
  return last && last.tagName === "SECTION" && last.classList.contains("footnotes") ? last : null;
}
function tailContentElement(completedEl) {
  const section = trailingFootnotesSection(completedEl);
  return section ? section.previousElementSibling : completedEl.lastElementChild;
}
function appendPendingTail(completedEl, el2) {
  const section = trailingFootnotesSection(completedEl);
  if (section)
    completedEl.insertBefore(el2, section);
  else
    completedEl.append(el2);
}
function tailPendingDescendant(completedEl, cls, tagName) {
  const last = tailContentElement(completedEl);
  if (!last)
    return null;
  return findDescendantByClass(last, cls, tagName);
}
function tailDirectPendingBlock(completedEl, excludeLi) {
  const last = tailContentElement(completedEl);
  if (!last || !last.classList.contains(BLOCK_PENDING_CLASS))
    return null;
  if (excludeLi && last.tagName === "LI")
    return null;
  return last;
}
function clearBlockPendingDom(completedEl, parts) {
  if (parts.includes("continuation"))
    clearListContinuationDom(completedEl);
  if (parts.includes("paragraph-continuation"))
    clearParagraphContinuationDom(completedEl);
  if (parts.includes("list-items")) {
    const pendingLi = tailPendingDescendant(completedEl, BLOCK_PENDING_CLASS, "LI");
    const wrapper = pendingLi?.parentElement;
    pendingLi?.remove();
    if (wrapper && (wrapper.tagName === "UL" || wrapper.tagName === "OL") && wrapper.childNodes.length === 0) {
      wrapper.remove();
    }
  }
  if (parts.includes("direct-blocks")) {
    tailDirectPendingBlock(completedEl, false)?.remove();
  }
  if (parts.includes("non-list-direct")) {
    tailDirectPendingBlock(completedEl, true)?.remove();
  }
}
function renderPendingInlineMarkdown(pending, openListItemFirstLine2) {
  if (openListItemFirstLine2 === void 0)
    return renderPendingLine(pending);
  return renderPendingLine(pending, { openListItemFirstLine: openListItemFirstLine2 });
}
function isBlockLevelPending(pending, openListItemFirstLine2) {
  if (!pending.trim() || pending.includes("\n"))
    return false;
  if (pendingListMarkerLength(pending) !== null)
    return true;
  if (pendingAtxHeadingLevel(pending) !== null)
    return true;
  if (isPendingBlockquoteLine(pending))
    return true;
  if (isListContinuationPending(pending, openListItemFirstLine2))
    return true;
  return !isAmbiguousBlockLine(pending);
}
function blockPendingTag(pending, openListItemFirstLine2) {
  if (isListContinuationPending(pending, openListItemFirstLine2))
    return "span";
  if (pendingListMarkerLength(pending) !== null)
    return "li";
  if (pendingAtxHeadingLevel(pending) !== null)
    return "div";
  if (isPendingBlockquoteLine(pending))
    return "blockquote";
  return "p";
}
function pendingListTag(pending) {
  return pendingListOrderedMarker(pending) !== null ? "ol" : "ul";
}
function findTrailingListHost(completedEl, listTag) {
  const last = tailContentElement(completedEl);
  if (last instanceof Element && last.tagName === listTag.toUpperCase()) {
    return last;
  }
  return null;
}
function syncListPendingDom(completedEl, pending, pendingInner, active2, openListItemFirstLine2) {
  clearBlockPendingDom(completedEl, ["continuation", "paragraph-continuation", "non-list-direct"]);
  const listTag = pendingListTag(pending);
  const indent = listPendingIndent(pending);
  const existingPendingLi = tailPendingDescendant(completedEl, BLOCK_PENDING_CLASS, "LI");
  if (!active2 || !pendingInner) {
    existingPendingLi?.remove();
    const last = tailContentElement(completedEl);
    if (last && last.tagName === listTag.toUpperCase() && last.childNodes.length === 0) {
      last.remove();
    }
    return;
  }
  let list = null;
  if (indent > 0) {
    const hostLi = findOpenListItemHost(completedEl);
    if (hostLi) {
      const existingNested = lastDirectChild(hostLi, listTag.toUpperCase(), null);
      if (existingNested instanceof HTMLElement) {
        list = existingNested;
      } else {
        list = document.createElement(listTag);
        hostLi.append(list);
      }
    }
  }
  if (!list) {
    const trailing = findTrailingListHost(completedEl, listTag);
    list = trailing ?? (() => {
      const created = document.createElement(listTag);
      const ordered2 = pendingListOrderedMarker(pending);
      if (ordered2 !== null && listTag === "ol")
        created.setAttribute("start", ordered2);
      appendPendingTail(completedEl, created);
      return created;
    })();
  }
  let li;
  if (existingPendingLi instanceof HTMLElement && existingPendingLi.parentElement === list) {
    li = existingPendingLi;
  } else {
    existingPendingLi?.remove();
    li = document.createElement("li");
    list.append(li);
  }
  li.className = blockPendingClassName(pending, openListItemFirstLine2);
  const ordered = pendingListOrderedMarker(pending);
  const headingLevel = pendingAtxHeadingLevel(pending);
  if (ordered !== null)
    li.setAttribute("data-ordered-marker", ordered);
  else
    li.removeAttribute("data-ordered-marker");
  if (headingLevel !== null)
    li.setAttribute("data-heading-level", String(headingLevel));
  else
    li.removeAttribute("data-heading-level");
  setPresanitizedHtml(li, wrapBlockPendingInner(pending, pendingInner));
}
function blockPendingClassName(pending, openListItemFirstLine2) {
  if (isListContinuationPending(pending, openListItemFirstLine2)) {
    return `stream-pending ${LIST_CONTINUATION_CLASS} ${BLOCK_PENDING_CLASS}`;
  }
  if (pendingListMarkerLength(pending) !== null) {
    const ordered = pendingListOrderedMarker(pending);
    return ordered ? `stream-pending stream-pending-list-item stream-pending-ordered-item ${BLOCK_PENDING_CLASS}` : `stream-pending stream-pending-list-item ${BLOCK_PENDING_CLASS}`;
  }
  const headingLevel = pendingAtxHeadingLevel(pending);
  if (headingLevel !== null) {
    return `stream-pending stream-pending-heading stream-pending-h${String(headingLevel)} ${BLOCK_PENDING_CLASS}`;
  }
  if (isPendingBlockquoteLine(pending)) {
    const alertType = pendingBlockquoteAlertType(pending);
    if (alertType) {
      return `stream-pending stream-pending-blockquote ${alertBlockquoteClass(alertType)} ${BLOCK_PENDING_CLASS}`;
    }
    return `stream-pending stream-pending-blockquote ${BLOCK_PENDING_CLASS}`;
  }
  return `stream-pending stream-pending-paragraph ${BLOCK_PENDING_CLASS}`;
}
function wrapBlockPendingInner(pending, pendingInner) {
  if (isPendingBlockquoteLine(pending)) {
    if (pendingBlockquoteAlertType(pending) !== null) {
      return pendingInner ? asSanitizedHtml(`<p class="markdown-alert-title">${pendingInner}</p>`) : "";
    }
    return pendingInner ? asSanitizedHtml(`<p>${pendingInner}</p>`) : "";
  }
  return pendingInner;
}
function findOpenListItemHost(completedEl) {
  const last = tailContentElement(completedEl);
  if (!(last instanceof HTMLElement) || last.tagName !== "UL" && last.tagName !== "OL") {
    return null;
  }
  let li = last.lastElementChild;
  if (li instanceof HTMLElement && li.classList.contains(BLOCK_PENDING_CLASS)) {
    li = li.previousElementSibling;
  }
  return li instanceof HTMLElement && li.tagName === "LI" ? li : null;
}
function clearListContinuationDom(completedEl) {
  tailPendingDescendant(completedEl, LIST_CONTINUATION_CLASS)?.remove();
}
function isParagraphContinuationPending(split) {
  const { pending, openListItemFirstLine: openListItemFirstLine2 } = split;
  return (split.inlineCodeContinuation === true || split.paragraphContinuation === true && isBlockLevelPending(pending, openListItemFirstLine2)) && blockPendingTag(pending, openListItemFirstLine2) === "p" && pending !== "";
}
function paragraphContinuationSeam(split) {
  return split.inlineCodeContinuation === true ? "" : "\n";
}
function findTrailingParagraphHost(completedEl) {
  const last = tailContentElement(completedEl);
  if (!(last instanceof HTMLElement) || last.tagName !== "P")
    return null;
  if (last.classList.contains(BLOCK_PENDING_CLASS))
    return null;
  return last;
}
function removeParagraphContinuationNode(el2) {
  if (!el2)
    return;
  const prev = el2.previousSibling;
  if (prev !== null && prev.nodeType === 3 && prev.textContent === "\n") {
    prev.remove();
  }
  el2.remove();
}
function clearParagraphContinuationDom(completedEl) {
  removeParagraphContinuationNode(tailPendingDescendant(completedEl, PARAGRAPH_CONTINUATION_CLASS));
}
function syncParagraphContinuationDom(completedEl, pendingInner, active2, seam) {
  const host = findTrailingParagraphHost(completedEl);
  if (!host)
    return false;
  const existing = firstDirectChild(host, null, PARAGRAPH_CONTINUATION_CLASS);
  if (!active2 || !pendingInner) {
    removeParagraphContinuationNode(existing);
    return true;
  }
  let el2 = existing;
  if (!el2) {
    if (seam)
      host.append(document.createTextNode(seam));
    el2 = document.createElement("span");
    host.append(el2);
  }
  el2.className = `stream-pending ${PARAGRAPH_CONTINUATION_CLASS} ${BLOCK_PENDING_CLASS}`;
  setPresanitizedHtml(el2, pendingInner);
  return true;
}
function syncListContinuationDom(completedEl, pendingInner, active2) {
  const li = findOpenListItemHost(completedEl);
  if (!li)
    return false;
  const existing = firstDirectChild(li, null, LIST_CONTINUATION_CLASS);
  if (!active2 || !pendingInner) {
    existing?.remove();
    return true;
  }
  let el2 = existing;
  if (!el2) {
    el2 = document.createElement("span");
    li.append(el2);
  }
  el2.className = `stream-pending ${LIST_CONTINUATION_CLASS} ${BLOCK_PENDING_CLASS}`;
  setPresanitizedHtml(el2, pendingInner.startsWith(" ") ? pendingInner : asSanitizedHtml(` ${pendingInner}`));
  return true;
}
function syncBlockPendingDom(completedEl, split, pendingInner, active2) {
  const { pending, openListItemFirstLine: openListItemFirstLine2 } = split;
  if (isParagraphContinuationPending(split)) {
    clearBlockPendingDom(completedEl, ["continuation", "list-items", "non-list-direct"]);
    if (syncParagraphContinuationDom(completedEl, pendingInner, active2, paragraphContinuationSeam(split))) {
      return;
    }
  }
  if (isListContinuationPending(pending, openListItemFirstLine2)) {
    clearBlockPendingDom(completedEl, [
      "continuation",
      "paragraph-continuation",
      "list-items",
      "non-list-direct"
    ]);
    syncListContinuationDom(completedEl, pendingInner, active2);
    return;
  }
  if (pendingListMarkerLength(pending) !== null) {
    syncListPendingDom(completedEl, pending, pendingInner, active2, openListItemFirstLine2);
    return;
  }
  clearBlockPendingDom(completedEl, ["continuation", "paragraph-continuation", "list-items"]);
  const existing = tailDirectPendingBlock(completedEl, false);
  if (!active2 || !pendingInner) {
    existing?.remove();
    return;
  }
  const tag = blockPendingTag(pending, openListItemFirstLine2);
  let el2 = existing;
  if (!el2 || el2.tagName.toLowerCase() !== tag) {
    existing?.remove();
    el2 = document.createElement(tag);
    appendPendingTail(completedEl, el2);
  }
  el2.className = blockPendingClassName(pending, openListItemFirstLine2);
  const ordered = pendingListOrderedMarker(pending);
  const headingLevel = pendingAtxHeadingLevel(pending);
  if (ordered !== null)
    el2.setAttribute("data-ordered-marker", ordered);
  else
    el2.removeAttribute("data-ordered-marker");
  if (headingLevel !== null)
    el2.setAttribute("data-heading-level", String(headingLevel));
  else
    el2.removeAttribute("data-heading-level");
  setPresanitizedHtml(el2, wrapBlockPendingInner(pending, pendingInner));
}
function syncInlinePendingDom(pendingEl, pendingInner, active2) {
  setPresanitizedHtml(pendingEl, pendingInner);
  pendingEl.hidden = !active2;
  pendingEl.className = "stream-pending";
  delete pendingEl.dataset["orderedMarker"];
}
function renderPendingTail(split, formingActive, pendingInTable) {
  const { pending, openListItemFirstLine: openListItemFirstLine2 } = split;
  const pendingInner = pending && !pendingInTable && !formingActive ? sanitizeRenderedMarkdown(renderPendingInlineMarkdown(pending, openListItemFirstLine2)) : "";
  const pendingVisible = pending !== "" && !pendingInTable && !formingActive && pendingInner !== "";
  return { pendingInner, pendingVisible };
}
function trailingInertRun(s) {
  let i = s.length;
  while (i > 0 && PENDING_FAST_PATH_INERT_RE.test(s[i - 1] ?? ""))
    i--;
  return s.slice(i);
}
function lastWhitespaceIndex(s) {
  return Math.max(s.lastIndexOf(" "), s.lastIndexOf("	"));
}
function hasAutolinkAbsorptionRisk(region) {
  const lower = region.toLowerCase();
  return lower.includes("@") || lower.includes("://") || lower.includes("www.");
}
function armPendingFastPath(completedEl, split, paragraphContinuation) {
  const { pending, openListItemFirstLine: openListItemFirstLine2 } = split;
  if (!PENDING_FAST_PATH_INERT_RE.test(pending[pending.length - 1] ?? ""))
    return null;
  if (pending.includes("\n"))
    return null;
  if (getInlinePasses().length > 0)
    return null;
  if (!isPlainParagraphPendingLine(pending, openListItemFirstLine2))
    return null;
  if (pendingHoldIndex(pending) !== pending.length)
    return null;
  const stripped = stripParagraphIndent2(pending);
  const revealed = revealFormingLink(stripped);
  if (revealed.includes("<"))
    return null;
  const inertTail = trailingInertRun(revealed);
  if (inertTail === "")
    return null;
  if (hasAutolinkAbsorptionRisk(revealed.slice(lastWhitespaceIndex(revealed) + 1)))
    return null;
  let el2 = null;
  if (paragraphContinuation) {
    const host = findTrailingParagraphHost(completedEl);
    if (host)
      el2 = firstDirectChild(host, null, PARAGRAPH_CONTINUATION_CLASS);
  }
  if (!el2) {
    const last = tailContentElement(completedEl);
    if (last && last.tagName === "P" && last.classList.contains(BLOCK_PENDING_CLASS) && last.classList.contains("stream-pending-paragraph")) {
      el2 = last;
    }
  }
  if (!el2)
    return null;
  const text = el2.lastChild;
  if (!text || text.nodeType !== 3)
    return null;
  const textData = text.data;
  if (!textData.endsWith(inertTail))
    return null;
  return {
    pending,
    stripped,
    revealed,
    el: el2,
    text,
    textData,
    paragraphContinuation,
    openListItemFirstLine: openListItemFirstLine2
  };
}
function tryPendingFastPath(st, split, completedEl, paragraphContinuation) {
  const { pending, openListItemFirstLine: openListItemFirstLine2 } = split;
  if (openListItemFirstLine2 !== st.openListItemFirstLine)
    return false;
  if (paragraphContinuation !== st.paragraphContinuation)
    return false;
  if (!pending.startsWith(st.pending))
    return false;
  if (!completedEl.contains(st.el))
    return false;
  if (st.el.lastChild !== st.text || st.text.data !== st.textData)
    return false;
  const appended = pending.slice(st.pending.length);
  if (appended === "")
    return true;
  if (!PENDING_FAST_PATH_INERT_RE.test(appended))
    return false;
  if (getInlinePasses().length > 0)
    return false;
  if (!isPlainParagraphPendingLine(pending, openListItemFirstLine2))
    return false;
  if (pendingHoldIndex(pending) !== pending.length)
    return false;
  const stripped = stripParagraphIndent2(pending);
  if (stripped !== st.stripped + appended)
    return false;
  const revealed = revealFormingLink(stripped);
  if (revealed !== st.revealed + appended)
    return false;
  if (hasAutolinkAbsorptionRisk(revealed.slice(lastWhitespaceIndex(st.revealed) + 1))) {
    return false;
  }
  st.text.data = st.textData + appended;
  st.pending = pending;
  st.stripped = stripped;
  st.revealed = revealed;
  st.textData = st.textData + appended;
  return true;
}
function formingTableSource(complete, content, pending, contentTokens, completeTokens) {
  if (getIncompleteFenceSource(content, contentTokens))
    return null;
  if (pendingLineBelongsInTable(complete, pending, completeTokens))
    return null;
  const fromTokens = getIncompleteTableSource(content, contentTokens);
  if (fromTokens)
    return fromTokens;
  const trimmed = pending.trimStart();
  if (trimmed.startsWith("|") && trimmed.includes("|", 1))
    return pending;
  return null;
}
function formingFenceSource(content, contentTokens) {
  return getIncompleteFenceSource(content, contentTokens);
}
function clearFormingDom(container) {
  clearFormingFenceDom(container);
  clearFormingTableDom(container);
}
var BLOCK_PENDING_CLASS, LIST_CONTINUATION_CLASS, PARAGRAPH_CONTINUATION_CLASS, PENDING_FAST_PATH_INERT_RE, StreamingMarkdownRenderer;
var init_streaming = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/streaming.js"() {
    init_alerts();
    init_block_tokenizer();
    init_render_pending_line();
    init_inline_emphasis();
    init_inline_passes();
    init_streaming_split();
    init_incremental_scan();
    init_dom_scan();
    init_config();
    init_math();
    init_mermaid();
    init_sanitize();
    init_html_sink();
    init_streaming_table_dom();
    init_streaming_fence_dom();
    init_streaming_math_dom();
    init_streaming_frozen_tail();
    BLOCK_PENDING_CLASS = "stream-pending-block";
    LIST_CONTINUATION_CLASS = "stream-pending-list-continuation";
    PARAGRAPH_CONTINUATION_CLASS = "stream-pending-paragraph-continuation";
    PENDING_FAST_PATH_INERT_RE = /^[0-9A-Za-z !?.,;'"-]+$/;
    StreamingMarkdownRenderer = class {
      completedEl = null;
      formingEl = null;
      pendingEl = null;
      lastComplete = "";
      /** The text of the last `update()`/`finish()` — what a bare `finish()` finalizes. */
      lastContent = "";
      /**
       * `committedTailContinues` at the last commit. It can flip while `complete`
       * stays put (the held tail ends the trailing container), which changes how a
       * nested open fence renders, so a flip re-runs the commit path.
       */
      lastFormingTail = false;
      /** `tokenizeBlocks(lastComplete)` — cached so pending-only frames stay O(tail). */
      committedTokens = [];
      /** Whether `lastComplete` contains `|` — cached for the same reason. */
      committedHasPipe = false;
      /**
       * The table currently hosting a pending body row, held by reference so its
       * cleanup never needs a DOM search (the backstop for the trailing-chain
       * table walk). Null whenever no pending row is attached.
       */
      pendingRowTable = null;
      /**
       * State for the pending-line plain-text fast path (see the block comment
       * above {@link armPendingFastPath}); null whenever the last frame was not a
       * qualifying plain-prose pending sync.
       */
      pendingFast = null;
      /**
       * Diagnostic: pending-only frames handled by the fast path (a direct text
       * append, or a byte-identical no-op) instead of a full inline re-render.
       * Mirrors `FrozenTailRenderer.renderedChars` as an observable for tests.
       */
      pendingFastPathHits = 0;
      frozenTail = new FrozenTailRenderer();
      /**
       * Timing-free work-shape counters, summed across this renderer's scanners
       * and commit path (ADR 0004 Phase 3). These are what the long-document
       * doubling guards assert on: totals that must stay ~O(new bytes) over an
       * append-only stream (`scannedChars`, `suffixTokensScanned`, `renderedChars`,
       * `parsedChars`), and the rewrite-guard comparison count (`prefixChecks`),
       * which must stay ~one per scanner call — a second O(prefix) memcmp per
       * update was a measured super-linear term on multi-hundred-kB streams.
       * @internal Diagnostics for tests/benchmarks, not a stable API (#147).
       */
      diagnostics() {
        return {
          scannedChars: this.contentScanner.scannedChars + this.completeScanner.scannedChars,
          suffixTokensScanned: this.contentScanner.suffixTokensScanned + this.completeScanner.suffixTokensScanned,
          prefixChecks: this.contentScanner.prefixChecks + this.completeScanner.prefixChecks,
          prefixBytesCompared: this.contentScanner.prefixBytesCompared + this.completeScanner.prefixBytesCompared,
          renderedChars: this.frozenTail.renderedChars,
          parsedChars: this.frozenTail.parsedChars,
          pendingFastPathHits: this.pendingFastPathHits
        };
      }
      // Incremental scanners (#30): re-tokenize / re-scan only past the last safe
      // boundary instead of the whole string every update. One per source stream —
      // the raw content and the committed prefix advance differently.
      contentScanner = new IncrementalSourceScanner();
      completeScanner = new IncrementalSourceScanner();
      host;
      /**
       * Full {@link MarkdownConfig} captured at construction and re-applied around
       * every commit — so this instance renders under its own policy *and* grammar
       * config (html/scheme/origin/sanitize, plus math syntax, link decorator, fence
       * handlers) regardless of the process-wide defaults. Two renderers with
       * different config coexist without an epoch or cache invalidation.
       */
      config;
      constructor(host, options = {}) {
        this.host = host;
        this.config = { ...options };
      }
      /** Render `content` (the full message text so far) into the host incrementally. */
      update(content) {
        this.lastContent = content;
        withConfig(this.config, () => {
          this.updateWithPolicy(content);
        });
      }
      /**
       * End the stream: `content` (default: the text of the last {@link update}) is
       * the final text. Mid-stream the renderer holds back what a later character
       * could still change — a trailing `~~old` / `**bold` run, the last table row,
       * list item or paragraph line — and shows an unclosed fence, `$$` block or
       * table as forming scaffolding. At end of stream nothing more can arrive, so
       * `finish()` commits the whole text: afterwards `.stream-complete` holds the
       * at-rest render of `content` as a complete document — what `renderMarkdown`
       * renders for `content` with its last line ended (an unclosed fence becomes
       * a finished code block, held text is released) — and the forming and
       * pending elements are empty and hidden.
       *
       * "With its last line ended": `renderMarkdown(content)` itself parses an
       * unterminated last line provisionally in three shapes — a setext underline
       * after a multi-line paragraph (`a\nb\n=`), a delimiter row whose column
       * count doesn't match its header, and an invalid link reference definition —
       * where the terminated render is the CommonMark one. For any `content` ending
       * in a newline, and for every other shape, the two are identical.
       *
       * Calling {@link update} afterwards resumes streaming from whatever text it
       * is given, exactly like any other update (including one that rewrites the
       * content), so a host that finished too early, or reuses the renderer for a
       * regenerated message, needs no reset. `finish()` is idempotent; call
       * {@link hydrate} after it as after an update.
       */
      finish(content = this.lastContent) {
        this.lastContent = content;
        withConfig(this.config, () => {
          this.finishWithPolicy(content);
        });
      }
      /**
       * Hydrate the pending math / diagram scaffolding this renderer has emitted into
       * its host, using the `mathRenderer` / `diagramRenderer` from the config passed
       * at construction. This is the config-injected replacement for the old global
       * `setMathRenderer` / `setDiagramRenderer` + free-function `hydratePendingMath`
       * dance: obtain the backends from `loadKatex()` / `loadMermaid()`, pass them in
       * the constructor config, then call `hydrate()` after `update()`. A no-op for a
       * tier whose renderer is not configured. Returns the counts rendered.
       *
       * `transformHtml` / `transformSvg` forward to the underlying hydrators (required
       * under Trusted Types enforcement — see {@link HydrateMathOptions}).
       */
      async hydrate(options = {}) {
        let math = 0;
        const mathRenderer = this.config.mathRenderer;
        if (mathRenderer) {
          const mathOptions = { renderer: mathRenderer };
          if (options.transformHtml)
            mathOptions.transformHtml = options.transformHtml;
          math = await hydratePendingMath(this.host, mathOptions);
        }
        let diagrams = 0;
        const diagramRenderer = this.config.diagramRenderer;
        if (diagramRenderer) {
          const diagramOptions = { renderer: diagramRenderer };
          if (options.transformSvg)
            diagramOptions.transformSvg = options.transformSvg;
          diagrams = await hydratePendingDiagrams(this.host, diagramOptions);
        }
        if (math > 0 || diagrams > 0)
          this.frozenTail.invalidateDomMemo();
        return { math, diagrams };
      }
      updateWithPolicy(content) {
        const split = splitForStreamingFrom(content, this.contentScanner.tokenize(content));
        const { complete, pending, openListItemFirstLine: openListItemFirstLine2, blocks } = split;
        const { completedEl, formingEl, pendingEl } = this.ensureNodes();
        const formingTail = committedTailContinues(complete, blocks);
        if (complete !== this.lastComplete || formingTail !== this.lastFormingTail) {
          this.commit(completedEl, complete, formingTail);
        }
        if (this.frozenTail.committedHasOpenDetails) {
          clearFormingDom(formingEl);
          formingEl.hidden = true;
          clearBlockPendingDom(completedEl, ["continuation", "paragraph-continuation", "direct-blocks"]);
          syncInlinePendingDom(pendingEl, "", false);
          this.pendingFast = null;
          return;
        }
        const completeTokensForPending = pending.includes("|") ? this.committedTokens : void 0;
        const mayHaveCommittedTable = this.committedHasPipe;
        const fenceSource = formingFenceSource(content, blocks);
        const mathSource = fenceSource ? null : getIncompleteMathSource(content, blocks);
        const tableSource = fenceSource || mathSource ? null : formingTableSource(complete, content, pending, blocks, completeTokensForPending);
        if (fenceSource || mathSource || tableSource) {
          if (fenceSource)
            syncFormingFenceDom(formingEl, fenceSource);
          else if (mathSource)
            syncFormingMathDom(formingEl, mathSource);
          else if (tableSource)
            syncFormingTableDom(formingEl, tableSource);
          formingEl.hidden = false;
          const committed = this.pendingRowTable ?? (mayHaveCommittedTable ? this.findLastCommittedTable() : null);
          if (committed)
            removePendingTableRow(committed);
          this.pendingRowTable = null;
        } else {
          clearFormingDom(formingEl);
          formingEl.hidden = true;
          if (mayHaveCommittedTable)
            this.syncCommittedTableRow(complete, pending, completeTokensForPending);
        }
        const formingActive = fenceSource !== null || mathSource !== null || tableSource !== null;
        const pendingInTable = pendingLineBelongsInTable(complete, pending, completeTokensForPending);
        if (!formingActive && !pendingInTable && this.pendingFast && tryPendingFastPath(this.pendingFast, split, completedEl, isParagraphContinuationPending(split))) {
          this.pendingFastPathHits++;
          return;
        }
        this.pendingFast = null;
        const { pendingInner, pendingVisible } = renderPendingTail(split, formingActive, pendingInTable);
        if (pendingVisible && (isBlockLevelPending(pending, openListItemFirstLine2) || isParagraphContinuationPending(split))) {
          syncBlockPendingDom(completedEl, split, pendingInner, true);
          syncInlinePendingDom(pendingEl, "", false);
          this.pendingFast = armPendingFastPath(completedEl, split, isParagraphContinuationPending(split));
        } else {
          clearBlockPendingDom(completedEl, [
            "continuation",
            "paragraph-continuation",
            "list-items",
            "direct-blocks"
          ]);
          syncInlinePendingDom(pendingEl, pendingInner, pendingVisible);
        }
      }
      /**
       * End-of-stream frame (see {@link finish}): the whole text becomes the
       * committed prefix. "Is this construct closed?" has a definite answer once
       * nothing more can arrive, and the committed renderer already is the at-rest
       * renderer (the frozen tail reconciles to
       * `sanitize(renderMarkdownUnsafe(complete))`), so no end-of-stream variant of
       * the split or of any pending shape is needed.
       *
       * The commit is line-terminated: a final line without a newline gets one.
       * Every mid-stream `complete` ends at a line boundary, and the frozen tail
       * relies on it — it renders settled token groups separately, and an
       * unterminated last line tokenizes provisionally (`Title\n---` as paragraph
       * + ambiguous break; a footnote definition that a later update extends in
       * place), which would freeze or split blocks the terminated text renders
       * differently. End of input ends the last line in CommonMark, so this is
       * the same document (`renderMarkdown` of an unterminated last line differs
       * in three provisional shapes; see streaming-finish.test.ts).
       *
       * Going through the ordinary commit keeps the frozen-tail invariants as they
       * are: finishing the last update's text is an append-only extension of the
       * last commit (the scanner's `verifiedUpTo` contract holds), and a later
       * update that retreats `complete` behind it, or rewrites it, is the same
       * rewrite a regenerated message produces — caught by the scanner's prefix
       * check and the frozen tail's prefix/straddle guards.
       */
      finishWithPolicy(content) {
        const { completedEl, formingEl, pendingEl } = this.ensureNodes();
        const complete = content === "" || content.endsWith("\n") ? content : `${content}
`;
        if (complete !== this.lastComplete || this.lastFormingTail) {
          this.commit(completedEl, complete, false);
        } else {
          this.sweepPendingTail(completedEl);
        }
        clearFormingDom(formingEl);
        formingEl.hidden = true;
        syncInlinePendingDom(pendingEl, "", false);
        this.pendingFast = null;
      }
      /**
       * Commit `complete` as the new committed prefix: sweep the pending tail, then
       * reconcile `completedEl` to the full render of `complete` through the
       * frozen-tail renderer.
       */
      commit(completedEl, complete, formingTail) {
        this.sweepPendingTail(completedEl);
        const advance = this.completeScanner.advance(complete);
        this.committedTokens = advance.tokens;
        this.committedHasPipe = complete.includes("|");
        this.frozenTail.update(completedEl, complete, this.committedTokens, this.completeScanner.linkRefs(complete), this.completeScanner.footnoteDefs(complete), advance, formingTail);
        this.lastComplete = complete;
        this.lastFormingTail = formingTail;
        this.pendingFast = null;
      }
      /**
       * Sweep the pending-tail artifacts attached since the last commit — a
       * pending block element, a pending `<li>` (and its wrapper) inside the
       * trailing list, a continuation span inside the trailing `<p>`/open `<li>`,
       * the pending table row. The commit morphs used to absorb them as ordinary
       * diff noise; the frozen-tail DOM memos (ADR 0004 Phase 2) instead require
       * the committed subtree to be exactly what the last commit left, so they go
       * before any commit (they are rebuilt from `pending` afterwards either way —
       * at most one kind exists at a time, each sync clears the others). O(tail),
       * and byte-equivalent to the old morph-side removal.
       */
      sweepPendingTail(completedEl) {
        clearBlockPendingDom(completedEl, [
          "continuation",
          "paragraph-continuation",
          "list-items",
          "direct-blocks"
        ]);
        if (this.pendingRowTable) {
          removePendingTableRow(this.pendingRowTable);
          this.pendingRowTable = null;
        }
      }
      syncCommittedTableRow(complete, pending, completeTokens) {
        const table = this.findLastCommittedTable() ?? this.pendingRowTable;
        if (!table)
          return;
        if (pendingLineBelongsInTable(complete, pending, completeTokens)) {
          syncPendingTableRowDom(table, pending);
          this.pendingRowTable = table;
          return;
        }
        removePendingTableRow(table);
        this.pendingRowTable = null;
      }
      /**
       * The trailing committed `<table>`, found by walking the last-element-child
       * chain — never the selector engine. A pending body row only ever targets
       * the TRAILING table (`pendingLineBelongsInTable` gates on the last block
       * token being a table), and a stale pending row can only live in a table
       * that was trailing when the row was attached (a frozen table never hosts
       * one, and the tail morph sweeps rows when the table settles) — so the old
       * whole-subtree `querySelectorAll('table')`, which ran on EVERY update of a
       * pipe-bearing stream and cost ~20% of the jsdom benchmark inside the
       * selector engine, is replaced by an O(depth) walk. The chain descends so a
       * table inside a re-rooted open container (ADR 0004 Phase 2) is still
       * found; a trailing footnotes section is skipped (the content precedes it).
       */
      findLastCommittedTable() {
        let el2 = this.completedEl ? tailContentElement(this.completedEl) : null;
        for (; el2; el2 = el2.lastElementChild) {
          if (el2.tagName === "TABLE")
            return el2;
        }
        return null;
      }
      ensureNodes() {
        if (this.completedEl && this.formingEl && this.pendingEl && this.host.contains(this.completedEl)) {
          return {
            completedEl: this.completedEl,
            formingEl: this.formingEl,
            pendingEl: this.pendingEl
          };
        }
        this.host.replaceChildren();
        const completedEl = document.createElement("div");
        completedEl.className = "stream-complete";
        const formingEl = document.createElement("div");
        formingEl.className = "stream-forming";
        formingEl.hidden = true;
        const pendingEl = document.createElement("span");
        pendingEl.className = "stream-pending";
        pendingEl.hidden = true;
        this.host.append(completedEl, formingEl, pendingEl);
        this.completedEl = completedEl;
        this.formingEl = formingEl;
        this.pendingEl = pendingEl;
        this.lastComplete = "";
        this.lastFormingTail = false;
        this.committedTokens = [];
        this.committedHasPipe = false;
        this.pendingFast = null;
        this.frozenTail.reset();
        return { completedEl, formingEl, pendingEl };
      }
    };
  }
});

// node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/index.js
var init_dist = __esm({
  "node_modules/.pnpm/@copse+streaming-markdown@1.8.0_dompurify@3.4.17_entities@8.1.0_highlight.js@11.12.0_ka_e82f9a16770bd25972d57b2fbb19aaf5/node_modules/@copse/streaming-markdown/dist/index.js"() {
    init_renderer();
    init_config();
    init_streaming();
    init_sanitize_browser();
    init_escape();
  }
});

// src/renderer/markdown/inline-markdown.ts
function setInlineMarkdown(target, source) {
  const host = document.createElement("div");
  host.innerHTML = renderMarkdown(source, { htmlPolicy: "escape-all" });
  const paragraph = host.firstElementChild;
  const isInline = host.children.length === 1 && paragraph?.tagName === "P" && Array.from(paragraph.querySelectorAll("*")).every((node) => PHRASING_TAGS.has(node.tagName));
  if (!paragraph || !isInline) {
    target.textContent = source;
    return;
  }
  target.replaceChildren(...Array.from(paragraph.childNodes));
}
var PHRASING_TAGS;
var init_inline_markdown = __esm({
  "src/renderer/markdown/inline-markdown.ts"() {
    init_dist();
    PHRASING_TAGS = /* @__PURE__ */ new Set(["CODE", "EM", "STRONG", "S", "DEL"]);
  }
});

// src/renderer/dom/inline-status.ts
function statusIcon(kind) {
  switch (kind) {
    case "ok":
      return checkIcon("ui-icon ui-icon-sm");
    case "error":
      return closeIcon("ui-icon ui-icon-sm");
    case "pending":
      return spinnerIcon("ui-icon ui-icon-sm");
    case "filled":
      return dotIcon("ui-icon ui-icon-sm");
    case "warn":
      return warningIcon("ui-icon ui-icon-sm");
    case "idle":
      return minusIcon("ui-icon ui-icon-sm");
  }
}
function inlineStatus(kind, text) {
  return el(
    "span",
    { class: "ui-inline-status", "data-status-kind": kind },
    statusIcon(kind),
    el("span", { class: "ui-inline-status-text" }, text)
  );
}
function setInlineStatus(target, kind, text) {
  target.replaceChildren(inlineStatus(kind, text));
}
function setInlineStatusMarkdown(target, kind, source) {
  const text = el("span", { class: "ui-inline-status-text" });
  setInlineMarkdown(text, source);
  target.replaceChildren(
    el("span", { class: "ui-inline-status", "data-status-kind": kind }, statusIcon(kind), text)
  );
}
var init_inline_status = __esm({
  "src/renderer/dom/inline-status.ts"() {
    init_inline_markdown();
    init_helpers();
    init_icons();
  }
});

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

// packages/std/src/unknown-value.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function expectRecord(value, label = "value") {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}
function recordArrayOrEmpty(value) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
function expectString(value, label = "value") {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}
function expectNumber(value, label = "value") {
  if (typeof value !== "number") throw new TypeError(`${label} must be a number`);
  return value;
}
function expectBoolean(value, label = "value") {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}
function expectStringArray(value, label = "value") {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  return value;
}
function stringRecordOrEmpty(value) {
  if (!isRecord(value)) return {};
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}
function optionalString(value, label = "value") {
  if (value === void 0 || value === null) return void 0;
  return expectString(value, label);
}
function optionalBoolean(value, label = "value") {
  if (value === void 0 || value === null) return void 0;
  return expectBoolean(value, label);
}
function optionalNumber(value, label = "value") {
  if (value === void 0 || value === null) return void 0;
  return expectNumber(value, label);
}
function optionalStringArray(value, label = "value") {
  if (value === void 0 || value === null) return void 0;
  return expectStringArray(value, label);
}
function firstNonEmptyString(...values) {
  return values.find(isNonEmptyString);
}
function nonEmptyStringOr(value, fallback) {
  return firstNonEmptyString(value, fallback) ?? fallback;
}
var init_unknown_value = __esm({
  "packages/std/src/unknown-value.ts"() {
    init_nullish();
  }
});

// src/shared/unknown-value.mts
var init_unknown_value2 = __esm({
  "src/shared/unknown-value.mts"() {
    init_unknown_value();
  }
});

// src/shared/unknown-value.ts
var init_unknown_value3 = __esm({
  "src/shared/unknown-value.ts"() {
    init_unknown_value2();
  }
});

// src/renderer/views/setup/ssh-host-helpers.ts
function parseSshWorkspaceHosts(value) {
  return recordArrayOrEmpty(value).flatMap((entry) => {
    const id = entry["id"];
    const label = entry["label"];
    const hostName = entry["host"];
    if (typeof id !== "string" || typeof label !== "string" || typeof hostName !== "string") {
      return [];
    }
    const host = { id, label, host: hostName };
    if (typeof entry["port"] === "number") host.port = entry["port"];
    if (typeof entry["user"] === "string") host.user = entry["user"];
    if (typeof entry["identityFile"] === "string") host.identityFile = entry["identityFile"];
    if (typeof entry["forwardAgent"] === "boolean") host.forwardAgent = entry["forwardAgent"];
    return [host];
  });
}
function emptySshHostDraft() {
  return {
    id: "",
    label: "",
    host: "",
    user: "",
    port: "",
    identityFile: "",
    forwardAgent: false
  };
}
function slugifyHostId(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "host";
}
function upsertHost(list, host) {
  const idx = list.findIndex((h) => h.id === host.id);
  if (idx === -1) return [...list, host];
  const next = [...list];
  next[idx] = host;
  return next;
}
function nextAvailableHostId(baseId, usedIds) {
  if (!usedIds.has(baseId)) return baseId;
  for (let suffixNumber = 2; ; suffixNumber += 1) {
    const suffix = `-${String(suffixNumber)}`;
    const candidate = `${baseId.slice(0, 64 - suffix.length)}${suffix}`;
    if (!usedIds.has(candidate)) return candidate;
  }
}
function importSshConfigHosts(existing, aliases) {
  const hosts = [...existing];
  const importedHostIds = [];
  const usedIds = new Set(hosts.map((host) => host.id));
  let firstAliasHostId;
  for (const alias of aliases) {
    const alreadyImported = hosts.find(
      (host) => host.host.toLowerCase() === alias.host.toLowerCase()
    );
    if (alreadyImported) {
      firstAliasHostId ??= alreadyImported.id;
      continue;
    }
    const id = nextAvailableHostId(alias.id, usedIds);
    const imported = id === alias.id ? alias : { ...alias, id };
    hosts.push(imported);
    usedIds.add(id);
    importedHostIds.push(id);
    firstAliasHostId ??= id;
  }
  return { hosts, importedHostIds, firstAliasHostId };
}
function removeHost(list, id) {
  return list.filter((h) => h.id !== id);
}
function parseSshHostDraft(draft) {
  const id = draft.id.trim() || slugifyHostId(draft.label || draft.host);
  if (!SSH_HOST_ID_RE.test(id)) {
    return { ok: false, error: "Host id must be a lowercase slug (a-z, 0-9, -).", fields: ["id"] };
  }
  if (!draft.label.trim() || !draft.host.trim()) {
    const fields = [];
    if (!draft.label.trim()) fields.push("label");
    if (!draft.host.trim()) fields.push("host");
    return { ok: false, error: "Label and host are required.", fields };
  }
  const host = {
    id,
    label: draft.label.trim(),
    host: draft.host.trim()
  };
  if (draft.user.trim()) host.user = draft.user.trim();
  const portText = draft.port.trim();
  if (portText) {
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: "Port must be a whole number from 1 to 65535.", fields: ["port"] };
    }
    host.port = port;
  }
  if (draft.identityFile.trim()) host.identityFile = draft.identityFile.trim();
  if (draft.forwardAgent) host.forwardAgent = true;
  return { ok: true, host };
}
var SSH_HOST_ID_RE;
var init_ssh_host_helpers = __esm({
  "src/renderer/views/setup/ssh-host-helpers.ts"() {
    init_unknown_value3();
    SSH_HOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  }
});

// src/renderer/views/toast.ts
function ensureHost() {
  let host = document.getElementById(TOAST_HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = TOAST_HOST_ID;
    host.className = "toast-host";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.append(host);
  }
  return host;
}
function normalizeMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof ErrorEvent !== "undefined" && error instanceof ErrorEvent) {
    return describeErrorEvent(error);
  }
  if (typeof Event !== "undefined" && error instanceof Event) {
    return describeEvent(error);
  }
  return String(error);
}
function describeErrorEvent(event) {
  if (event.error instanceof Error && event.error.message) return event.error.message;
  const location = formatSourceLocation(event.filename, event.lineno, event.colno);
  if (event.message) return location ? `${event.message} (${location})` : event.message;
  if (location) return `script error at ${location}`;
  return describeEvent(event);
}
function describeEvent(event) {
  const target = event.target;
  if (typeof Element !== "undefined" && target instanceof Element) {
    const tag = target.tagName.toLowerCase();
    const src = target.getAttribute("src") ?? target.getAttribute("href");
    return src ? `failed to load <${tag}> ${src}` : `<${tag}> ${event.type} event`;
  }
  return `${event.type} event`;
}
function formatSourceLocation(filename, lineno, colno) {
  if (!filename) return "";
  const parts = [filename];
  if (lineno) parts.push(String(lineno));
  if (colno) parts.push(String(colno));
  return parts.join(":");
}
function showToast(message, opts = {}) {
  const host = ensureHost();
  const variant = opts.variant ?? "info";
  const duration = opts.durationMs ?? DEFAULT_DURATION_MS;
  const existing = opts.action ? null : findVisibleToast(message, variant);
  if (existing) {
    existing.refresh(duration);
    return existing.dismiss;
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${variant}`;
  toast.textContent = message;
  host.append(toast);
  let timer = setTimeout(() => {
    toast.remove();
  }, duration);
  const dismiss = () => {
    clearTimeout(timer);
    toast.remove();
  };
  const refresh = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      toast.remove();
    }, ms);
  };
  toastControls.set(toast, { dismiss, refresh });
  toast.addEventListener("click", dismiss);
  if (opts.action) {
    const action = opts.action;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ui-btn toast-action";
    button.textContent = action.label;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      dismiss();
      action.onClick();
    });
    toast.append(button);
  }
  return dismiss;
}
function findVisibleToast(message, variant) {
  const host = document.getElementById(TOAST_HOST_ID);
  if (!host) return null;
  for (const node of host.querySelectorAll(`.toast-${variant}`)) {
    if (node.textContent === message) return toastControls.get(node) ?? null;
  }
  return null;
}
function showErrorToast(prefix, error) {
  const message = `${prefix}: ${normalizeMessage(error)}`;
  console.error(message, error);
  const e2e = window.__copseE2e;
  e2e?.pushErrorToast?.(message);
  showToast(message, { variant: "error" });
}
var TOAST_HOST_ID, DEFAULT_DURATION_MS, toastControls;
var init_toast = __esm({
  "src/renderer/views/toast.ts"() {
    TOAST_HOST_ID = "toast-host";
    DEFAULT_DURATION_MS = 6e3;
    toastControls = /* @__PURE__ */ new WeakMap();
  }
});

export {
  isDefined,
  isNonNull,
  isNonEmptyString,
  isNonBlankString,
  init_nullish,
  outlineIcon,
  init_outline_icon,
  playIcon,
  chevronRightIcon,
  chevronDownIcon,
  clockIcon,
  cornerDownLeftIcon,
  chevronUpIcon,
  arrowLeftIcon,
  arrowRightIcon,
  refreshIcon,
  externalLinkIcon,
  closeIcon,
  plusIcon,
  monitorIcon,
  downloadIcon,
  uploadIcon,
  maximizeIcon,
  minimizeIcon,
  moreHorizontalIcon,
  moreVerticalIcon,
  runningStatusIcon,
  checkIcon,
  shieldIcon,
  bellIcon,
  messageQuestionIcon,
  banIcon,
  circleIcon,
  spinnerIcon,
  minusIcon,
  warningIcon,
  searchIcon,
  fileTextIcon,
  imageIcon,
  sparkleIcon,
  zapIcon,
  gitBranchIcon,
  gitPullRequestIcon,
  gitMergeIcon,
  penLineIcon,
  slashIcon,
  arrowUpRightIcon,
  squareIcon,
  eraserIcon,
  undoIcon,
  trashIcon,
  historyIcon,
  init_icons,
  unwrapIpcErrorText,
  ipcErrorMessage,
  isUnavailableThreadCheckoutError,
  init_ipc_error_message,
  setDefaultConfig,
  escapeHtml,
  workspaceLinkTargetFromHref,
  init_workspace_link_href,
  appLinkDecorator,
  init_inline_links,
  isBrowserSanitizerSupported,
  renderMarkdown,
  StreamingMarkdownRenderer,
  init_dist,
  setInlineMarkdown,
  init_inline_markdown,
  inlineStatus,
  setInlineStatus,
  setInlineStatusMarkdown,
  init_inline_status,
  isRecord,
  expectRecord,
  recordArrayOrEmpty,
  expectString,
  expectNumber,
  stringRecordOrEmpty,
  optionalString,
  optionalBoolean,
  optionalNumber,
  optionalStringArray,
  firstNonEmptyString,
  nonEmptyStringOr,
  init_unknown_value,
  init_unknown_value2,
  init_unknown_value3,
  parseSshWorkspaceHosts,
  emptySshHostDraft,
  slugifyHostId,
  upsertHost,
  importSshConfigHosts,
  removeHost,
  parseSshHostDraft,
  init_ssh_host_helpers,
  showToast,
  showErrorToast,
  init_toast
};
