/**
 * Staging List — a per-session list of unsent drafts above the composer.
 *
 * Two slots carry the feature: a tray button in the composer tool row that
 * moves the current draft out of the composer, and the list panel above the
 * composer card. Items are plain text kept in this browser (`localStorage`,
 * keyed by session); the Host sees nothing until an item is sent through the
 * same `session.prompt` Remote the composer itself calls.
 *
 * File layout, top to bottom:
 *   store      one JSON document, `${sessionId} -> Item[]`, plus its hook
 *   copy       zh/en dictionaries bound to the Client locale service
 *   icons      inline SVGs (a plugin may not import Harness Client packages)
 *   styles     theme-token CSS for the panel, rows and buttons
 *   components editor, row, header, panel, composer button
 *   plugin     slot registrations
 */
window.__ModuleLoader__.load({
  id: "@ixtwuko/dsh-staging-list",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;

    /** Durable document: `{ [sessionId]: Item[] }`, shared by every session. */
    const STORAGE_KEY = "dsh.staging-list.v1";
    /** How long the clear button stays armed before reverting to its idle label. */
    const CLEAR_CONFIRM_MS = 4000;
    /** Reused so an empty session keeps a stable snapshot identity. */
    const EMPTY = Object.freeze([]);

    // ---------------------------------------------------------------------
    // Store
    // ---------------------------------------------------------------------

    // Parsed once, then kept in sync by every write. Never name this
    // `document`: a module-level binding would shadow the DOM global.
    let stored = null;
    const listeners = new Set();

    function readAll() {
      if (stored !== null) return stored;
      let parsed = null;
      try {
        const raw = globalThis.localStorage ? globalThis.localStorage.getItem(STORAGE_KEY) : null;
        if (typeof raw === "string" && raw !== "") parsed = JSON.parse(raw);
      } catch (_error) {
        parsed = null;
      }
      stored =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      return stored;
    }

    function saveAll() {
      try {
        if (globalThis.localStorage) {
          globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(readAll()));
        }
      } catch (_error) {
        // Quota exceeded, or a privacy mode that denies storage: the in-memory
        // list stays usable for this page.
      }
    }

    function notify() {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (_error) {
          // One broken subscriber must not starve the others.
        }
      }
    }

    function itemsOf(sessionId) {
      const items = readAll()[sessionId];
      return Array.isArray(items) ? items : EMPTY;
    }

    /** Replace one session's list, persist, and publish a new snapshot. */
    function setItems(sessionId, items) {
      const all = readAll();
      if (items.length === 0) delete all[sessionId];
      else all[sessionId] = items;
      saveAll();
      notify();
    }

    function mutate(sessionId, change) {
      setItems(sessionId, change(itemsOf(sessionId)));
    }

    function mintId() {
      const cryptoApi = globalThis.crypto;
      if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
      return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    const store = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },

      items: itemsOf,

      /** Append one item and return it, so the caller can open its editor. */
      add(sessionId, text) {
        const item = { id: mintId(), text: typeof text === "string" ? text : "" };
        mutate(sessionId, (items) => [...items, item]);
        return item;
      },

      update(sessionId, id, text) {
        mutate(sessionId, (items) =>
          items.map((item) => (item.id === id ? { ...item, text } : item)),
        );
      },

      remove(sessionId, id) {
        mutate(sessionId, (items) => items.filter((item) => item.id !== id));
      },

      /** Move the item at `from` so it lands at `to`; out-of-range is a no-op. */
      move(sessionId, from, to) {
        const items = itemsOf(sessionId);
        const inRange = (index) => Number.isInteger(index) && index >= 0 && index < items.length;
        if (from === to || !inRange(from) || !inRange(to)) return;
        const next = [...items];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        setItems(sessionId, next);
      },

      clear(sessionId) {
        setItems(sessionId, []);
      },
    };

    /** The live items of one session; the identity changes only with content. */
    function useItems(sessionId) {
      return useSyncExternalStore(store.subscribe, () => store.items(sessionId));
    }

    // ---------------------------------------------------------------------
    // Copy
    // ---------------------------------------------------------------------

    const DICT = {
      zh: {
        "staging.count": "{n} 条待发送",
        "staging.stash": "暂存当前草稿",
        "staging.add": "新增条目",
        "staging.clear": "清空",
        "staging.clearAll": "清空全部暂存",
        "staging.clearConfirm": "确认清空",
        "staging.expand": "展开",
        "staging.collapse": "收起",
        "staging.send": "发送",
        "staging.sending": "发送中…",
        "staging.edit": "编辑条目",
        "staging.delete": "删除这条",
        "staging.drag": "拖拽排序",
        "staging.empty": "（空）",
        "staging.placeholder": "输入要暂存的内容",
        "staging.sendFailed": "发送失败",
        "staging.unsupported": "当前界面不支持直接发送，请在输入框中手动发送。",
      },
      en: {
        "staging.count": "{n} unsent",
        "staging.stash": "Stage current draft",
        "staging.add": "Add item",
        "staging.clear": "Clear",
        "staging.clearAll": "Clear all staged items",
        "staging.clearConfirm": "Confirm clear",
        "staging.expand": "Expand",
        "staging.collapse": "Collapse",
        "staging.send": "Send",
        "staging.sending": "Sending…",
        "staging.edit": "Edit item",
        "staging.delete": "Delete this item",
        "staging.drag": "Drag to reorder",
        "staging.empty": "(empty)",
        "staging.placeholder": "Type something to stage",
        "staging.sendFailed": "Send failed",
        "staging.unsupported": "Sending is unavailable here; send it from the composer instead.",
      },
    };

    function prefersChinese() {
      try {
        return String(globalThis.navigator?.language ?? "zh")
          .toLowerCase()
          .startsWith("zh");
      } catch (_error) {
        return true;
      }
    }

    const FALLBACK = prefersChinese() ? DICT.zh : DICT.en;

    /**
     * Bind a slot's `t` to this plugin's keys.
     *
     * The bound translator already resolves the namespace; this covers the two
     * cases it cannot: a dictionary that has not registered yet (before
     * activation lands) and `{name}` interpolation.
     */
    function translate(t) {
      return (key, vars) => {
        let text;
        if (typeof t === "function") {
          try {
            text = t(key, vars);
          } catch (_error) {
            text = undefined;
          }
        }
        if (typeof text !== "string" || text === key) text = FALLBACK[key] ?? key;
        if (vars === undefined) return text;
        return text.replace(/\{(\w+)\}/g, (match, name) =>
          vars[name] === undefined ? match : String(vars[name]),
        );
      };
    }

    /** Copy for strings built outside a slot render, where no bound `t` exists. */
    const fallbackText = translate(null);

    // ---------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------

    function icon(children, size) {
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: size ?? 16,
          height: size ?? 16,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.4,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
          focusable: false,
        },
        children,
      );
    }

    function TrayIcon() {
      return icon([
        h("rect", { key: "box", x: 2, y: 3, width: 12, height: 10, rx: 2 }),
        h("path", { key: "lip", d: "M2 9h3l1 1.6h4L11 9h3" }),
      ]);
    }

    function ChevronIcon({ up }) {
      return icon([h("path", { key: "chevron", d: up ? "M4 9.5l4-4 4 4" : "M4 6.5l4 4 4-4" })], 14);
    }

    function PlusIcon() {
      return icon([h("path", { key: "plus", d: "M8 3.5v9M3.5 8h9" })], 15);
    }

    function CloseIcon() {
      return icon([h("path", { key: "cross", d: "M4.5 4.5l7 7M11.5 4.5l-7 7" })], 15);
    }

    function SendIcon() {
      return icon([h("path", { key: "arrow", d: "M8 12.5V4M4.5 7.5L8 4l3.5 3.5" })], 15);
    }

    function GripIcon() {
      const dots = [];
      for (let row = 0; row < 3; row += 1) {
        const cy = 4.5 + row * 3.5;
        dots.push(
          h("circle", {
            key: `l${row}`,
            cx: 6.5,
            cy,
            r: 0.9,
            fill: "currentColor",
            stroke: "none",
          }),
        );
        dots.push(
          h("circle", {
            key: `r${row}`,
            cx: 9.5,
            cy,
            r: 0.9,
            fill: "currentColor",
            stroke: "none",
          }),
        );
      }
      return icon(dots);
    }

    // ---------------------------------------------------------------------
    // Styles — theme tokens only, so light/dark follow the host
    // ---------------------------------------------------------------------

    const CSS = [
      // Frame: tucks into the composer column above the input card.
      ".dsl_dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto 6px;padding:0 var(--dsh-composer-dock-inset);flex:none}",
      ".dsl_panel{isolation:isolate;position:relative;width:100%;padding:2px 0;border-radius:var(--dsw-radius-lg);overflow:hidden;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}",
      '.dsl_panel:before{z-index:-1;position:absolute;inset:0;content:"";pointer-events:none;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter)}',
      '.dsl_panel:after{position:absolute;inset:0;content:"";pointer-events:none;border:.5px solid var(--dsw-alias-border-l1);border-radius:inherit}',

      // Header: tray mark, count, clear, collapse.
      ".dsl_header{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:4px 6px 4px 12px;color:var(--dsw-alias-label-primary)}",
      ".dsl_lead{display:grid;flex:none;place-items:center;color:var(--dsw-alias-label-tertiary)}",
      ".dsl_count{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:Inter,var(--dsw-font-family);font-size:13px;font-weight:500;line-height:24px}",
      ".dsl_headerActions{display:flex;flex:none;align-items:center;gap:2px}",
      ".dsl_clear{height:26px;padding:0 8px;border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary);font-family:Inter,var(--dsw-font-family);font-size:12px;line-height:26px;white-space:nowrap;cursor:pointer}",
      ".dsl_clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsl_clear:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}",
      ".dsl_clearConfirm{color:var(--dsw-alias-state-error-primary)}",
      ".dsl_clearConfirm:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}",

      // Rows: grip, one-line preview, always-present actions.
      ".dsl_list{max-height:184px;margin:0;padding:0;list-style:none;overflow-y:auto}",
      ".dsl_row{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:4px 6px;border-radius:var(--dsw-radius-md)}",
      ".dsl_row+.dsl_row{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}",
      ".dsl_rowDragging{opacity:.45}",
      ".dsl_rowOver{box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary);border-radius:var(--dsw-radius-md)}",
      ".dsl_grip{display:grid;flex:none;place-items:center;width:14px;height:20px;color:var(--dsw-alias-label-tertiary);cursor:grab}",
      ".dsl_grip:active{cursor:grabbing}",
      ".dsl_preview{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 0;border:none;background:0 0;color:var(--dsw-alias-label-primary-dimmed);font-family:Inter,var(--dsw-font-family);font:var(--dsw-font-xs-13);text-align:left;cursor:text}",
      ".dsl_previewEmpty{color:var(--dsw-alias-label-tertiary)}",

      // Icon buttons shared by rows and the header.
      ".dsl_actions{display:flex;flex:none;align-items:center;gap:2px}",
      ".dsl_action{display:grid;flex:none;place-items:center;width:26px;height:26px;padding:0;border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;corner-shape:round}",
      ".dsl_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsl_action:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}",
      ".dsl_action:disabled{cursor:default;opacity:.45}",
      ".dsl_actionSend{color:var(--dsw-alias-brand-primary)}",
      ".dsl_actionDanger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}",

      // Editor, replacing the preview in place.
      ".dsl_textarea{box-sizing:border-box;flex:auto;min-width:0;min-height:26px;max-height:120px;padding:4px 6px;border:none;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:Inter,var(--dsw-font-family);font:var(--dsw-font-xs-13);resize:none;overflow-y:auto}",
      ".dsl_textarea:focus{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:0}",
      ".dsl_status{flex:none;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);white-space:nowrap}",

      // Trailing add row.
      ".dsl_addRow{display:block;padding:2px 6px 4px}",
      ".dsl_row+.dsl_addRow{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}",
      ".dsl_add{display:flex;align-items:center;gap:6px;width:100%;height:30px;padding:0 8px;border:none;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-tertiary);font-family:Inter,var(--dsw-font-family);font-size:13px;line-height:20px;text-align:left;cursor:pointer}",
      ".dsl_add:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsl_add:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}",

      // Send failure, and the composer tool-row button.
      ".dsl_error{display:flex;align-items:center;gap:6px;padding:2px 12px 6px 34px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:16px}",
      ".dsl_tool{display:grid;flex:none;place-items:center;width:28px;height:28px;padding:0;border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}",
      ".dsl_tool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsl_tool:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}",
      ".dsl_tool:disabled{cursor:default;opacity:.45}",
      ".dsl_toolActive{color:var(--dsw-alias-brand-primary)}",
    ].join("\n");

    function installStyles(ctx) {
      ctx.effect(() => {
        if (typeof document === "undefined") return () => {};
        const id = "@ixtwuko/dsh-staging-list/styles";
        let tag = document.querySelector(`style[data-plugin-css="${id}"]`);
        if (tag === null) {
          tag = document.createElement("style");
          tag.dataset.plugin = "@ixtwuko/dsh-staging-list";
          tag.dataset.pluginCss = id;
          tag.textContent = CSS;
          document.head.appendChild(tag);
        }
        return () => {
          tag.remove();
        };
      }, "staging-list: styles");
    }

    // ---------------------------------------------------------------------
    // Components
    // ---------------------------------------------------------------------

    /** First non-blank line, for the one-line row preview. */
    function firstLine(text) {
      const line = String(text)
        .split("\n")
        .find((candidate) => candidate.trim() !== "");
      return line === undefined ? "" : line.trim();
    }

    /**
     * In-place editor for one item: a self-sizing textarea that saves on blur,
     * cancels on `Escape`, and commits on `Cmd/Ctrl+Enter`.
     */
    function ItemEditor({ value, label, onCommit, onCancel }) {
      const [text, setText] = useState(value);
      const node = useRef(null);
      const cancelled = useRef(false);

      const fit = useCallback(() => {
        const element = node.current;
        if (element === null) return;
        element.style.height = "auto";
        element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
      }, []);

      useEffect(() => {
        const element = node.current;
        if (element === null) return;
        element.focus();
        element.setSelectionRange(element.value.length, element.value.length);
        fit();
      }, [fit]);

      useEffect(() => {
        fit();
      }, [fit, text]);

      return h("textarea", {
        ref: node,
        className: "dsl_textarea",
        value: text,
        rows: 1,
        spellCheck: false,
        "aria-label": label,
        placeholder: label,
        onChange: (event) => setText(event.target.value),
        onBlur: () => {
          if (!cancelled.current) onCommit(text);
        },
        onKeyDown: (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancelled.current = true;
            onCancel();
            return;
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.blur();
          }
        },
      });
    }

    /**
     * One staged entry: drag handle, preview or editor, send, delete.
     *
     * The actions stay mounted while editing. Their `mousedown` default is
     * prevented so the editor keeps the caret and the handler still reads the
     * text being edited.
     */
    function StagingRow({
      item,
      index,
      tr,
      editingText,
      sending,
      busy,
      dragging,
      dropTarget,
      canDrop,
      handlers,
    }) {
      const isEditing = editingText !== null;
      const currentText = isEditing ? editingText : item.text;
      const preview = firstLine(item.text);
      const classes = ["dsl_row"];
      if (dragging) classes.push("dsl_rowDragging");
      if (dropTarget) classes.push("dsl_rowOver");

      return h(
        "li",
        {
          className: classes.join(" "),
          draggable: !isEditing,
          onDragStart: (event) => {
            if (isEditing) return;
            try {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", String(index));
            } catch (_error) {
              // Some engines refuse setData outside a real drag.
            }
            handlers.startDrag(index);
          },
          onDragOver: (event) => {
            if (!canDrop) return;
            event.preventDefault();
            handlers.hover(index);
          },
          onDragLeave: () => handlers.leave(index),
          onDrop: (event) => {
            event.preventDefault();
            handlers.drop(index);
          },
          onDragEnd: handlers.endDrag,
        },
        h(
          "span",
          { key: "grip", className: "dsl_grip", title: tr("staging.drag"), "aria-hidden": true },
          h(GripIcon),
        ),
        isEditing
          ? h(ItemEditor, {
              key: "editor",
              value: editingText,
              label: tr("staging.placeholder"),
              onCommit: (text) => handlers.commit(item.id, text),
              onCancel: handlers.cancelEdit,
            })
          : h(
              "button",
              {
                key: "preview",
                type: "button",
                className: preview === "" ? "dsl_preview dsl_previewEmpty" : "dsl_preview",
                title: tr("staging.edit"),
                onClick: () => handlers.edit(item),
              },
              preview === "" ? tr("staging.empty") : preview,
            ),
        h(
          "span",
          { key: "actions", className: "dsl_actions" },
          sending
            ? h("span", { key: "status", className: "dsl_status" }, tr("staging.sending"))
            : null,
          h(
            "button",
            {
              key: "send",
              type: "button",
              className: "dsl_action dsl_actionSend",
              title: tr("staging.send"),
              "aria-label": tr("staging.send"),
              disabled: busy || currentText.trim() === "",
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => handlers.send(item.id, currentText, isEditing ? editingText : null),
            },
            h(SendIcon),
          ),
          h(
            "button",
            {
              key: "delete",
              type: "button",
              className: "dsl_action dsl_actionDanger",
              title: tr("staging.delete"),
              "aria-label": tr("staging.delete"),
              disabled: busy,
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => handlers.remove(item.id),
            },
            h(CloseIcon),
          ),
        ),
      );
    }

    /** Panel title bar: how many are waiting, clear (armed twice), collapse. */
    function StagingHeader({ count, tr, confirmClear, collapsed, onClear, onToggle }) {
      return h(
        "div",
        { className: "dsl_header" },
        h("span", { className: "dsl_lead", "aria-hidden": true }, h(TrayIcon)),
        h("span", { className: "dsl_count" }, tr("staging.count", { n: count })),
        h(
          "span",
          { className: "dsl_headerActions" },
          h(
            "button",
            {
              type: "button",
              className: confirmClear ? "dsl_clear dsl_clearConfirm" : "dsl_clear",
              title: confirmClear ? tr("staging.clearConfirm") : tr("staging.clearAll"),
              onClick: onClear,
            },
            confirmClear ? tr("staging.clearConfirm") : tr("staging.clear"),
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsl_action",
              title: collapsed ? tr("staging.expand") : tr("staging.collapse"),
              "aria-label": collapsed ? tr("staging.expand") : tr("staging.collapse"),
              "aria-expanded": !collapsed,
              onClick: onToggle,
            },
            h(ChevronIcon, { up: !collapsed }),
          ),
        ),
      );
    }

    /** The list panel; renders nothing while the session has no staged items. */
    function StagingDock({ sessionId, t, promptApi }) {
      const tr = translate(t);
      const items = useItems(sessionId);
      const [collapsed, setCollapsed] = useState(false);
      const [editing, setEditing] = useState(null);
      const [sendingId, setSendingId] = useState(null);
      const [failure, setFailure] = useState(null);
      const [confirmClear, setConfirmClear] = useState(false);
      const [dragIndex, setDragIndex] = useState(null);
      const [overIndex, setOverIndex] = useState(null);
      const clearTimer = useRef(null);

      useEffect(
        () => () => {
          if (clearTimer.current !== null) clearTimeout(clearTimer.current);
        },
        [],
      );

      // An item can disappear underneath an open editor (delete, clear, or the
      // same session in another tab): close the editor with it.
      useEffect(() => {
        if (editing !== null && !items.some((item) => item.id === editing.id)) setEditing(null);
      }, [editing, items]);

      if (items.length === 0) return null;

      const cancelClear = () => {
        setConfirmClear(false);
        if (clearTimer.current !== null) {
          clearTimeout(clearTimer.current);
          clearTimer.current = null;
        }
      };

      const requestClear = () => {
        if (confirmClear) {
          cancelClear();
          store.clear(sessionId);
          return;
        }
        setConfirmClear(true);
        if (clearTimer.current !== null) clearTimeout(clearTimer.current);
        clearTimer.current = setTimeout(() => {
          clearTimer.current = null;
          setConfirmClear(false);
        }, CLEAR_CONFIRM_MS);
      };

      const edit = (item) => setEditing({ id: item.id, text: item.text });

      const commit = (id, text) => {
        if (items.some((item) => item.id === id)) store.update(sessionId, id, text);
        setEditing(null);
      };

      const remove = (id) => {
        setEditing(null);
        store.remove(sessionId, id);
      };

      const addBlank = () => {
        const item = store.add(sessionId, "");
        setCollapsed(false);
        setEditing({ id: item.id, text: "" });
      };

      const sendItem = async (id, text) => {
        const body = text.trim();
        if (sendingId !== null || body === "") return;
        setFailure(null);
        setSendingId(id);
        try {
          const result = await promptApi()({
            requestId: mintId(),
            sessionId,
            mode: "queue",
            content: [{ type: "text", text: body }],
          });
          if (result?.ok === true) {
            store.remove(sessionId, id);
            return;
          }
          setFailure({ id, message: result?.error?.message || tr("staging.sendFailed") });
        } catch (error) {
          setFailure({ id, message: error?.message || tr("staging.sendFailed") });
        } finally {
          setSendingId(null);
        }
      };

      const handlers = {
        startDrag: setDragIndex,
        hover: setOverIndex,
        leave: (at) => setOverIndex((current) => (current === at ? null : current)),
        drop: (index) => {
          const from = dragIndex;
          setOverIndex(null);
          setDragIndex(null);
          if (from !== null) store.move(sessionId, from, index);
        },
        endDrag: () => {
          setDragIndex(null);
          setOverIndex(null);
        },
        edit,
        commit,
        cancelEdit: () => setEditing(null),
        remove,
        send: (id, text, committed) => {
          if (committed !== null) commit(id, committed);
          void sendItem(id, text);
        },
      };

      const rows = items.map((item, index) =>
        h(StagingRow, {
          key: item.id,
          item,
          index,
          tr,
          handlers,
          editingText: editing !== null && editing.id === item.id ? editing.text : null,
          sending: sendingId === item.id,
          busy: sendingId !== null,
          dragging: dragIndex === index,
          dropTarget: overIndex === index && dragIndex !== null && dragIndex !== index,
          canDrop: dragIndex !== null,
        }),
      );

      // Adding belongs where a new item would land: after the last row.
      const addRow = h(
        "li",
        { key: "__add", className: "dsl_addRow" },
        h(
          "button",
          { type: "button", className: "dsl_add", title: tr("staging.add"), onClick: addBlank },
          h(PlusIcon),
          h("span", null, tr("staging.add")),
        ),
      );

      const visibleFailure =
        failure !== null && items.some((item) => item.id === failure.id) ? failure : null;

      return h(
        "div",
        { className: "dsl_dock" },
        h(
          "div",
          { className: "dsl_panel" },
          h(StagingHeader, {
            count: items.length,
            tr,
            confirmClear,
            collapsed,
            onClear: requestClear,
            onToggle: () => setCollapsed((value) => !value),
          }),
          h("ul", { className: "dsl_list", hidden: collapsed }, ...rows, addRow),
          visibleFailure === null
            ? null
            : h(
                "div",
                { className: "dsl_error", role: "alert" },
                `${tr("staging.sendFailed")} · ${visibleFailure.message}`,
              ),
        ),
      );
    }

    /** Composer tool-row button: stage the draft, or add an empty entry. */
    function StagingStashButton({ sessionId, useInput, inputActions, t }) {
      const tr = translate(t);
      const items = useItems(sessionId);
      const draft = useInput((state) => state?.draft);
      const phase = useInput((state) => state?.phase);
      const text = typeof draft === "string" ? draft : "";
      const busy = phase === "submitting" || phase === "adjudicating";
      const empty = text.trim() === "";
      const action = empty ? tr("staging.add") : tr("staging.stash");
      const title =
        items.length > 0 ? `${action} · ${tr("staging.count", { n: items.length })}` : action;

      return h(
        "button",
        {
          type: "button",
          className: items.length > 0 ? "dsl_tool dsl_toolActive" : "dsl_tool",
          title,
          "aria-label": title,
          "data-staging-stash": "",
          disabled: busy,
          onClick: () => {
            if (busy) return;
            store.add(sessionId, empty ? "" : text);
            if (!empty) inputActions.setDraft("");
          },
        },
        h(TrayIcon),
      );
    }

    // ---------------------------------------------------------------------
    // Plugin
    // ---------------------------------------------------------------------

    const STASH_SLOT = {
      name: "conversation.input.left",
      id: "staging-stash",
      order: 40,
      locale: "staging",
    };

    const LIST_SLOT = {
      name: "conversation.input.dock",
      id: "staging-list",
      order: 30,
      locale: "staging",
    };

    return {
      // `remote.session` is a child service of the API gateway; Cordis refuses
      // the property read unless both keys are declared here.
      inject: ["slots", "locale", "remote", "remote.session"],

      apply(ctx) {
        installStyles(ctx);
        ctx.effect(() => ctx.locale.register("staging", DICT), "staging-list: locale");

        const promptApi = () => {
          const api = ctx.remote?.session;
          if (api === undefined || typeof api.prompt !== "function") {
            throw new Error(fallbackText("staging.unsupported"));
          }
          return api.prompt.bind(api);
        };

        ctx.slots.inject("conversation.input.left", () =>
          ctx.slots.register(STASH_SLOT, StagingStashButton),
        );

        ctx.slots.inject("conversation.input.dock", () =>
          ctx.slots.register({ ...LIST_SLOT, inject: () => ({ promptApi }) }, StagingDock),
        );
      },
    };
  },
});
