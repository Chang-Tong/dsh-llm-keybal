window.__ModuleLoader__.load({
  id: "dsh-llm-keybal",
  factory: (require) => {
"use strict";
var __dshKeybalClientFactory = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __export = (target, all) => {
    for (var name2 in all)
      __defProp(target, name2, { get: all[name2], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/client/index.ts
  var index_exports = {};
  __export(index_exports, {
    apply: () => apply,
    inject: () => inject,
    name: () => name
  });

  // src/client/KeyBalSection.tsx
  var import_react = __require("react");
  var import_jsx_runtime = __require("react/jsx-runtime");
  var KEYBAL_NS = "llm-keybal";
  var STRATEGIES = ["round-robin", "random", "least-used", "health"];
  function keyCountOf(view, provider, model) {
    if (view === void 0) return 0;
    const prefix = ["providers", provider, "models", model, "keys"];
    let count = 0;
    for (const secret of view.secrets ?? []) {
      if (secret.path.length === prefix.length && secret.path.every((segment, index) => segment === prefix[index])) {
        if (secret.set) count += 1;
      }
    }
    return count;
  }
  function strategyOf(view, provider, model) {
    const providers = view?.value?.providers;
    const strategy = providers?.[provider]?.models?.[model]?.strategy;
    return STRATEGIES.includes(strategy) ? strategy : "round-robin";
  }
  function keybalView(namespaces) {
    return namespaces?.find((entry) => entry.ns === KEYBAL_NS);
  }
  function modelRowsOf(view) {
    const providers = view?.value?.providers;
    if (providers === void 0) return [];
    const rows = [];
    for (const [provider, profile] of Object.entries(providers)) {
      const models = profile?.models ?? {};
      for (const [model, entry] of Object.entries(models)) {
        rows.push({
          provider,
          model,
          displayName: entry?.name ?? model,
          strategy: strategyOf(view, provider, model),
          keys: keyCountOf(view, provider, model)
        });
      }
    }
    return rows;
  }
  var styles = {
    wrap: {
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      padding: "4px 0"
    },
    hint: {
      fontSize: "12px",
      color: "var(--dsw-text-secondary, #666)",
      lineHeight: "1.5"
    },
    card: {
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      border: "1px solid var(--dsw-border-subtle, #e0e0e0)",
      borderRadius: "8px",
      padding: "10px 12px"
    },
    provider: {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      fontSize: "13px",
      fontWeight: 600
    },
    row: {
      display: "flex",
      alignItems: "center",
      gap: "10px",
      fontSize: "12px",
      color: "var(--dsw-text-primary, #222)"
    },
    modelName: {
      flex: "1",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    },
    keys: {
      color: "var(--dsw-text-secondary, #666)"
    },
    select: {
      fontSize: "12px",
      padding: "2px 4px",
      border: "1px solid var(--dsw-border-subtle, #c8c8c8)",
      borderRadius: "4px",
      background: "var(--dsw-surface-subtle, #fff)",
      color: "var(--dsw-text-primary, #222)"
    },
    message: {
      fontSize: "12px"
    },
    ok: { color: "var(--dsw-text-success, #2e7d32)" },
    error: { color: "var(--dsw-text-danger, #c62828)" },
    code: {
      fontFamily: "var(--dsw-font-mono, ui-monospace, SFMono-Regular, monospace)",
      fontSize: "12px",
      background: "var(--dsw-surface-subtle, #f2f2f2)",
      borderRadius: "4px",
      padding: "1px 5px"
    }
  };
  function copy() {
    const zh = typeof navigator !== "undefined" && /^zh\b/u.test(navigator.language ?? "");
    return zh ? {
      title: "KeyBal \u6C60",
      empty: "\u5C1A\u672A\u914D\u7F6E\u4EFB\u4F55 KeyBal \u6C60\u3002\u5728\u63D2\u4EF6\u914D\u7F6E\uFF08cordis.yml \u7684 providers\uFF09\u91CC\u58F0\u660E\uFF0C\u6216\u7528 /keybal-add-key \u8FFD\u52A0\u3002",
      addHint: "\u8FFD\u52A0 key\uFF1A/keybal-add-key <provider> <model> <key>",
      strategyLabel: "\u7B56\u7565",
      keysLabel: "keys",
      saved: "\u5DF2\u4FDD\u5B58",
      failed: "\u4FDD\u5B58\u5931\u8D25",
      loaded: "\u5DF2\u52A0\u8F7D"
    } : {
      title: "KeyBal pools",
      empty: "No KeyBal pools configured. Declare providers in the plugin config (cordis.yml) or append with /keybal-add-key.",
      addHint: "Append a key: /keybal-add-key <provider> <model> <key>",
      strategyLabel: "Strategy",
      keysLabel: "keys",
      saved: "Saved",
      failed: "Save failed",
      loaded: "Loaded"
    };
  }
  function KeyBalSection({ api }) {
    const [view, setView] = (0, import_react.useState)(void 0);
    const [unavailable, setUnavailable] = (0, import_react.useState)(false);
    const [revision, setRevision] = (0, import_react.useState)(void 0);
    const [saving, setSaving] = (0, import_react.useState)(false);
    const [message, setMessage] = (0, import_react.useState)(void 0);
    const copyText = (0, import_react.useMemo)(() => copy(), []);
    const rows = (0, import_react.useMemo)(() => modelRowsOf(view), [view]);
    const load = (0, import_react.useCallback)(async () => {
      try {
        const response = await api?.settings.describe({});
        if (response === void 0 || !response.result.ok) {
          setUnavailable(true);
          return;
        }
        const found = keybalView(response.result.value.namespaces);
        setView(found);
        setRevision(found?.revision);
        setUnavailable(false);
        setMessage((current) => current === void 0 ? { ok: true, text: copyText.loaded } : current);
      } catch {
        setUnavailable(true);
      }
    }, [api, copyText.loaded]);
    (0, import_react.useEffect)(() => {
      void load();
    }, [load]);
    const changeStrategy = async (provider, model, strategy) => {
      if (api === void 0 || revision === void 0) return;
      setSaving(true);
      setMessage(void 0);
      try {
        const response = await api.settings.update({
          ns: KEYBAL_NS,
          expectedRevision: revision,
          patch: {
            providers: {
              [provider]: {
                models: {
                  [model]: { strategy }
                }
              }
            }
          }
        });
        if (!response.result.ok) {
          setMessage({ ok: false, text: `${copyText.failed}: ${response.result.error.message}` });
          return;
        }
        setView(response.result.value);
        setRevision(response.result.value.revision);
        setMessage({ ok: true, text: copyText.saved });
      } catch (error) {
        setMessage({ ok: false, text: `${copyText.failed}: ${error instanceof Error ? error.message : String(error)}` });
      } finally {
        setSaving(false);
      }
    };
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.wrap, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.hint, children: copyText.addHint }),
      unavailable && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...styles.message, ...styles.error }, children: [
        copyText.failed,
        ": describe"
      ] }),
      !unavailable && rows.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.hint, children: copyText.empty }),
      rows.map((row) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.card, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.provider, children: row.provider }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.row, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.modelName, title: row.displayName, children: row.displayName }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: styles.keys, children: [
            row.keys,
            " ",
            copyText.keysLabel
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "inline-flex", alignItems: "center", gap: "4px" }, children: [
            copyText.strategyLabel,
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "select",
              {
                style: styles.select,
                value: row.strategy,
                disabled: saving,
                onChange: (event) => void changeStrategy(row.provider, row.model, event.target.value),
                children: STRATEGIES.map((strategy) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: strategy, children: strategy }, strategy))
              }
            )
          ] })
        ] })
      ] }, `${row.provider}/${row.model}`)),
      message !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...styles.message, ...message.ok ? styles.ok : styles.error }, children: message.text })
    ] });
  }

  // src/client/index.ts
  var name = "dsh-llm-keybal";
  var inject = ["slots", "connection"];
  function apply(ctx) {
    const connection = ctx.get("connection");
    ctx.slots.inject("settings.section", () => ctx.slots.register(
      {
        name: "settings.section",
        id: "llm-keybal",
        order: 12,
        label: () => "KeyBal \u6C60",
        inject: () => ({ api: connection.api })
      },
      KeyBalSection
    ));
  }
  return __toCommonJS(index_exports);
})();
//# sourceMappingURL=factory.js.map

    return __dshKeybalClientFactory;
  },
});
//# sourceMappingURL=client.js.map
