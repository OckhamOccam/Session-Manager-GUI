/**
 * Session-Manager-GUI — DeepSeek Harness host half (web profile)
 * --------------------------------------------------------------
 * An independent plugin (own version line 0.1.x) that provides the WebUI
 * session-management surfaces:
 *   a) a session recycle bin ("trash"): delete-to-trash / restore / purge.
 *      A soft delete MOVES the session's log directory out of
 *      `$DSH_HOME/sessions` into `$DSH_HOME/storages/session_trash/<id>/`
 *      (so every persistence-backed listing — sidebar, search and the `@`
 *      session-reference candidates — stops seeing it), detaches a still
 *      attached session from the in-memory store (the live-preferred session
 *      query would otherwise keep listing it), and additionally hides it
 *      through the product's archived set while its context is attached.
 *      Restore moves the directory back to its original place; purge erases
 *      it. The trash index lives in
 *      `$DSH_HOME/storages/session_trash.json`.
 *   b) read-only helpers for the archived-session viewer;
 *   c) a same-origin JSON API under the webServer prefix
 *      "/Session-Manager-GUI" consumed by the browser half (lib/client.js):
 *
 *        GET  /Session-Manager-GUI/trash/list        -> trash entries
 *        POST /Session-Manager-GUI/trash/add         { sessionId, cascade? }
 *        POST /Session-Manager-GUI/trash/restore     { sessionId, restoreChildren? }
 *        POST /Session-Manager-GUI/trash/purge       { sessionId, includeOrphans? }
 *        GET  /Session-Manager-GUI/archived/list     -> archived entries
 *        POST /Session-Manager-GUI/archived/restore  { sessionId }
 *        POST /Session-Manager-GUI/archived/delete   { sessionId, cascade? } (alias of trash/add)
 *        GET  /Session-Manager-GUI/subagents/children?sessionId=… -> delete preview
 *        GET  /Session-Manager-GUI/hidden/list       -> normally-invisible sessions
 *        POST /Session-Manager-GUI/hidden/purge      { sessionIds: [...] }
 *
 * Parent/child binding (0.1.6): deleting a session also deletes the subagent
 * sessions derived from it (`origin === "subagent"` descendants — never forks,
 * which are ordinary visible sessions), restoring brings them back, and a
 * permanent delete erases them too. Every filesystem mutation first passes
 * assertAllowedPath(), so a session operation can never delete or rewrite a
 * file inside the user's workspace.
 *
 * Relationship to the "session-editor" plugin: they are TWO separate
 * plugins. Chat-facing model tools (session_editor_list / _restore /
 * _delete) belong to session-editor; this plugin deliberately does NOT
 * register them, so both plugins can be mounted at the same time without
 * duplicate tool-name conflicts. The trash/archive operations here reuse the
 * same workspace-registry mechanics that session-editor documented.
 *
 * Target runtime: DeepSeek Harness 0.1.5-rc.1 web profile. Referenced by a
 * loader row whose name is the package name "Session-Manager-GUI" (the
 * package must live in a node_modules directory of the profile resolution
 * chain). The browser half is discovered through package.json "dsh.client"
 * + exports["./client"].
 */

import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

export const name = 'Session-Manager-GUI';

/** Hard dependencies (web profile services). Optional ones are ctx.get()-ed. */
export const inject = ['workspaceRegistry', 'sessionPersistence', 'webServer'];

const SUPPORT_NOTE =
  'Session-Manager-GUI targets DeepSeek Harness 0.1.5-rc.2 (web profile, dsh-workspace registry layout). If you upgraded the harness, re-check the registry access helpers before use.';

/**
 * Session ids come in two shapes: the current `session-<uuid>` form and the
 * bare `<uuid>` form written by older harness versions (those sessions keep
 * their legacy id in the log header AND as their directory name, so they are
 * ordinary deletable sessions — the sidebar merely hides subagent ones).
 * Accepting both matters because rejecting an id made every endpoint unusable
 * for legacy sessions, including the "ghost" subagent sessions reachable only
 * through `@`. The pattern still has to rule out path separators and traversal,
 * because an id becomes a path segment.
 */
const SESSION_ID_PATTERN = /^(?:session-)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** API path prefix of this plugin (must not collide with /api or /plugins). */
export const API_PREFIX = '/Session-Manager-GUI';
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Structured API failure: carries an HTTP status plus a stable machine code
 * so the browser half can show accurate, localised messages instead of raw
 * internal errors. Codes: INVALID_SESSION_ID / LIVE_SESSION / UNKNOWN_SESSION
 * / NOT_IN_TRASH / LOG_MISSING.
 */
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ paths */

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function trashStoreFile() {
  return join(dshHome(), 'storages', 'session_trash.json');
}

function projectionCacheFile(sessionId) {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
}

/**
 * Holding area for trashed session directories. A soft delete MOVES the
 * session's log directory here, i.e. OUT of `$DSH_HOME/sessions` — the only
 * tree `sessionPersistence.list()` scans. That is what makes a deleted
 * session disappear from every listing surface (sidebar, search, and the `@`
 * session-reference candidates), not just from the workspace grouping.
 */
function trashRoot() {
  return join(dshHome(), 'storages', 'session_trash');
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The sessions tree every harness deployment owns; relocation never leaves it. */
function sessionsRoot() {
  return join(dshHome(), 'sessions');
}

function isInsideSessionsRoot(dir) {
  const root = sessionsRoot();
  return typeof dir === 'string' && dir.startsWith(root + '/');
}

/* ------------------------------------------------------------------ guards */

/**
 * The four path classes this plugin is ever allowed to touch. Everything here
 * lives under $DSH_HOME: session log directories, the recycle-bin holding
 * area, per-session projection checkpoints and the trash index. A delivered
 * work product (a document the agent wrote into the user's workspace) is
 * never among them — deleting a session must never delete or rewrite it.
 */
function allowedRoots() {
  return [
    sessionsRoot(),
    trashRoot(),
    join(dshHome(), 'storages', 'session_projcache', 'sessions'),
  ];
}

/**
 * Assert that a directory taken from the recycle-bin index really is a session
 * directory of `sessionId` in the expected location. The index is a JSON file:
 * a tampered `originalDir`/`storedDir` could otherwise point at ANOTHER live
 * session inside the allow-list, and restore would delete that session's log.
 * @param kind - "stored" (holding area) or "original" (persistence tree).
 */
function assertSessionDir(path, sessionId, kind) {
  const target = assertAllowedPath(path, `use the ${kind} directory of '${sessionId}'`);
  const parent = dirname(target);
  const expectedParent = kind === 'stored' ? trashRoot() : null;
  if (kind === 'stored' && parent !== resolve(expectedParent)) {
    throw new ApiError(500, 'PATH_NOT_ALLOWED', `recycle-bin entry for '${sessionId}' has a ${kind} directory outside the holding area: ${target}`);
  }
  if (kind === 'original' && !target.startsWith(resolve(sessionsRoot()) + sep)) {
    throw new ApiError(500, 'PATH_NOT_ALLOWED', `recycle-bin entry for '${sessionId}' has an ${kind} directory outside the sessions tree: ${target}`);
  }
  if (target.slice(parent.length + 1) !== sessionId) {
    throw new ApiError(
      500,
      'PATH_NOT_ALLOWED',
      `recycle-bin entry for '${sessionId}' points at a directory named '${target.slice(parent.length + 1)}' instead of the session id`,
    );
  }
  return target;
}

/**
 * Resolve `path` and refuse it unless it is the trash index or lives under one
 * of {@link allowedRoots}. Called before EVERY mutating filesystem call, so a
 * tampered recycle-bin entry (whose storedDir/originalDir come from a JSON
 * file) cannot direct a delete at a workspace file.
 * @param path - candidate path (absolute, or resolved against the cwd).
 * @param purpose - short verb phrase used in the error message.
 * @returns the resolved absolute path.
 */
function assertAllowedPath(path, purpose) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new ApiError(500, 'PATH_NOT_ALLOWED', `refusing to ${purpose}: empty path`);
  }
  const target = resolve(path);
  const store = trashStoreFile();
  // The index itself, plus exactly its `<store>.<pid>.tmp` staging file.
  const isStore = target === store || new RegExp(`^${store.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9]+\\.tmp$`).test(target);
  const inside = allowedRoots().some((root) => target === root || target.startsWith(root + sep));
  if (!isStore && !inside) {
    throw new ApiError(
      500,
      'PATH_NOT_ALLOWED',
      `refusing to ${purpose} outside the harness session data: ${target}`,
    );
  }
  // Second layer: a lexical prefix cannot see a symlinked parent, so the REAL
  // path of the deepest existing ancestor must still live under $DSH_HOME.
  const anchor = realAncestorOf(target);
  if (anchor != null) {
    let homeReal;
    try {
      homeReal = realpathSync(dshHome());
    } catch {
      homeReal = resolve(dshHome());
    }
    if (!(anchor === homeReal || anchor.startsWith(homeReal + sep))) {
      throw new ApiError(
        500,
        'PATH_NOT_ALLOWED',
        `refusing to ${purpose}: ${target} resolves outside the harness home (${anchor})`,
      );
    }
  }
  return target;
}

/**
 * Real path of the deepest existing ancestor of `path` (or of `path` itself).
 * Used by {@link assertAllowedPath} to catch a symlinked parent that a lexical
 * prefix check cannot see. Returns null when nothing along the chain exists.
 */
