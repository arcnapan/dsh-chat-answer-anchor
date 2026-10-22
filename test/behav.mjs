// 行为自测：用最小假 DOM 跑一遍「冻结视口位置」的逻辑。
// 只测逻辑，不测真实浏览器布局。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? path.join(here, "..", "lib", "client.js");
const code = fs.readFileSync(file, "utf8");

// ---------- 可控时钟 ----------
let now = 1000;
globalThis.performance = { now: () => now };

// ---------- 可控 rAF ----------
let rafQueue = [];
globalThis.requestAnimationFrame = (fn) => {
	rafQueue.push(fn);
	return rafQueue.length;
};
globalThis.cancelAnimationFrame = () => {};

// ---------- 可控定时器 ----------
let intervals = new Map();
let intervalSeq = 0;

// ---------- 最小 observer ----------
globalThis.MutationObserver = class {
	constructor(cb) {
		this.cb = cb;
		this.observed = [];
	}
	observe(target, opts) {
		this.observed.push({ target, opts });
	}
	disconnect() {
		this.observed = [];
	}
};

globalThis.ResizeObserver = class {
	constructor(cb) {
		this.cb = cb;
		this.targets = [];
		this.disconnected = false;
	}
	observe(el) {
		this.targets.push(el);
	}
	disconnect() {
		this.disconnected = true;
		this.targets = [];
	}
};

globalThis.Event = class {
	constructor(type) {
		this.type = type;
	}
};

// ---------- 最小存储 ----------
function makeStorage() {
	const map = new Map();
	return {
		map,
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => map.set(k, String(v)),
		removeItem: (k) => map.delete(k),
	};
}

// ---------- 最小元素 ----------
class FakeEl {
	constructor(name) {
		this.name = name;
		this.dataset = {};
		this.isConnected = true;
		this.listeners = new Map();
		this._scrollTop = 0;
		this._scrollHeight = 0;
		this._clientHeight = 0;
		this.dispatched = [];
	}
	// 像真浏览器一样：读 scrollTop 会被夹在 [0, scrollHeight-clientHeight]，
	// 内容变矮时读到的就是新的底部位置。
	get scrollHeight() {
		return this._scrollHeight;
	}
	set scrollHeight(v) {
		this._scrollHeight = v;
	}
	get clientHeight() {
		return this._clientHeight;
	}
	set clientHeight(v) {
		this._clientHeight = v;
	}
	get scrollTop() {
		const max = Math.max(0, this._scrollHeight - this._clientHeight);
		return Math.max(0, Math.min(this._scrollTop, max));
	}
	set scrollTop(v) {
		const max = Math.max(0, this._scrollHeight - this._clientHeight);
		this._scrollTop = Math.max(0, Math.min(v, max));
	}
	getBoundingClientRect() {
		return { top: 0, left: 0, height: this.clientHeight };
	}
	addEventListener(type, fn, opts) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		this.listeners.get(type).push({ fn, opts });
	}
	removeEventListener(type, fn, opts) {
		const arr = this.listeners.get(type);
		if (!arr) return;
		const i = arr.findIndex((x) => x.fn === fn);
		if (i >= 0) arr.splice(i, 1);
	}
	listenerCount(type) {
		return (this.listeners.get(type) ?? []).length;
	}
	dispatchEvent(ev) {
		this.dispatched.push(ev.type);
		for (const { fn } of [...(this.listeners.get(ev.type) ?? [])]) fn(ev);
		return true;
	}
	matches(sel) {
		return sel === "[data-conversation-scroll]" && this.isConversation === true;
	}
	querySelector(sel) {
		if (sel === "[data-chat-following-tail]") return this.tailEl ?? null;
		if (sel === "[data-chat-flow]") return this.flowEl ?? null;
		return null;
	}
	querySelectorAll(sel) {
		if (sel === "[data-chat-turn]") return (this.rows ?? []).filter((r) => r.isConnected);
		if (sel === '[data-chat-flow-kind="user"]') {
			return (this.rows ?? []).filter((r) => r.isConnected && r.dataset.chatFlowKind === "user");
		}
		return [];
	}
	closest(sel) {
		if (sel === "[data-conversation-session]") return this.sessionHost ?? null;
		return null;
	}
}

