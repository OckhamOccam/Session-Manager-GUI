#!/usr/bin/env node
/**
 * Session-Manager-GUI — install-time harness patches
 * --------------------------------------------------
 * Two shipped browser artifacts plus one host module are patched here, because
 * all three places are hard-coded upstream and expose no extension slot:
 *
 *  1. session row menu  @deepseek-ai/dsh-client-ui-workspace/lib/client.js
 *     - appends a 4th menu item “删除会话” with the IconTrashOutline16 glyph;
 *     - dispatches window CustomEvent "Session-Manager-GUI:delete" carrying
 *       the session id — the Session-Manager-GUI browser half listens and
 *       moves that session to the recycle bin.
 *
 *  2. settings navigation @deepseek-ai/dsh-client-ui-settings-general/lib/client.js
 *     - maps the plugin's settings sections to dedicated glyphs instead of the
 *       default gear: session-trash -> IconTrashOutline16 (same glyph as the
 *       row-menu delete item), session-archived -> IconArchiveOutline20, and
 *       session-hidden -> a hand-drawn eye-off (no built-in "invisible" glyph
 *       exists; see EYE_OFF_PATH_D). The 0.1.5 two-branch shape is still
 *       recognised by --status/--revert.
 *
 *  3. @ mention candidates  @deepseek-ai/dsh-session-reference/lib/index.js
 *     - HOST-side, not part of the plugin's own features: `projectedTitle`
 *       labels an `@` candidate by its projected title and otherwise falls back
 *       to the raw session id, reading ONLY the current-format projection
 *       checkpoint. The session list / sidebar reads the same cache as
 *       `cachedSnapshot(...) ?? cachedPredecessorTitle(...)`, so a session whose
 *       checkpoint predates a cache format bump shows a readable title in the
 *       sidebar but a bare UUID in `@`. The patch mirrors the listing fallback,
 *       so those candidates get their (possibly stale, never wrong) title back.
 *
 * Harness compatibility
 * ---------------------
 *  - validated against DeepSeek Harness 0.1.5-rc.2; the two browser artifacts
 *    are byte-identical to 0.1.5-rc.1 (checksums unchanged), so the anchors
 *    below are the rc.1/rc.2 shape (three-item menu rename/fork/archive with
 *    a four-branch navIcon if-chain). A harness upgrade REPLACES every patched
 *    file in place, which is exactly why the plugin's menu item and nav glyphs
 *    vanish after upgrading.
 *  - a harness upgrade also re-installs the packages, deleting the same
 *    directory backups (the installed copies under
 *    `$DSH_HOME/profiles/node_modules/@deepseek-ai/*` are symlinks into the
 *    npx deployment, so a reinstall rewrites the real files). Re-running this
 *    script recreates each backup from the freshly installed original.
 *  - the two browser bundles are serviced by the always-mounted client-hmr row
 *    (~500 ms stat poll, rebuilt frames over /plugins/events), so a running
 *    `dsh web` re-serves them without a restart; the `reference` target is host
 *    code and only takes effect after `dsh web` is restarted.
 *
 * Guards / migration:
 *  - every target is checksum-pinned to a known upstream artifact (EXPECTED
 *    below, plus any baseline adopted into baselines.json);
 *  - a same-directory backup (备份_client.js, or 备份_index.js for a host
 *    module) is created before the first patch of each artifact and is
 *    preferred by --revert;
 *  - if an artifact is not a known original but a backup with a known
 *    original content exists (e.g. it still carries the LEGACY
 *    "session-editor-gui:delete" patch), the backup is restored first and the
 *    new patch is applied on top — an in-place upgrade;
 *  - if the artifact already contains the new markers, the target is reported
 *    as already patched;
 *  - if the artifact is neither a known original nor recoverable from backup
 *    (a harness upgrade that changed these files), nothing is written: run
 *    --dry-run to inspect the anchors, then --adopt to accept the new
 *    upstream artifact as a baseline once its anchors verify.
 *
 * Usage:
 *   node install/patch-ui.js [--dry-run] [--status] [--adopt] [--revert]
 *                            [--target menu|settings|reference|all]
 *   --dry-run  check checksums/anchors and print the plan, changing nothing
 *   --status   report the installed artifacts, versions, and patch state
 *   --adopt    accept the current artifact as the new upstream baseline when
 *              its anchors verify (records it in install/baselines.json)
 *   --revert   restore every target from its backup, or — when a harness
 *              upgrade deleted the backup — strip the patch by its inverse
 *   --target   patch only one artifact (default: all)
 */
