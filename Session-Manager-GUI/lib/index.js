/**
 * Session-Manager-GUI — DeepSeek Harness host half (web profile)
 * --------------------------------------------------------------
 * An independent plugin (own version line 0.1.x) that provides the WebUI
 * session-management surfaces:
 *   a) a session recycle bin ("trash"): delete-to-trash / restore /
 *      purge, persisted in $DSH_HOME/storages/session_trash.json;
 *   b) read-only helpers for the archived-session viewer;
 *   c) a same-origin JSON API under the webServer prefix
 *      "/Session-Manager-GUI" consumed by the browser half (lib/client.js):
 *
 *        GET  /Session-Manager-GUI/trash/list        -> trash entries
 *        POST /Session-Manager-GUI/trash/add         { sessionId }
 *        POST /Session-Manager-GUI/trash/restore     { sessionId }
 *        POST /Session-Manager-GUI/trash/purge       { sessionId }
 *        GET  /Session-Manager-GUI/archived/list     -> archived entries
 *        POST /Session-Manager-GUI/archived/restore  { sessionId }
 *        POST /Session-Manager-GUI/archived/delete   { sessionId } (alias of trash/add)
 *
 * This is an independent plugin that focuses on WebUI session management
 * functionality. It provides visual session management surfaces without
 * registering chat-facing tools, maintaining compatibility with other
 * plugins. The trash/archive operations reuse workspace-registry mechanics.
 *
 * Target runtime: DeepSeek Harness 0.1.2-rc.1 web profile. Referenced by a
 * loader row whose name is the package name "Session-Manager-GUI" (the
 * package must live in a node_modules directory of the profile resolution
 * chain). The browser half is discovered through package.json "dsh.client"
 * + exports["./client"].
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const name = 'Session-Manager-GUI';

/** Hard dependencies (web profile services). Optional ones are ctx.get()-ed. */
export const inject = ['workspaceRegistry', 'sessionPersistence', 'webServer'];

const SUPPORT_NOTE =
  'Session-Manager-GUI targets DeepSeek Harness 0.1.2-rc.1 (web profile, dsh-workspace registry layout). If you upgraded the harness, re-check the registry access helpers before use.';

/** Session ids look like `session-<uuid>`; this also keeps ids safe as file names. */
const SESSION_ID_PATTERN = /^session-[A-Za-z0-9._-]+$/;

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

/* ------------------------------------------------------------------ helpers */

function checkSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new ApiError(
      400,
      'INVALID_SESSION_ID',
      `invalid session id: ${JSON.stringify(sessionId)}. Expected "session-…".`,
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
  const agents = ctx.get('agents');
  if (agents == null || typeof agents.list !== 'function') return [];
  const ids = [];
  for (const agent of agents.list()) {
    let id = undefined;
    let running = false;
    try {
      id = agent != null ? agent.id : undefined;
      running = agent != null && agent.status === 'running';
    } catch {
      running = false;
    }
    if (typeof id === 'string' && running) ids.push(id);
  }
  return ids;
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

/** Find one session header by scanning session persistence (files intact). */
async function findHeader(ctx, sessionId) {
  const headers = await ctx.sessionPersistence.list();
  for (const header of headers) {
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
  const target = trashStoreFile();
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
 * Delete-to-trash (soft delete): the session is hidden through the
 * product's own archived mechanism (the archived set removes a session
 * from EVERY grouping surface, including the "Ungrouped" bucket) while its
 * workspace slot, order and all files are kept. Restore therefore brings it
 * back at its original position, and nothing ever leaks into "Ungrouped".
 * The trash store entry carries the deletion snapshot for the recycle bin.
 */
async function trashAdd(ctx, sessionId) {
  checkSessionId(sessionId);
  const reg = registry(ctx);
  requireNotRunning(ctx, sessionId);

  return withTrashLock(async () => {
    const entries = await sweepPurgedTrash(ctx);
    if (trashEntryOf(entries, sessionId)) {
      return { session_id: sessionId, trashed: false, message: 'already in trash.' };
    }
    const archivedNow = reg.archivedSessionIds.map(String);
    const holder = [...reg.entities.values()].find(
      (entity) => entity != null && entity.record != null && Array.isArray(entity.record.sessionIds) && entity.record.sessionIds.includes(sessionId),
    );
    if (!holder && !archivedNow.includes(sessionId)) {
      let known = false;
      try {
        known = await reg.sessionKnown(sessionId);
      } catch (error) {
        throw new Error(`cannot verify session '${sessionId}': ${error.message}`);
      }
      if (!known) {
        throw new ApiError(
          404,
          'UNKNOWN_SESSION',
          `unknown session '${sessionId}' — nothing was moved to trash.`,
        );
      }
    }

    // Best-effort title snapshot for display without touching the log.
    const titleMap = await sessionTitles(ctx, [sessionId]);
    const title = titleMap.get(sessionId) ?? null;
    const deletedAt = new Date().toISOString();
    const holderInfo = holder != null
      ? {
          workspaceId: holder.id,
          workspaceTitle: holder.record.title,
          workspacePath: holder.record.path,
        }
      : { workspaceId: null, workspaceTitle: null, workspacePath: null };

    await reg.enqueueOperation(async () => {
      requireNotRunning(ctx, sessionId);
      // Soft delete = hide via the archived set. The workspace record keeps
      // the session's slot (native archive semantics), so a later restore
      // returns it to its original position; nothing moves to "Ungrouped".
      const currentArchived = reg.archivedSessionIds.map(String);
      if (!currentArchived.includes(sessionId)) {
        const state = reg.requireState();
        await reg.setState({
          ...state,
          archivedSessionIds: [...state.archivedSessionIds, sessionId],
        });
      }
    });

    const next = [
      {
        sessionId,
        title,
        deletedAt,
        workspaceId: holderInfo.workspaceId,
        workspaceTitle: holderInfo.workspaceTitle,
        workspacePath: holderInfo.workspacePath,
      },
      ...entries,
    ];
    await writeTrashEntries(next);
    return { session_id: sessionId, trashed: true, deleted_at: deletedAt, title };
  });
}

/**
 * Restore from trash: the log directory still exists, so the session is put
 * back into the workspace that owns its canonical cwd (creating the workspace
 * registration when missing). Its position becomes the top of that workspace
 * (native attach semantics); it is not re-archived (it was un-archived when
 * it was trashed).
 */
async function trashRestore(ctx, sessionId) {
  checkSessionId(sessionId);
  const reg = registry(ctx);

  return withTrashLock(async () => {
    const entries = await sweepPurgedTrash(ctx);
    const entry = trashEntryOf(entries, sessionId);
    if (!entry) {
      throw new ApiError(404, 'NOT_IN_TRASH', `session '${sessionId}' is not in the trash.`);
    }
    if (entry.purged === true) {
      throw new ApiError(410, 'ALREADY_PURGED', `session '${sessionId}' was already permanently deleted.`);
    }
    const header = await findHeader(ctx, sessionId);
    if (header == null || typeof header.cwd !== 'string') {
      throw new ApiError(
        404,
        'LOG_MISSING',
        `cannot restore session '${sessionId}': its session log directory no longer exists. Only purging is possible.`,
      );
    }

    await reg.enqueueOperation(async () => {
      requireNotRunning(ctx, sessionId);
      const cwd = header.cwd;
      let entity = await reg.resolveByPath(cwd);
      if (entity == null) {
        const { basename } = await import('node:path');
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
      const archivedNow = reg.archivedSessionIds.map(String);
      if (archivedNow.includes(sessionId)) {
        const state = reg.requireState();
        await reg.setState({
          ...state,
          archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
        });
      }
    });

    await writeTrashEntries(entries.filter((candidate) => candidate.sessionId !== sessionId));
    return { session_id: sessionId, restored: true, workspace_title: entry.workspaceTitle ?? null };
  });
}

/** Permanently erase a trashed session (accounting, archived set, log directory, projection cache, trash entry). */
async function trashPurge(ctx, sessionId) {
  checkSessionId(sessionId);
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

    // 1) Erase files unconditionally.
    const header = await findHeader(ctx, sessionId);
    const removed = { log_dir: null, projection_cache: null };
    if (header != null && typeof header.cwd === 'string' && typeof ctx.sessionPersistence.locate === 'function') {
      try {
        const location = ctx.sessionPersistence.locate(header);
        if (location != null && typeof location.path === 'string' && location.path.length > 0) {
          const sessionDir = dirname(location.path);
          await rm(sessionDir, { recursive: true, force: true });
          removed.log_dir = sessionDir;
        }
      } catch {
        removed.log_dir = null;
      }
    }
    try {
      await rm(projectionCacheFile(sessionId), { force: true });
      removed.projection_cache = projectionCacheFile(sessionId);
    } catch {
      removed.projection_cache = null;
    }

    // 2) Registry bookkeeping:
    //    - context detached  -> full accounting removal now, entry dropped;
    //    - context still attached (the product catalog would ghost the row
    //      under "Ungrouped") -> keep hidden via the archived set and mark the
    //      entry purged; sweepPurgedTrash() finishes the cleanup later.
    let final = false;
    await reg.enqueueOperation(async () => {
      requireNotRunning(ctx, sessionId);
      if (attachedSessionIds(ctx).includes(sessionId)) {
        const state = reg.requireState();
        if (!state.archivedSessionIds.includes(sessionId)) {
          await reg.setState({
            ...state,
            archivedSessionIds: [...state.archivedSessionIds, sessionId],
          });
        }
      } else {
        await removeSessionAccounting(reg, sessionId);
        final = true;
      }
    });

    if (final) {
      await writeTrashEntries(entries.filter((candidate) => candidate.sessionId !== sessionId));
    } else {
      const now = new Date().toISOString();
      await writeTrashEntries(
        entries.map((candidate) =>
          candidate.sessionId === sessionId ? { ...candidate, purged: true, purgedAt: now } : candidate,
        ),
      );
    }

    return {
      session_id: sessionId,
      purged: true,
      removed,
      final,
      message: final
        ? undefined
        : 'files erased; the session context is still open, so registry bookkeeping will be cleaned up once that context closes (a page refresh may show the row until then).',
    };
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
  const route = `${method} ${subpath}`;
  let result;
  switch (route) {
    case 'GET /trash/list':
      result = await withTrashLock(async () => {
        const swept = await sweepPurgedTrash(ctx);
        const restorable = swept.filter((entry) => entry != null && entry.purged !== true);
        // Display live titles (projection cache first): self-heals entries
        // whose stored snapshot was captured before the title fix.
        const ids = restorable.map((entry) => entry.sessionId);
        const liveTitles = await sessionTitles(ctx, ids);
        const hydrated = restorable.map((entry) => ({
          ...entry,
          title: liveTitles.get(entry.sessionId) ?? entry.title ?? null,
        }));
        return { entries: hydrated, count: hydrated.length };
      });
      break;
    case 'POST /trash/add': {
      const body = await readJsonBody(req);
      result = await trashAdd(ctx, body.sessionId);
      break;
    }
    case 'POST /trash/restore': {
      const body = await readJsonBody(req);
      result = await trashRestore(ctx, body.sessionId);
      break;
    }
    case 'POST /trash/purge': {
      const body = await readJsonBody(req);
      result = await trashPurge(ctx, body.sessionId);
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
      result = await trashAdd(ctx, body.sessionId);
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
              const pathname = req.url != null ? new URL(req.url, 'http://dsh.local').pathname : '/';
              const subpath = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname;
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
                },
              });
            }
          })();
        },
      }),
    'Session-Manager-GUI.webServer',
  );
}

export default { name, inject, apply };
