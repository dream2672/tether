# Tether Web 前端规范

本文件约束 `apps/web`。仓库级前端入口见 `../../FRONTEND.md`，根级长期事实见
`../../AI_CONTEXT.md`，共享编码原则见 `../../CLAUDE.md`。

`apps/web` 只承载普通用户会话控制台，不承载管理后台。管理后台统一在
`apps/admin-web`。

## 文档回写规范

`apps/web` 改动完成后必须判断是否需要回写文档。长期有效的 Web 事实回写到本文；
仓库级前端边界回写到 `../../FRONTEND.md`；跨模块架构事实再回写到
`../../AI_CONTEXT.md` 或 `../../PROJECT.md`。不得只改代码、不回写规范。

以下变更完成后必须同步更新本文或对应长期文档：

| 操作 | 需要更新 |
| --- | --- |
| 新增、删除或改名页面路由 | 本文「路由规范」和 `src/routes.tsx` |
| 新增或修改可见文案 | `src/i18n/messages.ts` |
| 新增页面布局模式 | 本文「布局模式」 |
| 新增或调整 `components/` 目录分层 | 本文「目录规范」 |
| 新增基础 UI 组件或 token 使用约束 | `../../packages/design` / `../../packages/theme` 相关文档 |
| 新增或修改 Chat 事件时序、Create/Restore flow、reducer/mapper/buffer | 本文「Chat 时序规范」和相关单测 |
| 新增或修改 chat-markdown / chat-code-block 样式 | `src/components/chats/messages/chat-markdown.css` |
| 发现新的 Web 反模式 | 本文「反模式速查」 |

不需要回写本文的内容：

- 单个 bug 修复，且没有改变路由、目录、时序、组件边界或用户可见契约。
- 临时施工状态、未确认方案、阶段性 TODO；这些写入 `docs/working/` 或 `.planning/`。
- 只影响一次提交的实现细节；保留在 git history 和测试里。

## 技术栈

- 框架：React + TypeScript + Vite
- 样式：Tailwind CSS v4 + CSS 自定义属性 token
- 基础组件：`@tether/design`
- 主题：`UiPreferencesProvider` 控制 `<html class="dark">`
- 多语言：`src/i18n/messages.ts` + `useI18n()`，禁止页面直接维护文案表
- 路由：`src/routes.tsx` 是路由事实源，禁止把新路由继续堆到 `main.tsx`
- 终端渲染：`@xterm/xterm` + `@xterm/addon-fit`

## 目录规范