/** 造一个滚动容器：内容高度 = contentHeight，视口 = viewport。 */
function buildChat({ contentHeight = 2000, viewport = 400, session = null } = {}) {
	const scroller = new FakeEl("scroller");
	scroller.isConversation = true;
	scroller.clientHeight = viewport;
	scroller.scrollHeight = contentHeight;
	scroller.scrollTop = 0;
	if (session !== null) {
		scroller.sessionHost = { dataset: { conversationSession: session } };
	}
	scroller.setFollowingTail = (on) => {
		scroller.tailEl = on ? new FakeEl("tailflag") : null;
	};
	scroller.max = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
	scroller.bottom = () => {
		scroller.scrollTop = scroller.max();
	};
	return scroller;
}

/** 造 n 个轮次行（只用于 countRows 计数）。 */
function addRows(scroller, specs) {
	scroller.rows = specs.map((s, i) => {
		const row = new FakeEl(`row-${i}`);
		row.dataset.chatTurn = String(s.turn ?? i + 1);
		if (s.kind) row.dataset.chatFlowKind = s.kind;
		if (s.anchor) row.dataset.chatAnchorKey = s.anchor;
		if (s.hidden) {
			row.closest = () => new FakeEl("hidden-wrap");
		}
		return row;
	});
	return scroller.rows;
}

/** 追加一条用户消息（模拟发出去）。 */
function sendUserRow(scroller, turn, anchor) {
	scroller.rows = scroller.rows ?? [];
	const row = new FakeEl(`user-${turn}`);
	row.dataset.chatTurn = String(turn);
	row.dataset.chatFlowKind = "user";
	row.dataset.chatAnchorKey = anchor ?? `u${turn}`;
	scroller.rows.push(row);
	return row;
}

// ---------- 假 document ----------
const containers = new Set();
const docListeners = new Map();
globalThis.document = {
	body: new FakeEl("body"),
	hidden: false,
	querySelectorAll(sel) {
		if (sel === "[data-conversation-scroll]") return [...containers].filter((c) => c.isConnected);
		return [];
	},
	addEventListener(type, fn) {
		if (!docListeners.has(type)) docListeners.set(type, []);
		docListeners.get(type).push(fn);
	},
	removeEventListener(type, fn) {
		const arr = docListeners.get(type);
		if (!arr) return;
		const i = arr.findIndex((x) => x === fn);
		if (i >= 0) arr.splice(i, 1);
	},
};

// ---------- 载入模块 ----------
const localStorage = makeStorage();
const sessionStorage = makeStorage();
let captured = null;
globalThis.window = {
	__ModuleLoader__: { load: (s) => (captured = s) },
	setInterval: (fn) => {
		intervalSeq += 1;
		intervals.set(intervalSeq, fn);
		return intervalSeq;
	},
	clearInterval: (id) => {
		intervals.delete(id);
	},
	localStorage,
	sessionStorage,
};
new Function(code)();
const mod = captured.factory((n) => {
	if (n === "react") return { useEffect() {}, useState: (v) => [v, () => {}], createElement: () => null };
	throw new Error("unexpected " + n);
});
const {
	Freeze,
	FreezeManager,
	countRows,
	sessionMemory,
	remember,
	recall,
	setEnabled,
	settingState,
	GESTURE_WINDOW_MS,
	TOLERANCE,
	SEND_FOLLOW_MS,
	FOLLOW_IDLE_MS,
	FOLLOW_MAX_MS,
	SESSION_SETTLE_MS,
	SESSION_MEMORY_LIMIT,
	RESTORE_GAP_MS,
} = mod.__test;

let failed = 0;
function assert(cond, msg) {
	if (!cond) {
		console.error("FAIL:", msg);
		failed += 1;
	} else {
		console.log("ok  -", msg);
	}
}
function tickWatch() {
	for (const fn of [...intervals.values()]) fn();
}
function flushFrames() {
	let guard = 0;
	while (rafQueue.length && guard++ < 50) {
		const q = rafQueue;
		rafQueue = [];
		for (const fn of q) fn();
	}
}