function realAncestorOf(path) {
  let current = path;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}

/* --------------------------------------------------------- session catalog */

/**
 * One header per persisted session, shape-tolerant across harness versions
 * (DSH <= 0.1.2 returns `SessionHeader[]`, 0.1.5 returns `{header, revision,
 * sizeBytes}` snapshots). Only sessions whose files are still inside
 * `$DSH_HOME/sessions` are listed — a trashed session is absent by design.
 * @returns an array of session headers (possibly empty).
 */
async function listSessionHeaders(ctx) {
  let listed;
  try {
    listed = await ctx.sessionPersistence.list();
  } catch {
    return [];
  }
  const headers = [];
  for (const entry of listed) {
    const header = entry != null && entry.header != null ? entry.header : entry;
    if (header != null && typeof header.id === 'string') headers.push(header);
  }
  return headers;
}

/** Byte size per session id, when the persistence snapshot reports one. */
async function sessionSizes(ctx) {
  const sizes = new Map();
  let listed;
  try {
    listed = await ctx.sessionPersistence.list();
  } catch {
    return sizes;
  }
  for (const entry of listed) {
    const header = entry != null && entry.header != null ? entry.header : entry;
    const size = entry != null && typeof entry.sizeBytes === 'number' ? entry.sizeBytes : undefined;
    if (header != null && typeof header.id === 'string' && size !== undefined) sizes.set(header.id, size);
  }
  return sizes;
}

/**
 * Subagent descendants of one session (transitive, cycle-safe).
 *
 * ONLY sessions whose header says `origin === "subagent"` qualify. A fork also
 * carries `parentSession`, but it is a normal, sidebar-visible session the user
 * chose to create — deleting a parent must never take a fork with it.
 * @param headers - headers from {@link listSessionHeaders}.
 * @param rootId - session whose derived subagent sessions are wanted.
 * @returns descendant ids in breadth-first order (root excluded).
 */
function subagentDescendantIds(headers, rootId) {
  const childrenOf = new Map();
  for (const header of headers) {
    if (header.origin !== 'subagent') continue;
    const parent = header.parentSession;
    if (typeof parent !== 'string' || parent.length === 0) continue;
    const bucket = childrenOf.get(parent);
    if (bucket === undefined) childrenOf.set(parent, [header.id]);
    else bucket.push(header.id);
  }
  const seen = new Set([rootId]);
  const out = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const child of childrenOf.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Blank flag of one session, read from its projection checkpoint (never via a log fold). */
async function projectionBlank(ctx, sessionId) {
  try {
    const parsed = JSON.parse(await readFile(projectionCacheFile(sessionId), 'utf8'));
    const rows = parsed != null && parsed.record != null ? parsed.record.rows : undefined;
    const meta = rows != null ? rows.sessionListMetadata : undefined;
    const value = meta != null && meta.val != null ? meta.val : undefined;
    return value != null && value.blank === true;
  } catch {
    return false;
  }
}

/** Ids of the workspaces that account a session (usually zero or one). */
function workspaceHolders(reg, sessionId) {
  const holders = [];
  for (const entity of reg.entities.values()) {
    const record = entity != null ? entity.record : undefined;
    if (record == null || !Array.isArray(record.sessionIds)) continue;
    if (record.sessionIds.includes(sessionId)) holders.push(entity);
  }
  return holders;
}

/* --------------------------------------------------------- preview read API */

/**
 * Subagent descendants of one session with the facts a confirmation dialog
 * needs (count, titles, running state). Read-only.
 */
async function subagentChildren(ctx, rootId) {
  checkSessionId(rootId);
  const headers = await listSessionHeaders(ctx);
  const byId = new Map(headers.map((header) => [header.id, header]));
  const onDisk = subagentDescendantIds(headers, rootId);
  // Children already in the recycle bin (cascaded earlier) are NOT on disk but
  // a purge still erases them — the confirmation must name them too.
  const trashed = (await readTrashEntries())
    .filter((entry) => entry != null && entry.cascadeOf === rootId && entry.purged !== true)
    .map((entry) => entry.sessionId);
  const ids = [...new Set([...onDisk, ...trashed])];
  const titles = await sessionTitles(ctx, [...ids, rootId]);
  const running = new Set(runningSessionIds(ctx));
  return {
    session_id: rootId,
    title: titles.get(rootId) ?? null,
    count: ids.length,
    on_disk: onDisk.length,
    in_trash: trashed.length,
    items: ids.map((id) => {
      const header = byId.get(id);
      const parent = header != null && typeof header.parentSession === 'string' ? header.parentSession : null;
      return {
        sessionId: id,
        title: titles.get(id) ?? null,
        running: running.has(id),
        in_trash: trashed.includes(id),
        parent_exists: parent != null && byId.has(parent),
      };
    }),
  };
}

/**
 * Every session that exists on disk, is in no recycle bin and no archive, yet
 * can never appear in the sidebar. Grouped by the reason it is invisible:
 *   1. subagents  — `origin === "subagent"` (split into leftover/parent-alive)
 *   2. blank      — never had a message; shown only while currently open
 *   3. unowned    — not accounted by any workspace
 * Groups are disjoint, with that priority order.
 */
async function hiddenList(ctx) {
  const reg = registry(ctx);
  const headers = await listSessionHeaders(ctx);
  const byId = new Map(headers.map((header) => [header.id, header]));
  const trashed = new Set((await readTrashEntries()).map((entry) => entry.sessionId));
  const archived = new Set(reg.archivedSessionIds.map(String));
  const running = new Set(runningSessionIds(ctx));
  const sizes = await sessionSizes(ctx);

  const candidates = headers.filter((header) => !trashed.has(header.id) && !archived.has(header.id));
  const titles = await sessionTitles(ctx, candidates.map((header) => header.id));

  const subagents = { leftover: [], attached: [] };
  const blank = [];
  const unowned = [];
  const describe = (header, extra) => ({
    sessionId: header.id,
    title: titles.get(header.id) ?? null,
    running: running.has(header.id),
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    bytes: sizes.get(header.id) ?? null,
    ...extra,
  });

  for (const header of candidates) {
    if (header.origin === 'subagent') {
      const parent = typeof header.parentSession === 'string' ? header.parentSession : null;
      const parentAlive = parent != null && byId.has(parent) && !trashed.has(parent);
      const row = describe(header, { parentSession: parent, parentTitle: parentAlive ? (titles.get(parent) ?? null) : null });
      (parentAlive ? subagents.attached : subagents.leftover).push(row);
      continue;
    }
    const holders = workspaceHolders(reg, header.id);
    if (await projectionBlank(ctx, header.id)) {
      blank.push(describe(header, { workspaceTitle: holders.length > 0 ? holders[0].record.title : null }));
      continue;
    }
    if (holders.length === 0) unowned.push(describe(header, {}));
  }

  const byRecency = (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0);
  const groups = {
    subagents: { leftover: subagents.leftover.sort(byRecency), attached: subagents.attached.sort(byRecency) },
    blank: blank.sort(byRecency),
    unowned: unowned.sort(byRecency),
  };
  const all = [...groups.subagents.leftover, ...groups.subagents.attached, ...groups.blank, ...groups.unowned];
  const total = all.length;
  const LIMIT = 200;
  if (total > LIMIT) {
    // Deterministic truncation in group order; the remaining rows are reported
    // so the page can say so instead of silently hiding sessions.
    let left = LIMIT;
    for (const bucket of [groups.subagents.leftover, groups.subagents.attached, groups.blank, groups.unowned]) {
      const keep = bucket.slice(0, Math.max(0, left));
      bucket.length = 0;
      bucket.push(...keep);
      left -= keep.length;
    }
  }
  return {
    groups,
    stats: {
      count: all.length,
      total,
      truncated: Math.max(0, total - all.length),
      bytes: all.reduce((sum, row) => sum + (typeof row.bytes === 'number' ? row.bytes : 0), 0),
      subagents: groups.subagents.leftover.length + groups.subagents.attached.length,
      blank: groups.blank.length,
      unowned: groups.unowned.length,
      running: all.filter((row) => row.running).length,
    },
  };
}

/** Absolute directory of a session whose log is still in the persistence tree. */
async function sessionDirOf(ctx, sessionId) {
  // 1) Filesystem-first: the sessions tree is authoritative and independent of
  //    any service return shape (DSH 0.1.5 changed sessionPersistence.list()).
  const root = sessionsRoot();
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(root, entry.name, sessionId);
      if (await dirExists(candidate)) return candidate;
    }
  } catch {
    /* fall through to the service-based resolution */
  }
  // 2) Fallback: ask the persistence backend where the log would live.
  const header = await findHeader(ctx, sessionId);
  if (header == null || typeof header.cwd !== 'string' || typeof ctx.sessionPersistence.locate !== 'function') return null;
  try {
    const location = ctx.sessionPersistence.locate(header);
    if (location == null || typeof location.path !== 'string' || location.path.length === 0) return null;
    return dirname(location.path);
  } catch {
    return null;
  }
}

async function moveDir(from, to) {
  // Both ends of every move are session data; nothing else may be touched.
  const source = assertAllowedPath(from, 'move a session directory');
  const target = assertAllowedPath(to, 'move a session directory');
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
}

/* ------------------------------------------------------------------ helpers */

function checkSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new ApiError(
      400,
      'INVALID_SESSION_ID',
      `invalid session id: ${JSON.stringify(sessionId)}. Expected "session-…" or a legacy bare uuid.`,
    );
  }
}

/** Feature-detect the live workspace registry instance (see SessionEditor dev log). */
function registry(ctx) {
  const reg = ctx.get('workspaceRegistry');
  if (reg == null) {
    throw new Error('workspace registry is unavailable — Session-Manager-GUI requires the web profile composition.');
  }
  const methods = [
    'enqueueOperation', 'requireState', 'requireTable', 'setState', 'rebuildEntities',
    'sessionKnown', 'readSessionHeader', 'list', 'get', 'create', 'delete',
    'archiveSession', 'insertBefore', 'resolveByPath',
  ];
  for (const method of methods) {
    if (typeof reg[method] !== 'function') {
      throw new Error(`workspace registry API changed (missing method "${method}"). ${SUPPORT_NOTE}`);
    }
  }
  const properties = ['table', 'global', 'state', 'entities', 'headers', 'sessionPaths', 'invalidSessionPaths', 'archivedSessionIds'];
  for (const key of properties) {
    if (!(key in reg)) {
      throw new Error(`workspace registry API changed (missing property "${key}"). ${SUPPORT_NOTE}`);
    }
  }
  if (reg.state == null) {
    throw new Error('workspace registry is not started yet.');
  }
  return reg;
}

/**
 * Ids of sessions whose agent is CURRENTLY executing (mid-turn / generating).
 * The sessions store keeps every session opened since process start
 * (even after the user left or archived it), so it must NOT be used to
 * decide deletability: an idle, no-longer-open session would be blocked
 * forever. Only an actively running agent is a real conflict for deletion.
 */
function runningSessionIds(ctx) {
  const ids = new Set();
  const agents = ctx.get('agents');
  if (agents != null && typeof agents.list === 'function') {
    for (const agent of agents.list()) {
      try {
        if (agent != null && typeof agent.id === 'string' && agent.status === 'running') ids.add(agent.id);
      } catch {
        /* shape drift: ignore this entry */
      }
    }
  }
  // Fallback for a background subagent whose agent entry is not part of the
  // agent registry listing: a store entry that exposes its own in-flight flag
  // still counts as executing, so a cascaded delete can never hit it.
  const store = ctx.get('sessions');
  if (store != null && typeof store.list === 'function') {
    for (const session of store.list()) {
      try {
        const id = session != null && session.header != null ? session.header.id : (session != null ? session.id : undefined);
        if (typeof id !== 'string') continue;
        if (session.running === true || session.isRunning === true || session.busy === true) ids.add(id);
      } catch {
        /* shape drift: ignore this entry */
      }
    }
  }
  return [...ids];
}

function requireNotRunning(ctx, sessionId) {
  if (runningSessionIds(ctx).includes(sessionId)) {
    throw new ApiError(
      409,
      'LIVE_SESSION',
      `refusing to operate on session '${sessionId}': the session is currently generating/executing. Wait for it to finish or stop it first.`,
    );
  }
}

/**
 * Sessions whose context is still attached in THIS process (opened since
 * boot and not yet destroyed). Such sessions keep appearing in the product's
 * session catalog (e.g. under "Ungrouped" when they have no workspace slot),
 * even after their files are gone — the ghost disappears only once the
 * context detaches (session closed / process restart).
 */
function attachedSessionIds(ctx) {
  const store = ctx.get('sessions');
  if (store == null || typeof store.list !== 'function') return [];
  const ids = [];
  for (const session of store.list()) {
    let id = undefined;
    try {
      id = session != null && session.header ? session.header.id : session.id;
    } catch {
      id = undefined;
    }
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

/**
 * Retire the live Agent of a session whose context is being ended.
 *
 * Detaching a session from the sessions store is only HALF of what the product
 * does when a session context really ends: the agent loop's teardown also
 * unregisters the Agent (`detachAgent?.()` next to `detachSession?.()`). An
 * agent left registered after its session entry is gone is a ZOMBIE:
 * `sessionController.liveAgent(id)` still returns it (it only asks the agents
 * registry), so every later prompt is handed to an agent whose context is gone
 * — accepted into its inbox, never written to the log, never answered, and a
 * fresh resume is impossible because the id is already registered. Retiring the
 * entry makes the next open/prompt resume a healthy agent from the restored log.
 *
 * Feature-detected and best-effort. The agent's own machine objects are released
 * by the owning scope (there is no public per-agent dispose), so this only drops
 * the registry entry — the state the REST of the product resolves through.
 * @returns true when an entry was actually removed.
 */
function retireAgentEntry(ctx, sessionId) {
  const agents = ctx.get('agents');
  if (agents == null || typeof agents.get !== 'function') return false;
  let agent;
  try {
    agent = agents.get(sessionId);
  } catch {
    return false;
  }
  if (agent == null) return false;
  try {
    if (typeof agent.cancel === 'function') {
      const pending = agent.cancel();
      if (pending != null && typeof pending.catch === 'function') pending.catch(() => {});
    }
  } catch {
    /* stopping a dead turn is best effort */
  }
  try {
    const entries = agents.store;
    if (entries != null && typeof entries.delete === 'function' && entries.has(sessionId)) {
      entries.delete(sessionId);
      return true;
    }
  } catch {
    /* shape drift: leave the entry alone */
  }
  return false;
}

/**
 * One-shot repair for agents left registered by an earlier build (or by any
 * other half-ended context): an agent whose session entry is absent can never
 * run again, so it is retired. A healthy agent always has its session entered
 * while it lives, so this can only match the zombie shape.
 * @returns the retired session ids.
 */
async function sweepZombieAgents(ctx) {
  const agents = ctx.get('agents');
  if (agents == null || typeof agents.list !== 'function') return [];
  let live;
  try {
    live = agents.list();
  } catch {
    return [];
  }
  const attached = new Set(attachedSessionIds(ctx));
  const retired = [];
  for (const agent of live) {
    let id;
    let running = false;
    try {
      id = agent != null ? agent.id : undefined;
      running = agent != null && agent.status === 'running';
    } catch {
      continue;
    }
    if (typeof id !== 'string' || running || attached.has(id)) continue;
    if (retireAgentEntry(ctx, id)) retired.push(id);
  }
  return retired;
}

/**
 * Detach one session from the in-memory sessions store, exactly the way the
 * product detaches a session whose owning context ends (the store entry's own
 * `detach`, which also emits `session/disposed`).
 *
 * Required by the recycle bin: `sessionQuery` is a LIVE-PREFERRED service, so
 * an attached session stays listed — and therefore `@`-mentionable — even
 * after its log directory has been moved into the trash area. Detaching makes
 * a deleted conversation disappear from every listing surface immediately.
 *
 * Feature-detected; returns false when the store shape is unknown, in which
 * case the caller keeps its previous behaviour.
 */
function detachAttachedSession(ctx, sessionId) {
  let detached = false;
  try {
    const store = ctx.get('sessions');
    const map = store != null ? store.store : undefined;
    const entry = map != null && typeof map.get === 'function' ? map.get(sessionId) : undefined;
    if (entry != null && typeof entry.detach === 'function') {
      entry.detach();
      detached = true;
    }
  } catch {
    /* best effort: a failed detach must not fail the deletion itself */
  }
  // ALWAYS retire the live agent: with no session entry left it could never run
  // another turn, and its registration would block a healthy resume.
  retireAgentEntry(ctx, sessionId);
  return detached;
}

/**
 * Find one session header by scanning session persistence (files intact).
 * Shape-tolerant across harness versions: DSH <= 0.1.2 returned
 * `SessionHeader[]`, while 0.1.5 returns snapshots `{ header, revision,
 * sizeBytes }` (and pending entries `{ header, revision }`).
 */
async function findHeader(ctx, sessionId) {
  let listed;
  try {
    listed = await ctx.sessionPersistence.list();
  } catch {
    return undefined; // a failing listing must not break relocation/restore
  }
  for (const entry of listed) {
    const header = entry != null && entry.header != null ? entry.header : entry;
    if (header != null && header.id === sessionId) return header;
  }
  return undefined;
}

/* ------------------------------------------------------------------ titles */

/**
 * Titles are read FIRST from each session's projection-cache checkpoint
 * document ($DSH_HOME/storages/session_projcache/sessions/<id>.json — the
 * same per-session source the WebUI list renders from), with the
 * sessionQuery service as a fallback. The checkpoint stores the title fold
 * somewhere inside the document (the exact nesting may vary), so a tolerant
 * recursive search is used. This fixes archived/trashed sessions showing
 * "untitled" when the sessionQuery read path returns nothing for them.
 */

function pickTitle(value, depth = 0) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value == null || typeof value !== 'object' || depth > 3) return null;
  if (Array.isArray(value)) return null;
  for (const key of ['title', 'text']) {
    const hit = pickTitle(value[key], depth + 1);
    if (hit != null) return hit;
  }
  return null;
}

/** Extract a title from a value found under a key named "title". */
function titleNodeValue(node) {
  if (typeof node === 'string') return node.length > 0 ? node : null;
  if (node == null || typeof node !== 'object') return null;
  if (typeof node.val === 'string' && node.val.length > 0) return node.val;
  if (typeof node.text === 'string' && node.text.length > 0) return node.text;
  if (typeof node.title === 'string' && node.title.length > 0) return node.title;
  return null;
}