"use strict";

const { createHash } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync, copyFileSync, realpathSync } = require("node:fs");
const { join, dirname, basename } = require("node:path");
const os = require("node:os");

const DSH_PROFILES = join(process.env.DSH_HOME || join(os.homedir(), ".dsh"), "profiles");
/** Recorded baselines adopted from later harness artifacts (repo-local). */
const STATE_FILE = join(__dirname, "baselines.json");

/**
 * Harness release the built-in pins (EXPECTED) were verified against.
 * 0.1.5-rc.1 and 0.1.5-rc.2 ship byte-identical copies of the artifacts below.
 */
const PINNED_HARNESS = "0.1.5-rc.1 / 0.1.5-rc.2";

/** One patched artifact: location, pinned checksum, marker, and patch steps. */
const TARGETS = {
  menu: {
    label: "session row menu",
    file: join(DSH_PROFILES, "node_modules", "@deepseek-ai", "dsh-client-ui-workspace", "lib", "client.js"),
    expectedSha256: "383b9ef779366c13d818500b6488896328b189f156addbaa480c835e902edd5f",
    marker: "Session-Manager-GUI:delete",
    backupSuffix: "备份_client.js",
    patch: patchMenu,
    unpatch: unpatchMenu,
    changes: "+1 menu item (删除会话, IconTrashOutline16), +1 onSelect dispatch branch",
  },
  settings: {
    label: "settings navigation icons",
    file: join(DSH_PROFILES, "node_modules", "@deepseek-ai", "dsh-client-ui-settings-general", "lib", "client.js"),
    expectedSha256: "c5995dba8c3b944a46ebae6bc860b35b8adacd4786105ca636b5b73b84ae396e",
    marker: 'id === "session-trash"',
    backupSuffix: "备份_client.js",
    patch: patchSettingsNav,
    unpatch: unpatchSettingsNav,
    // The current form contains the third (eye-off) branch; the 0.1.5 form has
    // only two, so it must be recognised as "upgrade available", not "done".
    isCurrent: (source) => source.includes(SETTINGS_NAV_ANCHOR_PATCHED),
    formOf: (source) =>
      source.includes(SETTINGS_NAV_ANCHOR_PATCHED)
        ? "0.1.6 (3 branches, incl. session-hidden eye-off)"
        : source.includes(SETTINGS_NAV_ANCHOR_PATCHED_V1)
          ? "0.1.5 (2 branches) — re-run without --status to upgrade"
          : null,
    changes: '+3 navIcon branches (session-trash, session-archived, session-hidden -> hand-drawn eye-off)',
  },
  reference: {
    label: "@ candidate labels (session-reference host module)",
    file: join(DSH_PROFILES, "node_modules", "@deepseek-ai", "dsh-session-reference", "lib", "index.js"),
    expectedSha256: "01c69c1b49d328dccfafbdc1fc88007c42772a43891c21ed500835fd79cc4a56",
    marker: "cachedPredecessorTitle(record.header",
    backupSuffix: "备份_index.js",
    hostSide: true,
    patch: patchReferenceLabel,
    unpatch: unpatchReferenceLabel,
    changes: "@ candidates fall back to the predecessor checkpoint title (the sidebar's own listing hint) instead of the raw session id",
  },
};

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseArgs(argv) {
  const args = { dryRun: false, revert: false, status: false, adopt: false, target: "all" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--revert") args.revert = true;
    else if (argv[i] === "--status") args.status = true;
    else if (argv[i] === "--adopt") args.adopt = true;
    else if (argv[i] === "--target") {
      i += 1;
      if (i >= argv.length) throw new Error("--target requires menu|settings|reference|all");
      args.target = argv[i];
      if (!["menu", "settings", "reference", "all"].includes(args.target)) throw new Error(`unknown target: ${args.target}`);
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (args.revert && args.adopt) throw new Error("--revert and --adopt are mutually exclusive");
  return args;
}

/* ----------------------------------------------------------- baselines */

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return undefined;
  }
}

