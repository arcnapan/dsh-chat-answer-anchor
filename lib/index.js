/**
 * dsh-chat-answer-anchor —— 宿主侧入口。
 *
 * 这个插件的全部行为都在浏览器里（见 ./client.js）：它观察聊天滚动容器，
 * 让视口停在你最后停留的位置，不再被新回答自动拽到底部。
 * 宿主侧不需要任何服务、路由或配置，所以这里只提供一个空实现的 apply，
 * 让 bundle 能被正常加载和启停。
 */

export const name = "dsh-chat-answer-anchor";

export function apply(ctx) {
	ctx.effect(() => () => {}, "dsh-chat-answer-anchor: 纯客户端插件，宿主侧无需初始化");
}