// ===== 用例 1：挂载时只记住位置，绝不主动写 scrollTop =====
{
	const scroller = buildChat();
	scroller.scrollTop = 500;
	const freeze = new Freeze(scroller);
	assert(freeze.restTop === 500, "用例1: 挂载时记住 restTop=500");
	assert(scroller.scrollTop === 500, "用例1: 挂载时不改动视口");
	scroller.scrollTop = 520;
	freeze.check(false);
	assert(scroller.scrollTop === 500, `用例1: 往下漂 20px 被拉回 500，实际 ${scroller.scrollTop}`);
	freeze.dispose();
}

// ===== 用例 2：DSH 贴底往下拽 -> 拉回并补发 scrollend =====
{
	const scroller = buildChat();
	scroller.scrollTop = 300;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	scroller.scrollTop = scroller.max(); // DSH followTail 拽到底
	freeze.check(false);
	assert(scroller.scrollTop === 300, `用例2: 被拽到底后拉回 300，实际 ${scroller.scrollTop}`);
	assert(freeze.restTop === 300, "用例2: restTop 不变");
	flushFrames();
	assert(scroller.dispatched.includes("scrollend"), "用例2: 补发 scrollend 让跟随关掉");
	freeze.dispose();
}

// ===== 用例 3：用户自己往下滚 -> 跟着走，不拉回 =====
{
	const scroller = buildChat();
	scroller.scrollTop = 100;
	const freeze = new Freeze(scroller);
	scroller.dispatchEvent({ type: "wheel" }); // 记手势
	scroller.scrollTop = 900;
	freeze.check(false);
	assert(freeze.restTop === 900, "用例3: 手势后 restTop 跟着用户到 900");
	assert(scroller.scrollTop === 900, "用例3: 不拉回用户自己滚到的位置");
	freeze.dispose();
}

// ===== 用例 4：用户往上滚 -> 同样跟着走 =====
{
	const scroller = buildChat();
	scroller.scrollTop = 1200;
	const freeze = new Freeze(scroller);
	scroller.dispatchEvent({ type: "keydown", key: "ArrowUp" });
	scroller.scrollTop = 200;
	freeze.check(false);
	assert(freeze.restTop === 200, "用例4: 往上翻后 restTop=200");
	assert(scroller.scrollTop === 200, "用例4: 不跟用户抢");
	freeze.dispose();
}

// ===== 用例 5：内容变短把位置夹回去 -> 接受新位置，不硬撑 =====
{
	const scroller = buildChat({ contentHeight: 2000, viewport: 400 });
	scroller.scrollTop = 1500;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	scroller.scrollHeight = 1000; // 内容缩了，最大只能 600
	scroller.scrollTop = 600;
	freeze.check(false);
	assert(scroller.scrollTop === 600, "用例5: 被夹到 600 就接受，不再往上顶");
	assert(freeze.restTop === 600, "用例5: restTop 同步为 600");
	freeze.dispose();
}

// ===== 用例 6：位置没漂但还开着「跟随底部」-> 定时器催一次采样 =====
{
	const scroller = buildChat();
	scroller.scrollTop = 200;
	scroller.setFollowingTail(true);
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	freeze.check(true);
	flushFrames();
	assert(scroller.dispatched.includes("scrollend"), "用例6: 跟随底部时补发 scrollend");
	assert(freeze.lastNudge === now, "用例6: 记下这次催促时间");
	// 700ms 内不重复催
	const before = scroller.dispatched.filter((t) => t === "scrollend").length;
	now += 100;
	freeze.check(true);
	flushFrames();
	assert(
		scroller.dispatched.filter((t) => t === "scrollend").length === before,
		"用例6: NUDGE_GAP_MS 内不重复补发",
	);
	// 过了间隔再催
	now += 1000;
	freeze.check(true);
	flushFrames();
	assert(
		scroller.dispatched.filter((t) => t === "scrollend").length === before + 1,
		"用例6: 过了间隔重新补发",
	);
	freeze.dispose();
}

// ===== 用例 7：自己刚写完 scrollTop 的那一小段时间，忽略自己引发的滚动 =====
{
	const scroller = buildChat();
	scroller.scrollTop = 300;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	scroller.scrollTop = 700;
	freeze.check(false); // 拉回，armedAt = now + 220
	assert(scroller.scrollTop === 300, "用例7: 拉回 300");
	const restoresAfter = freeze.lastNudge;
	scroller.scrollTop = 320; // 自己这次写入引发的滚动回弹
	freeze.check(false);
	assert(scroller.scrollTop === 320, "用例7: armedAt 内不理自己引发的滚动");
	assert(freeze.lastNudge === restoresAfter, "用例7: armedAt 内不再补发");
	freeze.dispose();
}