/** Installed version of the package that owns a patched artifact. */
function installedVersionOf(file) {
  const meta = readJson(join(dirname(dirname(realpathSync(file))), "package.json"));
  return meta === undefined ? "unknown" : meta.version;
}

function loadState() {
  const state = readJson(STATE_FILE);
  if (state === undefined || typeof state !== "object" || state === null) return { targets: {} };
  if (typeof state.targets !== "object" || state.targets === null) state.targets = {};
  return state;
}

/** Every checksum accepted as an upstream original for one target. */
function knownChecksums(name, target, state) {
  const known = [{ sha256: target.expectedSha256, source: `pinned (${PINNED_HARNESS})` }];
  const adopted = state.targets[name];
  if (adopted !== undefined && typeof adopted.sha256 === "string") {
    known.push({ sha256: adopted.sha256, source: `adopted for harness ${adopted.harnessVersion ?? "unknown"}` });
  }
  return known;
}

function matchKnown(checksum, known) {
  return known.find((entry) => entry.sha256 === checksum);
}

/* --------------------------------------------------------- menu artifact */

const T3 = "\t\t\t";
const T4 = "\t\t\t\t";
const T5 = "\t\t\t\t\t";

/** The archive menu item (the array's last entry) plus its closing `];`. */
const MENU_ANCHOR =
  T5 + 'id: "archive",\n' +
  T5 + 'label: t("menu.archiveSession"),\n' +
  T5 + "icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })\n" +
  T4 + "}\n" +
  T3 + "];";
/** What replaces MENU_ANCHOR once the delete item is appended. */
const MENU_ANCHOR_PATCHED =
  T5 + 'id: "archive",\n' +
  T5 + 'label: t("menu.archiveSession"),\n' +
  T5 + "icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })\n" +
  T4 + "},\n" +
  T4 + "{\n" +
  T5 + 'id: "se-delete",\n' +
  T5 + 'label: "删除会话",\n' +
  T5 + 'icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {})\n' +
  T4 + "}\n" +
  T3 + "];";
/** The onSelect branch the patch adds after the archive branch. */
const MENU_DISPATCH_ANCHOR = T5 + T3 + 'if (id === "archive") onArchive(node.id);';
const MENU_DISPATCH_PATCHED =
  MENU_DISPATCH_ANCHOR +
  "\n" +
  T5 + T3 + 'if (id === "se-delete") window.dispatchEvent(new CustomEvent("Session-Manager-GUI:delete", { detail: { sessionId: node.id } }));';

/** Insert the 4th menu item (with its glyph) before the closing `];`. */
function patchMenu(source) {
  const count = source.split(MENU_ANCHOR).length - 1;
  if (count !== 1) {
    throw new Error(`menu-items anchor not found exactly once (found ${count}). Re-check the artifact before patching.`);
  }
  let next = source.replace(MENU_ANCHOR, MENU_ANCHOR_PATCHED);

  const dispatchCount = next.split(MENU_DISPATCH_ANCHOR).length - 1;
  if (dispatchCount !== 1) {
    throw new Error(`onSelect anchor not found exactly once (found ${dispatchCount}). Re-check the artifact before patching.`);
  }
  next = next.replace(MENU_DISPATCH_ANCHOR, MENU_DISPATCH_PATCHED);
  return next;
}

/** Inverse of {@link patchMenu} — used by --revert when the backup is gone. */
function unpatchMenu(source) {
  if (!source.includes(MENU_ANCHOR_PATCHED)) throw new Error("patched menu block not found; cannot strip the patch");
  let next = source.replace(MENU_ANCHOR_PATCHED, MENU_ANCHOR);
  if (!next.includes(MENU_DISPATCH_PATCHED)) throw new Error("patched onSelect branch not found; cannot strip the patch");
  next = next.replace(MENU_DISPATCH_PATCHED, MENU_DISPATCH_ANCHOR);
  return next;
}

