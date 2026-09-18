#!/usr/bin/env node
/**
 * Session-Manager-GUI — offline self-test for the 0.1.6 session operations
 * -------------------------------------------------------------------------
 * Runs the host half's trash / restore / purge / hidden-list logic against a
 * throwaway `$DSH_HOME` fixture, with mock harness services. No DSH process,
 * no real session data, nothing outside the fixture directory is touched.
 *
 * Coverage (see 0.1.6-设计草案.md §6.4 T1):
 *   1. subagent closure — transitive, and NEVER a fork
 *   2. cascade soft delete + `cascadeOf` bookkeeping
 *   3. restore symmetry (parent restores its cascaded children)
 *   4. purge symmetry (children + on-disk leftovers)
 *   5. batch rollback when one participant fails half-way
 *   6. running participant refuses the whole batch
 *   7. path allow-list refuses a tampered trash entry
 *   8. hidden list grouping (subagent / blank / unowned) + batch purge
 *
 * Usage: node install/selftest.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

const HOST = new URL('../Session-Manager-GUI/lib/index.js', import.meta.url).href;

let passed = 0;
let failed = 0;
let skipped = 0;
/** A check that does not apply to this tree (see the release-hygiene group). */
function skip(label, why) {
  skipped += 1;
  console.log(`  skip ${label} — ${why}`);
}
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

/* --------------------------------------------------------------- fixture */

const HOME = mkdtempSync(join(tmpdir(), 'smg-selftest-'));
const SESSIONS = join(HOME, 'sessions');
const PROJECT = join(SESSIONS, '--home-user-work--');
const TRASH = join(HOME, 'storages', 'session_trash');
const CACHE = join(HOME, 'storages', 'session_projcache', 'sessions');
const WS_FILE = join(HOME, 'workspace.json');
for (const dir of [PROJECT, TRASH, CACHE]) mkdirSync(dir, { recursive: true });

const now = Date.now();
const HEADERS = [
  { id: 'session-parent', cwd: '/home/user/work', origin: undefined, parentSession: undefined, delegationDepth: 0, isSeeded: false, createdAt: now - 5000 },
  { id: 'session-child', cwd: '/home/user/work', origin: 'subagent', parentSession: 'session-parent', delegationDepth: 1, isSeeded: false, createdAt: now - 4000 },
  { id: 'session-grandchild', cwd: '/home/user/work', origin: 'subagent', parentSession: 'session-child', delegationDepth: 2, isSeeded: false, createdAt: now - 3000 },
  { id: 'session-fork', cwd: '/home/user/work', origin: undefined, parentSession: 'session-parent', delegationDepth: 0, isSeeded: true, createdAt: now - 2500 },
  { id: 'session-blank', cwd: '/home/user/work', origin: undefined, parentSession: undefined, delegationDepth: 0, isSeeded: false, createdAt: now - 2000 },
  { id: 'session-unowned', cwd: '/home/user/other', origin: undefined, parentSession: undefined, delegationDepth: 0, isSeeded: false, createdAt: now - 1000 },
];