// ===== 用例 8：位置没动就不做任何事 =====
{
	const scroller = buildChat();
	scroller.scrollTop = 400;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	freeze.check(false);
	assert(scroller.scrollTop === 400, "用例8: 位置没动就不写");
	assert(scroller.dispatched.length === 0, "用例8: 也不补发 scrollend");
	freeze.dispose();
}

// ===== 用例 9：容差之内的抖动不算漂 =====
{
	const scroller = buildChat();
	scroller.scrollTop = 400;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	scroller.scrollTop = 400 + TOLERANCE;
	freeze.check(false);
	assert(scroller.scrollTop === 400 + TOLERANCE, "用例9: 容差内不拉回");
	freeze.dispose();
}

// ===== 用例 10：容器断开 -> 自动清理 =====
{
	const scroller = buildChat();
	const freeze = new Freeze(scroller);
	const id = freeze.watchdog;
	scroller.isConnected = false;
	freeze.check(true);
	assert(freeze.disposed === true, "用例10: 容器断开后自动 dispose");
	assert(!intervals.has(id), "用例10: 定时器被清掉");
}

// ===== 用例 11：dispose 撤掉所有监听 =====
{
	const scroller = buildChat();
	const freeze = new Freeze(scroller);
	assert(scroller.listenerCount("scroll") === 1, "用例11: 挂了 scroll 监听");
	freeze.dispose();
	assert(scroller.listenerCount("scroll") === 0, "用例11: scroll 监听已撤");
	assert(scroller.listenerCount("wheel") === 0, "用例11: wheel 监听已撤");
	assert(intervals.size === 0, "用例11: 定时器全清");
	assert(docListeners.get("visibilitychange")?.length !== 1, "用例11: visibilitychange 监听已撤");
}

// ===== 用例 12：Manager 扫描容器、不重复建、断开就清 =====
{
	containers.clear();
	intervals.clear();
	const a = buildChat();
	const b = buildChat();
	containers.add(a);
	containers.add(b);
	const manager = new FreezeManager();
	manager.start();
	assert(manager.freezers.size === 2, "用例12: 扫到 2 个容器");
	manager.scan();
	assert(manager.freezers.size === 2, "用例12: 重复扫不会重复建");
	b.isConnected = false;
	manager.scan();
	assert(manager.freezers.size === 1, "用例12: 断开的容器被清理");
	manager.stop();
	assert(manager.freezers.size === 0, "用例12: stop 全清");
	assert(intervals.size === 0, "用例12: stop 后定时器全清");
	containers.clear();
}

// ===== 用例 13：countRows 数行、跳过 hidden 和非数字 =====
{
	const scroller = buildChat();
	addRows(scroller, [{ turn: 1 }, { turn: 2 }, { turn: 3, hidden: true }, { turn: "x" }]);
	assert(countRows(scroller) === 2, `用例13: 只数 2 个有效行，实际 ${countRows(scroller)}`);
}

// ===== 用例 14：长时间贴底 -> 不会把视口一路带到底 =====
{
	const scroller = buildChat({ contentHeight: 5000, viewport: 400 });
	scroller.scrollTop = 1000;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	// 模拟 DSH 每 100ms 往下拽一次，内容同时在变高
	for (let i = 0; i < 10; i += 1) {
		now += 100;
		scroller.scrollHeight += 200;
		scroller.bottom();
		freeze.check(false);
		now += 200; // 越过 armedAt
		freeze.check(false);
	}
	assert(scroller.scrollTop === 1000, `用例14: 十次拽底后仍停在 1000，实际 ${scroller.scrollTop}`);
	assert(freeze.restTop === 1000, "用例14: restTop 始终 1000");
	freeze.dispose();
}