/**
 * Recursively find the title fold: ONLY values stored under a key literally
 * named "title" qualify (e.g. .../rows/title -> {ver, seq, val}). Free-form
 * strings elsewhere (paths, ids, …) are never treated as titles.
 */
function findTitleValue(node, depth = 0) {
  if (node == null || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findTitleValue(child, depth + 1);
      if (hit != null) return hit;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(node, 'title')) {
    const direct = titleNodeValue(node.title);
    if (direct != null) return direct;
  }
  for (const key of Object.keys(node)) {
    if (key === 'title') continue;
    const hit = findTitleValue(node[key], depth + 1);
    if (hit != null) return hit;
  }
  return null;
}

async function projectionTitle(ctx, sessionId) {
  try {
    const raw = await readFile(projectionCacheFile(sessionId), 'utf8');
    const parsed = JSON.parse(raw);
    const found = findTitleValue(parsed);
    if (found != null) return found;
  } catch {
    /* missing/corrupt cache -> fall through to the query path */
  }
  return null;
}

async function sessionTitles(ctx, sessionIds) {
  const titles = new Map();
  if (sessionIds.length === 0) return titles;
  const missing = [];
  for (const sessionId of sessionIds) {
    const title = await projectionTitle(ctx, sessionId);
    if (title != null) titles.set(sessionId, title);
    else missing.push(sessionId);
  }
  if (missing.length === 0) return titles;
  const query = ctx.get('sessionQuery');
  if (query == null || typeof query.readTitleSnapshots !== 'function') return titles;
  try {
    const results = await query.readTitleSnapshots(missing);
    if (!Array.isArray(results)) return titles;
    for (const entry of results) {
      const id = entry != null
        ? (typeof entry.sessionId === 'string' ? entry.sessionId : typeof entry.id === 'string' ? entry.id : undefined)
        : undefined;
      if (id == null) continue;
      const title = pickTitle(entry);
      if (title != null) titles.set(id, title);
    }
  } catch {
    /* title reads are best-effort */
  }
  return titles;
}

/* ------------------------------------------------------- subagent marking */

/**
 * Log file names inside one session directory, newest format first. A session
 * directory carries the v3 log (and, for sessions written by older harness
 * versions, a legacy v1 log beside it).
 */
function sessionLogCandidates(dir) {
  return [join(dir, 'session.v3.jsonl.zstd'), join(dir, 'session.jsonl.zstd')];
}

/** zstd frame magic: `28 B5 2F FD`, little-endian `0xFD2FB528`. */
const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Decompress ONLY the first zstd frame of a session log.
 *
 * A session log is a concatenation of independently compressed frames (one per
 * appended batch), and `zstdDecompressSync` stops after the first frame it is
 * handed — which is exactly what is wanted here: the header is the first line
 * of the first frame. Passing the whole file would work by the same accident,
 * but slicing keeps the read proportional to the header, not to the log.
 *
 * @param file - absolute log path.
 * @returns the decoded text of the first frame, or null when unreadable.
 */
async function firstLogFrameText(file) {
  let buffer;
  try {
    buffer = await readFile(file);
  } catch {
    return null;
  }
  const start = buffer.indexOf(ZSTD_FRAME_MAGIC);
  if (start < 0) return null;
  const next = buffer.indexOf(ZSTD_FRAME_MAGIC, start + 1);
  const frame = buffer.subarray(start, next < 0 ? buffer.length : next);
  try {
    return zstdDecompressSync(frame).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Read the `session` header of a TRASHED session straight out of its log in the
 * holding area.
 *
 * `sessionPersistence.list()` cannot answer this: a soft delete MOVES the log
 * directory out of `$DSH_HOME/sessions`, which is the only tree that listing
 * scans — so a trashed session has no header through the harness services and
 * the log itself is the only authority left. The header carries `origin`
 * (`"subagent"` for derived child sessions, absent for forks) and
 * `parentSession`, which is what the recycle bin needs to mark a row.
 *
 * Best effort by design: a corrupt or half-written log yields null and the
 * caller falls back to the projection checkpoint.
 *
 * @param entry - one recycle-bin entry.
 * @returns the header object, or null when it cannot be read.
 */
async function trashedHeader(entry) {
  if (entry == null || entry.relocated !== true || typeof entry.storedDir !== 'string') return null;
  const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : null;
  if (sessionId == null) return null;
  let dir;
  try {
    dir = assertSessionDir(entry.storedDir, sessionId, 'stored');
  } catch {
    return null;
  }
  for (const candidate of sessionLogCandidates(dir)) {
    const text = await firstLogFrameText(candidate);
    if (text == null) continue;
    const line = text.split('\n').find((row) => row.trim() !== '');
    if (line == null) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed != null && parsed.type === 'session') return parsed;
    } catch {
      /* fall through to the next candidate */
    }
  }
  return null;
}

/**
 * The `subagent` projection of one trashed session, read from its projection
 * checkpoint. The product writes `{}` for a session that is not a subagent and
 * an object carrying `identity.mode` for one that is, so the presence of that
 * identity is the signal.
 *
 * @param sessionId - session id.
 * @returns the subagent identity when the checkpoint says so, else null.
 */
async function projectionSubagentIdentity(sessionId) {
  try {
    const parsed = JSON.parse(await readFile(projectionCacheFile(sessionId), 'utf8'));
    const rows = parsed != null && parsed.record != null ? parsed.record.rows : undefined;
    const row = rows != null ? rows.subagent : undefined;
    const value = row != null ? row.val : undefined;
    const identity = value != null ? value.identity : undefined;
    if (identity != null && typeof identity.mode === 'string') return identity;
    return null;
  } catch {
    return null;
  }
}

/**
 * Mark every recycle-bin entry that is a SUBAGENT session.
 *
 * A soft delete already records `cascadeOf` on the children it took down with
 * their parent, but that is only the cascade flavour: a subagent deleted on its
 * own, or restored and re-deleted, carries no `cascadeOf` at all. `origin` is
 * the authoritative relation (the same field `subagentDescendantIds` and the
 * “invisible sessions” page already key off), so it is read per entry and the
 * projection checkpoint only backs it up when the log is unreadable.
 *
 * @param entries - recycle-bin entries.
 * @returns a Map of sessionId -> { parentSessionId } for the subagent ones.
 */
async function subagentMarks(entries) {
  const marks = new Map();
  for (const entry of entries) {
    const sessionId = entry != null && typeof entry.sessionId === 'string' ? entry.sessionId : null;
    if (sessionId == null) continue;
    const header = await trashedHeader(entry);
    if (header != null) {
      if (header.origin !== 'subagent') continue;
      marks.set(sessionId, {
        parentSessionId: typeof header.parentSession === 'string' && header.parentSession.length > 0 ? header.parentSession : null,
        delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : null,
        label: null,
      });
      continue;
    }
    /* Log unreadable (corrupt, or a held session whose log was rewritten):
     * the checkpoint's subagent projection is the only signal left. */
    const identity = await projectionSubagentIdentity(sessionId);
    if (identity == null) continue;
    marks.set(sessionId, { parentSessionId: null, delegationDepth: null, label: typeof identity.label === 'string' ? identity.label : null });
  }
  return marks;
}

/* ------------------------------------------------------------------ trash store */

/**
 * Plain JSON store: {version:1, entries:[{sessionId,title,deletedAt,workspaceId,workspaceTitle,workspacePath}]}
 * All mutations funnel through one process-local promise chain so concurrent
 * requests cannot interleave read-modify-write cycles. Writes are atomic
 * (tmp file + rename). Only this host process is expected to touch the file.
 */
let trashTail = Promise.resolve();

function withTrashLock(task) {
  const run = trashTail.then(task, task);
  trashTail = run.then(() => {}, () => {});
  return run;
}

async function readTrashEntries() {
  try {
    const raw = await readFile(trashStoreFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed != null && Array.isArray(parsed.entries)) return parsed.entries;
  } catch {
    /* missing/corrupt file -> empty store */
  }
  return [];
}

async function writeTrashEntries(entries) {
  const target = assertAllowedPath(trashStoreFile(), 'write the recycle-bin index');
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
  await rename(tmp, target);
}

function trashEntryOf(entries, sessionId) {
  return entries.find((entry) => entry != null && entry.sessionId === sessionId);
}

/**
 * Deferred cleanup for "purged" tombstones. A purge erases files right away,
 * but when the session's context is still attached in this process the
 * product catalog would keep showing it (e.g. under "Ungrouped"). Such
 * entries are therefore hidden via the archived set and marked purged here;
 * once the context detaches (session closed / after restart) this sweep
 * removes the remaining accounting and drops the tombstone. Returns the
 * current (possibly swept) entry list.
 */