/* ----------------------------------------------------- settings artifact */

/** The whole navIcon if-chain head: models / agent-presets / plugins, then the default return. */
const SETTINGS_NAV_RETURN = T3 + "return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutline16, {";
const SETTINGS_NAV_ANCHOR =
  T3 + 'if (id === "plugins") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutline16, {\n' +
  T4 + "className: SettingsRoot_module_css_default.navIcon,\n" +
  T4 + "size: 16\n" +
  T3 + "});\n" +
  SETTINGS_NAV_RETURN;

/**
 * Session-Manager-GUI's own glyph for the settings navigation. DSH ships ~70
 * built-in icons and NONE of them expresses "hidden"/"invisible", so this one
 * is drawn here: an eye crossed by a top-left→bottom-right slash, with the
 * gaps cut **geometrically** (the almond and pupil strokes are split at the
 * slash crossings) so it depends on no background colour and stays clean on
 * the nav row's hover state.
 * Style matches the built-ins: 16×16, fill none, currentColor, width 1.25.
 */
const EYE_OFF_PATH_D =
  "M1.35 8C2.316 6.661 3.321 5.755 4.317 5.161M5.44 4.614C6.325 4.275 7.19 4.15 8 4.15M8 4.15C10.05 4.15 12.45 4.95 14.65 8M14.65 8C13.684 9.339 12.679 10.245 11.683 10.839M10.56 11.386C9.675 11.725 8.81 11.85 8 11.85M8 11.85C5.95 11.85 3.55 11.05 1.35 8 M6.975 6.11A2.15 2.15 0 0 1 9.89 9.025M9.025 9.89A2.15 2.15 0 0 1 6.11 6.975 M2.5 2.5L13.5 13.5";

/** The two branches version 0.1.5 inserted before the default return. */
const SETTINGS_NAV_BRANCHES_V1 =
  T3 + 'if (id === "session-trash") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {\n' +
  T4 + "className: SettingsRoot_module_css_default.navIcon,\n" +
  T4 + "size: 16\n" +
  T3 + "});\n" +
  T3 + 'if (id === "session-archived") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, {\n' +
  T4 + "className: SettingsRoot_module_css_default.navIcon,\n" +
  T4 + "size: 16\n" +
  T3 + "});\n";

/** The branch 0.1.6 adds: the hand-drawn eye-off for the hidden-session page. */
const SETTINGS_NAV_BRANCH_HIDDEN =
  T3 + 'if (id === "session-hidden") return (0, react_jsx_runtime.jsx)("svg", {\n' +
  T4 + "className: SettingsRoot_module_css_default.navIcon,\n" +
  T4 + "width: 16,\n" +
  T4 + "height: 16,\n" +
  T4 + 'viewBox: "0 0 16 16",\n' +
  T4 + 'fill: "none",\n' +
  T4 + 'xmlns: "http://www.w3.org/2000/svg",\n' +
  T4 + "children: (0, react_jsx_runtime.jsx)(\"path\", {\n" +
  T4 + T4 + 'd: "' + "M1.35 8C2.316 6.661 3.321 5.755 4.317 5.161M5.44 4.614C6.325 4.275 7.19 4.15 8 4.15M8 4.15C10.05 4.15 12.45 4.95 14.65 8M14.65 8C13.684 9.339 12.679 10.245 11.683 10.839M10.56 11.386C9.675 11.725 8.81 11.85 8 11.85M8 11.85C5.95 11.85 3.55 11.05 1.35 8 M6.975 6.11A2.15 2.15 0 0 1 9.89 9.025M9.025 9.89A2.15 2.15 0 0 1 6.11 6.975 M2.5 2.5L13.5 13.5" + '",\n' +
  T4 + T4 + 'stroke: "currentColor",\n' +
  T4 + T4 + 'strokeWidth: "1.25",\n' +
  T4 + T4 + 'strokeLinecap: "round",\n' +
  T4 + T4 + 'strokeLinejoin: "round"\n' +
  T4 + "})\n" +
  T3 + "});\n";