// ===== 用例 15：用户滚到一半停下，新内容往下长，位置不动 =====
{
	const scroller = buildChat({ contentHeight: 3000, viewport: 400 });
	scroller.scrollTop = 1500;
	const freeze = new Freeze(scroller);
	scroller.dispatchEvent({ type: "wheel" });
	scroller.scrollTop = 1700;
	freeze.check(false);
	assert(freeze.restTop === 1700, "用例15: 用户停在 1700");
	now += GESTURE_WINDOW_MS + 1;
	scroller.scrollHeight += 800; // 新内容长出来
	scroller.bottom();
	freeze.check(false);
	assert(scroller.scrollTop === 1700, `用例15: 新内容长出来后视口仍在 1700，实际 ${scroller.scrollTop}`);
	freeze.dispose();
}

// ===== 用例 16：切到别的会话再切回来，位置各自记住 =====
{
	sessionMemory.clear();
	const scroller = buildChat({ contentHeight: 5000, viewport: 400, session: "sess-A" });
	scroller.scrollTop = 1500;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;

	// A 会话里用户滚到 2600
	scroller.dispatchEvent({ type: "wheel" });
	scroller.scrollTop = 2600;
	freeze.check(false);
	assert(freeze.restTop === 2600, "用例16: A 会话记住 2600");

	// 切到 B 会话：同一个容器，会话 id 变了，内容也换了
	now += GESTURE_WINDOW_MS + 1;
	scroller.sessionHost = { dataset: { conversationSession: "sess-B" } };
	scroller.scrollHeight = 3000;
	scroller.scrollTop = 0;
	freeze.check(false);
	assert(freeze.sessionId === "sess-B", "用例16: 识别到切到 B 会话");
	assert(freeze.restTop === 0, "用例16: B 会话没有记忆，就用当前 0");

	// B 里滚到 800
	scroller.dispatchEvent({ type: "wheel" });
	scroller.scrollTop = 800;
	freeze.check(false);
	assert(freeze.restTop === 800, "用例16: B 会话记住 800");

	// 切回 A：位置应该恢复到 2600，而不是沿用 800
	now += GESTURE_WINDOW_MS + 1;
	scroller.sessionHost = { dataset: { conversationSession: "sess-A" } };
	scroller.scrollHeight = 5000;
	scroller.scrollTop = 0;
	freeze.check(false);
	assert(freeze.restTop === 2600, `用例16: 切回 A 恢复 2600，实际 ${freeze.restTop}`);
	freeze.dispose();
}

// ===== 用例 17：刚切回来内容没渲染完，等待期内不认输、内容长高后对齐 =====
{
	sessionMemory.clear();
	remember("sess-A", 2600);
	const scroller = buildChat({ contentHeight: 900, viewport: 400, session: "sess-A" });
	scroller.scrollTop = 0;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	// 内容只有 900 高，最多滚 500，2600 够不着
	freeze.check(false);
	assert(freeze.restTop === 2600, `用例17: 等待期内不把 restTop 改小，实际 ${freeze.restTop}`);

	// 内容长出来了，应该自动对齐到 2600（还在等待期内）
	now += SESSION_SETTLE_MS - 3000;
	scroller.scrollHeight = 5000;
	freeze.check(false);
	assert(scroller.scrollTop === 2600, `用例17: 内容长出来后对齐到 2600，实际 ${scroller.scrollTop}`);
	freeze.dispose();
}

// ===== 用例 18：等待期过了、内容确实变短，还是接受新位置 =====
{
	sessionMemory.clear();
	remember("sess-A", 2600);
	const scroller = buildChat({ contentHeight: 900, viewport: 400, session: "sess-A" });
	scroller.scrollTop = 500;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	freeze.check(false);
	assert(freeze.restTop === 2600, "用例18: 等待期内仍记着 2600");
	// 等待期结束，内容还是那么短 -> 认输，接受 500
	now += SESSION_SETTLE_MS + 1000;
	freeze.check(false);
	assert(freeze.restTop === 500, `用例18: 等待期过后接受 500，实际 ${freeze.restTop}`);
	freeze.dispose();
}

// ===== 用例 19：在输入框里打字/点输入框，不算「想滚页面」 =====
{
	const scroller = buildChat({ contentHeight: 3000, viewport: 400 });
	scroller.scrollTop = 600;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	const composer = { closest: (sel) => (sel === "[data-composer-seat]" ? {} : null) };
	scroller.dispatchEvent({ type: "keydown", key: "a", target: composer });
	scroller.dispatchEvent({ type: "pointerdown", target: composer });
	scroller.dispatchEvent({ type: "wheel", target: composer });
	scroller.scrollTop = scroller.max(); // DSH 拽到底
	freeze.check(false);
	assert(
		scroller.scrollTop === 600,
		`用例19: 输入框内事件不算手势，照样拉回 600，实际 ${scroller.scrollTop}`,
	);
	freeze.dispose();
}