```text
src/main.tsx                         应用启动、Provider、全局事件接线；
                                     /sessions 旧终端列表 surface 仍在此渲染
src/routes.tsx                       路由事实源和路由守卫
src/pages/                           页面级入口，只放路由页面
  help-page.tsx                      /help 公开使用帮助，不要求登录
  chats-page.tsx                     /chats 和 /chats/:sessionId
  terminal-page.tsx                  /terminal 和 /terminal/:sessionId
  login-page.tsx
  register-page.tsx
  gateway-auth-page.tsx
  session-control-page.tsx           /remote/session/:sessionId
  session-replay-page.tsx            /remote/session/:sessionId/replay
src/components/
  workbench/                         Workbench 三栏布局、统一 Sidebar、会话动作
    workbench-layout.tsx             路由嵌套 Outlet 布局；包裹 RelayClientProvider
    workbench-sidebar.tsx            统一 Sidebar（Chats / Terminal tab 切换）
    workbench-session-list.tsx       会话列表渲染
    workbench-session-actions.tsx    rename / archive / stop 动作
    workbench-status-pill.tsx        连接状态指示
    rename-session-dialog.tsx
    archive-session-dialog.tsx
    types.ts                         WorkbenchSessionRecord、WorkbenchSidebarTab 等类型
    session-utils.ts                 纯工具函数
  relay/                             共享 Relay WebSocket transport
    relay-client-provider.tsx        Provider：连接、认证、reconnect、sendFrame、frame fan-out
    use-relay-client.ts              useRelayClient() hook
  chats/                             Chat 领域 UI、结构化事件合并、Create/Restore 时序
    chat-panel.tsx                   Chat 工作区生产编排和 UI 接线
    app-sidebar.tsx                  旧 Sidebar（过渡期保留，逐步迁到 workbench/）
    composer/                        输入框、slash command UI 和交互
      chat-composer.tsx              输入框、发送按钮、session 状态浮层接线
      slash-command-menu.tsx         Slash command 菜单 UI
      slash-commands.ts              Slash command 定义和 localStorage 使用统计
      use-slash-menu.ts              Slash command 交互 hook
    data/                            Chat HTTP 数据请求和响应类型
      chat-data.ts                   Chat session / snapshot / catch-up 请求
    events/                          结构化事件类型、映射和 reducer
      chat-flow-types.ts             Chat event、snapshot、restore attempt 类型
      chat-event-reducer.ts          结构化事件 -> MessageItem 的纯 reducer
      chat-event-mappers.ts          Relay / Server 原始 frame -> Chat event
    flow/                            Create/Restore/session guard 纯逻辑
      chat-create-flow.ts            clientRequestId optimistic turn 生成/合并/回滚
      chat-restore-buffer.ts         Restore 期间 live event buffer
      chat-restore-plan.ts           进入、切换、重连时的恢复计划
      chat-session-guards.ts         sessionId、attempt、ack 异步保护
      session-switch-guards.ts       切换 session 时的遗留 guard 工具
    messages/                        消息气泡和卡片组件
      chat-bubble-agent.tsx
      chat-bubble-user.tsx
      chat-markdown.css              Markdown 和代码块样式事实源
      discussion-choice-cards.tsx
      model-avatar.tsx               模型头像
      permission-prompt.tsx
      result-card.tsx                结果卡片
      system-message.tsx
      tool-card.tsx
      streaming-cursor.tsx
      thinking-dots.tsx
    model/                           Chat UI 类型和展示工具函数
      chat-types.ts                  Chat UI 消息类型
      chat-utils.ts                  Chat UI 纯工具函数
    shell/                           Chat 页面壳、列表编排和状态控件
      chat-header.tsx                Chat 顶部栏
      chat-message-list.tsx          消息列表容器
      chat-session-status-popover.tsx 当前 chat session 状态浮层
      gateway-selector.tsx           Gateway 选择器
      new-chat-surface.tsx           空 session / 新建 chat surface
      notification-bell.tsx          通知入口
  terminal/                          Terminal 可嵌入面板
    terminal-pane.tsx                xterm 初始化、output 写入、resize、control/observe
    terminal-session-picker.tsx      选择 running session 的选择器
  session/                           旧整页 PTY surface（过渡期保留）
    session-surface.tsx
    session-detail-chrome.tsx
    chat-bubble.tsx
  console/                           登录壳和 Chrome 控制
    web-auth-shell.tsx
    web-chrome-controls.tsx
  ui/
    form.tsx
src/hooks/
  terminal/                          Terminal runtime 状态
    use-terminal-runtime.ts
    use-terminal-instance.ts
    use-terminal-composer.ts
  workbench/                         Workbench 数据
    use-workbench-sessions.ts
  use-auth.ts
  use-i18n.ts
  use-ui-preferences.ts
  use-update-check.ts
src/contexts/
  auth-context.tsx
  ui-preferences-context.tsx
src/lib/
  api.ts
  provider-resume-command.ts
  terminal-text-extractor.ts
  utils.ts
src/i18n/messages.ts
src/styles.css
test/
  chat-create-flow.test.ts           clientRequestId optimistic flow
  chat-event-mappers.test.ts         raw frame -> structured event 映射
  chat-event-reducer.test.ts         eventSeq / turnId reducer 行为
  chat-restore-buffer.test.ts        Restore live buffer 行为
  chat-restore-plan.test.ts          Restore plan 纯函数
  chat-session-guards.test.ts        async guard 行为
  chat-utils.test.ts                 Chat 工具函数
  session-switch-guards.test.ts      遗留 session switch guard
```

### 文件命名规范

- 新增文件统一使用 **kebab-case**：`session-list-page.tsx`、`use-i18n.ts`、
  `auth-context.tsx`。
- React 组件导出仍使用 **PascalCase**：`WorkbenchLayout`、`WebAuthShell`。
- Hook 文件用 `use-*.ts`，hook 导出用 camelCase：`useRelayClient`。
- Context 文件用 `*-context.tsx`。
- 路由页面文件用 `*-page.tsx`。
- 禁止新增 PascalCase 文件名；当前前端 app 文件名应保持 kebab-case。

### 目录职责边界