/** What 0.1.6 inserts: the 0.1.5 branches plus the eye-off branch. */
const SETTINGS_NAV_BRANCHES = SETTINGS_NAV_BRANCHES_V1 + SETTINGS_NAV_BRANCH_HIDDEN;

const SETTINGS_NAV_ANCHOR_PATCHED_V1 = SETTINGS_NAV_ANCHOR.replace(SETTINGS_NAV_RETURN, SETTINGS_NAV_BRANCHES_V1 + SETTINGS_NAV_RETURN);
const SETTINGS_NAV_ANCHOR_PATCHED = SETTINGS_NAV_ANCHOR.replace(SETTINGS_NAV_RETURN, SETTINGS_NAV_BRANCHES + SETTINGS_NAV_RETURN);

/** Add dedicated nav glyphs for the three Session-Manager-GUI settings sections. */
function patchSettingsNav(source) {
  const count = source.split(SETTINGS_NAV_ANCHOR).length - 1;
  if (count !== 1) {
    throw new Error(`navIcon anchor not found exactly once (found ${count}). Re-check the artifact before patching.`);
  }
  return source.replace(SETTINGS_NAV_ANCHOR, SETTINGS_NAV_ANCHOR_PATCHED);
}

/**
 * Inverse of {@link patchSettingsNav}. Recognises BOTH patched shapes: the
 * two-branch form written by 0.1.5 and the three-branch form written by 0.1.6,
 * so --status/--revert stay honest across the upgrade.
 */
function unpatchSettingsNav(source) {
  if (source.includes(SETTINGS_NAV_ANCHOR_PATCHED)) {
    return source.replace(SETTINGS_NAV_ANCHOR_PATCHED, SETTINGS_NAV_ANCHOR);
  }
  if (source.includes(SETTINGS_NAV_ANCHOR_PATCHED_V1)) {
    return source.replace(SETTINGS_NAV_ANCHOR_PATCHED_V1, SETTINGS_NAV_ANCHOR);
  }
  throw new Error("patched navIcon branches not found (neither the 0.1.5 two-branch nor the 0.1.6 three-branch form); cannot strip the patch");
}

/* ------------------------------------------- session-reference host module */

/**
 * `projectedTitle` reads ONLY the current-format checkpoint, while the session
 * list answers the same question with a predecessor fallback. The recorded
 * stale-but-never-wrong title is what makes an `@` candidate readable; without
 * it the label degrades to the raw session id.
 */
const REFERENCE_ANCHOR =
  T3 + 'return titleOf(this.ctx.get("sessionProjectionCache")?.cachedSnapshot(record.header, SessionLogOffset(0), ["title"]));';
const REFERENCE_ANCHOR_PATCHED =
  T3 + 'const cache = this.ctx.get("sessionProjectionCache");\n' +
  T3 + 'return titleOf(cache?.cachedSnapshot(record.header, SessionLogOffset(0), ["title"]) ?? cache?.cachedPredecessorTitle(record.header, SessionLogOffset(0)));';

/** Let `@` candidate labels use the sidebar's predecessor-checkpoint fallback. */
function patchReferenceLabel(source) {
  const count = source.split(REFERENCE_ANCHOR).length - 1;
  if (count !== 1) {
    throw new Error(`projectedTitle anchor not found exactly once (found ${count}). Re-check the artifact before patching.`);
  }
  return source.replace(REFERENCE_ANCHOR, REFERENCE_ANCHOR_PATCHED);
}

/** Inverse of {@link patchReferenceLabel} — used by --revert without a backup. */
function unpatchReferenceLabel(source) {
  if (!source.includes(REFERENCE_ANCHOR_PATCHED)) throw new Error("patched projectedTitle body not found; cannot strip the patch");
  return source.replace(REFERENCE_ANCHOR_PATCHED, REFERENCE_ANCHOR);
}

/* ---------------------------------------------------------------- runner */