// ===== 用例 20：位置记进 sessionStorage，容器重建后还能读回来 =====
{
	sessionMemory.clear();
	sessionStorage.map.clear();
	remember("sess-keep", 1234);
	assert(
		sessionStorage.getItem("dsh-chat-answer-anchor:pos:sess-keep") === "1234",
		"用例20: 位置写进 sessionStorage",
	);
	sessionMemory.clear(); // 模拟整个页面重载、内存记忆清空
	assert(recall("sess-keep") === 1234, "用例20: 内存丢了还能从 sessionStorage 读回 1234");
}

// ===== 用例 21：会话位置记忆有上限，不会无限涨 =====
{
	sessionMemory.clear();
	for (let i = 0; i < SESSION_MEMORY_LIMIT + 20; i += 1) remember(`s${i}`, i);
	assert(
		sessionMemory.size === SESSION_MEMORY_LIMIT,
		`用例21: 记忆条数被压到 ${SESSION_MEMORY_LIMIT}，实际 ${sessionMemory.size}`,
	);
	assert(recall("s0") === undefined, "用例21: 最久没用的被淘汰");
	assert(recall(`s${SESSION_MEMORY_LIMIT + 19}`) !== undefined, "用例21: 最新的还在");
	sessionMemory.clear();
}

// ===== 用例 22：等待期内内容没长高，不靠定时器每 250ms 硬顶 =====
{
	sessionMemory.clear();
	remember("sess-A", 2600);
	const scroller = buildChat({ contentHeight: 900, viewport: 400, session: "sess-A" });
	scroller.scrollTop = 0;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	const before = scroller.dispatched.length;
	freeze.check(true);
	freeze.check(true);
	freeze.check(true);
	assert(scroller.dispatched.length === before, "用例22: 内容没长高时不补发 scrollend，不吵");
	assert(freeze.restTop === 2600, "用例22: 但仍记着 2600");
	freeze.dispose();
}

// ===== 用例 23：总开关关掉后 Manager 停止工作 =====
{
	containers.clear();
	intervals.clear();
	const scroller = buildChat();
	containers.add(scroller);
	const manager = new FreezeManager();
	manager.start();
	assert(manager.freezers.size === 1, "用例23: 开启时挂上容器");
	setEnabled(false);
	applyEnabledWith(manager);
	assert(manager.freezers.size === 0, "用例23: 关掉后不再接管");
	assert(settingState.enabled === false, "用例23: 设置状态记为关闭");
	assert(
		localStorage.getItem("dsh-chat-answer-anchor:enabled") === "0",
		"用例23: 开关状态写进 localStorage",
	);
	setEnabled(true);
	applyEnabledWith(manager);
	assert(manager.freezers.size === 1, "用例23: 重新开启后恢复接管");
	manager.stop();
	containers.clear();
}

// applyEnabled 只作用于 activeManager，测试里手动喂一个。
function applyEnabledWith(manager) {
	mod.__test.setActiveManager(manager);
	mod.__test.applyEnabled();
}

// ===== 用例 24：发消息之后先跟着到最下方，等落定了才冻结 =====
{
	sessionMemory.clear();
	const scroller = buildChat({ contentHeight: 2000, viewport: 400 });
	addRows(scroller, [{ turn: 1, kind: "user" }, { turn: 1, kind: "assistant-step" }]);
	scroller.scrollTop = 400;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	freeze.check(false);
	assert(scroller.scrollTop === 400, "用例24: 平时照常冻结在 400");

	// 用户发了一条：内容长高，DSH 把视口带到最下方
	sendUserRow(scroller, 2, "u2");
	scroller.scrollHeight = 2600;
	scroller.bottom();
	freeze.check(false);
	assert(freeze.followActive === true, "用例24: 识别出发送了，进入放手期");
	assert(scroller.scrollTop === scroller.max(), "用例24: 放手期不拦，停在最下方");

	// 落定之后接管：位置就是最下方，不再被拉回
	now += SEND_FOLLOW_MS + FOLLOW_IDLE_MS + 10;
	freeze.check(true);
	assert(freeze.followActive === false, "用例24: 落定后退出放手期");
	assert(
		scroller.scrollTop === scroller.max(),
		`用例24: 以落定位置为基准，实际 ${scroller.scrollTop}`,
	);
	assert(freeze.restTop === scroller.max(), "用例24: restTop 记成落定位置");

	// 之后回答再长高，DSH 想拽到底也不再被允许
	scroller.scrollHeight = 4000;
	freeze.check(true);
	assert(
		scroller.scrollTop === 2200,
		`用例24: 回答开始生成后冻结生效，实际 ${scroller.scrollTop}`,
	);
	freeze.dispose();
}