- `components/workbench/`：三栏布局、统一 Sidebar、session list/actions、连接状态。不放 chat 消息或 terminal output 业务逻辑。
- `components/relay/`：Relay WS transport，只暴露连接能力、在线快照和 frame fan-out。不理解 chat message 或 terminal output。
- `components/chats/`：Chat 领域根目录，只保留 `chat-panel.tsx` 这种生产编排入口和过渡期入口文件；新增文件必须优先放入下列子目录。
- `components/chats/composer/`：输入框、slash command 菜单、slash command hook 和本地使用统计。不放事件 reducer、HTTP 请求或消息气泡。
- `components/chats/data/`：Chat HTTP snapshot / catch-up / session list 请求和响应类型。不放 React 组件。
- `components/chats/events/`：结构化事件类型、mapper、reducer。不依赖 React 组件，不读取 DOM / localStorage。
- `components/chats/flow/`：Create/Restore flow、buffer、guard、plan 等纯逻辑。不依赖 React 组件，不发 HTTP 请求。
- `components/chats/messages/`：消息气泡、Markdown 渲染、模型头像、结果卡片、tool/permission/system 卡片。不依赖 relay 或路由。
- `components/chats/model/`：Chat UI 类型和展示工具函数。不放副作用逻辑；如果要访问 localStorage、HTTP 或 relay，应放到更具体目录。
- `components/chats/shell/`：Chat 页面壳、列表编排、顶部栏、Gateway 选择器、通知入口和状态浮层。不放 reducer、mapper 或 Create/Restore guard。
- `components/terminal/`：可嵌入 terminal 面板。不处理 chat message。
- `components/session/`：旧整页 PTY surface，过渡期保留，新功能优先用 `terminal/terminal-pane.tsx`。
- `hooks/terminal/`：terminal runtime 状态，不处理 chat。
- `hooks/workbench/`：workbench 数据（session 列表、tab），不处理运行时业务。

## 路由规范

当前 `apps/web` 路由（`src/routes.tsx` 为事实源）：

| 路由 | 说明 |
| --- | --- |
| `/login` | 普通用户登录 |
| `/register` | 普通用户注册 |
| `/help` | 公开使用帮助，不要求登录 |
| `/gateway-auth` | Gateway 本地认证回调 |
| `/` | 重定向到 `/chats` |
| `/chats` | Chat 工作台（WorkbenchLayout 嵌套） |
| `/chats/:sessionId` | 特定 chat session（WorkbenchLayout 嵌套） |
| `/terminal` | Terminal 工作台（WorkbenchLayout 嵌套） |
| `/terminal/:sessionId` | 特定 terminal session（WorkbenchLayout 嵌套） |
| `/sessions` | 旧终端列表页（`main.tsx` 渲染，过渡期保留） |
| `/remote/session/:sessionId` | 旧整页 terminal session |
| `/remote/session/:sessionId/replay` | 旧终端 replay |
| `*` | 重定向 `/chats` |

规则：

- 新增路由必须先进入 `src/routes.tsx`。
- `/chats`、`/chats/:sessionId`、`/terminal`、`/terminal/:sessionId` 由 `WorkbenchLayout` 嵌套，共享 Relay WS 连接和 Sidebar。
- 需要鉴权的页面必须通过 `RequireUserAuth` 路由守卫表达，不能在页面组件里散装 `Navigate`。
- `apps/web` 禁止新增 `/admin/*` 页面；后台入口在 `apps/admin-web`。
- 不要继续把新路由挂到 `main.tsx`；`/sessions` 是遗留路由，不复制这种模式。

## Relay 架构

`RelayClientProvider`（`components/relay/relay-client-provider.tsx`）是共享 WebSocket transport 的唯一入口，由 `WorkbenchLayout` 包裹。

Provider 只暴露：

```ts
type RelayClientContextValue = {
  ready: boolean;
  connectionEpoch: number;
  gatewayIdsOnline: Set<string>;
  gatewayNamesById: Record<string, string>;
  relaySessions: RelaySessionSummary[];
  sendFrame(frame: Record<string, unknown>): boolean;
  subscribeFrame(handler: (frame: RelayFrame) => void): () => void;
  subscribe(input: RelaySessionSubscriptionInput): void;
  unsubscribe(ownerKey: string): void;
};
```

禁止：

