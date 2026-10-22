window.__ModuleLoader__.load({
	id: "dsh-chat-answer-anchor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");

		/**
		 * 关掉聊天区的「自动贴底」。
		 *
		 * 需求：新回答出现时视口别动，停在原处，由自己决定什么时候往下滚。
		 *
		 * 做法是纯 DOM 旁路，不替换 DSH 自带的聊天视图：
		 * 1. 记住用户最后停留的位置 restTop；
		 * 2. 只要滚动位置在没有真实手势的情况下被往下拽，就拉回 restTop；
		 * 3. 拉回后补一个 scrollend，让 ui-chat 立刻重新采样、把「跟随底部」关掉
		 *    （它的 ScrollFollow.sample 会把 following 重算成「是否贴近底部」）。
		 *
		 * 只拦「往下漂」：往上走（浏览器滚动锚定、内容变短被夹）一律放行，
		 * 免得跟浏览器自己的补偿逻辑打架。
		 */

		/** 这些输入事件都算「用户自己在动」。 */
		const INTENTS = ["wheel", "touchstart", "pointerdown", "keydown", "beforematch"];
		/** 手势之后多久之内出现的滚动，都算用户自己滚的。 */
		const GESTURE_WINDOW_MS = 1200;
		/** 自己刚写过 scrollTop 的一小段时间内，不理自己引发的滚动事件。 */
		const ARM_MS = 220;
		/** 位置差在这个像素数以内就不管。 */
		const TOLERANCE = 2;
		/** 多久复核一次。 */
		const WATCH_MS = 250;
		/** 两次补发 scrollend 之间至少隔这么久，别太吵。 */
		const NUDGE_GAP_MS = 700;
		/**
		 * 两次「拉回原位」之间至少隔这么久。
		 * 流式输出时每个 token 都会让内容长高，不限制的话每一帧都在跟 DSH 抢 scrollTop，
		 * 两边来回写会把主线程拖死（用户看到的就是窗口卡住、滚不动）。
		 */
		const RESTORE_GAP_MS = 120;
		/**
		 * 用户刚发完消息之后，先放手让 DSH 把视口带到最下方。
		 * 这段时间内完全不拦滚动，等它落定了再接管冻结。
		 */
		const SEND_FOLLOW_MS = 700;
		/** 距底部这么多像素以内就算贴住了（跟 DSH 自己用的阈值一致）。 */
		const NEAR_BOTTOM_PX = 25;
		/** 放手期间只要位置还在变就继续等，静止这么久才算落定。 */
		const FOLLOW_IDLE_MS = 260;
		/** 放手期最长多久，防止流式输出一直长高导致永远不接管。 */
		const FOLLOW_MAX_MS = 6000;
		/**
		 * 换会话之后，等 DSH 把内容渲染出来的最长时间。
		 * 会话内容是流式/分页加载的，刚切过去时高度还不够，位置会被夹住，
		 * 所以要一直重试到真的落到记住的位置为止。
		 */
		const SESSION_SETTLE_MS = 8000;
		/** 每个会话记住的位置最多存这么多条，超了按最久没用的淘汰。 */
		const SESSION_MEMORY_LIMIT = 200;
		/** DOM 变化的扫描合并窗口，别让流式输出的每个 token 都触发一次全量扫描。 */
		const SCAN_DEBOUNCE_MS = 120;
		/** 位置记忆持久化的键前缀（sessionStorage，刷新页面还在）。 */
		const STORAGE_PREFIX = "dsh-chat-answer-anchor:pos:";
		/** 总开关的存储键（localStorage，跨刷新保留）。 */
		const ENABLED_KEY = "dsh-chat-answer-anchor:enabled";
		/** 诊断面板开关：确认没问题后改成 false 就隐藏。 */
		const SHOW_PROBE = false;

		/** 插件依赖的 DOM 锚点，集中放这里，DSH 改名字时只用改这一处。 */
		const SELECTORS = {
			scroll: "[data-conversation-scroll]",
			flow: "[data-chat-flow]",
			session: "[data-conversation-session]",
			composer: "[data-composer-seat]",
			tail: "[data-chat-following-tail]",
			row: "[data-chat-turn]",
			user: '[data-chat-flow-kind="user"]',
			hidden: "[hidden]",
		};

		const probe = {
			anchors: 0,
			rows: 0,
			rest: 0,
			cur: 0,
			max: 0,
			tail: false,
			follow: false,
			users: 0,
			restores: 0,
			nudges: 0,
			sess: "-",
			note: "等待挂载",
		};

		// ---------- 文案 ----------

		const NS = "chatAnswerAnchor";

		const zh = {
			label: "新回答不抢视口",
			on: "新回答不抢视口（已开启）",
			off: "新回答不抢视口（已关闭）",
			hint: "新内容出现时视口停在原处，不再自动贴底。",
		};

		const en = {
			label: "Keep viewport on new replies",
			on: "Keep viewport on new replies (on)",
			off: "Keep viewport on new replies (off)",
			hint: "New content no longer scrolls the chat to the bottom.",
		};

		/** apply 里绑定好的翻译函数，组件直接读它。 */
		let translate = (key) => zh[key] ?? key;

		// ---------- 设置（总开关） ----------

		function loadEnabled() {
			try {
				const raw = window.localStorage?.getItem(ENABLED_KEY);
				return raw === null || raw === undefined ? true : raw === "1";
			} catch {
				return true;
			}
		}

		function saveEnabled(on) {
			try {
				window.localStorage?.setItem(ENABLED_KEY, on ? "1" : "0");
			} catch {
				/* 隐私模式下写不了就算了，本次会话内仍然有效 */
			}
		}

		const settingState = { enabled: loadEnabled(), listeners: new Set() };

		function setEnabled(on) {
			settingState.enabled = on;
			saveEnabled(on);
			for (const fn of settingState.listeners) {
				try {
					fn(on);
				} catch {
					/* 单个订阅者出错不影响别人 */
				}
			}
			applyEnabled();
		}

		/** 当前活着的 manager（同一时刻最多一个，由 overlay 组件持有）。 */
		let activeManager = null;

		function applyEnabled() {
			if (!activeManager) return;
			if (settingState.enabled) activeManager.start();
			else activeManager.stop();
		}

		// ---------- 位置记忆 ----------

		/** 滚动容器属于哪个会话（DSH 把会话 id 挂在祖先的 data-conversation-session 上）。 */
		function sessionIdOf(scroller) {
			const host = scroller.closest?.(SELECTORS.session);
			const id = host?.dataset?.conversationSession;
			return id === undefined || id === "" ? null : id;
		}

		/**
		 * 每个会话各自记住的停留位置。
		 * 放在模块级而不是 Freeze 实例里：切会话时 React 可能把滚动容器整个重建，
		 * 实例跟着一起没了，记忆得活得比实例久。
		 */
		const sessionMemory = new Map();

		/** 上次写进 sessionStorage 的值，用来避免每帧重复落盘。 */
		const storedSnapshot = new Map();

		function readStored(sessionId) {
			if (sessionId === null) return undefined;
			try {
				const raw = window.sessionStorage?.getItem(STORAGE_PREFIX + sessionId);
				if (raw === null || raw === undefined) return undefined;
				const value = Number(raw);
				return Number.isFinite(value) ? value : undefined;
			} catch {
				return undefined;
			}
		}

		function writeStored(sessionId, top) {
			if (sessionId === null) return;
			const rounded = Math.round(top);
			if (storedSnapshot.get(sessionId) === rounded) return;
			storedSnapshot.set(sessionId, rounded);
			try {
				window.sessionStorage?.setItem(STORAGE_PREFIX + sessionId, String(rounded));
			} catch {
				/* 存不下就算了，退化成只在内存里记 */
			}
		}

		/** 淘汰一个会话的记忆：内存和 sessionStorage 一起清，语义保持一致。 */
		function forget(sessionId) {
			if (sessionId === null) return;
			sessionMemory.delete(sessionId);
			storedSnapshot.delete(sessionId);
			try {
				window.sessionStorage?.removeItem(STORAGE_PREFIX + sessionId);
			} catch {
				/* 清不掉也无所谓 */
			}
		}

		/** 记一个会话的位置：内存 LRU + sessionStorage 双写。 */
		function remember(sessionId, top) {
			if (sessionId === null) return;
			sessionMemory.delete(sessionId);
			sessionMemory.set(sessionId, top);
			while (sessionMemory.size > SESSION_MEMORY_LIMIT) {
				const oldest = sessionMemory.keys().next().value;
				forget(oldest);
			}
			writeStored(sessionId, top);
		}

		function recall(sessionId) {
			if (sessionId === null) return undefined;
			const cached = sessionMemory.get(sessionId);
			if (cached !== undefined) return cached;
			const stored = readStored(sessionId);
			if (stored !== undefined) sessionMemory.set(sessionId, stored);
			return stored;
		}

		/** 只给诊断面板用，正常运行时根本不调用。 */
		function countRows(scroller) {
			let n = 0;
			for (const row of scroller.querySelectorAll(SELECTORS.row)) {
				if (row.closest(SELECTORS.hidden)) continue;
				if (!Number.isFinite(Number(row.dataset.chatTurn))) continue;
				n += 1;
			}
			return n;
		}

		function flowRoot(scroller) {
			return scroller.querySelector(SELECTORS.flow) ?? scroller;
		}

		/**
		 * 最后一条用户消息的「身份」，用来识别「刚发了一条」。
		 * 用属性拼字符串而不是直接比 DOM 节点：流式输出时 React 可能重建节点，
		 * 节点换了但消息没变，那就不能算新发的。
		 */
		function lastUserKey(scroller) {
			const rows = scroller.querySelectorAll(SELECTORS.user);
			if (rows.length === 0) return null;
			const row = rows[rows.length - 1];
			const key =
				row.dataset?.chatAnchorKey ??
				row.dataset?.chatFlowKey ??
				row.dataset?.chatTurn ??
				"?";
			return `${rows.length}:${key}`;
		}

		class Freeze {
			constructor(scroller) {
				this.scroller = scroller;
				this.disposed = false;
				/** 当前滚动容器属于哪个会话。 */
				this.sessionId = sessionIdOf(scroller);
				const remembered = recall(this.sessionId);
				/** 用户最后停留的位置（这个会话的）。 */
				this.restTop = remembered === undefined ? scroller.scrollTop : remembered;
				/**
				 * 切会话后的等待期，这期间位置被夹住不算「内容变短」，要一直重试。
				 * 容器被整个重建时也会走这里，所以从记忆里取回位置同样要给等待期。
				 */
				this.settleUntil =
					remembered === undefined ? 0 : performance.now() + SESSION_SETTLE_MS;
				/**
				 * 最近一次真实手势的时间戳。
				 * 初值是 -Infinity：页面刚打开那一两秒里 performance.now() 还很小，
				 * 用 0 当默认会让「还没人动过」被误判成「刚有人动过」。
				 */
				this.gestureAt = -Infinity;
				/** 自己刚写过 scrollTop 的时刻，用来忽略自己引发的滚动。 */
				this.armedAt = 0;
				this.lastNudge = 0;
				/** 上一次真正拉回原位的时刻，用来限速，防止跟 DSH 抢滚动把页面拖死。 */
				this.lastRestore = -Infinity;
				/** 上次看到的内容高度，用来判断「内容真的长高了」。 */
				this.lastHeight = scroller.scrollHeight;
				this.watchdog = null;
				/**
				 * 用户最后一次发消息的时刻。
				 * 刚发完这段时间先放手，让 DSH 把视口带到最下方，
				 * 之后才开始冻结——不然连自己发的话都看不见。
				 */
				this.sendAt = -Infinity;
				/** 放手跟到最下方的截止时刻。 */
				this.followUntil = 0;
				/** 放手期的硬性截止时刻，防止流式一直加高导致永远不接管。 */
				this.followDeadline = 0;
				/** 放手期内上一次看到的位置，用来判断「还在滚」还是「停稳了」。 */
				this.followTop = 0;
				/** 放手期内位置最后一次变化的时刻。 */
				this.followChangedAt = 0;
				/** 放手期内有没有到过最下方。 */
				this.reachedBottom = false;
				/** 是否正处于「发送后放手」状态。 */
				this.followActive = false;
				/** 上次见到的最后一条用户消息的标识，用来判断「刚发了一条新的」。 */
				this.lastUserKey = lastUserKey(scroller);

				const onGesture = (event) => {
					// 输入框里的按键和点击不算「想滚页面」。
					const target = event?.target;
					if (typeof target?.closest === "function" && target.closest(SELECTORS.composer)) {
						return;
					}
					this.gestureAt = performance.now();
				};
				this.onGesture = onGesture;
				for (const type of INTENTS) {
					scroller.addEventListener(type, onGesture, { passive: true, capture: true });
				}

				this.onScroll = () => this.check(false);
				scroller.addEventListener("scroll", this.onScroll, { passive: true });

				// 内容长高时立刻复核一次，切会话后不用靠定时器硬猜。
				if (typeof ResizeObserver === "function") {
					this.resizer = new ResizeObserver(() => {
						if (this.disposed) return;
						this.check(true, true);
					});
					try {
						this.resizer.observe(flowRoot(scroller));
					} catch {
						this.resizer = null;
					}
				}

				this.onVisibility = () => {
					if (document.hidden) {
						this.stopWatch();
						return;
					}
					this.startWatch();
					this.check(true);
				};
				document.addEventListener?.("visibilitychange", this.onVisibility);

				this.startWatch();
				this.publish("已挂载");
			}

			startWatch() {
				if (this.disposed || this.watchdog !== null) return;
				this.watchdog = window.setInterval(() => {
					if (this.disposed) return;
					this.check(true);
				}, WATCH_MS);
			}

			stopWatch() {
				if (this.watchdog === null) return;
				window.clearInterval(this.watchdog);
				this.watchdog = null;
			}

			publish(note) {
				// 位置记忆是功能，跟诊断面板开不开无关。
				remember(this.sessionId, this.restTop);
				if (!SHOW_PROBE) return;
				if (note) probe.note = note;
				probe.rows = countRows(this.scroller);
				probe.rest = Math.round(this.restTop);
				probe.cur = Math.round(this.scroller.scrollTop);
				probe.max = Math.round(this.maxScroll());
				probe.tail = this.followingTail();
				probe.follow = this.followActive;
				probe.users = this.scroller.querySelectorAll(SELECTORS.user).length;
				probe.sess = this.sessionId === null ? "-" : String(this.sessionId).slice(0, 8);
			}

			/**
			 * 会话变了就换一本账：先把这个会话的位置存好，再取出新会话记着的位置。
			 * 返回 true 表示刚刚换了会话。
			 */
			syncSession() {
				const id = sessionIdOf(this.scroller);
				if (id === this.sessionId) return false;
				// 旧会话：把这期间的位置存下来（用户可能刚在这边滚过）。
				remember(this.sessionId, this.restTop);
				this.sessionId = id;
				const remembered = recall(id);
				this.restTop = remembered === undefined ? this.scroller.scrollTop : remembered;
				// 刚切过来时内容还没渲染完，高度不够会被夹住，别急着认输。
				this.settleUntil = performance.now() + SESSION_SETTLE_MS;
				this.armedAt = 0;
				this.lastNudge = 0;
				this.lastHeight = this.scroller.scrollHeight;
				// 换会话了：发送后的放手状态和「最后一条用户消息」都得重新算。
				this.followActive = false;
				this.followUntil = 0;
				this.followDeadline = 0;
				this.lastUserKey = lastUserKey(this.scroller);
				return true;
			}

			maxScroll() {
				return Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
			}

			followingTail() {
				return this.scroller.querySelector(SELECTORS.tail) !== null;
			}

			/** 是不是刚发了一条新消息（最后一条用户消息换行了）。 */
			detectSend() {
				const key = lastUserKey(this.scroller);
				if (key === null || key === this.lastUserKey) return false;
				this.lastUserKey = key;
				return true;
			}

			/** 进入「发送后放手」：这段时间视口跟着 DSH 走，不拦。 */
			startFollow(now) {
				this.followActive = true;
				this.followUntil = now + SEND_FOLLOW_MS;
				this.followDeadline = now + FOLLOW_MAX_MS;
				this.reachedBottom = false;
				this.sendAt = now;
				// 自己动手把视口带到最下方。
				// 不能指望 DSH 一定帮我们滚：它只在「本来就在跟随底部」时才贴底，
				// 而用户发消息前往往是往上翻着的，那种情况它一声不吭，视口就留在上面，
				// 连自己刚发的话都看不见。
				const max = this.maxScroll();
				this.armedAt = now + ARM_MS;
				if (max > this.scroller.scrollTop) this.scroller.scrollTop = max;
				this.followTop = this.scroller.scrollTop;
				this.followChangedAt = now;
				this.publish("发送后跟随");
			}

			/**
			 * 放手期要不要收手。
			 *
			 * 关键判据是「回答已经开始往外长了」——这就是用户要的那一刻：
			 * 发出去的话已经看见了，接下来生成过程一律不许滚。
			 * 光等「位置静止」不行：DSH 流式输出时一直贴底，位置一直在变，
			 * 永远等不到静止，只能靠 6 秒硬上限兜底，那 6 秒里照样一路滚到底。
			 */
			shouldSettle(now, top) {
				if (now >= this.followDeadline) return true;
				if (Math.abs(top - this.followTop) > 1) {
					this.followTop = top;
					this.followChangedAt = now;
				}
				// DSH 自己的「跟随底部」标记是最可靠的「已经到底了」信号：
				// 滚动容器里还含输入框，纯按高度算 gap 会一直偏大，永远判不到底。
				if (this.followingTail()) this.reachedBottom = true;
				if (this.nearBottom()) this.reachedBottom = true;
				// 至少放手这么久，让「滚到你发的话」这一步走完。
				if (now < this.followUntil) return false;
				// 回答开始出现了：立刻收手冻结。
				if (this.generationStarted()) return true;
				if (!this.reachedBottom) return false;
				return now - this.followChangedAt >= FOLLOW_IDLE_MS;
			}

			/**
			 * 最后一条用户消息之后，是不是已经冒出回答的内容了。
			 * 从后往前扫：先撞到助手行就说明在生成，先撞到用户行就说明还没有。
			 */
			generationStarted() {
				const rows = this.scroller.querySelectorAll(SELECTORS.row);
				for (let i = rows.length - 1; i >= 0; i -= 1) {
					const row = rows[i];
					if (typeof row.closest === "function" && row.closest(SELECTORS.hidden)) continue;
					const kind = row.dataset?.chatFlowKind;
					if (kind === "user") return false;
					if (
						kind === "assistant-step" ||
						kind === "turn-process" ||
						kind === "turn-tail" ||
						kind === "tool-call" ||
						kind === "turn-error"
					) {
						return true;
					}
				}
				return false;
			}

			/** 距离底部是不是已经贴住了。 */
			nearBottom() {
				const gap =
					this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight;
				return gap <= NEAR_BOTTOM_PX;
			}

			/** 复核一次：该拉回就拉回。fromWatch 表示定时器触发，fromResize 表示内容长高触发。 */
			check(fromWatch, fromResize) {
				if (this.disposed) return;
				if (!this.scroller.isConnected) {
					this.dispose();
					return;
				}
				// 先看是不是换了会话：换了就换账本，并进入等待期。
				const switched = this.syncSession();
				const now = performance.now();
				const top = this.scroller.scrollTop;
				const max = this.maxScroll();
				const settling = now < this.settleUntil;

				// 内容是不是真的长高了（切会话后靠它决定要不要重新对齐）。
				const height = this.scroller.scrollHeight;
				const grew = height > this.lastHeight + 1;
				this.lastHeight = height;

				if (switched) {
					// 刚切过来：先往记住的位置靠一次，剩下的等内容长出来再慢慢对齐。
					this.armedAt = now + ARM_MS;
					this.scroller.scrollTop = Math.min(this.restTop, max);
					this.publish("换会话");
					return;
				}

				// 刚发完一条消息：先放手，让 DSH 自己把视口带到最下方。
				// 这样能看见自己发出去的话，等它滚停了我们再接管冻结。
				if (this.detectSend()) {
					this.startFollow(now);
					return;
				}
				if (this.followActive) {
					// 先判该不该收手：收手了就以当时位置为准，别再贴底。
					if (this.shouldSettle(now, top)) {
						this.followActive = false;
						this.restTop = top;
						this.armedAt = now + ARM_MS;
						this.publish("开始冻结");
						return;
					}
					// 还在放手期：自己也要贴住底部。DSH 只在「本来就在跟随」时才贴底，
					// 用户发消息前是往上翻着的，它就不管了，视口会留在上面。
					// 这段只持续到回答开始出现，所以这里贴底不违背「生成时不滚」。
					if (now - this.gestureAt > GESTURE_WINDOW_MS) {
						const bottom = this.maxScroll();
						if (bottom > this.scroller.scrollTop + 1) {
							this.armedAt = now + ARM_MS;
							this.scroller.scrollTop = bottom;
						}
					}
					this.restTop = this.scroller.scrollTop;
					this.publish("发送后跟随");
					return;
				}

				// 用户正在动：跟着他走，记下新位置。
				// 生成期间也必须认——不然用户想往上翻就被一直拽回来，页面像卡死一样。
				if (now - this.gestureAt <= GESTURE_WINDOW_MS) {
					this.restTop = top;
					this.publish("用户滚动");
					return;
				}
				if (now < this.armedAt) return;

				// 内容变短把位置夹回去了：接受这个新位置，别硬撑。
				// 但刚切会话的等待期内不算数——那是内容还没渲染完，得继续重试。
				if (top < this.restTop) {
					if (settling) {
						// 只有内容真的长高了（或 ResizeObserver 报高度变了）才重新对齐，
						// 不靠定时器每 250ms 硬顶一次。
						if (grew || fromResize) {
							this.restore("等会话内容");
						} else if (SHOW_PROBE) {
							this.publish("等内容");
						}
						return;
					}
					this.restTop = Math.min(top, max);
					this.publish("内容变短");
					return;
				}

				// 往下漂了（DSH 的贴底跟随干的）：拉回原处。
				if (top - this.restTop > TOLERANCE) {
					this.restore("拦下贴底");
					return;
				}

				if (!fromWatch) return;
				// 位置没漂，但 DSH 还开着「跟随底部」：催它采样一次，把跟随关掉，
				// 免得它下一秒又往下拽。
				if (this.followingTail() && now - this.lastNudge > NUDGE_GAP_MS) {
					this.lastNudge = now;
					if (SHOW_PROBE) probe.nudges += 1;
					this.nudgeScrollEnd();
				}
				this.publish();
			}

			restore(note) {
				const now = performance.now();
				// 限速：流式输出时每个 token 都会让内容长高，不限速就是每帧跟 DSH 抢 scrollTop，
				// 两边来回写会把主线程拖死——用户看到的就是窗口卡住、滚不动。
				if (now - this.lastRestore < RESTORE_GAP_MS) return;
				this.lastRestore = now;
				this.armedAt = now + ARM_MS;
				this.scroller.scrollTop = this.restTop;
				if (SHOW_PROBE) probe.restores += 1;
				this.publish(note);
				// 补发 scrollend 也有代价：DSH 收到后会立刻重新采样，
				// 采样发现还在跟随就再贴一次底，于是又触发我们拉回，同样会打起来。
				if (now - this.lastNudge > NUDGE_GAP_MS) {
					this.lastNudge = now;
					if (SHOW_PROBE) probe.nudges += 1;
					this.nudgeScrollEnd();
				}
			}

			/**
			 * 补一个 scrollend，让 ui-chat 立刻重新采样、把「跟随底部」关掉。
			 * 它的滚动事件下一帧才派发，所以等两帧再发。
			 */
			nudgeScrollEnd() {
				const scroller = this.scroller;
				const fire = () => {
					if (this.disposed) return;
					try {
						scroller.dispatchEvent(new Event("scrollend"));
					} catch {
						/* 环境不支持也无所谓，它 500ms 后照样会自己采样 */
					}
				};
				requestAnimationFrame(() => requestAnimationFrame(fire));
			}

			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				// 容器被重建前先把位置存好，回来还能接着用。
				remember(this.sessionId, this.restTop);
				this.stopWatch();
				this.resizer?.disconnect?.();
				this.resizer = null;
				document.removeEventListener?.("visibilitychange", this.onVisibility);
				for (const type of INTENTS) {
					this.scroller.removeEventListener(type, this.onGesture, { capture: true });
				}
				this.scroller.removeEventListener("scroll", this.onScroll);
			}
		}

		class FreezeManager {
			constructor() {
				this.freezers = new Map();
				this.observer = null;
				this.scanTimer = null;
				this.warned = false;
			}

			start() {
				if (this.observer) return;
				this.scan();
				this.observer = new MutationObserver((records) => {
					for (const record of records) {
						for (const node of record.addedNodes) {
							if (!node || node.nodeType !== 1) continue;
							const el = node;
							if (
								el.matches?.(SELECTORS.scroll) ||
								el.querySelector?.(SELECTORS.scroll)
							) {
								this.scheduleScan();
								return;
							}
						}
					}
				});
				this.observer.observe(document.body, { childList: true, subtree: true });
				this.checkAnchors();
			}

			/** 把同一批 DOM 变化合并成一次扫描，流式输出时不会每 token 扫一遍。 */
			scheduleScan() {
				if (this.scanTimer !== null) return;
				const schedule = window.setTimeout ?? setTimeout;
				this.scanTimer = schedule(() => {
					this.scanTimer = null;
					if (this.observer) this.scan();
				}, SCAN_DEBOUNCE_MS);
			}

			/** 一个容器都没找到时给个提示，别让插件静默失效。 */
			checkAnchors() {
				const schedule = window.setTimeout ?? setTimeout;
				const timer = schedule(() => {
					if (this.freezers.size > 0 || this.warned) return;
					this.warned = true;
					console.warn?.(
						"[dsh-chat-answer-anchor] 没找到聊天滚动容器 " +
							SELECTORS.scroll +
							"，DSH 可能改了 DOM 结构，插件本次不生效。",
					);
				}, 1500);
				timer?.unref?.();
			}

			scan() {
				for (const el of document.querySelectorAll(SELECTORS.scroll)) {
					if (!this.freezers.has(el)) this.freezers.set(el, new Freeze(el));
				}
				for (const [el, freeze] of this.freezers) {
					if (el.isConnected) continue;
					freeze.dispose();
					this.freezers.delete(el);
				}
				// 新消息是 DOM 变化来的，扫描时顺手复核一次，
				// 免得「刚发出的话」要等 250ms 看门狗才认出来。
				for (const freeze of this.freezers.values()) freeze.check(false, true);
				if (SHOW_PROBE) {
					probe.anchors = this.freezers.size;
					if (this.freezers.size === 0) probe.note = "没找到滚动容器";
				}
			}

			stop() {
				this.observer?.disconnect();
				this.observer = null;
				if (this.scanTimer !== null) {
					const clear = window.clearTimeout ?? clearTimeout;
					clear(this.scanTimer);
					this.scanTimer = null;
				}
				for (const freeze of this.freezers.values()) freeze.dispose();
				this.freezers.clear();
				if (SHOW_PROBE) probe.anchors = 0;
			}
		}

		/** 诊断面板：确认无误后把 SHOW_PROBE 改成 false 就消失。 */
		function AnswerAnchorPanel() {
			const [snap, setSnap] = react.useState(() => ({ ...probe }));

			react.useEffect(() => {
				const manager = new FreezeManager();
				activeManager = manager;
				if (settingState.enabled) manager.start();
				if (!SHOW_PROBE) {
					return () => {
						manager.stop();
						if (activeManager === manager) activeManager = null;
					};
				}
				const timer = window.setInterval(() => setSnap({ ...probe }), 400);
				return () => {
					window.clearInterval(timer);
					manager.stop();
					if (activeManager === manager) activeManager = null;
				};
			}, []);

			if (!SHOW_PROBE) return null;

			const text = [
				`冻结 v12 · 容器 ${snap.anchors} · 行 ${snap.rows} · 会话 ${snap.sess}`,
				`rest ${snap.rest} cur ${snap.cur} max ${snap.max}`,
				`tail ${snap.tail ? 1 : 0} 跟 ${snap.follow ? 1 : 0} 拦 ${snap.restores} 催 ${snap.nudges}`,
				`user ${snap.users}`,
				`${snap.note}`,
			].join("\n");

			return react.createElement(
				"div",
				{
					style: {
						position: "fixed",
						right: 10,
						bottom: 10,
						zIndex: 9999,
						padding: "6px 9px",
						borderRadius: 6,
						background: "rgba(0,0,0,0.66)",
						color: "#fff",
						font: "11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace",
						whiteSpace: "pre",
						pointerEvents: "none",
						maxWidth: 340,
						opacity: 0.92,
					},
				},
				text,
			);
		}

		/** 设置页里的一行开关。 */
		function AnswerAnchorSettings() {
			const [enabled, setLocal] = react.useState(() => settingState.enabled);

			react.useEffect(() => {
				const listener = (value) => setLocal(value);
				settingState.listeners.add(listener);
				setLocal(settingState.enabled);
				return () => {
					settingState.listeners.delete(listener);
				};
			}, []);

			return react.createElement(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						gap: 8,
						padding: "8px 0",
						fontSize: 13,
					},
				},
				react.createElement("input", {
					key: "toggle",
					type: "checkbox",
					checked: enabled,
					onChange: () => setEnabled(!settingState.enabled),
				}),
				react.createElement(
					"span",
					{ key: "text" },
					enabled ? translate("on") : translate("off"),
				),
			);
		}

		const inject = ["slots", "locale"];

		/** 有 locale 服务就注册文案，没有就退回内置中文，不硬依赖。 */
		function applyLocale(ctx) {
			if (!ctx.locale) return;
			try {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "chat-answer-anchor:dictionaries");
				translate = ctx.locale.bind(NS);
			} catch {
				/* 注册失败就继续用内置中文 */
			}
		}

		function apply(ctx) {
			applyLocale(ctx);
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "chat-answer-anchor",
						order: 60,
					},
					AnswerAnchorPanel,
				),
			);
			ctx.slots.inject("settings.general.item", () =>
				ctx.slots.register(
					{
						name: "settings.general.item",
						id: "chat-answer-anchor",
						order: 62,
						label: () => translate("label"),
					},
					AnswerAnchorSettings,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.AnswerAnchorPanel = AnswerAnchorPanel;
		exports.AnswerAnchorSettings = AnswerAnchorSettings;
		/** 给本地行为自测用，不参与运行时逻辑。 */
		exports.__test = {
			Freeze,
			FreezeManager,
			countRows,
			sessionIdOf,
			sessionMemory,
			remember,
			recall,
			setEnabled,
			applyEnabled,
			setActiveManager: (manager) => {
				activeManager = manager;
			},
			settingState,
			loadEnabled,
			SELECTORS,
			lastUserKey,
			INTENTS,
			GESTURE_WINDOW_MS,
			TOLERANCE,
			SEND_FOLLOW_MS,
			FOLLOW_IDLE_MS,
			FOLLOW_MAX_MS,
			NEAR_BOTTOM_PX,
			SESSION_SETTLE_MS,
			SESSION_MEMORY_LIMIT,
			RESTORE_GAP_MS,
		};
		return module.exports;
	},
});