// ===== 用例 25：放手期一直没到最下方（内容太高），到点也得收手 =====
{
	sessionMemory.clear();
	const scroller = buildChat({ contentHeight: 2000, viewport: 400 });
	addRows(scroller, [{ turn: 1, kind: "user" }]);
	scroller.scrollTop = 400;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	freeze.check(false);
	sendUserRow(scroller, 2, "u2");
	freeze.check(false);
	assert(freeze.followActive === true, "用例25: 进入放手期");
	assert(scroller.scrollTop === scroller.max(), "用例25: 放手期一开始就贴到最下方");
	// 用户在放手期里自己往上翻：这时候不许再强制贴底
	scroller.dispatchEvent({ type: "wheel", target: new FakeEl("x") });
	scroller.scrollTop = 900;
	freeze.check(false);
	assert(scroller.scrollTop === 900, "用例25: 放手期用户往上翻，不被强制贴底");
	// 硬上限到了照样收手
	now += FOLLOW_MAX_MS + 10;
	scroller.scrollTop = 900;
	freeze.check(true);
	assert(freeze.followActive === false, "用例25: 超过硬上限强制收手");
	assert(freeze.restTop === 900, `用例25: 以当前位置为准，实际 ${freeze.restTop}`);
	freeze.dispose();
}

// ===== 用例 26：消息节点被重建但没发新消息，不算「发送」 =====
{
	sessionMemory.clear();
	const scroller = buildChat({ contentHeight: 2000, viewport: 400 });
	const rows = addRows(scroller, [{ turn: 1, kind: "user", anchor: "u1" }]);
	scroller.scrollTop = 400;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	// 同一个 anchor，但换了一个 DOM 节点（React 重建）
	const clone = new FakeEl("user-1-clone");
	clone.dataset.chatTurn = "1";
	clone.dataset.chatFlowKind = "user";
	clone.dataset.chatAnchorKey = "u1";
	scroller.rows = [clone];
	freeze.check(false);
	assert(freeze.followActive === false, "用例26: 节点重建不算发送，不进入放手期");
	assert(scroller.scrollTop === 400, "用例26: 视口照旧冻在 400");
	void rows;
	freeze.dispose();
}

// ===== 用例 27：回答一开始生成就收手，不等位置静止 =====
{
	sessionMemory.clear();
	const scroller = buildChat({ contentHeight: 2000, viewport: 400 });
	addRows(scroller, [{ turn: 1, kind: "user" }]);
	scroller.scrollTop = 400;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	freeze.check(false);

	// 发消息：视口被带到最下方
	sendUserRow(scroller, 2, "u2");
	scroller.scrollHeight = 2600;
	scroller.bottom();
	freeze.check(false);
	assert(freeze.followActive === true, "用例27: 进入放手期");

	// 回答开始出现，同时位置还在变（远没到静止阈值）
	const answer = new FakeEl("answer");
	answer.dataset.chatTurn = "2";
	answer.dataset.chatFlowKind = "assistant-step";
	scroller.rows.push(answer);
	scroller.scrollHeight = 2700;
	scroller.scrollTop = scroller.max();
	now += SEND_FOLLOW_MS + 20;
	freeze.check(true);
	assert(freeze.followActive === false, "用例27: 回答一出现就收手，不等静止");
	assert(freeze.restTop === scroller.scrollTop, "用例27: 以当时的当前位置为准");

	// 之后回答继续长高，视口不许再动
	const frozen = scroller.scrollTop;
	scroller.scrollHeight = 5000;
	freeze.check(true);
	assert(scroller.scrollTop === frozen, `用例27: 生成过程中视口不动，实际 ${scroller.scrollTop}`);
	freeze.dispose();
}