- 在 `WorkbenchLayout` 以外再创建独立 Relay WS 连接。
- 在 Provider 里处理 chat message 或 terminal output 业务状态。
- Chat / Terminal 组件各自维护独立 WS 连接。

订阅所有权：每个 runtime hook 持有唯一 `owner` key（`chat:${sessionId}` / `terminal:${sessionId}`），`unsubscribe` 时只释放自己的 owner，不影响其他消费者。

## Chat 时序规范

Chat 消息必须以结构化事件为事实源。Web 侧只能按 `clientRequestId`、`turnId`、
`eventSeq` 合并，不允许再用文本内容、最后一个 assistant 气泡或历史快照新旧猜测来
推断消息归属。

### 事件身份

- `eventSeq`：session 级严格递增序号，所有事件类型共享。Web 按 `eventSeq ASC`
  应用事件；已处理过的 `eventSeq <= lastEventSeq` 必须忽略。
- `turnId`：一次 user -> assistant 交互的稳定 ID。`agent.delta`、`agent.result`、
  `agent.tool`、`agent.permission_request`、`session.error` 都按 `turnId` 归属到对应回合。
- `clientRequestId`：Web 发起新消息时生成，用于 optimistic user / waiting assistant
  和 Gateway echo 的 `user.message` 对齐。
- 当前 Web 生产路径只消费结构化事件：`user.message`、`agent.delta`、
  `agent.result`、`agent.tool`、`agent.permission_request`、`session.error`。
- `agent.delta` / `agent.result` 可以携带同一个 `clientRequestId`，作为
  `user.message` 乱序或延迟时绑定 optimistic waiting assistant 的兜底；主路径仍以
  `user.message(clientRequestId, turnId, eventSeq)` 确认 turn。

### Create Flow

新建或发送一轮 chat 必须按以下顺序：

1. Web 生成 `clientRequestId`。
2. Web 先创建 optimistic user message 和 waiting assistant message。
3. Web 发送 `client.chat`，payload 带上 `clientRequestId`。
4. Gateway echo `user.message`，带回 `clientRequestId`、`turnId`、`eventSeq`。
5. Web 用 `clientRequestId` 合并 optimistic user message，并把 waiting assistant 绑定到
   `turnId`。
6. 后续 `agent.delta` / `agent.result` / tool / permission / error 全部按 `turnId`
   合并；完成后的 turn 不再接受迟到 delta。

### Restore Flow

进入、切换或重连 chat session 时，Server snapshot/catch-up path 必须先行启动，
不能被 live subscribe 或 `subscription.ack` 阻塞。Live subscribe path 只负责实时增强；
两条路径最终通过 reducer 按 `eventSeq` 去重合流：

1. 切换 session 前释放旧 `chat:${sessionId}` owner。
2. 为本轮恢复创建 restore attempt 和 buffer。
3. 立即请求 `/api/server/chat-sessions/:sessionId/messages`，读取 messages 和 `snapshotEventSeq`。
4. 请求 `/api/server/chat-sessions/:sessionId/events?after=snapshotEventSeq` 拉取结构化 catch-up。
5. 同时或随后对目标 session 调 `subscribe(... after: 0)`，等待 `subscription.ack`。
6. `subscription.ack` 只表示 live subscribe 已生效，不再决定是否拉 snapshot。
7. snapshot 完成之前收到的 live 结构化事件只进入 buffer，不直接改 UI。
8. 将 catch-up 和 buffer 内事件按 `eventSeq ASC` 去重后交给 reducer。
9. buffer drain 后，本轮 attempt 仍有效的 live 事件才可直接进入 reducer。
10. snapshot 或 catch-up 失败时，不清空当前已有消息；显示 restore error / retry 状态。

`subscribe(... after: 0)` 是有意保留：这样 live path 不需要等待 Server snapshot
返回后才启动，避免重新引入串行依赖。在线 Gateway 下可能收到 `snapshotEventSeq`
之前的旧事件，必须由 reducer 的 `eventSeq` 去重丢弃；禁止在 `chat-panel.tsx` 手工
append 这类 live/catch-up 消息。

### 文件职责

- `events/chat-flow-types.ts`：Chat event、snapshot、restore attempt 等类型。
- `events/chat-event-reducer.ts`：结构化事件到 `MessageItem` 的纯 reducer；负责排序、去重、
  completed turn gate。
