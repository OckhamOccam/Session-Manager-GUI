/*
 * Session-Manager-GUI — browser half (prebuilt client-module artifact)
 * -------------------------------------------------------------------
 * Hand-written in the exact format the client module system expects
 * (window.__ModuleLoader__.load + CommonJS-ish factory; require() may only
 * resolve platform seed ids / other loaded client modules — here only
 * "react" is used). No build step is required: the file is served as-is.
 *
 * Registers two Settings sections (session recycle bin + archived
 * session viewer) into the "settings.section" list slot, and listens
 * for the "Session-Manager-GUI:delete" window event dispatched by the
 * patched three-dot menu of the session rows (see install/patch-menu.js).
 *
 * All data flows through the same-origin JSON API of the host half
 * (lib/index.js) at "/Session-Manager-GUI".
 */
window.__ModuleLoader__.load({
  id: "Session-Manager-GUI",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useCallback = react.useCallback;

    var API_PREFIX = "/Session-Manager-GUI";
    var CSS_ID = "Session-Manager-GUI-styles";

    /* ------------------------------------------------------------ styles */

    var STYLE = [
      ".seg-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex;width:100%;box-sizing:border-box}",
      ".seg-title{margin:0;font-size:18px;font-weight:600}",
      ".seg-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}",
      ".seg-group{flex-direction:column;gap:10px;display:flex}",
      ".seg-group + .seg-group{margin-top:20px}",
      ".seg-groupHead{letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:12px;font-weight:600}",
      ".seg-status{color:var(--dsw-alias-label-tertiary);font-size:13px;margin:0}",
      ".seg-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}",
      ".seg-row{border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;display:flex;align-items:center;gap:12px;padding:10px 14px}",
      ".seg-rowTitle{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".seg-rowMeta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}",
      ".seg-actions{display:flex;align-items:center;gap:8px;margin-left:auto;flex:none;justify-content:flex-end}",
      "button.seg-btn{border:.5px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 14px;font-size:13px;cursor:pointer;line-height:1.4}",
      "button.seg-btn:hover{border-color:var(--dsw-alias-label-tertiary)}",
      "button.seg-btn:disabled{opacity:.55;cursor:default}",
      "button.seg-btn.seg-danger{color:#e5484d}",
      "button.seg-btn.seg-danger:hover{border-color:#e5484d}",
      "button.seg-btn.seg-primary{border-color:var(--dsw-alias-label-tertiary)}",
      ".seg-toast{position:fixed;top:18px;right:18px;z-index:2147483000;max-width:420px;border-radius:10px;padding:10px 14px;font-size:13px;line-height:1.5;box-shadow:0 6px 24px rgba(0,0,0,.18)}",
      ".seg-toast-ok{color:#fff;background:rgba(46,125,50,.94)}",
      ".seg-toast-err{color:#fff;background:rgba(185,28,28,.94)}",
      ".seg-modal-mask{position:fixed;inset:0;z-index:2147483200;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;padding:24px}",
      ".seg-modal{width:100%;max-width:420px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:14px;padding:20px 22px 16px;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-l1,#fff));color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px rgba(0,0,0,.24)}",
      ".seg-modal-text{margin:0 0 18px;font-size:14px;line-height:1.7}",
      ".seg-danger-bold{color:#FF0000;font-weight:700}",
      ".seg-modal-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px}",
      ".seg-modal-note{margin:0 0 14px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.7}",
      ".seg-modal-list{margin:0 0 16px;padding-left:20px;max-height:220px;overflow:auto;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.7}",
      ".seg-rowMain{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".seg-rowSub{color:var(--dsw-alias-label-tertiary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".seg-groupHeadRow{display:flex;align-items:center;gap:10px;margin:0 0 4px}",
      ".seg-groupHeadRow .seg-groupHead{flex:1 1 auto;margin:0}",
      /* Subagent marker on a recycle-bin row: an icon chip in front of the
       * title. Sized and coloured after the shipped row chrome, so it reads as
       * part of the list rather than as a decoration bolted on. */
      ".seg-subBadge{flex:none;display:inline-flex;align-items:center;gap:4px;padding:1px 7px 1px 5px;border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;color:var(--dsw-alias-label-secondary);background:transparent;font-size:12px;line-height:18px;white-space:nowrap}",
      ".seg-subBadge svg{display:block;flex:none}",
      "li.seg-row.is-subagent .seg-rowTitle{color:var(--dsw-alias-label-secondary)}"
    ].join("\n");

    function ensureCss() {
      if (typeof document === "undefined") return;
      if (document.getElementById(CSS_ID)) return;
      var style = document.createElement("style");
      style.id = CSS_ID;
      style.textContent = STYLE;
      var head = document.head || document.documentElement;
      if (head) head.appendChild(style);
    }

    /* --------------------------------------------------------------- api */

    async function parseResponse(response) {
      var data = null;
      try {
        data = await response.json();
      } catch (error) {
        data = null;
      }
      if (response.ok && data && data.ok === true) return data;
      var message = "request failed";
      if (data && data.error) {
        message = data.error.message || data.error.code || message;
      } else if (response.status) {
        message = "HTTP " + response.status;
      }
      var error = new Error(message);
      error.code = data && data.error ? data.error.code : undefined;
      throw error;
    }

    function apiGet(path) {
      return globalThis.fetch(API_PREFIX + path, {
        method: "GET",
        headers: { accept: "application/json" },
      }).then(parseResponse);
    }

    function apiPost(path, payload) {
      return globalThis.fetch(API_PREFIX + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {}),
      }).then(parseResponse);
    }

    var api = {
      trashList: () => apiGet("/trash/list"),
      // cascade: a delete always takes the session's derived subagent sessions
      // with it (parent/child binding); the flag stays explicit so a caller
      // can never inherit the old single-session behaviour by accident.
      trashAdd: (sessionId, cascade) => apiPost("/trash/add", { sessionId, cascade: cascade !== false }),
      trashRestore: (sessionId, restoreChildren) => apiPost("/trash/restore", { sessionId, restoreChildren: restoreChildren !== false }),
      trashPurge: (sessionId, includeOrphans) => apiPost("/trash/purge", { sessionId, includeOrphans: includeOrphans !== false }),
      archivedList: () => apiGet("/archived/list"),
      archivedRestore: (sessionId) => apiPost("/archived/restore", { sessionId }),
      archivedDelete: (sessionId, cascade) => apiPost("/archived/delete", { sessionId, cascade: cascade !== false }),
      subagentChildren: (sessionId) => apiGet("/subagents/children?sessionId=" + encodeURIComponent(sessionId)),
      hiddenList: () => apiGet("/hidden/list"),
      hiddenPurge: (sessionIds) => apiPost("/hidden/purge", { sessionIds }),
    };

    /*
     * Catalog resync hook, installed by apply(ctx).
     *
     * The sidebar catalog (the client `sessions` service) is only pulled when
     * a connection generation starts — `sessions.refresh()` is what
     * reconnect calls internally. A host-side restore/purge changes which
     * sessions EXIST for the catalog, but emits no workspace-feed frame that
     * would re-pull it, so a restored session stayed missing from the sidebar
     * (while `@` mention candidates — a host-side listing — already saw it).
     * Calling refresh() after such operations repaints the sidebar.
     */
    var refreshSessionCatalog = null;
    /*
     * The browser session service, resolved LAZILY from the live context.
     *
     * A captured handle is what broke this feature: apply() can run before the
     * session controller publishes `sessions`, and a null capture then makes
     * every revive no-op on its first guard — silently, forever. Reading it at
     * call time (through the injected context) is immune to that ordering.
     * @returns the sessions service, or null while it is not available.
     */
    function sessionStore() {
      if (clientCtx != null && typeof clientCtx.get === "function") {
        var live = clientCtx.get("sessions");
        if (live != null) return live;
      }
      return null;
    }
    /* Root client context, captured by apply(ctx) — the live service lookup. */
    var clientCtx = null;
    /* Locale-bound copy for the menu bridge (installed by apply(ctx)). */
    var menuTranslate = null;

    /**
     * Undo the browser-side aftermath of a delete.
     *
     * The delete detaches the session on the host, which makes the browser store
     * flag its resident Session instance with the STICKY `removed` bit (the
     * product only ever initialises that bit to false). A restored session is
     * listed again, but that stale instance keeps the composer disabled —
     * “会话不可用” / submissions ignored — until the page is reloaded.
     *
     * Dropping the INSTANCE alone is not enough. Each session owns a scope
     * record (`scopes: Map<id, {fiber, ctx, binding, session}>`), and every
     * consumer resolves the session THROUGH it. The store's own prune skips the
     * record of the session on stage (`id === this.watched`) and defers it for a
     * stage move — a move that never comes when the session is restored, since
     * eligibility returns and `sweepDeferred()` drops the deferral while keeping
     * the record. The view therefore keeps rendering that surviving record,
     * whose `session` still carries `removed = true`: switching away and back
     * changes nothing. Discarding the whole scope through the store's own
     * teardown (unbindScope + scope-fiber dispose + manager.drop, exactly what
     * prune does) is what makes the next resolve() mint a fresh scope over a
     * fresh instance — `removed` is initialised false in the constructor only,
     * so a new instance is a live one, and open() backfills its history.
     *
     * Flipping the `removed` bit would be the cheaper fix, but the product tears
     * the session's event stream down with the instance, so it would leave a
     * half-dead object behind; re-materialising is the shape the product itself
     * expects. Feature-detected on purpose: an unknown store shape falls back to
     * instance-level recovery and is logged, never fatal (a manual page reload
     * remains the last resort).
     *
     * Repairing the STAGED session takes both halves — discard its scope here,
     * then materialise it again and open its history once the catalog pull lands
     * (see {@link ensureRevivedSessionsOpen}, which explains why the discard
     * alone left the composer disabled and the transcript empty).
     */
    function reviveSessionInstances(sessionIds) {
      var clientSessions = sessionStore();
      if (clientSessions == null || !Array.isArray(sessionIds) || sessionIds.length === 0) return;
      var manager = clientSessions.manager;
      for (var index = 0; index < sessionIds.length; index += 1) {
        var sessionId = sessionIds[index];
        if (typeof sessionId !== "string" || sessionId.length === 0) continue;
        var scopes = clientSessions.scopes;
        var record = scopes != null && typeof scopes.get === "function" ? scopes.get(sessionId) : undefined;
        var scopeDropped = false;
        if (record != null) {
          try {
            var startScopeDrop = clientSessions.startScopeDrop;
            if (typeof startScopeDrop !== "function") throw new Error("client sessions expose no startScopeDrop");
            /* Mirror prune: leave the map first, so a re-resolve during teardown
             * mints a new scope instead of handing back the dying record. */
            if (typeof scopes.delete === "function") scopes.delete(sessionId);
            var deferred = clientSessions.deferredRemovals;
            if (deferred != null && typeof deferred.delete === "function") deferred.delete(sessionId);
            startScopeDrop.call(clientSessions, sessionId, record);
            scopeDropped = true;
          } catch (error) {
            scopeDropped = false;
            // eslint-disable-next-line no-console
            console.warn("Session-Manager-GUI: could not discard the stale session scope, falling back:", error && error.message ? error.message : error);
          }
        }
        try {
          /* The scope path may be unavailable (or refuse a record mid-teardown):
           * clear the sticky bit on the live instance so the composer comes back,
           * and let the re-materialise step below pick a fresh one up. */
          if (!scopeDropped) {
            var instances = manager != null ? manager.sessions : undefined;
            var instance = instances != null && typeof instances.get === "function" ? instances.get(sessionId) : undefined;
            if (instance != null && instance.removed === true) {
              instance.removed = false;
              if (instance.notifier != null && typeof instance.notifier.markDirty === "function") instance.notifier.markDirty();
            }
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn("Session-Manager-GUI: could not revive session instance:", error && error.message ? error.message : error);
        }
      }
      /* The half the scope discard cannot perform on its own — and it must wait
       * for the catalog pull, because a restored session only becomes resolvable
       * once the pulled list lists it again. */
      syncSessionCatalog().then(function () {
        scheduleReviveOpen(sessionIds);
      });
    }

    /* Delays after the catalog pull for the repair attempts: the client's own
     * list, the store's projection and the restored session's remotes do not all
     * settle in the same tick, and a single attempt measurably misses the window
     * (the polling variant healed the same incident reliably). Each attempt is
     * guarded, so the extra passes are no-ops on a session that is already
     * whole — this is a retry of an idempotent call, not a loop of side
     * effects. */
    var REVIVE_OPEN_RETRY_MS = [0, 1200, 3000, 6000];

    function scheduleReviveOpen(sessionIds) {
      for (var index = 0; index < REVIVE_OPEN_RETRY_MS.length; index += 1) {
        scheduleAfter(REVIVE_OPEN_RETRY_MS[index], sessionIds);
      }
    }

    function scheduleAfter(delay, sessionIds) {
      if (typeof globalThis.setTimeout !== "function") return;
      if (delay <= 0) {
        ensureRevivedSessionsOpen(sessionIds);
        return;
      }
      globalThis.setTimeout(function () {
        ensureRevivedSessionsOpen(sessionIds);
      }, delay);
    }

    function notifyCatalogChanged() {
      return syncSessionCatalog();
    }

    /**
     * Re-pull the session catalog and resolve when the pull settles.
     * @returns a promise (never rejected) for the resync attempt.
     */
    function syncSessionCatalog() {
      try {
        if (typeof refreshSessionCatalog !== "function") return Promise.resolve();
        var pending = refreshSessionCatalog();
        if (pending != null && typeof pending.then === "function") {
          return pending.then(function () {}, function () {});
        }
      } catch (error) {
        /* best effort: a failed resync must never fail the action itself */
      }
      return Promise.resolve();
    }

    /**
     * Materialise the session's scope (public `binding()`) and open its history
     * window.
     *
     * This is the half of the repair that discarding the scope cannot do, and it
     * must NOT be written as a "stage move". The obvious shape — `clear()` then
     * `open(id)` — looks like the store's own stage-move path, but both write
     * their state with a SYNCHRONOUS notification, so `followCurrent()` runs
     * twice inside one tick: once with `current` blanked while `watched` still
     * holds the old id (early return), and once with `current` back on the same
     * id (early return again, `current === watched`). The stage therefore never
     * moves, `sweepDeferred()` never runs, `session.open()` is never called, and
     * the freshly minted instance stays `cold` with an empty history window —
     * the composer works, but the transcript is gone until the user switches
     * away and back. (Measured: `bindingOpenState: "cold"`, `eventEntries: 0`
     * after that shape, and `"open"` / 100 entries after this one.)
     *
     * Resolving the binding materialises the scope, and `open()` is idempotent
     * (it no-ops while open or in flight), so this is safe to call unchanged on
     * a healthy session: it does nothing at all.
     *
     * @param sessionIds - revived session ids.
     * @returns true when a reopened window is already known to be good.
     */
    function ensureRevivedSessionsOpen(sessionIds) {
      var clientSessions = sessionStore();
      /* Nothing was revived ⇒ nothing to repair. */
      if (clientSessions == null || !Array.isArray(sessionIds) || sessionIds.length === 0) return true;
      if (typeof clientSessions.binding !== "function") return true;
      /* Only the session on stage can be bound; touching any other id would
       * materialise a scope for a session the user is not looking at. */
      var list = clientSessions.list;
      var snapshot = list != null && typeof list.getSnapshot === "function" ? list.getSnapshot() : undefined;
      var staged = snapshot != null && typeof snapshot.current === "string" ? snapshot.current : null;
      /* "Already whole" and "nothing to repair" are both done: true tells the
       * retry schedule to stop. */
      if (staged === null || sessionIds.indexOf(staged) === -1) return true;
      var session = null;
      try {
        var binding = clientSessions.binding(staged);
        session = binding != null ? binding.session : undefined;
      } catch (error) {
        session = undefined;
      }
      if (session == null || typeof session.open !== "function") return false;
      if (typeof session.getSnapshot === "function") {
        var snapshot0 = session.getSnapshot();
        /* Already whole — a late retry must not re-render the view for nothing. */
        if (snapshot0 != null && snapshot0.openState === "open") return true;
      }
      try {
        session.open();
        return false;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn("Session-Manager-GUI: could not reopen the revived session's history:", error && error.message ? error.message : error);
        return false;
      }
    }

    /* ------------------------------------------------------------ locale */

    var zhTrash = {
      nav: "会话回收站",
      title: "会话回收站",
      intro: "被删除的会话会先移入回收站。恢复后回到原工作区；彻底删除会永久清除其会话日志与缓存。",
      empty: "回收站是空的。",
      loading: "加载中…",
      loadError: "加载失败：{message}",
      fallbackTitle: "（无标题）",
      restore: "恢复会话",
      purge: "彻底删除",
      purgeConfirmTitle: "是否确认彻底删除？会话彻底删除后",
      purgeConfirmHighlight: "不可恢复",
      purgeConfirmTail: "。",
      cancel: "取消",
      purgeConfirmAction: "确认彻底删除",
      actionError: "操作失败：{message}",
      backToTop: "重新加载",
      deleteHint: "移入回收站的会话仅从列表中移除，日志与缓存会保留到“彻底删除”。",
      toastPartial: "部分条目未能彻底删除（失败 {count} 条），详见页面提示。",
      deleteConfirmTitle: "删除会话",
      deleteConfirmBody: "确定要将「{title}」移入回收站吗？",
      deleteConfirmAction: "确认删除",
      cascadeNotice: "该操作也将会同步删除会话中所衍生的子代理会话（{count} 条）。",
      purgeCascadeNotice: "该操作也将会同步彻底删除会话中所衍生的子代理会话（{count} 条），删除后不可恢复。",
      toastTrashed: "已移入回收站",
      toastTrashedWithChildren: "已移入回收站（含 {count} 条子代理会话）",
      toastPurged: "已彻底删除",
      toastRestored: "已恢复到原工作区",
      toastBatchPurged: "已彻底删除 {count} 条会话",
      moreTitles: "…等另外 {count} 条",
      INVALID_SESSION_ID: "无效的会话 id，请刷新页面后重试。",
      PATH_NOT_ALLOWED: "出于安全考虑已拒绝该操作：目标不在 Harness 的会话数据范围内（绝不触碰工作区文件）。",
      SELECTION_TOO_LARGE: "一次最多彻底删除 500 条会话。",
      EMPTY_SELECTION: "没有选中任何会话。",
      subagentBadge: "子代理",
      subagentTip: "由父会话衍生出的子代理会话",
    };

    var enTrash = {
      nav: "Session trash",
      title: "Session trash",
      intro: "Deleted sessions land here first. Restore sends them back to their workspace; purge permanently erases their logs and cache.",
      empty: "The trash is empty.",
      loading: "Loading…",
      loadError: "Failed to load: {message}",
      fallbackTitle: "(untitled)",
      restore: "Restore",
      purge: "Purge permanently",
      purgeConfirmTitle: "Permanently delete this session? A permanently deleted session",
      purgeConfirmHighlight: "cannot be recovered",
      purgeConfirmTail: ".",
      cancel: "Cancel",
      purgeConfirmAction: "Permanently delete",
      actionError: "Action failed: {message}",
      backToTop: "Reload",
      deleteHint: "Trashed sessions are only hidden; their logs and cache stay until purged.",
      toastPartial: "Some sessions could not be purged ({count} failed) — see the page message.",
      deleteConfirmTitle: "Delete session",
      deleteConfirmBody: "Move “{title}” to the recycle bin?",
      deleteConfirmAction: "Delete",
      cascadeNotice: "This also deletes the subagent sessions derived from it ({count}).",
      purgeCascadeNotice: "This also permanently deletes the subagent sessions derived from it ({count}); the deletion cannot be undone.",
      toastTrashed: "Moved to the recycle bin",
      toastTrashedWithChildren: "Moved to the recycle bin (with {count} subagent session(s))",
      toastPurged: "Permanently deleted",
      toastRestored: "Restored to its workspace",
      toastBatchPurged: "Permanently deleted {count} session(s)",
      moreTitles: "…and {count} more",
      INVALID_SESSION_ID: "Invalid session id — reload the page and try again.",
      PATH_NOT_ALLOWED: "Refused for safety: the target is outside the harness session data (workspace files are never touched).",
      SELECTION_TOO_LARGE: "At most 500 sessions can be purged in one batch.",
      EMPTY_SELECTION: "No session was selected.",
      subagentBadge: "Subagent",
      subagentTip: "A subagent session derived from a parent session",
    };

    var zhArchived = {
      nav: "已归档会话",
      title: "已归档会话",
      intro: "查看已归档的会话。可以恢复回工作区，也可以移入回收站。",
      empty: "没有已归档的会话。",
      loading: "加载中…",
      loadError: "加载失败：{message}",
      fallbackTitle: "（无标题）",
      restore: "恢复会话",
      delete: "删除会话",
      deleteHint: "“删除会话”会将会话移入回收站，可随时恢复。若该会话派生过子代理会话，会一并移入。",
      actionError: "操作失败：{message}",
      backToTop: "重新加载",
      cancel: "取消",
      deleteConfirmTitle: "删除会话",
      deleteConfirmBody: "确定要将「{title}」移入回收站吗？",
      deleteConfirmAction: "确认删除",
      cascadeNotice: "该操作也将会同步删除会话中所衍生的子代理会话（{count} 条）。",
      purgeCascadeNotice: "该操作也将会同步彻底删除会话中所衍生的子代理会话（{count} 条），删除后不可恢复。",
      toastTrashed: "已移入回收站",
      toastTrashedWithChildren: "已移入回收站（含 {count} 条子代理会话）",
      toastPurged: "已彻底删除",
      toastRestored: "已恢复到原工作区",
      toastBatchPurged: "已彻底删除 {count} 条会话",
      moreTitles: "…等另外 {count} 条",
      INVALID_SESSION_ID: "无效的会话 id，请刷新页面后重试。",
      PATH_NOT_ALLOWED: "出于安全考虑已拒绝该操作：目标不在 Harness 的会话数据范围内（绝不触碰工作区文件）。",
      SELECTION_TOO_LARGE: "一次最多彻底删除 500 条会话。",
      EMPTY_SELECTION: "没有选中任何会话。",
    };

    var enArchived = {
      nav: "Archived sessions",
      title: "Archived sessions",
      intro: "View archived sessions. Restore them to their workspace, or move them to the trash.",
      empty: "No archived sessions.",
      loading: "Loading…",
      loadError: "Failed to load: {message}",
      fallbackTitle: "(untitled)",
      restore: "Restore",
      delete: "Delete",
      deleteHint: "“Delete” moves the session to the trash, where it can still be restored. Subagent sessions derived from it move with it.",
      actionError: "Action failed: {message}",
      backToTop: "Reload",
      cancel: "Cancel",
      deleteConfirmTitle: "Delete session",
      deleteConfirmBody: "Move “{title}” to the recycle bin?",
      deleteConfirmAction: "Delete",
      cascadeNotice: "This also deletes the subagent sessions derived from it ({count}).",
      purgeCascadeNotice: "This also permanently deletes the subagent sessions derived from it ({count}); the deletion cannot be undone.",
      toastTrashed: "Moved to the recycle bin",
      toastTrashedWithChildren: "Moved to the recycle bin (with {count} subagent session(s))",
      toastPurged: "Permanently deleted",
      toastRestored: "Restored to its workspace",
      toastBatchPurged: "Permanently deleted {count} session(s)",
      moreTitles: "…and {count} more",
      INVALID_SESSION_ID: "Invalid session id — reload the page and try again.",
      PATH_NOT_ALLOWED: "Refused for safety: the target is outside the harness session data (workspace files are never touched).",
      SELECTION_TOO_LARGE: "At most 500 sessions can be purged in one batch.",
      EMPTY_SELECTION: "No session was selected.",
    };


    var zhHidden = {
      nav: "常规不可见会话",
      title: "常规不可见会话",
      intro: "这些会话存在于磁盘、也仍能被 @ 引用，但侧栏永远不会显示它们。可以在这里删除（移入回收站）或彻底删除。",
      empty: "没有这类会话。",
      loading: "加载中…",
      loadError: "加载失败：{message}",
      fallbackTitle: "（无标题）",
      delete: "删除会话",
      purge: "彻底删除",
      deleteHint: "删除 = 移入会话回收站（可恢复）；彻底删除 = 永久清除日志与缓存。",
      cancel: "取消",
      purgeConfirmTitle: "是否确认彻底删除？会话彻底删除后",
      purgeConfirmHighlight: "不可恢复",
      purgeConfirmTail: "。",
      purgeConfirmAction: "确认彻底删除",
      batchButton: "彻底删除本组（{count} 条）",
      batchPurgeConfirm: "将彻底删除本组 {count} 条会话及其衍生的子代理会话，删除后不可恢复：",
      statsLine: "共 {count} 条 · 占用约 {size}",
      groupCount: "{label}（{count}）",
      truncatedNote: "另有 {count} 条未显示（本次上限 200 条）。",
      toastPartial: "部分条目未能彻底删除（失败 {count} 条），详见页面提示。",
      groupSubagents: "子代理会话",
      groupLeftover: "遗留（父会话已删除）",
      groupAttached: "父会话仍在",
      groupBlank: "空白会话（从未发过消息）",
      groupUnowned: "无归属会话（不属于任何工作区）",
      rowParent: "父会话：{title}",
      rowParentMissing: "父会话已删除",
      rowWorkspace: "工作区：{title}",
      rowUnowned: "不属于任何工作区",
      running: "运行中",
      actionError: "操作失败：{message}",
      backToTop: "重新加载",
      deleteConfirmTitle: "删除会话",
      deleteConfirmBody: "确定要将「{title}」移入回收站吗？",
      deleteConfirmAction: "确认删除",
      cascadeNotice: "该操作也将会同步删除会话中所衍生的子代理会话（{count} 条）。",
      purgeCascadeNotice: "该操作也将会同步彻底删除会话中所衍生的子代理会话（{count} 条），删除后不可恢复。",
      toastTrashed: "已移入回收站",
      toastTrashedWithChildren: "已移入回收站（含 {count} 条子代理会话）",
      toastPurged: "已彻底删除",
      toastRestored: "已恢复到原工作区",
      toastBatchPurged: "已彻底删除 {count} 条会话",
      moreTitles: "…等另外 {count} 条",
      INVALID_SESSION_ID: "无效的会话 id，请刷新页面后重试。",
      PATH_NOT_ALLOWED: "出于安全考虑已拒绝该操作：目标不在 Harness 的会话数据范围内（绝不触碰工作区文件）。",
      SELECTION_TOO_LARGE: "一次最多彻底删除 500 条会话。",
      EMPTY_SELECTION: "没有选中任何会话。",
    };

    var enHidden = {
      nav: "Normally hidden sessions",
      title: "Normally hidden sessions",
      intro: "These sessions exist on disk and can still be @-referenced, but the sidebar never shows them. Delete them (to the recycle bin) or purge them here.",
      empty: "Nothing here.",
      loading: "Loading…",
      loadError: "Failed to load: {message}",
      fallbackTitle: "(untitled)",
      delete: "Delete",
      purge: "Purge permanently",
      deleteHint: "Delete moves it to the recycle bin (restorable); purge erases its log and cache for good.",
      cancel: "Cancel",
      purgeConfirmTitle: "Permanently delete this session? A permanently deleted session",
      purgeConfirmHighlight: "cannot be recovered",
      purgeConfirmTail: ".",
      purgeConfirmAction: "Permanently delete",
      batchButton: "Purge this group ({count})",
      batchPurgeConfirm: "This permanently deletes {count} session(s) in this group and the subagent sessions derived from them:",
      statsLine: "{count} session(s) · about {size}",
      groupCount: "{label} ({count})",
      truncatedNote: "{count} more are not shown (200-row limit).",
      toastPartial: "Some sessions could not be purged ({count} failed) — see the page message.",
      groupSubagents: "Subagent sessions",
      groupLeftover: "Leftover (parent deleted)",
      groupAttached: "Parent still exists",
      groupBlank: "Blank sessions (never sent a message)",
      groupUnowned: "Unowned sessions (in no workspace)",
      rowParent: "Parent: {title}",
      rowParentMissing: "Parent deleted",
      rowWorkspace: "Workspace: {title}",
      rowUnowned: "No workspace",
      running: "running",
      actionError: "Action failed: {message}",
      backToTop: "Reload",
      deleteConfirmTitle: "Delete session",
      deleteConfirmBody: "Move “{title}” to the recycle bin?",
      deleteConfirmAction: "Delete",
      cascadeNotice: "This also deletes the subagent sessions derived from it ({count}).",
      purgeCascadeNotice: "This also permanently deletes the subagent sessions derived from it ({count}); the deletion cannot be undone.",
      toastTrashed: "Moved to the recycle bin",
      toastTrashedWithChildren: "Moved to the recycle bin (with {count} subagent session(s))",
      toastPurged: "Permanently deleted",
      toastRestored: "Restored to its workspace",
      toastBatchPurged: "Permanently deleted {count} session(s)",
      moreTitles: "…and {count} more",
      INVALID_SESSION_ID: "Invalid session id — reload the page and try again.",
      PATH_NOT_ALLOWED: "Refused for safety: the target is outside the harness session data (workspace files are never touched).",
      SELECTION_TOO_LARGE: "At most 500 sessions can be purged in one batch.",
      EMPTY_SELECTION: "No session was selected.",
    };

    /* ------------------------------------------------------- shared bits */

    function message(entry) {
      return entry && typeof entry.title === "string" && entry.title.length > 0 ? entry.title : null;
    }

    function titleText(t, entry) {
      var title = message(entry);
      return title != null ? title : t("fallbackTitle");
    }

    /** Session id from a list entry, tolerant of camelCase and snake_case. */
    function sessionIdOf(entry) {
      if (entry == null) return null;
      if (typeof entry.sessionId === "string" && entry.sessionId.length > 0) return entry.sessionId;
      if (typeof entry.session_id === "string" && entry.session_id.length > 0) return entry.session_id;
      return null;
    }

    /* Host error codes -> friendly localised text; fall back to the server message. */
    var KNOWN_ERRORS = {
      INVALID_SESSION_ID: "无效的会话 id，请刷新页面后重试。",
      LIVE_SESSION: "该会话当前正在生成/运行中；请等它结束或先停止，再执行此操作。",
      UNKNOWN_SESSION: "找不到该会话（可能已被移除）。",
      NOT_IN_TRASH: "该会话不在回收站中。",
      LOG_MISSING: "会话日志已不存在，无法恢复。",
      ALREADY_PURGED: "该会话已被彻底删除。",
      PATH_NOT_ALLOWED: "出于安全考虑已拒绝该操作：目标不在 Harness 的会话数据范围内（绝不触碰工作区文件）。",
      SELECTION_TOO_LARGE: "一次最多彻底删除 500 条会话。",
      EMPTY_SELECTION: "没有选中任何会话。",
      INTERNAL: "服务内部错误，请查看 Harness 控制台日志。",
    };

    function friendlyError(error) {
      var code = error && error.code ? error.code : null;
      if (code != null && KNOWN_ERRORS[code]) return KNOWN_ERRORS[code];
      var raw = error && error.message ? error.message : String(error || "request failed");
      return raw;
    }

    /* Lightweight toast for actions triggered outside the settings pages. */
    function showToast(kind, text) {
      if (typeof document === "undefined") return;
      var toast = document.createElement("div");
      toast.className = "seg-toast " + (kind === "ok" ? "seg-toast-ok" : "seg-toast-err");
      toast.textContent = text;
      document.body.appendChild(toast);
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 4000);
    }

    /* List hook: {phase:'loading'|'ready'|'error', rows, error, reload} */
    function useRows(loader) {
      var statePair = useState({ phase: "loading", rows: [], error: null });
      var state = statePair[0];
      var setState = statePair[1];
      var mounted = react.useRef(true);
      var run = useCallback(() => {
        setState({ phase: "loading", rows: [], error: null });
        Promise.resolve()
          .then(() => loader())
          .then((value) => {
            if (mounted.current) {
              setState({
                phase: "ready",
                rows: value && Array.isArray(value.entries) ? value.entries : [],
                error: null,
              });
            }
          })
          .catch((error) => {
            if (mounted.current) setState({ phase: "error", rows: [], error: error.message || String(error) });
          });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      useEffect(() => {
        run();
        return () => {
          mounted.current = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [run]);
      return { phase: state.phase, rows: state.rows, error: state.error, reload: run };
    }

    function emptyBlock(t, key) {
      return h("p", { className: "seg-status" }, t(key));
    }

    /* Buttons (right-aligned via .seg-actions). */
    function actionButton(label, onClick, danger) {
      return h(
        "button",
        { type: "button", className: "seg-btn" + (danger ? " seg-danger" : ""), onClick: onClick },
        label,
      );
    }

    function rowItem(t, entry, actions) {
      var sid = sessionIdOf(entry);
      return h(
        "li",
        {
          key: sid != null ? sid : "row-" + Math.random().toString(36).slice(2),
          className: entry != null && entry.isSubagent === true ? "seg-row is-subagent" : "seg-row",
        },
        entry != null && entry.isSubagent === true ? subagentBadge(t, entry) : null,
        h("span", { className: "seg-rowTitle", title: sid != null ? sid : "" }, titleText(t, entry)),
        h("div", { className: "seg-actions" }, actions),
      );
    }

    /*
     * Subagent pin for one recycle-bin row.
     *
     * The glyph is the product's own subagent mark (`SubagentSwitcherIcon` —
     * one node branching into two, drawn as a three-circle mask over a ring),
     * copied verbatim from the shipped primitives bundle so a subagent reads the
     * same here as it does in the conversation header. Inlined as plain
     * `createElement` because this client half is not compiled: no JSX, and the
     * primitives package is not a dependency of this plugin.
     *
     * The mask id is the shipped one; it is a document-global id, and an SVG
     * `mask` resolves to the first match in tree order, so a duplicate id
     * elsewhere in the page could only ever resolve to an identical mask.
     */
    function subagentIcon(size) {
      var px = String(size != null ? size : 16);
      return h(
        "svg",
        { width: px, height: px, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", focusable: "false" },
        h(
          "mask",
          { id: "mask0_agent_preset_16", maskUnits: "userSpaceOnUse", x: "0", y: "0", width: "16", height: "16" },
          h("rect", { width: "16", height: "16", fill: "white" }),
          h("circle", { cx: "7.9995", cy: "3.28319", r: "1.712", fill: "black" }),
          h("circle", { cx: "3.51122", cy: "11.3855", r: "1.712", fill: "black" }),
          h("circle", { cx: "12.4878", cy: "11.3855", r: "1.712", fill: "black" }),
        ),
        h("path", {
          mask: "url(#mask0_agent_preset_16)",
          fill: "currentColor",
          d: "M12.2881 11.0425C12.6002 11.3723 13.0413 11.5786 13.5312 11.5786L13.5342 11.5776C13.1476 12.3233 12.6119 12.9785 11.9639 13.5005C10.9327 14.3309 9.6199 14.8286 8.19336 14.8286C7.29864 14.8285 6.45056 14.6313 5.6875 14.2808C6.08309 14.0281 6.36707 13.6189 6.45215 13.1392C6.99022 13.3561 7.57767 13.476 8.19336 13.4761C9.30019 13.4761 10.3157 13.0915 11.1152 12.4478C11.5935 12.0626 11.9924 11.5848 12.2881 11.0425ZM4.14746 4.36475C4.25569 4.83228 4.55488 5.2247 4.95898 5.4585C4.07956 6.30639 3.53144 7.49605 3.53125 8.81396C3.53125 9.69534 3.77613 10.5202 4.20117 11.2231C3.74959 11.3817 3.38395 11.7232 3.19531 12.1597C2.5541 11.2032 2.17969 10.052 2.17969 8.81396C2.17989 7.05087 2.93868 5.4646 4.14746 4.36475ZM8.19336 2.80029C8.85717 2.80029 9.49784 2.90834 10.0967 3.10791C12.3237 3.85044 13.9725 5.86061 14.1846 8.28369C13.9832 8.20048 13.7627 8.15382 13.5312 8.15381C13.2802 8.15381 13.042 8.20907 12.8271 8.30615C12.6281 6.47264 11.3666 4.95616 9.66895 4.39014C9.2063 4.236 8.70989 4.15186 8.19336 4.15186C7.96112 4.15189 7.7329 4.16981 7.50977 4.20264C7.51947 4.12886 7.52637 4.05348 7.52637 3.97705C7.52628 3.56604 7.3811 3.18914 7.13965 2.89404C7.48183 2.83352 7.83381 2.80033 8.19336 2.80029Z",
        }),
        h("path", {
          fill: "currentColor",
          d: "M9.1123 3.28271C9.11205 2.66858 8.61322 2.17041 7.99902 2.17041C7.38504 2.17067 6.88697 2.66874 6.88672 3.28271C6.88672 3.89691 7.38489 4.39574 7.99902 4.396C8.61338 4.396 9.1123 3.89707 9.1123 3.28271ZM10.3115 3.28271C10.3115 4.55981 9.27612 5.59521 7.99902 5.59521C6.72214 5.59496 5.6875 4.55965 5.6875 3.28271C5.68776 2.00599 6.7223 0.971447 7.99902 0.971191C9.27596 0.971191 10.3113 2.00584 10.3115 3.28271Z",
        }),
        h("path", {
          fill: "currentColor",
          d: "M4.62402 11.385C4.62377 10.7709 4.12494 10.2727 3.51074 10.2727C2.89676 10.273 2.39869 10.771 2.39844 11.385C2.39844 11.9992 2.89661 12.498 3.51074 12.4983C4.1251 12.4983 4.62402 11.9994 4.62402 11.385ZM5.82324 11.385C5.82324 12.6621 4.78784 13.6975 3.51074 13.6975C2.23386 13.6973 1.19922 12.6619 1.19922 11.385C1.19947 10.1083 2.23402 9.07374 3.51074 9.07349C4.78768 9.07349 5.82299 10.1081 5.82324 11.385Z",
        }),
        h("path", {
          fill: "currentColor",
          d: "M13.6006 11.385C13.6003 10.7709 13.1015 10.2727 12.4873 10.2727C11.8733 10.273 11.3753 10.771 11.375 11.385C11.375 11.9992 11.8732 12.498 12.4873 12.4983C13.1017 12.4983 13.6006 11.9994 13.6006 11.385ZM14.7998 11.385C14.7998 12.6621 13.7644 13.6975 12.4873 13.6975C11.2104 13.6973 10.1758 12.6619 10.1758 11.385C10.176 10.1083 11.2106 9.07374 12.4873 9.07349C13.7642 9.07349 14.7995 10.1081 14.7998 11.385Z",
        }),
      );
    }

    /** The labelled subagent pin: icon + word, with the parent as its tooltip. */
    function subagentBadge(t, entry) {
      var parentId = entry != null && typeof entry.parentSessionId === "string" ? entry.parentSessionId : null;
      var label = entry != null && typeof entry.subagentLabel === "string" && entry.subagentLabel.length > 0 ? entry.subagentLabel : null;
      var tip = t("subagentTip");
      if (label != null) tip += " · " + label;
      if (parentId != null) tip += " · " + parentId;
      return h(
        "span",
        { className: "seg-subBadge", title: tip },
        subagentIcon(14),
        h("span", null, t("subagentBadge")),
      );
    }

    function statusOrRows(t, view, renderRow) {
      if (view.phase === "loading") {
        return h("p", { className: "seg-status" }, t("loading"));
      }
      if (view.phase === "error") {
        return h(
          "div",
          { className: "seg-group" },
          h("p", { className: "seg-status" }, t("loadError").replace("{message}", view.error || "")),
          h("div", { className: "seg-actions", style: { marginLeft: 0 } },
            actionButton(t("backToTop"), view.reload)),
        );
      }
      if (view.rows.length === 0) {
        return emptyBlock(t, "empty");
      }
      return h("ul", { className: "seg-rows" }, view.rows.map(renderRow));
    }

    /* --------------------------------------------------- dialogs & actions */

    /*
     * ONE modal dialog for every destructive confirmation, built imperatively
     * with the same markup the React sections use. It renders identically
     * whether it is opened from a React handler or from the sidebar menu
     * bridge — which lives outside React entirely. It resolves true only when
     * the user confirms; Escape, a mask click and the cancel button all
     * resolve false.
     */
    var activeDialogClose = null;

    function openConfirm(options) {
      // Only one dialog at a time: a second request dismisses the first
      // (resolving it false) instead of stacking two masks.
      if (activeDialogClose != null) {
        var previous = activeDialogClose;
        activeDialogClose = null;
        previous(false);
      }
      return new Promise(function (resolve) {
        if (typeof document === "undefined") {
          resolve(false);
          return;
        }
        var settled = false;
        var mask = document.createElement("div");
        mask.className = "seg-modal-mask";
        mask.setAttribute("role", "presentation");
        var modal = document.createElement("div");
        modal.className = "seg-modal";
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-modal", "true");

        var text = document.createElement("p");
        text.className = "seg-modal-text";
        text.appendChild(document.createTextNode(options.title || ""));
        if (options.highlight) {
          var strong = document.createElement("span");
          strong.className = "seg-danger-bold";
          strong.textContent = options.highlight;
          text.appendChild(strong);
        }
        if (options.tail) text.appendChild(document.createTextNode(options.tail));
        modal.appendChild(text);

        if (Array.isArray(options.notes) && options.notes.length > 0) {
          var note = document.createElement("p");
          note.className = "seg-modal-note";
          note.textContent = options.notes.join(" ");
          modal.appendChild(note);
        }
        if (Array.isArray(options.titles) && options.titles.length > 0) {
          var list = document.createElement("ul");
          list.className = "seg-modal-list";
          options.titles.forEach(function (item) {
            var li = document.createElement("li");
            li.textContent = item;
            list.appendChild(li);
          });
          modal.appendChild(list);
        }

        var actions = document.createElement("div");
        actions.className = "seg-modal-actions";
        var cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "seg-btn";
        cancel.textContent = options.cancelLabel;
        var confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className = "seg-btn seg-danger";
        confirm.textContent = options.confirmLabel;

        function close(value) {
          if (settled) return;
          settled = true;
          document.removeEventListener("keydown", onKey);
          if (mask.parentNode) mask.parentNode.removeChild(mask);
          if (activeDialogClose === close) activeDialogClose = null;
          resolve(value);
        }
        activeDialogClose = close;
        function onKey(event) {
          if (event.key === "Escape") close(false);
        }
        cancel.addEventListener("click", function () {
          close(false);
        });
        confirm.addEventListener("click", function () {
          close(true);
        });
        mask.addEventListener("click", function (event) {
          if (event.target === mask) close(false);
        });
        actions.appendChild(cancel);
        actions.appendChild(confirm);
        modal.appendChild(actions);
        mask.appendChild(modal);
        document.body.appendChild(mask);
        document.addEventListener("keydown", onKey);
        try {
          confirm.focus();
        } catch (error) {
          /* focus is best effort */
        }
      });
    }

    /** Subagent children of one session, or a zero preview when the read fails. */
    function childPreview(sessionId) {
      return Promise.resolve()
        .then(function () {
          return api.subagentChildren(sessionId);
        })
        .catch(function (error) {
          // A missing preview must not block the user's delete, but it does mean
          // no cascade notice can be shown — leave a trace for diagnosis.
          // eslint-disable-next-line no-console
          console.warn("Session-Manager-GUI: subagent preview unavailable:", error && error.message ? error.message : error);
          return { count: 0, items: [], title: null };
        });
    }

    /**
     * Soft delete (move to the recycle bin). The dialog appears ONLY when the
     * session actually derived subagent sessions — those are deleted with it
     * (parent/child binding, no opt-out), so the user is told before it
     * happens; a childless session deletes immediately with a toast.
     * @returns true when the caller should proceed.
     */
    function requestSoftDelete(t, sessionId, title) {
      return childPreview(sessionId).then(function (preview) {
        var count = preview && typeof preview.count === "number" ? preview.count : 0;
        if (count === 0) return true;
        // The sidebar menu bridge only knows the id, so fall back to the title
        // the preview read for us before showing the raw id.
        var label = title != null && title.length > 0
          ? title
          : (preview != null && typeof preview.title === "string" && preview.title.length > 0 ? preview.title : sessionId);
        return openConfirm({
          title: t("deleteConfirmBody").replace("{title}", label),
          notes: [t("cascadeNotice").replace("{count}", String(count))],
          cancelLabel: t("cancel"),
          confirmLabel: t("deleteConfirmAction"),
        });
      });
    }

    /** Irreversible purge of one session; names the subagent sessions it takes with it. */
    function requestPurge(t, sessionId) {
      return childPreview(sessionId).then(function (preview) {
        var count = preview && typeof preview.count === "number" ? preview.count : 0;
        return openConfirm({
          title: t("purgeConfirmTitle"),
          highlight: t("purgeConfirmHighlight"),
          tail: t("purgeConfirmTail"),
          notes: count > 0 ? [t("purgeCascadeNotice").replace("{count}", String(count))] : [],
          cancelLabel: t("cancel"),
          confirmLabel: t("purgeConfirmAction"),
        });
      });
    }

    /** Irreversible purge of a whole rendered group: count + the titles at stake. */
    function requestBatchPurge(t, titles) {
      var shown = titles.slice(0, 10);
      return openConfirm({
        title: t("batchPurgeConfirm").replace("{count}", String(titles.length)),
        notes: titles.length > shown.length ? [t("moreTitles").replace("{count}", String(titles.length - shown.length))] : [],
        titles: shown,
        cancelLabel: t("cancel"),
        confirmLabel: t("purgeConfirmAction"),
      });
    }

    /** Subagent count of a finished trash/add response (0 when absent). */
    function cascadedCount(result) {
      if (result == null || result.cascade == null) return 0;
      return Array.isArray(result.cascade.deleted) ? result.cascade.deleted.length : 0;
    }

    function formatBytes(bytes) {
      if (typeof bytes !== "number" || bytes <= 0) return "0 B";
      var units = ["B", "KB", "MB", "GB"];
      var value = bytes;
      var index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value = value / 1024;
        index += 1;
      }
      return (index === 0 ? String(Math.round(value)) : value.toFixed(1)) + " " + units[index];
    }

    function formatWhen(ms) {
      try {
        return new Date(ms).toLocaleString();
      } catch (error) {
        return "";
      }
    }

    /* ------------------------------------------------------- trash page */

    function TrashSection(props) {
      var t = props.t;
      var view = useRows(() => api.trashList());
      var busyState = useState(null);
      var busyId = busyState[0];
      var setBusyId = busyState[1];
      var errorState = useState(null);
      var pageError = errorState[0];
      var setPageError = errorState[1];

      function runAction(sessionId, operation, after) {
        if (busyId != null) return;
        setBusyId(sessionId);
        setPageError(null);
        Promise.resolve()
          .then(() => operation(sessionId))
          .then(() => {
            setBusyId(null);
            after();
            notifyCatalogChanged();
          })
          .catch((error) => {
            setBusyId(null);
            setPageError(friendlyError(error));
          });
      }

      /* Purge is irreversible and, by the parent/child binding, also erases
         the subagent sessions derived from the target — the dialog names them
         first (a plain confirm dialog, exactly like the recycle-bin one). */
      function confirmPurge(entry) {
        var sid = sessionIdOf(entry);
        if (sid == null || busyId != null) return;
        setPageError(null);
        Promise.resolve()
          .then(() => requestPurge(t, sid))
          .then((ok) => {
            if (!ok) return null;
            setBusyId(sid);
            return api.trashPurge(sid);
          })
          .then((result) => {
            if (result == null) return;
            setBusyId(null);
            var failed = result != null && Array.isArray(result.failed) ? result.failed.length : 0;
            showToast(failed > 0 ? "err" : "ok", failed > 0 ? t("toastPartial").replace("{count}", String(failed)) : t("toastPurged"));
            view.reload();
            notifyCatalogChanged();
          })
          .catch((error) => {
            setBusyId(null);
            setPageError(friendlyError(error));
          });
      }

      /* Restore also revives the browser's session instance: without it a
         session that was open when it got deleted stays "removed" (composer
         disabled, prompts ignored) until the page is reloaded. */
      function runRestore(sessionId) {
        if (busyId != null) return;
        setBusyId(sessionId);
        setPageError(null);
        Promise.resolve()
          .then(() => api.trashRestore(sessionId))
          .then((result) => {
            setBusyId(null);
            var restored = [sessionId].concat(
              result != null && Array.isArray(result.restored_children) ? result.restored_children : [],
            );
            reviveSessionInstances(restored);
            showToast("ok", t("toastRestored"));
            view.reload();
            notifyCatalogChanged();
          })
          .catch((error) => {
            setBusyId(null);
            setPageError(friendlyError(error));
          });
      }

      var restoreRow = (entry) => {
        var sid = sessionIdOf(entry);
        if (sid == null) return null;
        return rowItem(t, entry, [
          actionButton(t("restore"), () => runRestore(sid)),
          actionButton(t("purge"), () => confirmPurge(entry), true),
        ]);
      };

      return h(
        "div",
        { className: "seg-section" },
        h("h2", { className: "seg-title" }, t("title")),
        h("p", { className: "seg-intro" }, t("intro")),
        h("div", { className: "seg-group" },
          h("p", { className: "seg-status" }, t("deleteHint"))),
        pageError != null
          ? h("p", { className: "seg-status" }, t("actionError").replace("{message}", pageError))
          : null,
        statusOrRows(t, view, restoreRow),
      );
    }

    /* ---------------------------------------------------- archived page */

    function ArchivedSection(props) {
      var t = props.t;
      var view = useRows(() => api.archivedList());
      var busyState = useState(null);
      var busyId = busyState[0];
      var setBusyId = busyState[1];
      var errorState = useState(null);
      var pageError = errorState[0];
      var setPageError = errorState[1];

      function runAction(sessionId, operation, after) {
        if (busyId != null) return;
        setBusyId(sessionId);
        setPageError(null);
        Promise.resolve()
          .then(() => operation(sessionId))
          .then(() => {
            setBusyId(null);
            after();
            notifyCatalogChanged();
          })
          .catch((error) => {
            setBusyId(null);
            setPageError(friendlyError(error));
          });
      }

      /* "Delete" moves the session to the recycle bin. When it derived
         subagent sessions they move with it, so confirm first. */
      function confirmDelete(entry) {
        var sid = sessionIdOf(entry);
        if (sid == null || busyId != null) return;
        setPageError(null);
        Promise.resolve()
          .then(() => requestSoftDelete(t, sid, message(entry)))
          .then((ok) => {
            if (!ok) return null;
            setBusyId(sid);
            return api.archivedDelete(sid, true);
          })
          .then((result) => {
            if (result == null) return;
            setBusyId(null);
            var count = cascadedCount(result);
            showToast("ok", count > 0 ? t("toastTrashedWithChildren").replace("{count}", String(count)) : t("toastTrashed"));
            view.reload();
            notifyCatalogChanged();
          })
          .catch((error) => {
            setBusyId(null);
            setPageError(friendlyError(error));
          });
      }

      /* Un-archiving brings a session back to the sidebar; clear the browser's
         stale "removed" instance too, in case it was disposed while hidden. */
      function runUnarchive(sessionId) {
        if (busyId != null) return;
        setBusyId(sessionId);
        setPageError(null);
        Promise.resolve()
          .then(() => api.archivedRestore(sessionId))
          .then(() => {
            setBusyId(null);
            reviveSessionInstances([sessionId]);
            view.reload();
            notifyCatalogChanged();
          })
          .catch((error) => {
            setBusyId(null);
            setPageError(friendlyError(error));
          });
      }

      var archivedRow = (entry) => {
        var sid = sessionIdOf(entry);
        if (sid == null) return null;
        return rowItem(t, entry, [
          actionButton(t("restore"), () => runUnarchive(sid)),
          actionButton(t("delete"), () => confirmDelete(entry), true),
        ]);
      };

      return h(
        "div",
        { className: "seg-section" },
        h("h2", { className: "seg-title" }, t("title")),
        h("p", { className: "seg-intro" }, t("intro")),
        h("div", { className: "seg-group" },
          h("p", { className: "seg-status" }, t("deleteHint"))),
        pageError != null
          ? h("p", { className: "seg-status" }, t("actionError").replace("{message}", pageError))
          : null,
        statusOrRows(t, view, archivedRow),
      );
    }

    /* ------------------------------------------- normally-invisible page */

    /**
     * The hidden-session listing carries `{groups, stats}` instead of a flat
     * `entries` array, so it has its own tiny loader.
     */
    function useHiddenList() {
      var pair = useState({ phase: "loading", data: null, error: null });
      var state = pair[0];
      var setState = pair[1];
      var mounted = react.useRef(true);
      var run = useCallback(() => {
        setState({ phase: "loading", data: null, error: null });
        Promise.resolve()
          .then(() => api.hiddenList())
          .then((value) => {
            if (mounted.current) setState({ phase: "ready", data: value, error: null });
          })
          .catch((error) => {
            if (mounted.current) setState({ phase: "error", data: null, error: error.message || String(error) });
          });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      useEffect(() => {
        run();
        return () => {
          mounted.current = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [run]);
      return { phase: state.phase, data: state.data, error: state.error, reload: run };
    }

    /**
     * "常规不可见会话" — every session that exists on disk, is in no recycle bin
     * and no archive, yet can never appear in the sidebar: subagent sessions
     * (split into leftovers whose parent is gone, and those whose parent is
     * still there), blank sessions and unowned sessions. Row actions and the
     * per-group batch action are the ordinary delete/purge paths, so a delete
     * here cascades to derived subagent sessions exactly like everywhere else.
     */
    function HiddenSection(props) {
      var t = props.t;
      var view = useHiddenList();
      var busyPair = useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var errorPair = useState(null);
      var pageError = errorPair[0];
      var setPageError = errorPair[1];

      function finish(result) {
        setBusy(false);
        if (result == null) return; // the dialog was cancelled: nothing changed
        var count = cascadedCount(result);
        showToast("ok", count > 0 ? t("toastTrashedWithChildren").replace("{count}", String(count)) : t("toastTrashed"));
        view.reload();
        notifyCatalogChanged();
      }

      /** Purge results can be partial: never report those as a clean success. */
      function reportPurge(result, okText) {
        setBusy(false);
        var failed = result != null && Array.isArray(result.failed) ? result.failed.length : 0;
        showToast(failed > 0 ? "err" : "ok", failed > 0 ? t("toastPartial").replace("{count}", String(failed)) : okText);
        view.reload();
        notifyCatalogChanged();
      }

      function softDelete(row) {
        if (busy) return;
        setPageError(null);
        Promise.resolve()
          .then(() => requestSoftDelete(t, row.sessionId, row.title))
          .then((ok) => {
            if (!ok) return null;
            setBusy(true);
            return api.trashAdd(row.sessionId, true);
          })
          .then(finish)
          .catch((error) => {
            setBusy(false);
            setPageError(friendlyError(error));
          });
      }

      function purgeOne(row) {
        if (busy) return;
        setPageError(null);
        Promise.resolve()
          .then(() => requestPurge(t, row.sessionId))
          .then((ok) => {
            if (!ok) return null;
            setBusy(true);
            return api.hiddenPurge([row.sessionId]);
          })
          .then((result) => {
            if (result == null) return;
            reportPurge(result, t("toastPurged"));
          })
          .catch((error) => {
            setBusy(false);
            setPageError(friendlyError(error));
          });
      }

      function purgeGroup(rows) {
        if (busy || rows.length === 0) return;
        setPageError(null);
        var titles = rows.map((row) => (row.title != null && row.title.length > 0 ? row.title : row.sessionId));
        Promise.resolve()
          .then(() => requestBatchPurge(t, titles))
          .then((ok) => {
            if (!ok) return null;
            setBusy(true);
            return api.hiddenPurge(rows.map((row) => row.sessionId));
          })
          .then((result) => {
            if (result == null) return;
            reportPurge(result, t("toastBatchPurged").replace("{count}", String(result.count != null ? result.count : 0)));
          })
          .catch((error) => {
            setBusy(false);
            setPageError(friendlyError(error));
          });
      }

      function metaText(row) {
        var parts = [];
        if (row.parentSession != null) {
          parts.push(row.parentTitle != null ? t("rowParent").replace("{title}", row.parentTitle) : t("rowParentMissing"));
        } else if (row.workspaceTitle != null) {
          parts.push(t("rowWorkspace").replace("{title}", row.workspaceTitle));
        } else {
          parts.push(t("rowUnowned"));
        }
        if (row.createdAt != null) parts.push(formatWhen(row.createdAt));
        if (row.running === true) parts.push(t("running"));
        return parts.join(" · ");
      }

      function hiddenRow(row) {
        return h(
          "li",
          { key: row.sessionId, className: "seg-row" },
          h(
            "div",
            { className: "seg-rowMain" },
            h("span", { className: "seg-rowTitle", title: row.sessionId }, titleText(t, row)),
            h("span", { className: "seg-rowSub" }, metaText(row)),
          ),
          h(
            "div",
            { className: "seg-actions" },
            actionButton(t("delete"), () => softDelete(row)),
            actionButton(t("purge"), () => purgeOne(row), true),
          ),
        );
      }

      function groupBlock(key, label, rows) {
        if (rows.length === 0) return null;
        return h(
          "div",
          { className: "seg-group", key: key },
          h(
            "div",
            { className: "seg-groupHeadRow" },
            h("p", { className: "seg-groupHead" }, t("groupCount").replace("{label}", label).replace("{count}", String(rows.length))),
            actionButton(t("batchButton").replace("{count}", String(rows.length)), () => purgeGroup(rows), true),
          ),
          h("ul", { className: "seg-rows" }, rows.map(hiddenRow)),
        );
      }

      if (view.phase === "loading") {
        return h("div", { className: "seg-section" }, h("p", { className: "seg-status" }, t("loading")));
      }
      if (view.phase === "error") {
        return h(
          "div",
          { className: "seg-section" },
          h("h2", { className: "seg-title" }, t("title")),
          h("p", { className: "seg-status" }, t("loadError").replace("{message}", view.error || "")),
          h("div", { className: "seg-actions", style: { marginLeft: 0 } }, actionButton(t("backToTop"), view.reload)),
        );
      }

      var groups = view.data != null && view.data.groups != null ? view.data.groups : {};
      var stats = view.data != null && view.data.stats != null ? view.data.stats : { count: 0, bytes: 0 };
      var subagents = groups.subagents != null ? groups.subagents : { leftover: [], attached: [] };
      var blank = Array.isArray(groups.blank) ? groups.blank : [];
      var unowned = Array.isArray(groups.unowned) ? groups.unowned : [];

      return h(
        "div",
        { className: "seg-section" },
        h("h2", { className: "seg-title" }, t("title")),
        h("p", { className: "seg-intro" }, t("intro")),
        h("p", { className: "seg-status" },
          t("statsLine").replace("{count}", String(stats.count || 0)).replace("{size}", formatBytes(stats.bytes || 0))),
        h("p", { className: "seg-status" }, t("deleteHint")),
        stats.truncated > 0
          ? h("p", { className: "seg-status" }, t("truncatedNote").replace("{count}", String(stats.truncated)))
          : null,
        pageError != null
          ? h("p", { className: "seg-status" }, t("actionError").replace("{message}", pageError))
          : null,
        stats.count === 0 ? emptyBlock(t, "empty") : null,
        groupBlock("subagent-leftover", t("groupLeftover"), Array.isArray(subagents.leftover) ? subagents.leftover : []),
        groupBlock("subagent-attached", t("groupAttached"), Array.isArray(subagents.attached) ? subagents.attached : []),
        groupBlock("blank", t("groupBlank"), blank),
        groupBlock("unowned", t("groupUnowned"), unowned),
      );
    }

    /* -------------------------------------------------------- lifecycle */

    /*
     * `sessions` is a HARD dependency, and that is load-bearing.
     *
     * Client services do not all exist when a plugin is applied: with only
     * slots/locale declared, apply() ran BEFORE the session controller had
     * published `sessions`, so the captured handle was null and every revive
     * silently no-opped on its first guard — the repair looked "deployed but
     * ineffective" no matter how correct the code was. Declaring it in inject
     * makes Cordis hold the plugin until the service appears (and reload it if
     * it is ever replaced).
     */
    var inject = ["slots", "locale", "sessions"];

    function registerSection(ctx, options, Component) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: options.id,
            order: options.order,
            label: () => ctx.locale.bind(options.locale)("nav"),
            locale: options.locale,
            inject: () => ({ api }),
          },
          Component,
        ),
      );
    }

    /**
     * Sidebar-menu delete. The menu lives outside React, so this path uses the
     * imperative dialog: a session that derived subagent sessions is confirmed
     * first (and then deleted together with them); a childless session is
     * moved to the recycle bin immediately, exactly as in 0.1.5.
     */
    function onMenuDelete(event) {
      var detail = event && event.detail ? event.detail : null;
      var sessionId = detail ? detail.sessionId : null;
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      var t = menuTranslate != null ? menuTranslate : null;
      if (t == null) return;
      var title = detail != null && typeof detail.title === "string" ? detail.title : null;
      Promise.resolve()
        .then(() => requestSoftDelete(t, sessionId, title))
        .then((ok) => (ok ? api.trashAdd(sessionId, true) : null))
        .then((result) => {
          if (result == null) return;
          var count = cascadedCount(result);
          showToast("ok", count > 0 ? t("toastTrashedWithChildren").replace("{count}", String(count)) : t("toastTrashed"));
          notifyCatalogChanged();
        })
        .catch((error) => {
          // eslint-disable-next-line no-console
          console.warn("Session-Manager-GUI: move-to-trash rejected:", error && error.message ? error.message : error);
          showToast("err", friendlyError(error));
        });
    }

    function apply(ctx) {
      ensureCss();
      /* The context must be recorded FIRST: every session lookup goes through
       * it lazily (see sessionStore). */
      clientCtx = ctx;
      // Install the catalog resync hook: the client `sessions` service exposes
      // refresh(), the same pull a reconnect performs (see notifyCatalogChanged).
      refreshSessionCatalog = () => {
        var sessions = ctx.get("sessions");
        if (sessions != null && typeof sessions.refresh === "function") return sessions.refresh();
        return undefined;
      };
      ctx.effect(() => ctx.locale.register("settings.sessionTrash", { zh: zhTrash, en: enTrash }), "Session-Manager-GUI.locale.trash");
      ctx.effect(() => ctx.locale.register("settings.sessionArchived", { zh: zhArchived, en: enArchived }), "Session-Manager-GUI.locale.archived");
      ctx.effect(() => ctx.locale.register("settings.sessionHidden", { zh: zhHidden, en: enHidden }), "Session-Manager-GUI.locale.hidden");
      menuTranslate = ctx.locale.bind("settings.sessionHidden");

      registerSection(
        ctx,
        { id: "session-trash", order: 30, locale: "settings.sessionTrash" },
        TrashSection,
      );
      registerSection(
        ctx,
        { id: "session-archived", order: 31, locale: "settings.sessionArchived" },
        ArchivedSection,
      );
      registerSection(
        ctx,
        { id: "session-hidden", order: 32, locale: "settings.sessionHidden" },
        HiddenSection,
      );

      ctx.effect(
        () => {
          if (typeof window === "undefined") return;
          window.addEventListener("Session-Manager-GUI:delete", onMenuDelete);
          return () => window.removeEventListener("Session-Manager-GUI:delete", onMenuDelete);
        },
        "Session-Manager-GUI.menuBridge",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
