// 静态自测：模拟浏览器里的 __ModuleLoader__，把 lib/client.js 跑一遍，
// 确认 factory 能正常求值、apply/inject 导出正确、注册调用的参数形状对得上。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? path.join(here, "..", "lib", "client.js");
const code = fs.readFileSync(file, "utf8");

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
    },
  },
};

// 最小的 react 替身：只需要 useEffect 不炸。
const fakeReact = {
  useEffect() {},
  useRef() {
    return { current: null };
  },
  useState(v) {
    return [v, () => {}];
  },
};

new Function(code)();

if (!captured) {
  console.error("FAIL: __ModuleLoader__.load 没有被调用");
  process.exit(1);
}
if (captured.id !== "dsh-chat-answer-anchor") {
  console.error("FAIL: id 不对 ->", captured.id);
  process.exit(1);
}

const mod = captured.factory((name) => {
  if (name === "react") return fakeReact;
  throw new Error("unexpected require: " + name);
});

console.log("id:", captured.id);
console.log("exports:", Object.keys(mod).join(", "));
console.log("inject:", JSON.stringify(mod.inject));
console.log("typeof apply:", typeof mod.apply);
console.log("typeof AnswerAnchorPanel:", typeof mod.AnswerAnchorPanel);

// 模拟一次 apply，看看注册参数长什么样。
const registered = [];
const ctx = {
  slots: {
    inject(key, fn) {
      console.log("slots.inject key:", key);
      fn();
    },
    register(options, component) {
      registered.push({ options, component });
    },
  },
};
mod.apply(ctx);
console.log("registered:", JSON.stringify(registered.map((r) => r.options)));
console.log("component === AnswerAnchorPanel:", registered[0]?.component === mod.AnswerAnchorPanel);

// 渲染一次，确认返回 null 且 useEffect 被调用。
let effectCalls = 0;
const react2 = {
  useEffect(fn) {
    effectCalls += 1;
    return undefined;
  },
};
globalThis.__reactSwap = react2;
console.log("OK");