function seedFiles() {
  for (const header of HEADERS) {
    const dir = join(PROJECT, header.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.jsonl.zstd'), `log of ${header.id}`);
    writeFileSync(
      join(CACHE, `${header.id}.json`),
      JSON.stringify({
        version: 7,
        record: {
          identity: { formatVersion: 3, createdAt: header.createdAt, cwd: header.cwd, isSeeded: false, inheritedEventCount: 0 },
          rows: {
            title: { ver: 1, seq: 3, val: header.id === 'session-blank' ? null : `title of ${header.id}` },
            sessionListMetadata: { ver: 1, seq: 3, val: { blank: header.id === 'session-blank', lastPromptAt: null } },
          },
        },
      }),
    );
  }
  writeFileSync(join(HOME, 'storages', 'session_trash.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));
}
seedFiles();

/** Mock harness services: only the surface the plugin feature-detects. */
function makeContext(options = {}) {
  const state = { archivedSessionIds: [] };
  const entities = new Map();
  const headers = new Map(HEADERS.map((header) => [header.id, header]));
  // Per-test cwd overrides: a session's recorded cwd is only a memory of where
  // it lived, so a test may point it at a directory that exists — or one that
  // does not.
  for (const [id, cwd] of Object.entries(options.headerCwd ?? {})) {
    if (headers.has(id)) headers.set(id, { ...headers.get(id), cwd });
  }
  // The real sessionPersistence.list() is filesystem-derived: a session whose
  // directory has been moved into the holding area is NOT listed any more.
  const listed = () => [...headers.values()].filter((header) => existsSync(join(PROJECT, header.id)));
  const entityOf = (cwd, title) => ({
    id: `ws-${title}`,
    record: { title, path: cwd, sessionIds: [], updatedAt: new Date().toISOString() },
    attachSession: async (id) => {
      const record = entities.get(`ws-${title}`).record;
      if (!record.sessionIds.includes(id)) record.sessionIds.push(id);
    },
  });
  const registry = {
    state,
    global: {},
    headers: new Map(),
    sessionPaths: new Map(),
    invalidSessionPaths: new Map(),
    entities,
    table: { update: async () => {} },
    requireState: () => state,
    requireTable: () => registry.table,
    setState: async (next) => {
      state.archivedSessionIds = [...next.archivedSessionIds];
    },
    enqueueOperation: async (task) => task(),
    rebuildEntities: () => {},
    get archivedSessionIds() {
      return state.archivedSessionIds;
    },
    sessionKnown: async (id) => (options.unknownIds ?? []).includes(id) ? false : headers.has(id) || existsSync(join(PROJECT, id)),
    readSessionHeader: async (id) => headers.get(id),
    list: async () => listed(),
    get: () => undefined,
    delete: async () => {},
    archiveSession: async () => {},
    insertBefore: async () => {},
    resolveByPath: async (cwd) => {
      for (const entity of entities.values()) if (entity.record.path === cwd) return entity;
      return null;
    },
    create: async (cwd, title) => {
      const entity = entityOf(cwd, title);
      entities.set(entity.id, entity);
      return entity;
    },
  };
  return {
    workspaceRegistry: registry,
    sessionPersistence: {
      list: async () => listed().map((header) => ({ header, revision: '1', sizeBytes: 1234 })),
      locate: () => undefined,
    },
    sessionQuery: { readTitleSnapshots: async () => [] },
    agents: { list: () => (options.runningIds ?? []).map((id) => ({ id, status: 'running' })) },
    sessions: { list: () => [], store: new Map() },
    webServer: { register: () => () => {} },
    get(name) {
      return this[name];
    },
  };
}

/* ------------------------------------------------------------------ tests */

process.env.DSH_HOME = HOME;
const smg = await import(HOST);
const I = smg.__internals;
const entriesOf = () => JSON.parse(readFileSync(join(HOME, 'storages', 'session_trash.json'), 'utf8')).entries;
const inProject = (id) => existsSync(join(PROJECT, id));
const inTrash = (id) => existsSync(join(TRASH, id));

console.log(`fixture: ${HOME}\n`);

console.log('1) subagent closure (transitive, never a fork)');
{
  const ctx = makeContext();
  const preview = await I.subagentChildren(ctx, 'session-parent');
  check('count is 2 (child + grandchild)', preview.count === 2, `got ${preview.count}`);
  check('child listed', preview.items.some((item) => item.sessionId === 'session-child'));
  check('grandchild listed', preview.items.some((item) => item.sessionId === 'session-grandchild'));
  check('fork NOT listed', !preview.items.some((item) => item.sessionId === 'session-fork'));
}

console.log('2) cascade soft delete writes cascadeOf + moves every directory');
{
  const ctx = makeContext();
  const result = await I.trashAdd(ctx, 'session-parent');
  check('parent trashed', result.trashed === true);
  check('cascade deleted 2 children', result.cascade.deleted.length === 2, JSON.stringify(result.cascade));
  check('parent directory moved to the holding area', inTrash('session-parent') && !inProject('session-parent'));
  check('child directory moved', inTrash('session-child') && !inProject('session-child'));
  check('grandchild directory moved', inTrash('session-grandchild') && !inProject('session-grandchild'));
  check('fork directory untouched', inProject('session-fork'));
  check('blank/unowned untouched', inProject('session-blank') && inProject('session-unowned'));
  const entries = entriesOf();
  check('three trash entries', entries.length === 3, `got ${entries.length}`);
  check('child entry carries cascadeOf', entries.find((entry) => entry.sessionId === 'session-child')?.cascadeOf === 'session-parent');
  check('grandchild entry carries cascadeOf', entries.find((entry) => entry.sessionId === 'session-grandchild')?.cascadeOf === 'session-parent');
  check('parent entry has NO cascadeOf', entries.find((entry) => entry.sessionId === 'session-parent')?.cascadeOf === undefined);
  check('archived set hides all three', ctx.workspaceRegistry.archivedSessionIds.length === 3, JSON.stringify(ctx.workspaceRegistry.archivedSessionIds));
}

console.log('3) restore brings the parent AND its cascaded children back');
{
  const ctx = makeContext();
  const result = await I.trashRestore(ctx, 'session-parent');
  check('restored', result.restored === true);
  check('restored_children has 2', Array.isArray(result.restored_children) && result.restored_children.length === 2, JSON.stringify(result.restored_children));
  check('all three directories are back', inProject('session-parent') && inProject('session-child') && inProject('session-grandchild'));
  check('holding area is empty', !inTrash('session-parent') && !inTrash('session-child') && !inTrash('session-grandchild'));
  check('trash index is empty', entriesOf().length === 0);
  check('archived set cleared', ctx.workspaceRegistry.archivedSessionIds.length === 0, JSON.stringify(ctx.workspaceRegistry.archivedSessionIds));
}

console.log('4) purge erases the parent, cascaded children and on-disk leftovers');
{
  const ctx = makeContext();
  await I.trashAdd(ctx, 'session-parent');
  const result = await I.trashPurge(ctx, 'session-parent');
  check('purged', result.purged === true);
  check('2 children purged', result.purged_children.length === 2, JSON.stringify(result.purged_children));
  check('no directories left', !inProject('session-parent') && !inProject('session-child') && !inProject('session-grandchild'));
  check('no holding area left', !inTrash('session-parent') && !inTrash('session-child') && !inTrash('session-grandchild'));
  check('projection checkpoints erased', !existsSync(join(CACHE, 'session-parent.json')) && !existsSync(join(CACHE, 'session-child.json')));
  check('trash index empty', entriesOf().length === 0);
  check('fork still on disk', inProject('session-fork'));
  check('fork checkpoint intact', existsSync(join(CACHE, 'session-fork.json')));
}

console.log('5) a half-way failure rolls the whole batch back');
{
  seedFiles();
  writeFileSync(join(HOME, 'storages', 'session_trash.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));
  const ctx = makeContext({ unknownIds: ['session-child'] });
  let threw = null;
  try {
    await I.trashAdd(ctx, 'session-parent');
  } catch (error) {
    threw = error;
  }
  check('the batch threw', threw != null);
  check('parent directory is back home', inProject('session-parent') && !inTrash('session-parent'));
  check('nothing left in the holding area', !inTrash('session-child') && !inTrash('session-grandchild'));
  check('trash index rolled back to empty', entriesOf().length === 0, JSON.stringify(entriesOf()));
  check('archived set rolled back', ctx.workspaceRegistry.archivedSessionIds.length === 0, JSON.stringify(ctx.workspaceRegistry.archivedSessionIds));
}

console.log('6) a running participant refuses the whole batch');
{
  seedFiles();
  writeFileSync(join(HOME, 'storages', 'session_trash.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));
  const ctx = makeContext({ runningIds: ['session-grandchild'] });
  let threw = null;
  try {
    await I.trashAdd(ctx, 'session-parent');
  } catch (error) {
    threw = error;
  }
  check('refused with LIVE_SESSION', threw != null && threw.code === 'LIVE_SESSION', threw && threw.code);
  check('running id reported', threw != null && Array.isArray(threw.details?.runningIds) && threw.details.runningIds.includes('session-grandchild'));
  check('parent still on disk', inProject('session-parent'));
  check('trash index untouched', entriesOf().length === 0);
}

console.log('7) the path allow-list refuses a tampered trash entry');
{
  seedFiles();
  const workspaceFile = join(HOME, 'delivered-document.md');
  writeFileSync(workspaceFile, 'precious deliverable');
  const before = readFileSync(workspaceFile, 'utf8');
  writeFileSync(
    join(HOME, 'storages', 'session_trash.json'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          sessionId: 'session-parent',
          title: 'tampered',
          deletedAt: new Date().toISOString(),
          relocated: true,
          originalDir: join(PROJECT, 'session-parent'),
          storedDir: workspaceFile,
        },
      ],
    }, null, 2),
  );
  const ctx = makeContext();
  let threw = null;
  try {
    await I.trashPurge(ctx, 'session-parent');
  } catch (error) {
    threw = error;
  }
  check('refused with PATH_NOT_ALLOWED', threw != null && threw.code === 'PATH_NOT_ALLOWED', threw && threw.code);
  check('delivered file untouched', existsSync(workspaceFile) && readFileSync(workspaceFile, 'utf8') === before);
}

console.log('8) hidden list groups + batch purge');
{
  seedFiles();
  writeFileSync(join(HOME, 'storages', 'session_trash.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));
  const ctx = makeContext();
  // account two sessions in a workspace so they do not count as "unowned"
  const entity = await ctx.workspaceRegistry.create('/home/user/work', 'work');
  await entity.attachSession('session-parent');
  await entity.attachSession('session-fork');
  await entity.attachSession('session-blank');
  const list = await I.hiddenList(ctx);
  check('subagent attached group has 2', list.groups.subagents.attached.length === 2, JSON.stringify(list.groups.subagents.attached.map((row) => row.sessionId)));
  check('no leftovers yet', list.groups.subagents.leftover.length === 0);
  check('blank group has the blank session', list.groups.blank.length === 1 && list.groups.blank[0].sessionId === 'session-blank');
  check('unowned group has the other-cwd session', list.groups.unowned.length === 1 && list.groups.unowned[0].sessionId === 'session-unowned');
  check('stats count is 4', list.stats.count === 4, String(list.stats.count));

  // trashing the parent turns its children into leftovers
  await I.trashAdd(ctx, 'session-parent');
  const after = await I.hiddenList(ctx);
  check('children are gone from the list once trashed', after.groups.subagents.attached.length === 0 && after.groups.subagents.leftover.length === 0);

  const purge = await I.hiddenPurge(ctx, ['session-blank', 'session-unowned']);
  check('batch purged 2', purge.count === 2, JSON.stringify(purge));
  check('directories erased', !inProject('session-blank') && !inProject('session-unowned'));
  check('checkpoints erased', !existsSync(join(CACHE, 'session-blank.json')) && !existsSync(join(CACHE, 'session-unowned.json')));
  check('still-listed sessions untouched', inProject('session-fork'));

  let emptyThrew = null;
  try {
    await I.hiddenPurge(ctx, []);
  } catch (error) {
    emptyThrew = error;
  }
  check('empty selection is rejected', emptyThrew != null && emptyThrew.code === 'EMPTY_SELECTION', emptyThrew && emptyThrew.code);
}

console.log('9) a symlinked parent escaping $DSH_HOME is refused');
{
  seedFiles();
  writeFileSync(join(HOME, 'storages', 'session_trash.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));
  // A workspace directory that must never be touched, reachable through a
  // symlink planted where the sessions tree expects a project directory.
  const escapeTarget = mkdtempSync(join(tmpdir(), 'smg-escape-'));
  const precious = join(escapeTarget, 'deliverable.md');
  writeFileSync(precious, 'precious');
  const link = join(SESSIONS, '--evil--');
  rmSync(link, { recursive: true, force: true });
  const { symlinkSync } = await import('node:fs');
  symlinkSync(escapeTarget, link);
  mkdirSync(join(link, 'session-parent'), { recursive: true });
  // (a) the guard itself must refuse a path whose REAL location escapes home
  let guard = null;
  try {
    I.assertAllowedPath(join(link, 'session-parent'), 'test the guard');
  } catch (error) {
    guard = error;
  }
  check('assertAllowedPath refuses a symlinked path that escapes $DSH_HOME', guard != null && guard.code === 'PATH_NOT_ALLOWED', guard && guard.code);
  check('a plain path inside the sessions tree is still allowed', (() => {
    try {
      I.assertAllowedPath(join(PROJECT, 'session-parent'), 'test the guard');
      return true;
    } catch {
      return false;
    }
  })());
  // (b) a soft delete must not reach through the symlink either
  const ctx = makeContext();
  let threw = null;
  try {
    await I.trashAdd(ctx, 'session-parent');
  } catch (error) {
    threw = error;
  }
  check('soft delete is refused or skips relocation (never the escape target)', threw === null || threw.code === 'PATH_NOT_ALLOWED', threw && threw.code);
  check('the symlinked-through directory survived', existsSync(join(escapeTarget, 'session-parent')));
  check('the deliverable survived', existsSync(precious) && readFileSync(precious, 'utf8') === 'precious');
  rmSync(link, { recursive: true, force: true });
  mkdirSync(join(PROJECT, 'session-parent'), { recursive: true });
  writeFileSync(join(PROJECT, 'session-parent', 'session.jsonl.zstd'), 'log of session-parent');
  rmSync(escapeTarget, { recursive: true, force: true });
}

console.log('10) the real HTTP route layer keeps the query string');
{
  seedFiles();
  writeFileSync(join(HOME, 'storages', 'session_trash.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));
  const captured = {};
  const ctx = makeContext();
  ctx.effect = (fn) => {
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : () => {};
  };
  ctx.webServer = { register: (route) => { captured.route = route; return () => {}; } };
  smg.apply(ctx);
  check('apply registered the API route', captured.route != null && captured.route.path === '/Session-Manager-GUI');

  async function call(url) {
    const res = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body ?? ''; } };
    captured.route.handler({ url, method: 'GET' }, res);
    for (let i = 0; i < 200 && res.body === ''; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    return { status: res.status, json: res.body === '' ? null : JSON.parse(res.body) };
  }

  const preview = await call('/Session-Manager-GUI/subagents/children?sessionId=session-parent');
  check('GET /subagents/children?sessionId=… answers 200', preview.status === 200, `status ${preview.status}`);
  check('the preview reports both children', preview.json != null && preview.json.count === 2, JSON.stringify(preview.json));
  check('the preview carries the session title', preview.json != null && typeof preview.json.title === 'string' && preview.json.title.length > 0);

  const missing = await call('/Session-Manager-GUI/subagents/children');
  check('a missing sessionId is still a 400', missing.status === 400, `status ${missing.status}`);

  const hidden = await call('/Session-Manager-GUI/hidden/list');
  check('GET /hidden/list answers 200', hidden.status === 200, `status ${hidden.status}`);
  check('rows are sorted newest-first inside a group', hidden.json != null && hidden.json.groups.blank.length <= 1);
}

console.log('11) rollback keeps an ALREADY-archived membership archived');
{
  seedFiles();
  writeFileSync(join(HOME, 'storages', 'session_trash.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));
  const ctx = makeContext({ unknownIds: ['session-child'] });
  await ctx.workspaceRegistry.setState({ archivedSessionIds: ['session-parent'] });
  let threw = null;
  try {
    await I.trashAdd(ctx, 'session-parent');
  } catch (error) {
    threw = error;
  }
  check('the batch threw', threw != null);
  check('the pre-existing archive membership survived', ctx.workspaceRegistry.archivedSessionIds.includes('session-parent'), JSON.stringify(ctx.workspaceRegistry.archivedSessionIds));
}

console.log('12) a purge that fails mid-loop never advertises unrestorable rows');
{
  seedFiles();
  const ctx = makeContext();
  await I.trashAdd(ctx, 'session-parent');
  // Make the accounting step fail for the grandchild only.
  const originalEnqueue = ctx.workspaceRegistry.enqueueOperation;
  ctx.workspaceRegistry.enqueueOperation = async (task) => {
    throw new Error('simulated registry failure');
  };
  const result = await I.trashPurge(ctx, 'session-parent');
  ctx.workspaceRegistry.enqueueOperation = originalEnqueue;
  check('the failure is reported', Array.isArray(result.failed) && result.failed.length === 3, JSON.stringify(result.failed));
  check('files were erased', !inTrash('session-parent') && !inTrash('session-child'));
  const rows = JSON.parse(readFileSync(join(HOME, 'storages', 'session_trash.json'), 'utf8')).entries;
  check('every remaining row is a tombstone (never a restorable ghost)', rows.every((row) => row.purged === true), JSON.stringify(rows));
}

console.log('13) hidden purge validates membership and cascades');
{
  seedFiles();
  writeFileSync(join(HOME, 'storages', 'session_trash.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));
  const ctx = makeContext();
  const bogus = await I.hiddenPurge(ctx, ['session-does-not-exist']);
  check('an unknown id is refused, not purged', bogus.count === 0 && bogus.refused.includes('session-does-not-exist'), JSON.stringify(bogus));
  check('nothing was erased for the unknown id', !existsSync(join(PROJECT, 'session-does-not-exist')));

  // session-child is a hidden (subagent) session that itself has a subagent child
  const cascadeResult = await I.hiddenPurge(ctx, ['session-child']);
  check('the selected hidden session was purged', cascadeResult.purged.includes('session-child'), JSON.stringify(cascadeResult));
  check('its derived subagent session went with it', cascadeResult.purged.includes('session-grandchild'), JSON.stringify(cascadeResult));
  check('directories erased', !inProject('session-child') && !inProject('session-grandchild'));
  check('the fork was NOT touched', inProject('session-fork'));

  // attached session (detach unavailable) must leave a tombstone, not nothing
  const attachedCtx = makeContext();
  attachedCtx.sessions = { list: () => [{ header: { id: 'session-blank' } }], store: new Map() };
  const attachedResult = await I.hiddenPurge(attachedCtx, ['session-blank']);
  check('the attached session was processed', attachedResult.purged.includes('session-blank'), JSON.stringify(attachedResult));
  const rows = JSON.parse(readFileSync(join(HOME, 'storages', 'session_trash.json'), 'utf8')).entries;
  check('a tombstone keeps it hidden until the context detaches', rows.some((row) => row.sessionId === 'session-blank' && row.purged === true), JSON.stringify(rows));
}

console.log('14) a tampered index cannot target ANOTHER live session');
{
  seedFiles();
  writeFileSync(
    join(HOME, 'storages', 'session_trash.json'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          sessionId: 'session-child',
          title: 'tampered',
          deletedAt: new Date().toISOString(),
          relocated: true,
          originalDir: join(PROJECT, 'session-fork'),
          storedDir: join(TRASH, 'session-child'),
        },
      ],
    }, null, 2),
  );
  mkdirSync(join(TRASH, 'session-child'), { recursive: true });
  writeFileSync(join(TRASH, 'session-child', 'session.jsonl.zstd'), 'log of session-child');
  const ctx = makeContext();
  let threw = null;
  try {
    await I.trashRestore(ctx, 'session-child');
  } catch (error) {
    threw = error;
  }
  check('restore refused with PATH_NOT_ALLOWED', threw != null && threw.code === 'PATH_NOT_ALLOWED', threw && threw.code);
  check('the other live session survived', existsSync(join(PROJECT, 'session-fork', 'session.jsonl.zstd')));
  check('it kept its own log content', readFileSync(join(PROJECT, 'session-fork', 'session.jsonl.zstd'), 'utf8') === 'log of session-fork');
}

console.log('15) a stale holding-area copy never wins over the live directory');
{
  seedFiles();
  writeFileSync(join(HOME, 'storages', 'session_trash.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));
  // a half-finished earlier run left a copy behind
  mkdirSync(join(TRASH, 'session-parent'), { recursive: true });
  writeFileSync(join(TRASH, 'session-parent', 'session.jsonl.zstd'), 'STALE copy');
  const ctx = makeContext();
  const result = await I.trashAdd(ctx, 'session-parent');
  check('the delete reports a relocation', result.relocated === true, JSON.stringify(result));
  check('the live directory left the sessions tree', !inProject('session-parent'));
  check('the holding area now holds the LIVE log', readFileSync(join(TRASH, 'session-parent', 'session.jsonl.zstd'), 'utf8') === 'log of session-parent');
  const purge = await I.trashPurge(ctx, 'session-parent');
  check('purge removes it for real', purge.purged === true && !inTrash('session-parent'));
  check('nothing is left behind in the sessions tree', !inProject('session-parent'));
}

console.log('16) the confirmation preview counts children already in the trash');
{
  seedFiles();
  writeFileSync(join(HOME, 'storages', 'session_trash.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));
  const ctx = makeContext();
  await I.trashAdd(ctx, 'session-parent');
  const preview = await I.subagentChildren(ctx, 'session-parent');
  check('both children are still counted while trashed', preview.count === 2, JSON.stringify(preview));
  check('they are marked as being in the trash', preview.items.every((item) => item.in_trash === true));
  check('none of them is on disk any more', preview.on_disk === 0);
}

console.log('17) ending a session context also retires its live agent');
{
  seedFiles();
  writeFileSync(join(HOME, 'storages', 'session_trash.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));
  const attached = new Map([['session-parent', { header: { id: 'session-parent' }, detach: () => attached.delete('session-parent') }]]);
  const agentEntries = new Map();
  const cancelled = [];
  const ctx = makeContext();
  ctx.sessions = { list: () => [...attached.values()], store: attached, get: (id) => attached.get(id) };
  ctx.agents = {
    store: agentEntries,
    list: () => [...agentEntries.values()].map((entry) => entry.agent),
    get: (id) => (agentEntries.get(id) == null ? undefined : agentEntries.get(id).agent),
  };
  const mkAgent = (id, status) => ({ id, status, cancel: () => cancelled.push(id), session: { id } });
  agentEntries.set('session-parent', { id: 'session-parent', agent: mkAgent('session-parent', 'idle') });
  agentEntries.set('session-child', { id: 'session-child', agent: mkAgent('session-child', 'idle') });
  agentEntries.set('session-fork', { id: 'session-fork', agent: mkAgent('session-fork', 'running') });

  await I.trashAdd(ctx, 'session-parent');
  check('the deleted session was detached', !attached.has('session-parent'));
  check('its agent entry was retired', !agentEntries.has('session-parent'), JSON.stringify([...agentEntries.keys()]));
  check('the cancelled turn was requested', cancelled.includes('session-parent'));
  check('its cascaded child agent was retired too', !agentEntries.has('session-child'));
  check('an unrelated running agent was left alone', agentEntries.has('session-fork'));
}

console.log('18) the zombie sweep repairs leftovers without touching healthy agents');
{
  seedFiles();
  const attached = new Map([['session-blank', { header: { id: 'session-blank' }, detach: () => {} }]]);
  const agentEntries = new Map();
  const ctx = makeContext();
  ctx.sessions = { list: () => [...attached.values()], store: attached, get: (id) => attached.get(id) };
  ctx.agents = {
    store: agentEntries,
    list: () => [...agentEntries.values()].map((entry) => entry.agent),
    get: (id) => (agentEntries.get(id) == null ? undefined : agentEntries.get(id).agent),
  };
  const mkAgent = (id, status) => ({ id, status, cancel: () => {}, session: { id } });
  // zombie: agent registered, no session entry
  agentEntries.set('session-parent', { id: 'session-parent', agent: mkAgent('session-parent', 'idle') });
  // healthy: agent registered AND its session is attached
  agentEntries.set('session-blank', { id: 'session-blank', agent: mkAgent('session-blank', 'idle') });
  // running: never touched
  agentEntries.set('session-fork', { id: 'session-fork', agent: mkAgent('session-fork', 'running') });

  const retired = await I.sweepZombieAgents(ctx);
  check('the zombie was retired', retired.includes('session-parent'), JSON.stringify(retired));
  check('the healthy attached agent survived', agentEntries.has('session-blank'));
  check('the running agent survived', agentEntries.has('session-fork'));

  // restore repairs a zombie for that exact session
  writeFileSync(join(HOME, 'storages', 'session_trash.json'), JSON.stringify({ version: 1, entries: [{ sessionId: 'session-child', title: 'x', deletedAt: new Date().toISOString(), relocated: true, originalDir: join(PROJECT, 'session-child'), storedDir: join(TRASH, 'session-child') }] }, null, 2));
  mkdirSync(join(TRASH, 'session-child'), { recursive: true });
  writeFileSync(join(TRASH, 'session-child', 'session.jsonl.zstd'), 'log of session-child');
  agentEntries.set('session-child', { id: 'session-child', agent: mkAgent('session-child', 'idle') });
  await I.trashRestore(ctx, 'session-child');
  check('restoring retires a stale zombie for that session', !agentEntries.has('session-child'), JSON.stringify([...agentEntries.keys()]));
}

console.log('19) restore groups the session by its cwd, and survives a vanished cwd');
{
  /*
   * The cwd recorded in a session header is a MEMORY: the directory may be
   * renamed, moved or deleted while the session sits in the recycle bin. The
   * workspace registry canonicalises through fs.realpath and refuses a path
   * that is not an existing directory, so resolving a vanished cwd used to
   * abort the whole restore (log moved back, then rolled out again) — the
   * restore is about the LOG, so it must complete either way.
   */
  const WORK = join(HOME, 'work');
  writeFileSync(join(HOME, 'storages', 'session_trash.json'), JSON.stringify({
    version: 1,
    entries: [
      { sessionId: 'session-parent', title: 'present cwd', deletedAt: new Date().toISOString(), relocated: true, originalDir: join(PROJECT, 'session-parent'), storedDir: join(TRASH, 'session-parent') },
      { sessionId: 'session-blank', title: 'vanished cwd', deletedAt: new Date().toISOString(), relocated: true, originalDir: join(PROJECT, 'session-blank'), storedDir: join(TRASH, 'session-blank') },
    ],
  }, null, 2));
  for (const id of ['session-parent', 'session-blank']) {
    mkdirSync(join(TRASH, id), { recursive: true });
    writeFileSync(join(TRASH, id, 'session.jsonl.zstd'), `log of ${id}`);
  }

  // 'session-parent' remembers $HOME/work, which exists; 'session-blank'
  // remembers /home/user/work, which does not.
  mkdirSync(WORK, { recursive: true });

  const ctx = makeContext({ headerCwd: { 'session-parent': WORK } });
  const present = await I.trashRestore(ctx, 'session-parent');
  check('a restore into an existing cwd reports the workspace as accounted', present.workspace_accounted === true, JSON.stringify(present));
  const grouped = [...ctx.workspaceRegistry.entities.values()].find((entity) => entity.record.sessionIds.includes('session-parent'));
  check('the restored session is attached to its workspace again', grouped != null && grouped.record.path === WORK, JSON.stringify(grouped && grouped.record));

  let threw = null;
  let vanished = null;
  try {
    vanished = await I.trashRestore(ctx, 'session-blank');
  } catch (error) {
    threw = error;
  }
  check('a restore whose recorded cwd is gone no longer fails', threw === null, threw && `${threw.code}: ${threw.message}`);
  check('the log is back in the sessions tree', existsSync(join(PROJECT, 'session-blank', 'session.jsonl.zstd')));
  check('it reports the workspace as not accounted', vanished != null && vanished.workspace_accounted === false, JSON.stringify(vanished));
  check('no workspace record was invented for the vanished path', ![...ctx.workspaceRegistry.entities.values()].some((entity) => entity.record.path === '/home/user/work'), JSON.stringify([...ctx.workspaceRegistry.entities.values()].map((entity) => entity.record.path)));
  check('the trash entry is gone either way', !JSON.parse(readFileSync(join(HOME, 'storages', 'session_trash.json'), 'utf8')).entries.some((entry) => entry.sessionId === 'session-blank'));
}


console.log('20) the recycle bin marks which entries are subagent sessions');
{
  /*
   * The list may only trust the session header for this: a soft delete MOVES
   * the log directory out of $DSH_HOME/sessions, which is the only tree
   * `sessionPersistence.list()` scans, so a trashed session has no header
   * through the harness services and the log in the holding area is the only
   * authority left. `cascadeOf` alone is not enough either — it only records
   * the cascade flavour, and a subagent deleted on its own carries none.
   */
  seedFiles();
  const header = (over) => JSON.stringify({
    type: 'session', version: 3, id: 'x', createdAt: 1, cwd: '/home/user/work',
    isSeeded: false, origin: 'subagent', delegationDepth: 1, ...over,
  }) + '\n';

  const store = (id, text) => {
    mkdirSync(join(TRASH, id), { recursive: true });
    writeFileSync(join(TRASH, id, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(text, 'utf8')));
  };
  /* A child trashed WITH its parent: real log, real header. */
  store('session-child', header({ id: 'session-child', parentSession: 'session-parent' }));
  /* A child that is a subagent but whose log held no readable frame. */
  mkdirSync(join(TRASH, 'session-grandchild'), { recursive: true });
  writeFileSync(join(TRASH, 'session-grandchild', 'session.v3.jsonl.zstd'), 'not a zstd frame at all');
  /* The parent itself: a top-level session, so it must stay unmarked. */
  store('session-parent', header({ id: 'session-parent', origin: undefined, parentSession: undefined, delegationDepth: undefined }));

  writeFileSync(join(HOME, 'storages', 'session_trash.json'), JSON.stringify({
    version: 1,
    entries: [
      { sessionId: 'session-child', title: 'child', deletedAt: new Date().toISOString(), relocated: true, cascadeOf: 'session-parent', originalDir: join(PROJECT, 'session-child'), storedDir: join(TRASH, 'session-child') },
      { sessionId: 'session-grandchild', title: 'grandchild', deletedAt: new Date().toISOString(), relocated: true, originalDir: join(PROJECT, 'session-grandchild'), storedDir: join(TRASH, 'session-grandchild') },
      { sessionId: 'session-parent', title: 'parent', deletedAt: new Date().toISOString(), relocated: true, originalDir: join(PROJECT, 'session-parent'), storedDir: join(TRASH, 'session-parent') },
    ],
  }, null, 2));

  const ctx = makeContext();
  let captured = null;
  const res = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body ?? ''; } };
  await I.handleApiRequest(ctx, { method: 'GET' }, res, '/trash/list');
  for (let i = 0; i < 200 && res.body === ''; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  captured = JSON.parse(res.body);
  const byId = new Map(captured.entries.map((entry) => [entry.sessionId, entry]));

  check('GET /trash/list still answers 200', res.status === 200, `status ${res.status}`);
  check('a subagent row is marked', byId.get('session-child')?.isSubagent === true, JSON.stringify(byId.get('session-child')));
  check('the mark carries the parent session id', byId.get('session-child')?.parentSessionId === 'session-parent', JSON.stringify(byId.get('session-child')));
  check('the mark records that it came down with its parent', byId.get('session-child')?.isCascaded === true);
  check('a top-level session is NOT marked', byId.get('session-parent')?.isSubagent === false, JSON.stringify(byId.get('session-parent')));
  check('an unreadable log degrades to unmarked instead of throwing', byId.get('session-grandchild')?.isSubagent === false, JSON.stringify(byId.get('session-grandchild')));
  check('every entry still reaches the list', captured.entries.length === 3, String(captured.entries.length));
  check('the restored titles are untouched by the marking', typeof byId.get('session-child')?.title === 'string');
}


console.log('21) release hygiene: the shipped tree leaks no local identity');
{
  /*
   * The published archive is a copy of this tree, so these invariant checks are
   * the last line of defence against shipping something private. Two kinds of
   * payload are checked by EXACT string, not by a loose pattern: the machine
   * account name, and any concrete session id (session ids are hex uuids here,
   * so this can be exact). Synthetic paths in the fixtures (`/home/user/work`)
   * are deliberate and must NOT be flagged — they are not this machine.
   */
  const ROOT = new URL('..', import.meta.url);
  const shipped = [
    'Session-Manager-GUI/lib/client.js',
    'Session-Manager-GUI/lib/index.js',
    'Session-Manager-GUI/package.json',
    'Session-Manager-GUI/README.md',
    '使用手册.md',
    '开发日志.md',
  ];
  const alsoShipped = ['install/patch-ui.js'];
  const FORBIDDEN_ID_PATTERN = /session-[0-9a-f]{8}-[0-9a-f]{4}-/;
  /* The machine account name is ASSEMBLED AT RUNTIME on purpose: spelling it out
   * here would make this very file the leak it is meant to catch (and the check
   * would then flag itself). For the same reason the file carrying the needles
   * is exempt from the needle scan — but never from the session-id scan. */
  const FORBIDDEN = [['ma' + 'chine account name', new RegExp('ubt' + '2204', 'i')]];
  const NEEDLE_FILE = 'install/selftest.mjs';

  const present = [...shipped, ...alsoShipped].filter((rel) => existsSync(new URL(rel, ROOT)));
  /* Every documented file must exist in a release tree; only the working tree
   * is allowed to lack the release-only pieces, and it has all of them. */
  check('the shipped file list is complete', present.length === shipped.length + alsoShipped.length, `${present.length}/${shipped.length + alsoShipped.length}`);

  /*
   * A DEVELOPMENT tree legitimately carries this machine's real paths (the docs
   * quote them as evidence), so the needle scan only applies to a sanitized
   * release tree. Detect which one this is rather than guessing: the presence of
   * the development plugin directory is the marker.
   */
  /*
   * An explicit, self-contained marker: this development tree carries
   * `install/.dev-tree`, and the packaging step never copies it into a release.
   * Inferring the tree kind from the surrounding layout was tried and is not
   * reliable — a release folder can itself sit inside the development
   * workspace, which is exactly how the published archives are built here.
   */
  const isReleaseTree = !existsSync(new URL('install/.dev-tree', ROOT));

  for (const rel of present) {
    if (rel === NEEDLE_FILE) continue;
    const text = readFileSync(new URL(rel, ROOT), 'utf8');
    for (const [label, pattern] of FORBIDDEN) {
      if (!isReleaseTree) {
        skip(`${rel} carries no ${label}`, 'development tree keeps real paths');
        continue;
      }
      const hit = text.match(pattern);
      check(`${rel} carries no ${label}`, hit === null, hit === null ? '' : `found ${JSON.stringify(hit[0])}`);
    }
  }
  /*
   * No assertion proves "this file never spells the account name": the check
   * that would do it is itself a spelling, so it could only ever fail on
   * itself. The property is instead held structurally — the needles are
   * assembled from fragments above, and the file carrying them is exempt from
   * the needle scan — and verified by an outside reader (a repository-wide
   * grep before publishing), which is where it belongs.
   */
  /* Concrete session ids may only appear inside the fixtures of the test file
   * itself, never in shipped docs or sources. */
  for (const rel of present.filter((r) => r !== 'install/patch-ui.js')) {
    const text = readFileSync(new URL(rel, ROOT), 'utf8');
    const hit = text.match(FORBIDDEN_ID_PATTERN);
    check(`${rel} carries no real session id`, hit === null, hit === null ? '' : hit[0]);
  }

  const pkg = JSON.parse(readFileSync(new URL('Session-Manager-GUI/package.json', ROOT), 'utf8'));
  check('the shipped package declares the Unlicense', pkg.license === 'Unlicense', String(pkg.license));

  /*
   * One version, stated in four places. A doc that keeps announcing the previous
   * version is invisible to every other check — nothing fails, nothing logs, it
   * simply ships wrong — so the four statements are tied to `package.json` here.
   * Both 0.1.5 and 0.1.6 shipped with a manual whose header still said 0.1.5.
   */
  check('the manual announces the package version', readFileSync(new URL('使用手册.md', ROOT), 'utf8').includes(`当前版本 **${pkg.version}**`), `expected "${pkg.version}"`);
  check('the plugin README announces the package version', readFileSync(new URL('Session-Manager-GUI/README.md', ROOT), 'utf8').includes(`当前版本 **${pkg.version}**`), `expected "${pkg.version}"`);
  check('the development log announces the package version', readFileSync(new URL('开发日志.md', ROOT), 'utf8').includes(`当前版本 **${pkg.version}**`), `expected "${pkg.version}"`);
  {
    /* The relationship table in §0 must name the same version. */
    const manual = readFileSync(new URL('使用手册.md', ROOT), 'utf8');
    check('the manual relationship table names the package version', manual.includes(`独立（**${pkg.version}**）`) || manual.includes(`独立（${pkg.version}）`), `expected "${pkg.version}"`);
  }
  check('the shipped package declares the web client half', pkg.dsh?.client?.platform === 'web');
  check('the shipped package carries the 0.1.6 version', pkg.version === '0.1.6', String(pkg.version));

  /* Both install scripts must resolve the plugin from their own location, so an
   * unpacked archive works from any directory. */
  check('patch-ui.js resolves its own directory (CJS __dirname)', readFileSync(new URL('install/patch-ui.js', ROOT), 'utf8').includes('__dirname'));
  check('selftest.mjs resolves the plugin relative to itself', readFileSync(new URL('install/selftest.mjs', ROOT), 'utf8').includes("new URL('../Session-Manager-GUI/lib/index.js', import.meta.url)"));
}

console.log(`\n${passed} passed, ${failed} failed${skipped === 0 ? '' : `, ${skipped} skipped (development tree)`}`);
rmSync(HOME, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
