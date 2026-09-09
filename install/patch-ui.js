#!/usr/bin/env node
/**
 * Session-Manager-GUI — install-time UI patches
 * ---------------------------------------------
 * Two shipped browser artifacts are patched here, because both places are
 * hard-coded upstream and expose no extension slot:
 *
 *  1. session row menu  @deepseek-ai/dsh-client-ui-workspace/lib/client.js
 *     - appends a 4th menu item “删除会话” with the IconTrashOutline16 glyph;
 *     - dispatches window CustomEvent "Session-Manager-GUI:delete" carrying
 *       the session id — the Session-Manager-GUI browser half listens and
 *       moves that session to the recycle bin.
 *
 *  2. settings navigation @deepseek-ai/dsh-client-ui-settings-general/lib/client.js
 *     - maps the two new settings sections to dedicated glyphs instead of the
 *       default gear: session-trash -> IconTrashOutline16 (same glyph as the
 *       row-menu delete item) and session-archived -> IconArchiveOutline20.
 *
 * Guards / migration:
 *  - every target is checksum-pinned to the artifact of DeepSeek Harness
 *    0.1.2-rc.1 (see EXPECTED below);
 *  - a same-directory backup "备份_client.js" is created before the first
 *    patch of each artifact;
 *  - if an artifact is not the pinned original but a backup with the pinned
 *    original content exists (e.g. it still carries the LEGACY
 *    "session-editor-gui:delete" patch), the backup is restored first and the
 *    new patch is applied on top — an in-place upgrade;
 *  - if the artifact already contains the new markers, the target is reported
 *    as already patched.
 *
 * Usage:
 *   node install/patch-ui.js [--dry-run] [--revert] [--target menu|settings|all]
 *   --dry-run  check checksums/anchors and print the plan, changing nothing
 *   --revert   restore every target from its backup copy
 *   --target   patch only one artifact (default: all)
 */
"use strict";

const { createHash } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync, copyFileSync, realpathSync } = require("node:fs");
const { join, dirname, basename } = require("node:path");
const os = require("node:os");

const DSH_PROFILES = join(process.env.DSH_HOME || join(os.homedir(), ".dsh"), "profiles");
const BACKUP_SUFFIX = "备份_client.js";