function reportStatus(name, target, state) {
  const file = realpathSync(target.file);
  const backup = join(dirname(file), target.backupSuffix);
  const current = readFileSync(file, "utf8");
  const checksum = sha256(current);
  const known = knownChecksums(name, target, state);
  const match = matchKnown(checksum, known);
  const patched = current.includes(target.marker);
  let upstream;
  if (match !== undefined) upstream = `current bytes are a known original — ${match.source}`;
  else if (patched) {
    let stripped;
    try {
      stripped = target.unpatch(current);
    } catch (error) {
      stripped = undefined;
    }
    const original = stripped === undefined ? undefined : matchKnown(sha256(stripped), known);
    upstream =
      original === undefined
        ? "patch present but it does NOT strip back to a known original — re-check this artifact"
        : `patch strips back to a known original — ${original.source}`;
  } else {
    upstream = "not a known original (a harness upgrade changed it — see --adopt)";
  }
  console.log(`[${name}] ${target.label}`);
  console.log(`  artifact : ${file}`);
  console.log(`  package  : @deepseek-ai/${basename(dirname(dirname(file)))}@${installedVersionOf(file)}`);
  console.log(`  sha256   : ${checksum}`);
  console.log(`  upstream : ${upstream}`);
  console.log(`  patched  : ${patched ? "yes" : "no"}`);
  if (target.formOf !== undefined) {
    const form = target.formOf(current);
    if (form != null) console.log(`  form     : ${form}`);
  }
  console.log(`  backup   : ${existsSync(backup) ? basename(backup) + " present" : "absent (a harness upgrade removes it)"}`);
  return true;
}