async function sweepPurgedTrash(ctx) {
  const entries = await readTrashEntries();
  const pending = entries.filter((entry) => entry != null && entry.purged === true);
  if (pending.length === 0) return entries;
  let reg;
  try {
    reg = registry(ctx);
  } catch {
    return entries;
  }
  const cleaned = new Set();
  for (const entry of pending) {
    if (attachedSessionIds(ctx).includes(entry.sessionId) || runningSessionIds(ctx).includes(entry.sessionId)) {
      continue; // context still alive: keep tombstone, stay hidden via archived
    }
    try {
      await reg.enqueueOperation(async () => {
        if (attachedSessionIds(ctx).includes(entry.sessionId)) return; // attached meanwhile
        await removeSessionAccounting(reg, entry.sessionId);
      });
      cleaned.add(entry.sessionId);
    } catch {
      /* keep the tombstone; retry on the next API call */
    }
  }
  if (cleaned.size === 0) return entries;
  const next = entries.filter((entry) => !(entry != null && entry.purged === true && cleaned.has(entry.sessionId)));
  await writeTrashEntries(next);
  return next;
}

/**
 * Migration sweep for entries created by versions that only hid a session
 * (archived set + trash record) while leaving its log directory inside
 * `$DSH_HOME/sessions` — which left it visible to `@` mention candidates.
 * Such entries are relocated into the trash holding area now. Best effort:
 * a failure (locked file, missing dirs) keeps the entry as-is and is retried
 * on the next trash interaction. Returns the current entry list.
 */
async function sweepLegacyRelocation(ctx) {
  const entries = await readTrashEntries();
  const pending = entries.filter((entry) => entry != null && entry.purged !== true && entry.relocated !== true);
  if (pending.length === 0) return entries;
  let changed = false;
  for (const entry of pending) {
    if (runningSessionIds(ctx).includes(entry.sessionId)) continue; // never move a generating session
    const dir = await sessionDirOf(ctx, entry.sessionId);
    if (dir == null || !isInsideSessionsRoot(dir)) continue; // files already gone
    const target = join(trashRoot(), entry.sessionId);
    try {
      if (await pathExists(target)) {
        // A stored copy already exists (previous run half-finished): keep it.
        if (dir !== target) await rm(assertAllowedPath(dir, 'drop a stale session directory'), { recursive: true, force: true });
      } else {
        await moveDir(dir, target);
      }
      entry.relocated = true;
      entry.originalDir = dir;
      entry.storedDir = target;
      // A legacy entry may still be attached in memory: detach it so the
      // live-preferred query (and therefore `@`) stops listing it too.
      detachAttachedSession(ctx, entry.sessionId);
      changed = true;
    } catch {
      /* retry later */
    }
  }
  if (changed) await writeTrashEntries(entries);
  return entries;
}

/* --------------------------------------------------------------- registry ops */

/**
 * Remove a session's workspace accounting AND archived membership durably:
 * workspace records, header index caches, and the archived set. Used by
 * permanent purge (files are erased separately).
 */
async function removeSessionAccounting(reg, sessionId) {
  const table = reg.requireTable();
  const now = new Date().toISOString();
  for (const entity of [...reg.entities.values()]) {
    const record = entity != null ? entity.record : undefined;
    if (record == null || !Array.isArray(record.sessionIds) || !record.sessionIds.includes(sessionId)) continue;
    await table.update(entity.id, (current) =>
      current != null && Array.isArray(current.sessionIds) && current.sessionIds.includes(sessionId)
        ? { ...current, sessionIds: current.sessionIds.filter((id) => id !== sessionId), updatedAt: now }
        : current,
    );
  }
  reg.rebuildEntities();
  reg.headers.delete(sessionId);
  reg.sessionPaths.delete(sessionId);
  reg.invalidSessionPaths.delete(sessionId);
  const state = reg.requireState();
  if (state.archivedSessionIds.includes(sessionId)) {
    await reg.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
    });
  }
}

/**
 * Delete-to-trash (soft delete) of ONE session, the single-session primitive
 * the batch orchestrator reuses. Two mechanisms, both required:
 *  1. the session directory is MOVED out of `$DSH_HOME/sessions` into the
 *     trash holding area — that is what removes it from every
 *     persistence-backed listing, including the `@` session-reference
 *     candidates and search, not just from the workspace grouping;
 *  2. the session is added to the product's archived set, which keeps an
 *     attached (still-open) context hidden from grouping surfaces too.
 * The workspace record keeps the session's slot, so a restore returns it to
 * its original position. The trash entry carries the recycle-bin snapshot,
 * the exact from/to directories of the move, and — for a session removed as
 * a parent's derived subagent — the `cascadeOf` parent id that keeps restore
 * and purge symmetric.
 * @param cascadeOf - parent session id when this session is a cascaded
 *   subagent, otherwise null.
 * @returns the written entry plus what was actually done (for rollback).
 */
async function trashOneEntry(ctx, reg, entries, sessionId, cascadeOf) {
  requireNotRunning(ctx, sessionId);
  const archivedNow = reg.archivedSessionIds.map(String);
  const holders = workspaceHolders(reg, sessionId);
  const holder = holders.length > 0 ? holders[0] : undefined;
  if (holder === undefined && !archivedNow.includes(sessionId)) {
    let known = false;
    try {
      known = await reg.sessionKnown(sessionId);
    } catch (error) {
      throw new Error(`cannot verify session '${sessionId}': ${error.message}`);
    }
    if (!known) {
      throw new ApiError(404, 'UNKNOWN_SESSION', `unknown session '${sessionId}' — nothing was moved to trash.`);
    }
  }

  // Best-effort title snapshot for display without touching the log.
  const titleMap = await sessionTitles(ctx, [sessionId]);
  const title = titleMap.get(sessionId) ?? null;
  const deletedAt = new Date().toISOString();
  const holderInfo = holder != null
    ? { workspaceId: holder.id, workspaceTitle: holder.record.title, workspacePath: holder.record.path }
    : { workspaceId: null, workspaceTitle: null, workspacePath: null };

  // 1) Move the log directory out of the persistence scan.
  const dir = await sessionDirOf(ctx, sessionId);
  let relocated = null;
  if (dir != null) {
    const source = assertSessionDir(dir, sessionId, 'original');
    const target = assertAllowedPath(join(trashRoot(), sessionId), `relocate session '${sessionId}'`);
    if (await pathExists(target)) {
      // A stale copy from a half-finished earlier run: the LIVE directory is
      // the authoritative one (it is what every listing shows), so the stale
      // copy goes and the move always happens. Keeping the stale copy instead
      // would leave the session listed while claiming it was trashed.
      await rm(target, { recursive: true, force: true });
    }
    await moveDir(source, target);
    relocated = { originalDir: source, storedDir: target };
  }

  // 2) Hide via the archived set (covers an attached context) and record the
  //    trash entry. Any failure rolls both steps back.
  let archivedAdded = false;
  try {
    await reg.enqueueOperation(async () => {
      requireNotRunning(ctx, sessionId);
      const currentArchived = reg.archivedSessionIds.map(String);
      if (!currentArchived.includes(sessionId)) {
        const state = reg.requireState();
        await reg.setState({
          ...state,
          archivedSessionIds: [...state.archivedSessionIds, sessionId],
        });
        archivedAdded = true;
      }
    });
    const entry = {
      sessionId,
      title,
      deletedAt,
      workspaceId: holderInfo.workspaceId,
      workspaceTitle: holderInfo.workspaceTitle,
      workspacePath: holderInfo.workspacePath,
      ...(cascadeOf != null ? { cascadeOf } : {}),
      ...(relocated != null ? { relocated: true, originalDir: relocated.originalDir, storedDir: relocated.storedDir } : {}),
    };
    const next = [entry, ...entries];
    await writeTrashEntries(next);
    return { entry, relocated, archivedAdded, entries: next };
  } catch (error) {
    if (archivedAdded) {
      try {
        await reg.enqueueOperation(async () => {
          const state = reg.requireState();
          if (state.archivedSessionIds.includes(sessionId)) {
            await reg.setState({
              ...state,
              archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
            });
          }
        });
      } catch {
        /* best effort */
      }
    }
    if (relocated != null) {
      try {
        if (await pathExists(relocated.storedDir)) await moveDir(relocated.storedDir, relocated.originalDir);
      } catch {
        /* best effort */
      }
    }
    throw error;
  }
}

/**
 * Undo one {@link trashOneEntry} during a batch rollback: drop the entry,
 * drop the archived membership, move the directory back. A detach cannot be
 * undone (it only affects in-memory listings; the files are back, so the next
 * listing/refresh shows the session again).
 */
async function undoTrashOne(ctx, reg, outcome) {
  const { entry } = outcome;
  // 1) Put the files back FIRST. While the directory is still in the holding
  //    area the entry must stay in the index, otherwise the only copy of the
  //    session would be unreachable (no entry -> no restore, no purge).
  if (outcome.relocated != null) {
    try {
      if (await pathExists(outcome.relocated.storedDir)) {
        await moveDir(outcome.relocated.storedDir, outcome.relocated.originalDir);
      }
    } catch {
      return; // keep the entry so the user can still restore it by hand
    }
  }
  // 2) Then drop the index entry.
  try {
    const current = await readTrashEntries();
    await writeTrashEntries(current.filter((candidate) => candidate.sessionId !== entry.sessionId));
  } catch {
    /* best effort */
  }
  // 3) Only undo the archive membership THIS operation added — a session that
  //    was already archived before the delete must stay archived.
  if (outcome.archivedAdded !== true) return;
  try {
    await reg.enqueueOperation(async () => {
      const state = reg.requireState();
      if (state.archivedSessionIds.includes(entry.sessionId)) {
        await reg.setState({
          ...state,
          archivedSessionIds: state.archivedSessionIds.filter((id) => id !== entry.sessionId),
        });
      }
    });
  } catch {
    /* best effort */
  }
}