- `events/chat-event-mappers.ts`：Relay / Server 原始 frame 到 Chat event 的映射。
- `flow/chat-restore-buffer.ts`：Restore 期间 live event buffer。
- `flow/chat-restore-plan.ts`：进入、切换、重连时的恢复计划纯函数。
- `flow/chat-session-guards.ts`：sessionId、attempt、ack 等异步保护。
- `flow/chat-create-flow.ts`：`clientRequestId` optimistic turn 的创建、合并和失败回滚。
- `data/chat-data.ts`：HTTP snapshot / catch-up 请求封装。
- `chat-panel.tsx`：生产编排和 UI 接线，不承载可单测的 reducer/mapper 细节。

### 禁止回退的旧做法

- 禁止用 `gateway.chat-catchup` blob 写 streaming assistant；新流程只用 structured
  catch-up events。
- 禁止恢复 `lastDeltaEventIdRef`、`currentAgentIdRef`、
  `historySnapshotLooksOlder()` 这类启发式生产路径。
- 禁止按 message text 做用户消息或 assistant 消息去重。
- 禁止把 chat merge 逻辑下沉到 `RelayClientProvider`；Provider 仍然只做 transport。
- `session.error` 是 turn 级错误，不等同于 Relay 连接断开；连接状态由 Relay 层表达。

## i18n 规范

- `apps/web` 默认所有页面都必须支持中文 / English，不允许新增单语言页面。
- 所有可见文案必须来自 `src/i18n/messages.ts`。
- 页面组件通过 `useI18n()` 获取 `t`，不要直接 import 文案对象。
- 语言偏好由 `UiPreferencesProvider` 统一读写 localStorage。
- 表单校验、按钮 loading、空态、错误兜底文案都属于可见文案，新增时必须进 i18n。
- 登录后页面也必须提供语言切换入口；复用 `WebChromeControls` 或等价共享组件。
- 禁止再新增 `ui-copy.ts`、页面内 `const copy = ...` 或散落的双语 map。

## Chat Markdown 样式规范

聊天气泡内的 Markdown 渲染和代码块所有 CSS 统一写入：

```
src/components/chats/messages/chat-markdown.css
```

该文件在 `src/styles.css` 顶部通过 `@import` 引入，**禁止**把 `.chat-markdown`、
`.chat-code-block`、`.chat-code-*` 及 hljs token 覆盖规则写到 `styles.css` 或
其他文件。

新增样式时的判断：

| 样式范围 | 写入位置 |
| --- | --- |
| Markdown 内 `p` / `ul` / `ol` / `li` / `hr` / `h*` / `a` 等 prose 覆盖 | `messages/chat-markdown.css` |
| 代码块容器、header、copy 按钮、pre/code 颜色 | `messages/chat-markdown.css` |
| hljs token 亮色/暗色 overrides | `messages/chat-markdown.css` |
| 其他页面级、全局布局样式 | `styles.css` |

## Token 与样式规范

- 主题入口是 `@tether/theme/globals.css`，由 `src/styles.css` import。
- `apps/web` 默认所有页面都必须同时支持 light / dark；新增页面、shell、终端面板和空态都要在两种主题下可读。
- 页面级 header 或 shell 必须提供主题切换入口；复用 `ThemeToggle` / `WebChromeControls`，不要另写视觉。
- 公共 token 只维护在 `packages/theme`；app 层不得定义新的品牌色、文字色、阴影体系。
- 使用 shadcn 扁平 token utility：`bg-card`、`text-foreground`、`border-input`、
  `text-foreground-tertiary` 等。
- 禁止 `bg-bg-*`、`text-text-*`、`border-border-*`、`ring-border-*` 双前缀写法。
- 品牌色只用于主 CTA、active/current 状态、关键 badge、focus ring；不要大面积铺满页面。
- `backdrop-blur` 只允许登录背景特效、header/nav、modal overlay；业务卡片不要滥用。

## 组件规范

| 场景 | 必用组件 | 禁止 |
| --- | --- | --- |
| 按钮 | `Button` | 手写 button 样式 |
| 图标 | `lucide-react` | 手写 SVG |
| 文本输入 | `Input` | 裸 `<input>` |
| 多行输入 | `Textarea` | 裸 `<textarea>` |
| 信息提示 | `InfoBlock` / `Alert` | 散装 rounded border div |
| 卡片 | `Card` parts | 页面层重复拼 card |
| 反馈 | `toast` | `alert()` |
| 主题切换 | `ThemeToggle` | 重写主题按钮视觉 |