/** One patched artifact: location, pinned checksum, marker, and patch steps. */
const TARGETS = {
  menu: {
    label: "session row menu",
    file: join(DSH_PROFILES, "node_modules", "@deepseek-ai", "dsh-client-ui-workspace", "lib", "client.js"),
    expectedSha256: "53c40660195c42cde709b802e239f473dd721f45bc329684af31c01fdb73282a",
    marker: "Session-Manager-GUI:delete",
    patch: patchMenu,
    changes: "+1 menu item (删除会话, IconTrashOutline16), +1 onSelect dispatch branch",
  },
  settings: {
    label: "settings navigation icons",
    file: join(DSH_PROFILES, "node_modules", "@deepseek-ai", "dsh-client-ui-settings-general", "lib", "client.js"),
    expectedSha256: "903bb84407104d5511f38eac13fc740ad147bab6a9c8d51bde52d90cfd996aff",
    marker: 'id === "session-trash"',
    patch: patchSettingsNav,
    changes: '+2 navIcon branches (session-trash -> IconTrashOutline16, session-archived -> IconArchiveOutline20)',
  },
};

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseArgs(argv) {
  const args = { dryRun: false, revert: false, target: "all" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--revert") args.revert = true;
    else if (argv[i] === "--target") {
      i += 1;
      if (i >= argv.length) throw new Error("--target requires menu|settings|all");
      args.target = argv[i];
      if (!["menu", "settings", "all"].includes(args.target)) throw new Error(`unknown target: ${args.target}`);
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

/* --------------------------------------------------------- menu artifact */

/** Insert the 4th menu item (with its glyph) before the closing `];`. */
function patchMenu(source) {
  const brace = "\t\t\t\t"; // item braces, one level in from the array
  const field = "\t\t\t\t\t"; // menu item fields
  const close = "\t\t\t"; // the array's own `];` line
  const anchor =
    field + 'id: "archive",\n' +
    field + 'label: t("menu.archiveSession"),\n' +
    field + 'icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })\n' +
    brace + "}\n" +
    close + "];";
  const count = source.split(anchor).length - 1;
  if (count !== 1) {
    throw new Error(`menu-items anchor not found exactly once (found ${count}). Re-check the artifact before patching.`);
  }
  const replacement =
    field + 'id: "archive",\n' +
    field + 'label: t("menu.archiveSession"),\n' +
    field + 'icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })\n' +
    brace + "},\n" +
    brace + "{\n" +
    field + 'id: "se-delete",\n' +
    field + 'label: "删除会话",\n' +
    field + 'icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {})\n' +
    brace + "}\n" +
    close + "];";
  let next = source.replace(anchor, replacement);

  const dispatchAnchor = '\t\t\t\t\t\t\t\t\tif (id === "archive") onArchive(node.id);';
  const dispatchCount = next.split(dispatchAnchor).length - 1;
  if (dispatchCount !== 1) {
    throw new Error(`onSelect anchor not found exactly once (found ${dispatchCount}). Re-check the artifact before patching.`);
  }
  const dispatchAddition =
    "\n" +
    '\t\t\t\t\t\t\t\t\tif (id === "se-delete") window.dispatchEvent(new CustomEvent("Session-Manager-GUI:delete", { detail: { sessionId: node.id } }));';
  next = next.replace(dispatchAnchor, dispatchAnchor + dispatchAddition);
  return next;
}

/* ----------------------------------------------------- settings artifact */

/** Add dedicated nav glyphs for the two Session-Manager-GUI settings sections. */
function patchSettingsNav(source) {
  const t3 = "\t\t\t";
  const t4 = "\t\t\t\t";
  const anchor =
    t3 + 'if (id === "plugins") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutline16, {\n' +
    t4 + "className: SettingsRoot_module_css_default.navIcon,\n" +
    t4 + "size: 16\n" +
    t3 + "});\n" +
    t3 + "return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutline16, {";
  const count = source.split(anchor).length - 1;
  if (count !== 1) {
    throw new Error(`navIcon anchor not found exactly once (found ${count}). Re-check the artifact before patching.`);
  }
  const replacement =
    t3 + 'if (id === "plugins") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutline16, {\n' +
    t4 + "className: SettingsRoot_module_css_default.navIcon,\n" +
    t4 + "size: 16\n" +
    t3 + "});\n" +
    t3 + 'if (id === "session-trash") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {\n' +
    t4 + "className: SettingsRoot_module_css_default.navIcon,\n" +
    t4 + "size: 16\n" +
    t3 + "});\n" +
    t3 + 'if (id === "session-archived") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, {\n' +
    t4 + "className: SettingsRoot_module_css_default.navIcon,\n" +
    t4 + "size: 16\n" +
    t3 + "});\n" +
    t3 + "return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutline16, {";
  return source.replace(anchor, replacement);
}

/* ---------------------------------------------------------------- runner */

function runTarget(name, target, args) {
  const file = realpathSync(target.file);
  const backup = join(dirname(file), BACKUP_SUFFIX);

  if (args.revert) {
    if (!existsSync(backup)) {
      console.error(`[${name}] error: backup not found at ${backup} — nothing to revert.`);
      return false;
    }
    if (args.dryRun) {
      console.log(`[${name}] [dry-run] would restore ${basename(file)} from ${basename(backup)}`);
      return true;
    }
    copyFileSync(backup, file);
    console.log(`[${name}] reverted: ${file} (restored from ${basename(backup)}; backup kept)`);
    return true;
  }

  const current = readFileSync(file, "utf8");
  if (current.includes(target.marker)) {
    console.log(`[${name}] already patched — nothing to do.`);
    return true;
  }

  let base = current;
  let restoredFromBackup = false;
  if (sha256(current) !== target.expectedSha256) {
    if (existsSync(backup) && sha256(readFileSync(backup, "utf8")) === target.expectedSha256) {
      base = readFileSync(backup, "utf8");
      restoredFromBackup = true;
    } else {
      console.error(
        `[${name}] checksum mismatch.\n  file     : ${file}\n  actual   : ${sha256(current)}\n  expected : ${target.expectedSha256}\n` +
          "This artifact is neither the pinned original nor recoverable from its backup. If you upgraded the harness, " +
          "inspect the anchors with --dry-run, adjust the script, and only then run it again.",
      );
      return false;
    }
  }

  let patched;
  try {
    patched = target.patch(base);
  } catch (error) {
    console.error(`[${name}] error: ${error.message}`);
    return false;
  }

  if (args.dryRun) {
    console.log(
      `[${name}] [dry-run] ${restoredFromBackup ? "would restore the original from backup and patch" : "would patch"}:\n  ${file}\n  changes: ${target.changes}`,
    );
    return true;
  }

  if (!existsSync(backup)) {
    copyFileSync(file, backup);
    console.log(`[${name}] backup created: ${backup}`);
  }
  if (restoredFromBackup) {
    console.log(`[${name}] restored pinned original from ${basename(backup)} before patching (in-place upgrade).`);
  }
  writeFileSync(file, patched, "utf8");
  console.log(`[${name}] patched: ${file}\n  ${target.changes}`);
  return true;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    console.error("usage: node patch-ui.js [--dry-run] [--revert] [--target menu|settings|all]");
    process.exit(2);
  }

  const names = args.target === "all" ? ["menu", "settings"] : [args.target];
  let ok = true;
  for (const name of names) {
    const target = TARGETS[name];
    if (!existsSync(target.file)) {
      console.error(`[${name}] error: artifact not found at ${target.file}`);
      ok = false;
      continue;
    }
    if (!runTarget(name, target, args)) ok = false;
  }

  if (!ok) process.exit(1);
  if (!args.dryRun && !args.revert) {
    console.log(
      "Restart the harness and hard-refresh the browser (Ctrl+Shift+R) so the patched artifacts load.\n" +
        "After a harness upgrade, re-run this script (it refuses to patch an unexpected artifact unless the pinned " +
        "original is recoverable from the backup).",
    );
  }
}

main();