/**
 * Delete-to-trash with parent/child binding: the session itself plus every
 * derived subagent session (transitive `origin === "subagent"` descendants —
 * forks are NEVER included). The batch is all-or-nothing: the set is resolved
 * and pre-flighted first (a running participant refuses the whole batch), and
 * a failure while writing the entries rolls back what was already done.
 * @param options.cascade - false keeps the 0.1.5 single-session behaviour.
 */
async function trashAdd(ctx, sessionId, options = {}) {
  checkSessionId(sessionId);
  const cascade = options.cascade !== false;
  const reg = registry(ctx);
  requireNotRunning(ctx, sessionId);

  return withTrashLock(async () => {
    await sweepLegacyRelocation(ctx);
    let entries = await sweepPurgedTrash(ctx);
    const existing = trashEntryOf(entries, sessionId);
    if (existing) {
      return { session_id: sessionId, trashed: false, message: 'already in trash.' };
    }

    let childIds = [];
    if (cascade) {
      const headers = await listSessionHeaders(ctx);
      childIds = subagentDescendantIds(headers, sessionId).filter((id) => trashEntryOf(entries, id) === undefined);
    }
    const targets = [sessionId, ...childIds];
    const running = new Set(runningSessionIds(ctx));
    const live = targets.filter((id) => running.has(id));
    if (live.length > 0) {
      const error = new ApiError(
        409,
        'LIVE_SESSION',
        `refusing to delete: ${live.length} session(s) are currently generating/executing (${live.join(', ')}). ` +
          'Wait for them to finish or stop them first — nothing was deleted.',
      );
      error.details = { runningIds: live };
      throw error;
    }

    const outcomes = [];
    const skipped = [];
    try {
      for (const id of targets) {
        if (trashEntryOf(entries, id) !== undefined) {
          skipped.push(id);
          continue;
        }
        const outcome = await trashOneEntry(ctx, reg, entries, id, id === sessionId ? null : sessionId);
        entries = outcome.entries;
        outcomes.push(outcome);
      }
    } catch (error) {
      for (const outcome of [...outcomes].reverse()) {
        try {
          await undoTrashOne(ctx, reg, outcome);
        } catch {
          /* best effort */
        }
      }
      throw error;
    }

    const detached = targets.map((id) => detachAttachedSession(ctx, id));
    const primary = outcomes.find((outcome) => outcome.entry.sessionId === sessionId);
    return {
      session_id: sessionId,
      trashed: true,
      deleted_at: primary.entry.deletedAt,
      title: primary.entry.title,
      relocated: primary.relocated != null,
      detached: detached[0] === true,
      cascade: {
        requested: cascade,
        deleted: outcomes
          .filter((outcome) => outcome.entry.sessionId !== sessionId)
          .map((outcome) => ({ sessionId: outcome.entry.sessionId, title: outcome.entry.title })),
        skipped,
      },
    };
  });
}

/**
 * Restore one trashed session: move its directory back, re-index the header,
 * put it back into the workspace that owns its canonical cwd, drop the
 * archived membership and drop its entry. Returns what was restored plus the
 * remaining entry list (the caller may restore cascaded children afterwards).
 */
async function restoreOneEntry(ctx, reg, sessionId) {
  const entries = await readTrashEntries();
  const entry = trashEntryOf(entries, sessionId);
  if (!entry) {
    throw new ApiError(404, 'NOT_IN_TRASH', `session '${sessionId}' is not in the trash.`);
  }
  if (entry.purged === true) {
    throw new ApiError(410, 'ALREADY_PURGED', `session '${sessionId}' was already permanently deleted.`);
  }

  // 1) Move the directory back first so the session is listed again.
  let movedBack = false;
  if (entry.relocated === true && typeof entry.storedDir === 'string' && typeof entry.originalDir === 'string') {
    const storedDir = assertSessionDir(entry.storedDir, sessionId, 'stored');
    const originalDir = assertSessionDir(entry.originalDir, sessionId, 'original');
    if (!(await pathExists(storedDir))) {
      throw new ApiError(
        404,
        'LOG_MISSING',
        `cannot restore session '${sessionId}': its stored session directory is gone. Only purging is possible.`,
      );
    }
    await mkdir(dirname(originalDir), { recursive: true });
    if (await pathExists(originalDir)) await rm(originalDir, { recursive: true, force: true });
    await rename(storedDir, originalDir);
    movedBack = true;
  }

  const rollbackMove = async () => {
    if (!movedBack) return;
    try {
      if (await pathExists(entry.originalDir)) await moveDir(entry.originalDir, entry.storedDir);
    } catch {
      /* best effort */
    }
  };

  const header = await findHeader(ctx, sessionId);
  // The header is the canonical source; the stored workspace path is a
  // tolerant fallback for a persistence listing that cannot be read.
  const cwd = header != null && typeof header.cwd === 'string'
    ? header.cwd
    : (typeof entry.workspacePath === 'string' && entry.workspacePath.length > 0 ? entry.workspacePath : null);
  if (cwd == null) {
    await rollbackMove();
    throw new ApiError(
      404,
      'LOG_MISSING',
      `cannot restore session '${sessionId}': its session log directory no longer exists. Only purging is possible.`,
    );
  }

  try {
    // Repair any agent left registered by an earlier delete of this session:
    // it would otherwise swallow the prompts of the session we just restored.
    retireAgentEntry(ctx, sessionId);

    const workspaceRestored = await reg.enqueueOperation(async () => {
      requireNotRunning(ctx, sessionId);
      // Re-index the restored header so the workspace view admits it again.
      try {
        await reg.sessionKnown(sessionId);
      } catch {
        /* best effort */
      }
      /*
       * Put the session back into the workspace that owns its canonical cwd.
       *
       * A session's cwd is only a MEMORY of where it lived: the directory can be
       * renamed, moved or deleted while the session sits in the recycle bin (we
       * do not, and must not, police the user's real files). `resolveByPath` and
       * `create` both canonicalize through `fs.realpath`, and the registry
       * rejects a workspace whose path is not an existing directory — so
       * resolving a vanished cwd throws ENOENT and used to abort the whole
       * restore (moving the log back, then rolling it out again). The log
       * itself is intact and the restore is about the LOG.
       *
       * ⇒ resolve the workspace only when its directory still exists; otherwise
       * restore the session UNGROUPED (exactly where a session with no
       * workspace slot belongs) and say so. Never invent a workspace record for
       * a path that cannot be stat'ed: a workspace is defined as an existing
       * directory, and a durable record pointing at nothing would fail every
       * later path resolution from inside the registry.
       */
      let workspaceAccounted = false;
      if (await pathExists(cwd)) {
        const { basename } = await import('node:path');
        let entity = await reg.resolveByPath(cwd);
        if (entity == null) {
          entity = await reg.create(cwd, basename(cwd));
        }
        if (entity == null) {
          throw new Error(`cannot restore session '${sessionId}': workspace resolution failed for '${cwd}'.`);
        }
        const stillThere = [...reg.entities.values()].some(
          (candidate) => candidate != null && candidate.record != null && Array.isArray(candidate.record.sessionIds) && candidate.record.sessionIds.includes(sessionId),
        );
        if (!stillThere) {
          await entity.attachSession(sessionId);
        }
        workspaceAccounted = true;
      } else {
        console.warn(
          `Session-Manager-GUI: restoring session '${sessionId}' without a workspace grouping — its recorded cwd '${cwd}' no longer exists. `
          + 'It will reappear under “未分类” (unowned); recreate that directory and restore again to regroup it.',
        );
      }
      const archivedNow = reg.archivedSessionIds.map(String);
      if (archivedNow.includes(sessionId)) {
        const state = reg.requireState();
        await reg.setState({
          ...state,
          archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
        });
      }
      return workspaceAccounted;
    });
    const next = (await readTrashEntries()).filter((candidate) => candidate.sessionId !== sessionId);
    await writeTrashEntries(next);
    return {
      entries: next,
      sessionId,
      workspaceTitle: entry.workspaceTitle ?? null,
      workspaceAccounted: workspaceRestored === true,
    };
  } catch (error) {
    await rollbackMove();
    throw error;
  }
}

/**
 * Restore a session and — by the parent/child binding — the subagent sessions
 * that were trashed together with it (`cascadeOf === sessionId`). A child
 * whose log is gone (already purged externally) is skipped, never fatal.
 * @param options.restoreChildren - false restores only the session itself.
 */
async function trashRestore(ctx, sessionId, options = {}) {
  checkSessionId(sessionId);
  const restoreChildren = options.restoreChildren !== false;
  const reg = registry(ctx);

  return withTrashLock(async () => {
    await sweepLegacyRelocation(ctx);
    await sweepPurgedTrash(ctx);
    const primary = await restoreOneEntry(ctx, reg, sessionId);
    const restoredChildren = [];
    if (restoreChildren) {
      const children = primary.entries
        .filter((entry) => entry != null && entry.cascadeOf === sessionId && entry.purged !== true)
        .map((entry) => entry.sessionId);
      for (const childId of children) {
        try {
          await restoreOneEntry(ctx, reg, childId);
          restoredChildren.push(childId);
        } catch {
          /* a missing child log must not fail the parent's restore */
        }
      }
    }
    return {
      session_id: sessionId,
      restored: true,
      workspace_title: primary.workspaceTitle,
      /* false when the session's recorded cwd no longer exists: the log is
       * restored, but ungrouped (it lands under “未分类”). */
      workspace_accounted: primary.workspaceAccounted === true,
      restored_children: restoredChildren,
    };
  });
}