可复用的基础交互模式必须先考虑上移到 `packages/design/src/`，不要在 `apps/web`
复制一套组件库。

## 布局模式

### 模式 A：Auth Shell

适用：`/login`、`/register`。

- 由 `WebAuthShell` 统一承载。
- 背景允许低饱和品牌渐变和轻微动画。
- 表单卡片固定宽度；禁止宽屏铺满。
- 移动端隐藏左侧状态面板，只保留登录卡片。

### 模式 B：Workbench

适用：`/chats`、`/chats/:sessionId`、`/terminal`、`/terminal/:sessionId`。

- 由 `WorkbenchLayout` 统一承载，内部包裹 `RelayClientProvider`。
- 三栏结构：左侧 `WorkbenchSidebar`（260px）+ 中间内容区（flex: 1）。
- 左侧 Sidebar 支持 Chats / Terminal tab 切换；移动端收入 drawer。
- 内容区由 React Router `<Outlet>` 渲染对应页面（`ChatsPage` / `TerminalPage`）。
- Relay WS 连接由 `WorkbenchLayout` 持有，`/chats` 和 `/terminal` 共享同一连接。

### 模式 C：Terminal Surface（旧）

适用：`/remote/session/:sessionId`、`/remote/session/:sessionId/replay`。

- 整页 terminal，由 `SessionSurface` 承载（过渡期保留）。
- 终端区域优先占满可用高度，输入区固定底部。
- 新功能优先使用 `components/terminal/terminal-pane.tsx` 嵌入，不要扩展旧 surface。

### 模式 D：Auth Callback

适用：`/gateway-auth`。

- Gateway 本地认证回调页，功能页，无需完整 shell。

## 反模式速查

| 禁止行为 | 正确做法 |
| --- | --- |
| 在 `main.tsx` 继续堆新路由 | 改 `src/routes.tsx` |
| 新增 PascalCase 文件名 | 新文件统一 kebab-case |
| 在页面写硬编码可见文案 | 放进 `src/i18n/messages.ts` |
| `apps/web` 新增 `/admin/*` | 改 `apps/admin-web` |
| 页面层重复实现基础控件 | 用 `@tether/design` |
| 大面积品牌绿背景/阴影 | 只在主操作和状态锚点使用品牌信号 |
| 宽屏登录表单铺满 | 走 `WebAuthShell` 固定卡片宽度 |
| 把 `.chat-markdown` / `.chat-code-*` 样式写进 `styles.css` | 统一写入 `src/components/chats/messages/chat-markdown.css` |
| Chat 组件或 Terminal 组件自建 Relay WS 连接 | 通过 `useRelayClient()` 共享 WorkbenchLayout 的连接 |
| Chat 用文本内容、最后一个 assistant 气泡或历史快照新旧猜测合并消息 | 用 `clientRequestId` / `turnId` / `eventSeq` |
| Restore snapshot 返回前直接 apply live chat 事件 | 先 buffer，snapshot + catch-up 完成后按 `eventSeq ASC` drain |
| 用 `gateway.chat-catchup` blob 写 streaming assistant | 只消费 structured catch-up events |
| 重新引入 `lastDeltaEventIdRef` / `currentAgentIdRef` / `historySnapshotLooksOlder()` | 保持 reducer + restore buffer 的确定性时序 |
| Terminal 业务逻辑写进 `components/chats/` | 放 `components/terminal/` 和 `hooks/terminal/` |
| `unsubscribe` 时不指定 owner key | 传自己的 `chat:${sessionId}` / `terminal:${sessionId}` owner，防止误断他方订阅 |
| 新功能扩展 `components/session/session-surface.tsx` | 用 `components/terminal/terminal-pane.tsx` |
| 用裸 `<select>` 做复杂选择器 | 优先 `Select`；简单调试控件例外需保持样式 token |

## 验证

Web 改动至少执行：

```bash
pnpm --filter @tether/web typecheck
```

修改 Chat Create/Restore 时序、mapper、reducer、buffer 或 `chat-panel.tsx` 接线时执行：

```bash
pnpm --filter @tether/web test
pnpm --filter @tether/web typecheck
```

影响构建、路由、i18n 或样式时执行：

```bash
pnpm --filter @tether/web build
```