function runTarget(name, target, args, state) {
  const file = realpathSync(target.file);
  const backup = join(dirname(file), target.backupSuffix);
  const known = knownChecksums(name, target, state);

  if (args.status) return reportStatus(name, target, state);

  const current = readFileSync(file, "utf8");
  const patched = target.isCurrent !== undefined ? target.isCurrent(current) : current.includes(target.marker);

  if (args.revert) {
    if (existsSync(backup)) {
      if (args.dryRun) {
        console.log(`[${name}] [dry-run] would restore ${basename(file)} from ${basename(backup)}`);
        return true;
      }
      copyFileSync(backup, file);
      console.log(`[${name}] reverted: ${file} (restored from ${basename(backup)}; backup kept)`);
      return true;
    }
    if (!patched) {
      console.log(`[${name}] nothing to revert — artifact is unpatched and no backup exists.`);
      return true;
    }
    let stripped;
    try {
      stripped = target.unpatch(current);
    } catch (error) {
      console.error(`[${name}] error: ${error.message}`);
      return false;
    }
    const original = matchKnown(sha256(stripped), known);
    if (original === undefined) {
      console.error(
        `[${name}] refusing to revert: stripping the patch did not reproduce a known original ` +
          `(sha256 ${sha256(stripped)}). Inspect the artifact manually.`,
      );
      return false;
    }
    if (args.dryRun) {
      console.log(`[${name}] [dry-run] would strip the patch by its inverse; result matches ${original.source}`);
      return true;
    }
    writeFileSync(file, stripped, "utf8");
    console.log(`[${name}] reverted: ${file} (patch stripped by its inverse; checksum matches ${original.source})`);
    return true;
  }

  if (patched) {
    console.log(`[${name}] already patched — nothing to do.`);
    return true;
  }

  let base = current;
  let restoredFromBackup = false;
  let upgradedInPlace = false;
  let adopted = false;
  let trialAdopt = false;
  if (matchKnown(sha256(current), known) === undefined) {
    const backupMatch = existsSync(backup) ? matchKnown(sha256(readFileSync(backup, "utf8")), known) : undefined;
    if (backupMatch !== undefined) {
      base = readFileSync(backup, "utf8");
      restoredFromBackup = true;
    } else if (target.unpatch !== undefined && (() => {
      // An older patch of ours (e.g. the 0.1.5 two-branch navIcon patch) is not
      // a "known original", but its inverse restores one — upgrade in place.
      try {
        const stripped = target.unpatch(current);
        if (matchKnown(sha256(stripped), known) !== undefined) {
          base = stripped;
          upgradedInPlace = true;
          return true;
        }
      } catch (error) {
        /* fall through to the refusal below */
      }
      return false;
    })()) {
      /* handled by the IIFE above */
    } else if (args.adopt || args.dryRun) {
      // Unknown upstream artifact: anchor verification below decides.
      base = current;
      adopted = !args.dryRun;
      trialAdopt = args.dryRun;
    } else {
      console.error(
        `[${name}] checksum mismatch.\n  file     : ${file}\n  actual   : ${sha256(current)}\n  expected : ${target.expectedSha256}\n` +
          "This artifact is neither a known original nor recoverable from its backup — a harness upgrade most likely " +
          "changed it. Inspect the anchors with --dry-run; if they still hold, re-run with --adopt to record this " +
          "artifact as the new baseline, otherwise update the patch before touching the file.",
      );
      return false;
    }
  }

  let patchedSource;
  try {
    patchedSource = target.patch(base);
  } catch (error) {
    console.error(`[${name}] error: ${error.message}`);
    return false;
  }

  if (args.dryRun) {
    const plan = restoredFromBackup
      ? "would restore the original from backup and patch"
      : upgradedInPlace
        ? "would strip the older patch and apply the current one (in-place upgrade)"
        : trialAdopt
          ? "would adopt the current artifact as a new baseline and patch (anchors verified) — re-run with --adopt"
          : "would patch";
    console.log(`[${name}] [dry-run] ${plan}:\n  ${file}\n  changes: ${target.changes}`);
    return true;
  }

  if (!existsSync(backup)) {
    copyFileSync(file, backup);
    console.log(`[${name}] backup created: ${backup}`);
  }
  if (restoredFromBackup) {
    console.log(`[${name}] restored pinned original from ${basename(backup)} before patching (in-place upgrade).`);
  }
  if (upgradedInPlace) {
    console.log(`[${name}] stripped the previous patch form and applied the current one (in-place upgrade).`);
  }
  if (adopted) {
    state.targets[name] = {
      sha256: sha256(base),
      harnessVersion: installedVersionOf(file),
      adoptedAt: new Date().toISOString(),
    };
    console.log(`[${name}] adopted new upstream baseline: ${state.targets[name].sha256} (harness ${state.targets[name].harnessVersion})`);
    console.log(
      `[${name}] note: the anchors still hold, but review what upstream changed — if the harness now ships its own ` +
        "session delete/archive entry, drop this patch instead of stacking a second one on top.",
    );
  }
  writeFileSync(file, patchedSource, "utf8");
  console.log(`[${name}] patched: ${file}\n  ${target.changes}`);
  return true;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    console.error("usage: node patch-ui.js [--dry-run] [--status] [--adopt] [--revert] [--target menu|settings|reference|all]");
    process.exit(2);
  }

  const state = loadState();
  const names = args.target === "all" ? ["menu", "settings", "reference"] : [args.target];
  let ok = true;
  for (const name of names) {
    const target = TARGETS[name];
    if (!existsSync(target.file)) {
      console.error(`[${name}] error: artifact not found at ${target.file}`);
      ok = false;
      continue;
    }
    if (!runTarget(name, target, args, state)) ok = false;
  }

  if (args.adopt && !args.dryRun && !args.status && !args.revert) {
    try {
      writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) {
      console.error(`warning: could not write ${STATE_FILE}: ${error.message}`);
    }
  }

  if (!ok) process.exit(1);
  if (!args.dryRun && !args.revert && !args.status) {
    const touched = names.filter((name) => {
      try {
        return readFileSync(realpathSync(TARGETS[name].file), "utf8").includes(TARGETS[name].marker);
      } catch (error) {
        return false;
      }
    });
    const hostTargets = touched.filter((name) => TARGETS[name].hostSide === true);
    console.log(
      "Browser bundles are stat-polled by the always-mounted client-hmr row, so a running `dsh web` re-serves the " +
        "patched modules within a second; hard-refresh the browser (Ctrl+Shift+R) to be sure.",
    );
    if (hostTargets.length > 0) {
      console.log(
        `Host modules patched (${hostTargets.join(", ")}) are NOT hot-served: restart \`dsh web\` for them to take effect.`,
      );
    }
    console.log(
      "After a harness upgrade, re-run this script (it refuses to patch an unexpected artifact unless --adopt " +
        "accepts it or the pinned original is recoverable from the backup).",
    );
  }
}

main();