// ===== 用例 28：生成过程中用户还能自己滚，不许被拽回来 =====
{
	sessionMemory.clear();
	const scroller = buildChat({ contentHeight: 3000, viewport: 400 });
	addRows(scroller, [{ turn: 1, kind: "user" }, { turn: 1, kind: "assistant-step" }]);
	scroller.scrollTop = 800;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	freeze.check(false);
	assert(scroller.scrollTop === 800, "用例28: 起始冻在 800");

	// 生成中用户自己往上翻
	scroller.dispatchEvent({ type: "wheel", target: new FakeEl("x") });
	scroller.scrollTop = 300;
	freeze.check(false);
	assert(scroller.scrollTop === 300, `用例28: 生成中用户往上翻要跟着走，实际 ${scroller.scrollTop}`);
	assert(freeze.restTop === 300, "用例28: 基准跟着用户挪到 300");
	freeze.dispose();
}

// ===== 用例 29：拉回限速，别每帧跟 DSH 抢 scrollTop =====
{
	sessionMemory.clear();
	const scroller = buildChat({ contentHeight: 3000, viewport: 400 });
	addRows(scroller, [{ turn: 1, kind: "user" }, { turn: 1, kind: "assistant-step" }]);
	scroller.scrollTop = 1000;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	freeze.check(false);
	assert(scroller.scrollTop === 1000, "用例29: 起始冻在 1000");

	// 第一次被拽下去：拉回
	scroller.scrollTop = 1500;
	freeze.check(false);
	assert(scroller.scrollTop === 1000, "用例29: 第一次拉回生效");

	// 紧接着又被拽（限速窗口内）：这次先不拉，免得每帧打架
	scroller.scrollTop = 1500;
	now += 40;
	freeze.check(false);
	assert(scroller.scrollTop === 1500, "用例29: 限速窗口内不重复拉回");

	// 过了限速窗口和自写忽略窗口，再拉
	now += Math.max(RESTORE_GAP_MS, 220) + 40;
	freeze.check(false);
	assert(scroller.scrollTop === 1000, `用例29: 过了窗口照样拉回，实际 ${scroller.scrollTop}`);
	freeze.dispose();
}

// ===== 用例 30：往上翻着的时候发消息，也必须自己滚到最下方 =====
{
	sessionMemory.clear();
	const scroller = buildChat({ contentHeight: 4000, viewport: 400 });
	addRows(scroller, [
		{ turn: 1, kind: "user" },
		{ turn: 1, kind: "assistant-step" },
		{ turn: 2, kind: "user" },
		{ turn: 2, kind: "assistant-step" },
	]);
	scroller.scrollTop = 600;
	const freeze = new Freeze(scroller);
	now += GESTURE_WINDOW_MS + 1;
	freeze.check(false);
	assert(scroller.scrollTop === 600, "用例30: 用户停在上方 600");

	// 用户在上方时发消息：DSH 不一定帮我们滚（它只在本来跟随底部时才贴底）
	sendUserRow(scroller, 3, "u3");
	scroller.scrollHeight = 4400;
	freeze.check(false);
	assert(freeze.followActive === true, "用例30: 进入放手期");
	assert(
		scroller.scrollTop === scroller.max(),
		`用例30: 自己动手滚到最下方，实际 ${scroller.scrollTop} / max ${scroller.max()}`,
	);

	// 回答出现后锁住，不许再动
	const answer = new FakeEl("a3");
	answer.dataset.chatTurn = "3";
	answer.dataset.chatFlowKind = "assistant-step";
	scroller.rows.push(answer);
	scroller.scrollHeight = 4800;
	now += SEND_FOLLOW_MS + 20;
	freeze.check(true);
	assert(freeze.followActive === false, "用例30: 回答出现后收手");
	const frozen = scroller.scrollTop;
	scroller.scrollHeight = 6000;
	freeze.check(true);
	assert(scroller.scrollTop === frozen, `用例30: 生成中不动，实际 ${scroller.scrollTop}`);
	freeze.dispose();
}

console.log(failed === 0 ? "全部通过" : `${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);