/**
 * Erase one session's durable artifacts (log directory + projection cache).
 * Every path passes {@link assertAllowedPath} first, so a tampered trash entry
 * cannot aim a delete at a workspace file.
 */
async function eraseOneSessionFiles(ctx, sessionId, entry) {
  const removed = { log_dir: null, projection_cache: null };
  if (entry != null && entry.relocated === true && typeof entry.storedDir === 'string') {
    const target = assertSessionDir(entry.storedDir, sessionId, 'stored');
    try {
      if (await pathExists(target)) {
        await rm(target, { recursive: true, force: true });
        removed.log_dir = target;
      }
    } catch {
      removed.log_dir = null;
    }
  } else {
    const dir = await sessionDirOf(ctx, sessionId);
    if (dir != null) {
      const target = assertSessionDir(dir, sessionId, 'original');
      try {
        await rm(target, { recursive: true, force: true });
        removed.log_dir = target;
      } catch {
        removed.log_dir = null;
      }
    }
  }
  const cache = assertAllowedPath(projectionCacheFile(sessionId), `remove the projection checkpoint of '${sessionId}'`);
  try {
    await rm(cache, { force: true });
    removed.projection_cache = cache;
  } catch {
    removed.projection_cache = null;
  }
  return removed;
}

/**
 * Remove one session's accounting now. Returns false when the session's
 * context is still attached and cannot be detached, in which case the caller
 * keeps the previous fallback: hide it via the archived set and finish the
 * cleanup later (see {@link sweepPurgedTrash}).
 */
async function purgeOneAccount(ctx, reg, sessionId) {
  let final = false;
  await reg.enqueueOperation(async () => {
    requireNotRunning(ctx, sessionId);
    const wasAttached = attachedSessionIds(ctx).includes(sessionId);
    const detachedNow = wasAttached ? detachAttachedSession(ctx, sessionId) : false;
    if (!wasAttached || detachedNow) {
      await removeSessionAccounting(reg, sessionId);
      final = true;
    } else {
      const state = reg.requireState();
      if (!state.archivedSessionIds.includes(sessionId)) {
        await reg.setState({
          ...state,
          archivedSessionIds: [...state.archivedSessionIds, sessionId],
        });
      }
    }
  });
  return final;
}

/**
 * Permanently erase a trashed session — and, by the parent/child binding, the
 * subagent entries trashed with it plus any leftover subagent sessions of it
 * that are still on disk.
 * @param options.includeOrphans - false keeps on-disk leftovers untouched.
 */
async function trashPurge(ctx, sessionId, options = {}) {
  checkSessionId(sessionId);
  const includeOrphans = options.includeOrphans !== false;
  const reg = registry(ctx);
  requireNotRunning(ctx, sessionId);

  return withTrashLock(async () => {
    const entries = await sweepPurgedTrash(ctx);
    const entry = trashEntryOf(entries, sessionId);
    if (!entry) {
      throw new ApiError(404, 'NOT_IN_TRASH', `session '${sessionId}' is not in the trash.`);
    }
    if (entry.purged === true) {
      throw new ApiError(410, 'ALREADY_PURGED', `session '${sessionId}' was already permanently deleted.`);
    }

    const cascadeEntries = entries.filter(
      (candidate) => candidate != null && candidate.cascadeOf === sessionId && candidate.purged !== true,
    );
    let orphanIds = [];
    if (includeOrphans) {
      const headers = await listSessionHeaders(ctx);
      orphanIds = subagentDescendantIds(headers, sessionId).filter((id) => trashEntryOf(entries, id) === undefined);
    }

    const participants = [
      { sessionId, entry, kind: 'self' },
      ...cascadeEntries.map((candidate) => ({ sessionId: candidate.sessionId, entry: candidate, kind: 'child' })),
      ...orphanIds.map((id) => ({ sessionId: id, entry: null, kind: 'orphan' })),
    ];
    const running = new Set(runningSessionIds(ctx));
    const live = participants.map((item) => item.sessionId).filter((id) => running.has(id));
    if (live.length > 0) {
      const error = new ApiError(
        409,
        'LIVE_SESSION',
        `refusing to purge: ${live.length} session(s) are currently generating/executing (${live.join(', ')}). ` +
          'Wait for them to finish or stop them first — nothing was erased.',
      );
      error.details = { runningIds: live };
      throw error;
    }

    const results = [];
    const failedItems = [];
    for (const item of participants) {
      let files = { log_dir: null, projection_cache: null };
      try {
        files = await eraseOneSessionFiles(ctx, item.sessionId, item.entry);
      } catch (error) {
        // Erasure itself was refused (path guard / validation) BEFORE deleting
        // anything: for the session the user asked to purge, that is a hard
        // failure — report it and leave the index exactly as it was.
        if (item.kind === 'self') throw error;
        failedItems.push({ sessionId: item.sessionId, message: String((error != null && error.message) || error) });
        results.push({ sessionId: item.sessionId, kind: item.kind, files, final: false });
        continue;
      }
      try {
        const final = await purgeOneAccount(ctx, reg, item.sessionId);
        results.push({ sessionId: item.sessionId, kind: item.kind, files, final });
      } catch (error) {
        // The files are gone but the accounting could not be cleaned: the entry
        // MUST become a tombstone rather than a restorable row with no log.
        failedItems.push({ sessionId: item.sessionId, message: String((error != null && error.message) || error) });
        results.push({ sessionId: item.sessionId, kind: item.kind, files, final: false });
      }
    }

    const now = new Date().toISOString();
    const next = entries
      .map((candidate) => {
        const hit = results.find((result) => result.sessionId === candidate.sessionId);
        if (hit === undefined) return candidate;
        return hit.final ? null : { ...candidate, purged: true, purgedAt: now };
      })
      .filter((candidate) => candidate != null);
    await writeTrashEntries(next);

    const primary = results.find((result) => result.sessionId === sessionId);
    return {
      session_id: sessionId,
      purged: true,
      removed: primary.files,
      final: primary.final,
      purged_children: results.filter((result) => result.kind === 'child').map((result) => result.sessionId),
      purged_orphans: results.filter((result) => result.kind === 'orphan').map((result) => result.sessionId),
      failed: failedItems,
      message: primary.final
        ? undefined
        : 'files erased; the session context is still open, so registry bookkeeping will be cleaned up once that context closes (a page refresh may show the row until then).',
    };
  });
}

/**
 * Permanently delete an explicit list of sessions — the "normally invisible"
 * page's batch action. The client submits exactly the ids it rendered, so the
 * server never has to guess a set. All pre-flight checks (id shape, running
 * state, path guard) run BEFORE anything is erased; per-item failures are
 * reported instead of failing the whole batch, because erasure is not
 * reversible.
 */
async function hiddenPurge(ctx, sessionIds) {
  if (!Array.isArray(sessionIds)) {
    throw new ApiError(400, 'EMPTY_SELECTION', 'no sessions were selected.');
  }
  const unique = [...new Set(sessionIds)];
  if (unique.length === 0) {
    throw new ApiError(400, 'EMPTY_SELECTION', 'no sessions were selected.');
  }
  if (unique.length > 500) {
    throw new ApiError(400, 'SELECTION_TOO_LARGE', 'at most 500 sessions can be purged in one batch.');
  }
  for (const id of unique) checkSessionId(id);
  const reg = registry(ctx);

  return withTrashLock(async () => {
    const entries = await sweepPurgedTrash(ctx);

    // (a) Only ids that are in the hidden set RIGHT NOW may be purged. A stale
    // page must never be able to erase a session that has meanwhile become a
    // normal, sidebar-visible session again.
    const hidden = await hiddenList(ctx);
    const hiddenIds = new Set(
      [
        ...hidden.groups.subagents.leftover,
        ...hidden.groups.subagents.attached,
        ...hidden.groups.blank,
        ...hidden.groups.unowned,
      ].map((row) => row.sessionId),
    );
    const refused = unique.filter((id) => !hiddenIds.has(id));
    const accepted = unique.filter((id) => hiddenIds.has(id));

    // (b) Parent/child binding: the subagent sessions derived from a selected
    // session are erased with it, exactly as the confirmation dialog says.
    const headers = await listSessionHeaders(ctx);
    const targets = [...new Set(accepted.flatMap((id) => [id, ...subagentDescendantIds(headers, id)]))];
    if (targets.length === 0) {
      return { purged: [], count: 0, refused, failed: [] };
    }

    const running = new Set(runningSessionIds(ctx));
    const live = targets.filter((id) => running.has(id));
    if (live.length > 0) {
      const error = new ApiError(
        409,
        'LIVE_SESSION',
        `refusing to purge: ${live.length} session(s) are currently generating/executing (${live.join(', ')}). ` +
          'Wait for them to finish or stop them first — nothing was erased.',
      );
      error.details = { runningIds: live };
      throw error;
    }

    // Pre-flight every path BEFORE anything is erased; erasure is not reversible.
    const plans = [];
    for (const id of targets) {
      const entry = trashEntryOf(entries, id) ?? null;
      const relocated = entry != null && entry.relocated === true && typeof entry.storedDir === 'string';
      const dir = relocated ? entry.storedDir : await sessionDirOf(ctx, id);
      if (dir != null) assertSessionDir(dir, id, relocated ? 'stored' : 'original');
      assertAllowedPath(projectionCacheFile(id), `remove the projection checkpoint of '${id}'`);
      plans.push({ sessionId: id, entry });
    }

    const purged = [];
    const failed = refused.map((id) => ({
      sessionId: id,
      message: 'not part of the current hidden-session list (the page may be stale) — reload and retry',
    }));
    for (const plan of plans) {
      try {
        const removed = await eraseOneSessionFiles(ctx, plan.sessionId, plan.entry);
        const final = await purgeOneAccount(ctx, reg, plan.sessionId);
        purged.push({ sessionId: plan.sessionId, removed, final });
      } catch (error) {
        failed.push({ sessionId: plan.sessionId, message: String((error != null && error.message) || error) });
      }
    }

    // Index bookkeeping: finished sessions lose their entry; anything that
    // could not be fully cleaned (context still attached) becomes a tombstone
    // so the recycle bin never advertises a restorable row whose files are gone.
    const now = new Date().toISOString();
    const current = await readTrashEntries();
    const byId = new Map(current.map((entry) => [entry.sessionId, entry]));
    for (const item of purged) {
      if (item.final) {
        byId.delete(item.sessionId);
      } else {
        const existing = byId.get(item.sessionId);
        byId.set(
          item.sessionId,
          existing != null
            ? { ...existing, purged: true, purgedAt: now }
            : { sessionId: item.sessionId, title: null, deletedAt: now, purged: true, purgedAt: now },
        );
      }
    }
    await writeTrashEntries([...byId.values()]);

    return { purged: purged.map((item) => item.sessionId), count: purged.length, refused, failed };
  });
}

