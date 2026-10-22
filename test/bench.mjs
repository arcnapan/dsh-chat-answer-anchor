// 微基准：量一下 Freeze.check() 这个热路径到底多贵。
// 用和 behav.mjs 一样的假 DOM，但行数按真实聊天规模给（比如 60 轮、每轮几行）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? path.join(here, "..", "lib", "client.js");
const code = fs.readFileSync(file, "utf8");

let now = 1000;
globalThis.performance = { now: () => now };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.MutationObserver = class {
	observe() {}
	disconnect() {}
};
globalThis.ResizeObserver = class {
	observe() {}
	disconnect() {}
};
globalThis.Event = class {
	constructor(t) {
		this.type = t;
	}
};

function storage() {
	const m = new Map();
	return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

class FakeEl {
	constructor() {
		this.dataset = {};
		this.isConnected = true;
		this.listeners = new Map();
		this._top = 0;
		this._h = 0;
		this._vh = 0;
		this.rows = [];
	}
	get scrollHeight() { return this._h; }
	set scrollHeight(v) { this._h = v; }
	get clientHeight() { return this._vh; }
	set clientHeight(v) { this._vh = v; }
	get scrollTop() {
		const max = Math.max(0, this._h - this._vh);
		return Math.max(0, Math.min(this._top, max));
	}
	set scrollTop(v) {
		const max = Math.max(0, this._h - this._vh);
		this._top = Math.max(0, Math.min(v, max));
	}
	addEventListener() {}
	removeEventListener() {}
	matches(s) { return s === "[data-conversation-scroll]"; }
	querySelector(s) { return s === "[data-chat-following-tail]" ? null : null; }
	querySelectorAll(s) { return s === "[data-chat-turn]" ? this.rows : []; }
	closest(s) { return s === "[data-conversation-session]" ? { dataset: { conversationSession: "bench" } } : null; }
}

const scroller = new FakeEl();
scroller.clientHeight = 800;
scroller.scrollHeight = 60000; // 60 轮左右的长会话
scroller.scrollTop = 20000;
// 造 120 个轮次行，模拟长会话
scroller.rows = Array.from({ length: 120 }, (_, i) => {
	const r = new FakeEl();
	r.dataset.chatTurn = String(i + 1);
	return r;
});

globalThis.document = {
	body: new FakeEl(),
	hidden: false,
	querySelectorAll: () => [scroller],
	addEventListener() {},
	removeEventListener() {},
};

let captured = null;
globalThis.window = {
	__ModuleLoader__: { load: (s) => (captured = s) },
	setInterval: () => 1,
	clearInterval: () => {},
	setTimeout: (fn) => { fn(); return 1; },
	clearTimeout: () => {},
	localStorage: storage(),
	sessionStorage: storage(),
};
new Function(code)();
const mod = captured.factory((n) => {
	if (n === "react") return { useEffect() {}, useState: (v) => [v, () => {}], createElement: () => null };
	throw new Error(n);
});

const { Freeze } = mod.__test;
const freeze = new Freeze(scroller);
now += 5000; // 越过手势窗口

// 稳态：位置没动、也没在跟随底部 —— 这是最常见的每 250ms 一次的情况
const N = 200000;
let t0 = process.hrtime.bigint();
for (let i = 0; i < N; i += 1) {
	now += 1;
	freeze.check(true);
}
let t1 = process.hrtime.bigint();
const idle = Number(t1 - t0) / N / 1000;
console.log(`稳态 check()（位置没动）: ${idle.toFixed(3)} 微秒/次`);

// 有位移、需要拉回的情况（更贵：写 scrollTop + publish）
scroller.scrollTop = 20000;
const M = 100000;
t0 = process.hrtime.bigint();
for (let i = 0; i < M; i += 1) {
	now += 1;
	scroller._top = 20050; // 被拽走 50px
	freeze.check(false);
}
t1 = process.hrtime.bigint();
const restore = Number(t1 - t0) / M / 1000;
console.log(`拉回一次（含写 scrollTop）: ${restore.toFixed(3)} 微秒/次`);

// 换算成「每小时多少毫秒」
const idleHourMs = (idle * (3600 * 1000 / 250)) / 1000;
console.log(`按 250ms 看门狗算，稳态每小时 CPU 时间约: ${idleHourMs.toFixed(1)} ms`);
