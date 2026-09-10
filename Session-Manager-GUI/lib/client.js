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
      ".seg-modal-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px}"
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
      trashAdd: (sessionId) => apiPost("/trash/add", { sessionId }),
      trashRestore: (sessionId) => apiPost("/trash/restore", { sessionId }),
      trashPurge: (sessionId) => apiPost("/trash/purge", { sessionId }),
      archivedList: () => apiGet("/archived/list"),
      archivedRestore: (sessionId) => apiPost("/archived/restore", { sessionId }),
      archivedDelete: (sessionId) => apiPost("/archived/delete", { sessionId }),
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

    function notifyCatalogChanged() {
      try {
        if (typeof refreshSessionCatalog !== "function") return;
        var pending = refreshSessionCatalog();
        if (pending != null && typeof pending.catch === "function") pending.catch(function () {});
      } catch (error) {
        /* best effort: a failed resync must never fail the action itself */
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
      deleteHint: "移入回收站的会话仅从列表中移除，日志与缓存会保留到“彻底删除”。"
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
      deleteHint: "Trashed sessions are only hidden; their logs and cache stay until purged."
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
      deleteHint: "“删除会话”会将会话移入回收站，可随时恢复。",
      actionError: "操作失败：{message}"
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
      deleteHint: "“Delete” moves the session to the trash, where it can still be restored.",
      actionError: "Action failed: {message}"
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
        { key: sid != null ? sid : "row-" + Math.random().toString(36).slice(2), className: "seg-row" },
        h("span", { className: "seg-rowTitle", title: sid != null ? sid : "" }, titleText(t, entry)),
        h("div", { className: "seg-actions" }, actions),
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

    /* ------------------------------------------------------- trash page */

    /**
     * Confirmation dialog for the irreversible purge action. The message is
     * fixed by product copy; “不可恢复 / cannot be recovered” is emphasised in
     * red bold. Left button cancels, right button confirms. Escape and a
     * mask click also cancel (never confirm).
     */
    function PurgeConfirmDialog(props) {
      var t = props.t;
      var busyRef = react.useRef(props.busy);
      busyRef.current = props.busy;
      useEffect(() => {
        function onKey(event) {
          if (event.key === "Escape" && !busyRef.current) props.onCancel();
        }
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return h(
        "div",
        {
          className: "seg-modal-mask",
          role: "presentation",
          onClick: (event) => {
            if (event.target === event.currentTarget) props.onCancel();
          },
        },
        h(
          "div",
          { className: "seg-modal", role: "dialog", "aria-modal": "true" },
          h(
            "p",
            { className: "seg-modal-text" },
            t("purgeConfirmTitle"),
            h("span", { className: "seg-danger-bold" }, t("purgeConfirmHighlight")),
            t("purgeConfirmTail"),
          ),
          h(
            "div",
            { className: "seg-modal-actions" },
            actionButton(t("cancel"), () => {
              if (!props.busy) props.onCancel();
            }),
            actionButton(
              t("purgeConfirmAction"),
              () => {
                if (!props.busy) props.onConfirm();
              },
              true,
            ),
          ),
        ),
      );
    }

    function TrashSection(props) {
      var t = props.t;
      var view = useRows(() => api.trashList());
      var pendingState = useState(null); // entry awaiting permanent-delete confirmation
      var pending = pendingState[0];
      var setPending = pendingState[1];
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

      var restoreRow = (entry) => {
        var sid = sessionIdOf(entry);
        if (sid == null) return null;
        return rowItem(t, entry, [
          actionButton(t("restore"), () => runAction(sid, api.trashRestore, view.reload)),
          actionButton(t("purge"), () => setPending(entry), true),
        ]);
      };

      var confirmSid = pending != null ? sessionIdOf(pending) : null;

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
        pending != null && confirmSid != null
          ? h(PurgeConfirmDialog, {
              t: t,
              busy: busyId === confirmSid,
              onCancel: () => {
                if (busyId == null) setPending(null);
              },
              onConfirm: () => {
                runAction(confirmSid, api.trashPurge, () => {
                  setPending(null);
                  view.reload();
                });
              },
            })
          : null,
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

      var archivedRow = (entry) => {
        var sid = sessionIdOf(entry);
        if (sid == null) return null;
        return rowItem(t, entry, [
          actionButton(t("restore"), () => runAction(sid, api.archivedRestore, view.reload)),
          actionButton(t("delete"), () => runAction(sid, api.archivedDelete, view.reload), true),
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

    /* -------------------------------------------------------- lifecycle */

    var inject = ["slots", "locale"];

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

    function onMenuDelete(event) {
      var detail = event && event.detail ? event.detail : null;
      var sessionId = detail ? detail.sessionId : null;
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      api.trashAdd(sessionId).then(
        function () {
          showToast("ok", "已移入回收站");
          notifyCatalogChanged();
        },
        function (error) {
          // eslint-disable-next-line no-console
          console.warn("Session-Manager-GUI: move-to-trash rejected:", error && error.message ? error.message : error);
          showToast("err", friendlyError(error));
        },
      );
    }

    function apply(ctx) {
      ensureCss();
      // Install the catalog resync hook: the client `sessions` service exposes
      // refresh(), the same pull a reconnect performs (see notifyCatalogChanged).
      refreshSessionCatalog = () => {
        var sessions = ctx.get("sessions");
        if (sessions != null && typeof sessions.refresh === "function") return sessions.refresh();
        return undefined;
      };
      ctx.effect(() => ctx.locale.register("settings.sessionTrash", { zh: zhTrash, en: enTrash }), "Session-Manager-GUI.locale.trash");
      ctx.effect(() => ctx.locale.register("settings.sessionArchived", { zh: zhArchived, en: enArchived }), "Session-Manager-GUI.locale.archived");

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