/** Archived sessions (for the Settings viewer); trashed ones are excluded (they live in the recycle bin view). */
async function archivedList(ctx) {
  const reg = registry(ctx);
  const archivedNow = reg.archivedSessionIds.map(String);
  const trashedIds = new Set((await readTrashEntries()).map((entry) => entry.sessionId));
  const visibleArchived = archivedNow.filter((sessionId) => !trashedIds.has(sessionId));
  const titles = await sessionTitles(ctx, visibleArchived);
  const running = new Set(runningSessionIds(ctx));
  const rows = visibleArchived.map((sessionId) => {
    const holder = [...reg.entities.values()].find(
      (entity) => entity != null && entity.record != null && Array.isArray(entity.record.sessionIds) && entity.record.sessionIds.includes(sessionId),
    );
    return {
      sessionId,
      title: titles.get(sessionId) ?? null,
      running: running.has(sessionId),
      workspace_title: holder != null ? holder.record.title : null,
      workspace_id: holder != null ? holder.id : null,
    };
  });
  return { entries: rows, count: rows.length };
}

/** Un-archive one session. */
async function archivedRestore(ctx, sessionId) {
  checkSessionId(sessionId);
  const reg = registry(ctx);
  const archivedNow = reg.archivedSessionIds.map(String);
  if (!archivedNow.includes(sessionId)) {
    let known = false;
    try {
      known = await reg.sessionKnown(sessionId);
    } catch {
      known = false;
    }
    if (!known) {
      throw new ApiError(
        404,
        'UNKNOWN_SESSION',
        `unknown session '${sessionId}': it is neither archived nor present in session persistence.`,
      );
    }
    return { session_id: sessionId, restored: false, message: 'the session is not archived.' };
  }
  await reg.enqueueOperation(async () => {
    const state = reg.requireState();
    if (!state.archivedSessionIds.includes(sessionId)) return;
    await reg.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
    });
  });
  return { session_id: sessionId, restored: true };
}

/* ------------------------------------------------------------- webServer API */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('request body is not valid JSON');
    error.status = 400;
    throw error;
  }
}

async function handleApiRequest(ctx, req, res, subpath) {
  const method = req.method ?? 'GET';
  const queryAt = subpath.indexOf('?');
  const routePath = queryAt === -1 ? subpath : subpath.slice(0, queryAt);
  const query = queryAt === -1 ? new URLSearchParams() : new URLSearchParams(subpath.slice(queryAt + 1));
  const route = `${method} ${routePath}`;
  let result;
  switch (route) {
    case 'GET /trash/list':
      result = await withTrashLock(async () => {
        await sweepLegacyRelocation(ctx);
        const swept = await sweepPurgedTrash(ctx);
        const restorable = swept.filter((entry) => entry != null && entry.purged !== true);
        // Display live titles (projection cache first): self-heals entries
        // whose stored snapshot was captured before the title fix.
        const ids = restorable.map((entry) => entry.sessionId);
        const liveTitles = await sessionTitles(ctx, ids);
        // Mark subagent rows so the list shows which entries are derived
        // sessions (read from each trashed log's header; see subagentMarks).
        const subagents = await subagentMarks(restorable);
        const hydrated = restorable.map((entry) => {
          const mark = subagents.get(entry.sessionId);
          return {
            ...entry,
            title: liveTitles.get(entry.sessionId) ?? entry.title ?? null,
            ...(mark == null ? { isSubagent: false } : {
              isSubagent: true,
              parentSessionId: mark.parentSessionId,
              subagentLabel: mark.label,
              isCascaded: typeof entry.cascadeOf === 'string',
            }),
          };
        });
        return { entries: hydrated, count: hydrated.length };
      });
      break;
    case 'POST /trash/add': {
      const body = await readJsonBody(req);
      result = await trashAdd(ctx, body.sessionId, { cascade: body.cascade !== false });
      break;
    }
    case 'POST /trash/restore': {
      const body = await readJsonBody(req);
      result = await trashRestore(ctx, body.sessionId, { restoreChildren: body.restoreChildren !== false });
      break;
    }
    case 'POST /trash/purge': {
      const body = await readJsonBody(req);
      result = await trashPurge(ctx, body.sessionId, { includeOrphans: body.includeOrphans !== false });
      break;
    }
    case 'GET /subagents/children': {
      const sessionId = query.get('sessionId');
      result = await subagentChildren(ctx, sessionId);
      break;
    }
    case 'GET /hidden/list':
      result = await hiddenList(ctx);
      break;
    case 'POST /hidden/purge': {
      const body = await readJsonBody(req);
      result = await hiddenPurge(ctx, body.sessionIds);
      break;
    }
    case 'GET /archived/list':
      result = await archivedList(ctx);
      break;
    case 'POST /archived/restore': {
      const body = await readJsonBody(req);
      result = await archivedRestore(ctx, body.sessionId);
      break;
    }
    case 'POST /archived/delete': {
      const body = await readJsonBody(req);
      result = await trashAdd(ctx, body.sessionId, { cascade: body.cascade !== false });
      break;
    }
    default:
      sendJson(res, route.startsWith(method) ? 404 : 405, {
        ok: false,
        error: { code: 'NOT_FOUND', message: `unknown Session-Manager-GUI endpoint: ${route}` },
      });
      return;
  }
  sendJson(res, 200, { ok: true, ...result });
}

/* ------------------------------------------------------------------ apply */

export function apply(ctx) {
  // Same-origin JSON API for the browser half.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => {
          void (async () => {
            try {
              // Keep the query string: routes such as /subagents/children read
              // `sessionId` from it, and dropping it made that endpoint answer
              // INVALID_SESSION_ID for every call.
              const url = new URL(req.url != null ? req.url : '/', 'http://dsh.local');
              const subpath = (url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname) + url.search;
              await handleApiRequest(ctx, req, res, subpath);
            } catch (error) {
              const isApiError = error instanceof ApiError;
              const status = isApiError
                ? error.status
                : typeof error.status === 'number'
                  ? error.status
                  : 500;
              sendJson(res, status, {
                ok: false,
                error: {
                  code: isApiError ? error.code : status === 500 ? 'INTERNAL' : 'BAD_REQUEST',
                  message: String(error.message || error),
                  ...(isApiError && error.details !== undefined ? { details: error.details } : {}),
                },
              });
            }
          })();
        },
      }),
    'Session-Manager-GUI.webServer',
  );

  // One-shot migration: entries trashed by earlier versions kept their log
  // directories inside `$DSH_HOME/sessions`, so `@` mention candidates could
  // still find them. Relocate those directories now (best effort, idempotent).
  void withTrashLock(() => sweepLegacyRelocation(ctx)).catch(() => {});
  // One-shot repair: retire agents whose session context is already gone (left
  // behind by a delete from an earlier build). Such an agent blocks a healthy
  // resume of its session, so the session could never be used again.
  void withTrashLock(() => sweepZombieAgents(ctx)).catch(() => {});
}

export default { name, inject, apply };

/**
 * Internal test hooks. Not part of the plugin API and never used by the
 * runtime: they exist so the relocation/restore/purge logic can be exercised
 * offline against a temporary DSH_HOME (see install/../开发日志.md §13).
 */
export const __internals = {
  sweepLegacyRelocation,
  sweepZombieAgents,
  retireAgentEntry,
  sweepPurgedTrash,
  trashAdd,
  trashRestore,
  trashPurge,
  hiddenList,
  hiddenPurge,
  subagentChildren,
  subagentDescendantIds,
  listSessionHeaders,
  assertAllowedPath,
  handleApiRequest,
};
