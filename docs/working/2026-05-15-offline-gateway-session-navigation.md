# 离线 Gateway 下 Session 导航降级方案

状态：Working / 第一阶段 Chat 修复已实现

日期：2026-05-15

## 背景

当前 Web 工作台左侧导航切换 session 时，如果目标 session 所属电脑的 Gateway 不在线，用户可能感觉“切换不成功”。实际问题不应被定义为 session 不存在，而应定义为：

- session 仍属于某台固定 Gateway；
- Gateway 离线只影响实时控制能力；
- 用户仍应能进入 session 页面查看已有历史和归属状态；
- 不能把该 session 自动路由到另一台在线 Gateway。

本文件记录方案、TODO、验证项目和第一阶段实现结果。当前已实现 Chat Server-first Restore；Terminal 离线只读、Relay 离线语义收敛仍是后续项。

## 当前事实

### Web 路由事实源

`apps/web/src/routes.tsx` 已经定义：

- `/chats`
- `/chats/:sessionId`
- `/terminal`
- `/terminal/:sessionId`

左侧 session 点击本质上应该只是进入对应 session 路由。Gateway 在线状态不应决定这个路由是否可进入。

### Session ownership

session 记录中存在 `gatewayId`。这个字段是 session 属于哪台电脑 / 哪个 Gateway 的关键边界。

因此：

- 已有 session 不能因为 owner Gateway 离线而切到其他 Gateway。
- 已有 session 也不能 fallback 到账号下第一台在线 Gateway。
- 新建 session 可以选择在线 Gateway；已有 session 只能显示自己的 owner Gateway。

### Relay 与 Gateway 在线状态

Relay 已经存在以下语义：

- `gateway.status`：通知某个 Gateway connected / disconnected。
- `gateway_unavailable`：目标 Gateway 不在线，实时请求无法转发。

这些语义适合表达“实时能力不可用”，不适合表达“页面不能进入”。

### Web 当前可用状态

Web 侧已经维护：

- `gatewayIdsOnline`
- `gatewayNamesById`
- `relaySessions`
- session list
- Gateway selector
- Chat / Terminal 的连接状态展示

因此本问题优先应在 Web 层做“离线只读降级”，不需要先新增后端抽象。

## 目标体验

### 核心规则

| 场景 | 目标行为 |
| --- | --- |
| 点击左侧已有 Chat session | 永远允许切换到 `/chats/:sessionId` |
| 点击左侧已有 Terminal session | 永远允许切换到 `/terminal/:sessionId` |
| owner Gateway 在线 | 正常订阅实时流，可继续输入 / 控制 |
| owner Gateway 离线 | 页面正常打开，显示历史与离线提示，输入 / 控制禁用 |
| owner Gateway 恢复在线 | 当前页面自动恢复订阅，输入 / 控制恢复 |
| 新建 Chat / Terminal | 仍必须选择在线 Gateway |
| 已有 session 的 Gateway selector | 只读显示 owner Gateway，离线也要显示 |

### 产品结论

正确体验是：

```text
能打开，能看历史，不能实时控制。
```

不是：

```text
离线 Gateway 下 session 点不进去。
```

## 设计原则

1. **路由不受 Gateway 在线状态阻断**
   - `sessionId` 是进入页面的主键。
   - Gateway 在线状态只决定页面内的实时能力。

2. **不跨 Gateway fallback**
   - 不能用另一台在线 Gateway 承接离线 Gateway 的 session。
   - 不能使用“第一个在线 Gateway”作为已有 session 的替代路由。

3. **历史读取和实时控制分离**
   - 历史 metadata / messages / events 应尽量从 Server 读取。
   - Gateway 在线只影响 subscribe、send message、input、resize、stop 等实时动作。

4. **错误语义降级**
   - `gateway_unavailable` 对当前 session 应解释为“owner Gateway 离线”。
   - 不应把它解释成全局 Web 连接失败。

5. **保持多账号 / 多 Gateway 隔离**
   - session 必须继续按 `session.gatewayId` 路由。
   - 离线态不能绕过账号、用户、Gateway ownership 检查。

6. **不改变 Chat 事件身份，但需要修正 Restore flow 入口顺序**
   - 本方案不修改 Chat Event Ordering 的 `eventSeq`、`turnId`、`clientRequestId`、`snapshotEventSeq` 契约。
   - Gateway 离线只影响 live subscribe / send / control，不改变 history、catch-up、reducer 的消息合并规则。
   - 现有 `apps/web/CLAUDE.md` 的 Restore flow 仍写着“先等 `subscription.ack`，再拉 snapshot/catch-up”。这会导致 owner Gateway 离线时 `/messages` 不发请求，右侧保留上一个 session 数据。
   - 修正方向：Server snapshot/catch-up path 必须在进入 session 后立即启动，不能被 live subscribe / `subscription.ack` 阻塞；live subscribe 只负责实时增强。
   - Gateway 恢复在线后的重新订阅必须复用 Restore flow 的 reducer / mapper 边界；恢复水位继续使用 `snapshotEventSeq` / `eventSeq after`。
   - 不允许为了修离线切换，在 `chat-panel.tsx` 里新增文本拼接、最后一个 assistant 气泡猜测、delta 文本去重等旧启发式逻辑。
   - 相关长期规范以 `apps/web/CLAUDE.md` 的“Chat 时序规范”为准，但本方案确认后必须同步修正其中 Restore flow 顺序；完整时序方案记录在 `docs/working/2026-05-14-chat-event-ordering-and-web-refactor.md`。

## 当前问题判断

本次用户反馈的真实症状是：

```text
左侧点击后看起来切了，但右侧仍然是上一个 session 的数据。
```

代码对照后，当前触发链路是：

1. `/chats/:sessionId` 路由会把 URL 参数传给 `ChatPanel.activeSessionId`。
2. `activeSessionId` 变化后，`ChatPanel` 会加载 metadata。
3. 但 `/api/server/chat-sessions/:sessionId/messages` 不是在 `activeSessionId` 变化时立即请求。
4. 当前消息历史请求挂在 `subscription.ack` 分支之后。
5. 如果目标 session 的 owner Gateway 离线，`subscription.ack` 不会回来，`/messages` 就不会发。
6. 同时切换 session 时没有先清掉旧 `messages`，所以右侧继续显示上一个 session 的数据。

因此第一优先级不是改 Relay，也不是改 Gateway，而是修正 Web Chat Restore flow 的入口：

```text
Server history path 不等 Gateway live subscribe；
Gateway live subscribe 只决定实时能力。
```

## 方案收敛结论

本问题应拆成两个层次处理：

| 层次 | 当前问题 | 处理优先级 |
| --- | --- | --- |
| Chat session 切换状态隔离 | 右侧继续显示上一个 session，且 `/messages` 没发请求 | P0 |
| 离线 Gateway 只读降级 | owner Gateway 离线时不能实时输入 / 控制，但应能看 Server 历史 | P0 |
| Terminal 离线只读 | Terminal session 也应允许进入并禁用实时控制 | P1 |
| Relay `sessions: []` 语义 | 可能导致列表被误清空，但不是 `/messages` 不发请求的根因 | P1/P2 |

当前第一阶段只收敛 Chat：

```text
activeSessionId 变化
  -> 立即切换右侧到目标 session 的 restoring 状态
  -> 立即启动 Server metadata/history/catch-up
  -> 同时或随后尝试 live subscribe
  -> ack 成功才进入实时
  -> ack 失败或 gateway_unavailable 则保持当前 session 的离线只读态
```

第一阶段不改：

- 不改 Relay。
- 不改 Gateway runner。
- 不改协议字段。
- 不改 Chat event identity。
- 不处理 Terminal 的完整离线只读体验，Terminal 作为第二阶段。

这样可以直接解决用户当前看到的“切过去了但还是上一个数据 / 没有发 `/messages` 请求”。

## 对原 Chat 时序方案的影响判断

本方案会影响 Restore flow 的编排顺序，但不改变 Chat 时序的核心事件契约。

| 层 | 内容 | 本方案影响 |
| --- | --- | --- |
| 事件身份层 | `eventSeq`、`turnId`、`clientRequestId`、`snapshotEventSeq` | 不影响 |
| Restore 编排层 | 什么时候 subscribe、什么时候 snapshot、什么时候 catch-up、什么时候 drain buffer | 需要修正 |

原 Restore flow 的问题在于把 Server history 绑定到了 live subscribe 成功之后：

```text
subscribe -> 等 subscription.ack -> 拉 /messages -> 拉 /events?after=snapshotEventSeq -> drain
```

这在 Gateway 在线时可以减少 live 事件窗口，但在 owner Gateway 离线时会导致：

```text
subscription.ack 不回来 -> /messages 不发 -> 右侧保留上一个 session 数据
```

修正后的 Restore flow 应拆成两条路径：

```text
Server path:
activeSessionId 变化 -> 立即 /messages -> /events?after=snapshotEventSeq -> reducer 展示历史

Live path:
同时/随后 subscribe -> ack 成功后接 live -> ack 失败则只读离线
```

因此，`subscription.ack` 的职责需要收窄：

| 原职责 | 修正后职责 |
| --- | --- |
| 决定是否开始拉 Server history | 取消 |
| 确认 live subscribe 已生效 | 保留 |
| 控制 live buffer / live frame 进入 reducer | 保留 |
| Gateway 离线时阻塞页面展示 | 禁止 |

核心时序仍保持不变：

- snapshot 仍然带 `snapshotEventSeq`。
- catch-up 仍然用 `/events?after=snapshotEventSeq`。
- events 仍然按 `eventSeq ASC` 合并。
- 重复 event 仍然按 `eventSeq` 丢弃。
- assistant 仍然按 `turnId` 归位。
- optimistic message 仍然按 `clientRequestId` 合并。
- 不恢复 `gateway.chat-catchup` blob。
- 不恢复文本拼接、最后一个 assistant 气泡猜测、历史快照新旧猜测。

需要特别防范的在线场景：

```text
/messages 返回 snapshotEventSeq=100
live 已经收到 eventSeq=101,102
/events?after=100 又返回 101,102
```

这个交叠不能靠请求顺序解决，必须靠 reducer 的 `eventSeq` 去重解决。因此实现时不得绕开 reducer 在 `chat-panel.tsx` 手工 append 消息。

确认本方案后，`apps/web/CLAUDE.md` 的长期规范建议改成：

```text
Restore flow 分为 Server snapshot/catch-up path 和 Live subscribe path。
Server path 进入 session 后立即启动，不被 subscription.ack 阻塞。
Live path 只负责实时增强。
两条路径最终通过 reducer 按 eventSeq 去重合流。
```

## 推荐方案

### 方案 A：离线 Session 可进入，只读降级

这是推荐方案。

流程：

```text
1. 用户点击左侧 session。
2. Web 立即导航到 /chats/:sessionId 或 /terminal/:sessionId。
3. Web 立即把右侧切到目标 session 的 restoring/loading 状态，不能继续展示上一个 session 的数据。
4. Server snapshot/catch-up path 立即启动：
   - 请求 metadata，确认 owner gatewayId/provider/projectPath。
   - 请求 /messages，拿 messages + snapshotEventSeq。
   - 请求 /events?after=snapshotEventSeq，拿结构化 catch-up events。
   - 用 reducer 按 eventSeq 合并后展示当前 session 历史。
5. Live subscribe path 同时或随后启动：
   - 尝试 subscribe(sessionId, after=0)。
   - subscription.ack 只代表 live subscribe 已生效，不再决定是否拉历史。
   - ack 前收到的 live frame 如有必要进入 buffer；最终仍按 eventSeq 与 Server path 合流。
   - 这里保留 `after=0` 是为了避免 live subscribe 等待 Server snapshot 后才启动，重新引入串行依赖。代价是在线 Gateway 下可能收到 snapshot 水位之前的旧事件，必须依赖 reducer 的 `eventSeq` 去重丢弃；不能在 `chat-panel.tsx` 手工 append。
6. 如果 owner Gateway 在线：
   - live subscribe 成功后接收实时 frames。
   - 输入和控制可用。
7. 如果 owner Gateway 离线：
   - 不阻断页面进入。
   - 已展示 Server 历史。
   - 输入框、Terminal 控制、stop、resize 禁用。
   - 显示“这台 Gateway 离线，恢复连接后可继续”。
8. Gateway 恢复在线：
   - Web 收到 gateway.status connected。
   - 当前 session 自动重试 subscribe。
   - 页面从只读恢复为可交互。
```

优点：

- 符合用户对“历史 session 可查看”的直觉。
- 不改变 session ownership。
- 不引入跨 Gateway 路由风险。
- 主要改 Web 状态机和错误处理，影响面可控。

代价：

- Chat 和 Terminal 都要处理离线只读态。
- Web 需要区分“Relay 断开”和“owner Gateway 离线”。
- 需要避免 `gateway_unavailable` 触发全局列表清空体验。
- 需要修正 `apps/web/CLAUDE.md` 里现有 Restore flow 的“ack 后 snapshot”顺序。

### 不推荐方案 B：离线 session 禁止点击

不推荐。

问题：

- 用户无法判断是点击失败、路由失败、还是 Gateway 离线。
- 历史内容也无法查看。
- 和 `/chats/:sessionId`、`/terminal/:sessionId` 的路由语义冲突。

### 不推荐方案 C：自动切到其他在线 Gateway

不推荐。

问题：

- 违反 session ownership。
- 多电脑场景下可能把 A 电脑 session 的操作发到 B 电脑。
- 与多账号 / 多 Gateway 隔离规范冲突。

### 不推荐方案 D：Relay 对离线 Gateway 广播空 sessions

不推荐作为 Web 体验事实。

问题：

- `sessions: []` 容易被 Web 解释为“没有 session”，导致左侧列表突然清空。
- Gateway 离线不等于历史 session 不存在。
- 离线应是 Gateway 状态，不应直接抹掉 Server 历史列表。

## 代码级 TODO

> 本节记录第一阶段实现状态和后续 TODO。

### 第一阶段范围：Chat Server-first Restore

- [x] 只修改 Chat 相关路径，优先解决 `/chats/:sessionId` 右侧旧数据残留和 `/messages` 不发请求。
- [x] 不先修改 `apps/relay/src/relay.ts`。
- [x] 不先修改 `apps/gateway/src/chat/*` 或 `apps/gateway/src/pty/*`。
- [x] 不新增或修改 `packages/protocol/src/index.ts` 字段。
- [x] 不在第一阶段处理 Terminal 完整离线只读；只保留文档和后续 TODO。

### 第一阶段文件清单

| 文件 | 是否第一阶段改 | 改动目的 |
| --- | --- | --- |
| `apps/web/src/components/chats/chat-panel.tsx` | 已改 | 核心接线：切换 session 立即清旧 UI，Server history path 不等 `subscription.ack`，live subscribe 只管实时增强 |
| `apps/web/src/components/chats/flow/chat-restore-plan.ts` | 已改 | 用纯函数表达 Server-first Restore plan，避免把新顺序散落在组件里 |
| `apps/web/test/chat-restore-plan.test.ts` | 已改 | 锁定“不等 ack 也会计划 snapshot/catch-up”的行为 |
| `apps/web/src/components/chats/flow/chat-session-guards.ts` | 已改 | 补 restore attempt / session guard，防旧请求和旧错误覆盖当前 session |
| `apps/web/test/chat-session-guards.test.ts` | 已改 | 覆盖 stale response、missing ack、gateway_unavailable 当前 session 保护 |
| `apps/web/src/i18n/messages.ts` | 未改 | 现有离线文案已够第一阶段使用 |
| `apps/web/CLAUDE.md` | 已改 | 回写长期 Restore Flow 规范：Server path 先行，Live path 增强 |
| `docs/working/2026-05-15-offline-gateway-session-navigation.md` | 已改 | 实现后勾 TODO、记录验证结果 |

第一阶段明确不改：

| 文件 / 模块 | 不改原因 |
| --- | --- |
| `apps/relay/src/relay.ts` | 不是 `/messages` 不发请求的根因；先由 Web 隔离 `gateway_unavailable` / `sessions: []` 副作用 |
| `apps/gateway/src/*` | 不改 runner、provider、事件生成或 Gateway ownership |
| `apps/server/*` | 现有 `/messages` 与 `/events?after=` 已满足第一阶段需要 |
| `packages/protocol/src/index.ts` | 不新增协议字段；继续使用既有 `snapshotEventSeq/eventSeq/turnId/clientRequestId` |
| `apps/web/src/components/terminal/terminal-pane.tsx` | Terminal 离线只读作为第二阶段 |

### Web：左侧导航

- [ ] 检查 `apps/web/src/components/workbench/workbench-session-list.tsx`。
- [ ] 确认 Chat / Terminal session link 不因 Gateway 离线被阻断。
- [ ] 左侧 item 可以显示 Gateway 离线状态，但不能禁用进入路由。
- [ ] 离线状态只影响 running 指示和操作按钮，不影响 link。

### Web：Chat 页面离线态

- [x] 检查 `apps/web/src/components/chats/chat-panel.tsx`。
- [x] `activeSessionId` 变化时，立即将右侧切到目标 session 的 restoring/loading 状态。
  - [x] 清理旧 `messages`。
  - [x] 清理旧 `usageStats`。
  - [x] 清理旧 `restoreError`。
  - [x] 设置 `isRestoring(true)` 或等价状态。
  - [x] 保留新建 session optimistic path 的保护，不误清刚创建的本地消息。
- [x] 进入 `/chats/:sessionId` 后，按 `sessionId` 加载 metadata。
- [x] 从 metadata 中拿到 owner `gatewayId`。
- [x] 进入 `/chats/:sessionId` 后，立即启动 Server history path，不等待 `subscription.ack`。
  - [x] 请求 `/api/server/chat-sessions/:sessionId/messages`。
  - [x] 使用 `snapshotEventSeq` 请求 `/api/server/chat-sessions/:sessionId/events?after=snapshotEventSeq`。
  - [x] 使用现有 reducer / mapper 合并 snapshot + catch-up。
  - [x] 所有异步返回必须检查 `sessionId` 和 restore attempt，旧 session 返回直接丢弃。
- [x] `subscription.ack` 分支只处理 live subscribe 成功、live buffer drain 或 realtime ready，不再作为 history 请求入口。
- [x] 如果 live subscribe 一直没有 ack，不能阻止 Server history 展示；页面应停留在当前 session 的离线 / realtime unavailable 状态。
- [ ] 如果 owner Gateway 离线：
  - [ ] 页面保持在当前 session。
  - [ ] 历史消息继续展示。
  - [ ] 输入框禁用。
  - [ ] 显示当前 Gateway 离线提示。
  - [ ] 不把该状态当作全局 Relay 连接失败。
- [x] 收到 `gateway.status connected` 后，如果 gatewayId 等于当前 session owner，触发重新 subscribe。
- [x] 重新 subscribe 不新增新的消息合并路径；必须沿用当前 Restore flow / reducer / mapper 边界。
- [x] 不新增基于文本内容、最新 assistant 气泡、历史快照新旧猜测的兼容补丁。

### Web：Terminal 页面离线态

- [ ] 检查 `apps/web/src/components/terminal/terminal-pane.tsx`。
- [ ] 进入 `/terminal/:sessionId` 后，允许页面打开。
- [ ] 如果 owner Gateway 离线：
  - [ ] 禁用输入。
  - [ ] 禁用 resize / stop 等实时控制。
  - [ ] 显示离线提示。
  - [ ] 不把离线误报为 session 不存在。
- [ ] Gateway 恢复在线后，重新订阅该 terminal session。

### Web：Gateway selector

- [ ] 检查 `apps/web/src/components/chats/shell/gateway-selector.tsx`。
- [ ] 新建 session 态：
  - [ ] 只允许选择在线 Gateway。
  - [ ] 没有在线 Gateway 时不能发送 / 创建。
- [ ] 已有 session 态：
  - [ ] selector 只读。
  - [ ] 显示 owner Gateway。
  - [ ] owner Gateway 离线时仍显示名称和 offline 状态。
  - [ ] 不允许用户把已有 session 改绑到其他 Gateway。

### Web：Relay frame / error 处理

- [ ] 检查 `apps/web/src/components/relay/relay-client-provider.tsx`。
- [ ] 检查 `apps/web/src/components/chats/chat-panel.tsx` 中 `gateway_unavailable` 分支。
- [ ] 将 `gateway_unavailable` 区分为：
  - 当前 session owner Gateway 离线；
  - 当前选中的新建 Gateway 离线；
  - Relay / auth / scope 级错误。
- [ ] 当前 session owner Gateway 离线时，只设置 session-level offline 状态，不清空页面。
- [ ] 不允许旧 session 的 `gateway_unavailable` 覆盖当前 session。

### Relay：离线语义收敛

> 不是第一阶段必改项。只有验证发现 Web 侧无法隔离 `sessions: []` 副作用，才进入 Relay 修改。

- [ ] 检查 `apps/relay/src/relay.ts` 的 `sendGatewayUnavailable()`。
- [ ] 评估是否继续在 `gateway_unavailable` 前发送 `sessions: []`。
- [ ] 如果保留 `sessions: []`，Web 必须明确不把它当作 Server 历史列表清空。
- [ ] 更理想的语义是：Relay 只通知目标 Gateway 不可用，不声明用户没有 session。
- [ ] Relay 离线语义不能重新引入 `gateway.chat-catchup` blob 或任何文本级 catch-up 路径；Chat 恢复仍以结构化事件时序规范为准。

### i18n 文案

- [ ] 检查 `apps/web/src/i18n/messages.ts`。
- [ ] 补中文 / 英文文案：
  - owner Gateway 离线；
  - 当前 session 只读；
  - Gateway 恢复后可继续；
  - 新建 session 需要在线 Gateway。
- [ ] 页面内所有新增可见文案必须走 i18n。

### 文档回写

- [x] 方案确认后，如果实现改变了长期 Web 行为，更新 `apps/web/CLAUDE.md`。
- [x] 本方案确认后，必须把 `apps/web/CLAUDE.md` 的 Restore flow 从“先等 `subscription.ack`，再 snapshot/catch-up”改成“Server snapshot/catch-up path 先行，live subscribe path 增强；两条路径通过 reducer 和 `eventSeq` 合流”。
- [ ] 如果确认为跨模块长期事实，再更新 `AI_CONTEXT.md` 或 `docs/current/`。
- [ ] 如果只是一次 bugfix，不改变长期契约，可只保留本 working 文档和测试。

## 自动验证项目

### Web 单测

- [x] Chat Server-first Restore 测试：
  - [x] `activeSessionId` 变化后，Server history path 被计划或触发，不依赖 `subscription.ack`。
  - [x] `subscription.ack` 超时或缺失时，仍能应用当前 session 的 Server snapshot。
  - [x] 旧 session 的 snapshot/catch-up 晚返回时，不覆盖当前 session。
  - [x] 当前 session 的 snapshot/catch-up 成功后，右侧不再显示上一个 session。

- [ ] `workbench-session-list` 或对应 guard 测试：
  - 离线 Gateway 下的 session link 仍指向 `/chats/:sessionId` 或 `/terminal/:sessionId`。
  - 离线 session 不被自动改写到其他 Gateway。

- [ ] Chat 离线态测试：
  - [x] 切换到新 session 后立即不再显示上一个 session 的消息。
  - [x] 没有 `subscription.ack` 时仍会触发 Server history path。
  - [ ] 当前 session owner Gateway 离线时，页面进入只读状态。
  - [ ] 输入框禁用。
  - [ ] 历史内容不被清空。
  - [ ] `gateway_unavailable` 不触发导航回 `/chats`。
  - [x] `subscription.ack` 不再是 `/messages` 请求的前置条件。

- [ ] Terminal 离线态测试：
  - 当前 terminal session owner Gateway 离线时，页面可进入。
  - input / resize / stop 被禁用。
  - Gateway 恢复在线后能重新 subscribe。

- [ ] Gateway selector 测试：
  - 新建态不能选择离线 Gateway。
  - 已有 session 态只读显示 owner Gateway。
  - 已有 session 的 owner Gateway 离线时仍显示 offline。

- [ ] Relay frame guard 测试：
  - [x] 旧 session 的 `gateway_unavailable` 不覆盖当前 session。
  - [ ] 非当前 Gateway 的 disconnected 状态不影响当前 session。

### 回归点清单

#### Chat 切换回归

- [ ] A -> B 切换后，右侧立即不再显示 A 的消息。
- [ ] A -> B 切换后，Network 能看到 B 的 `/api/server/chat-sessions/:sessionId/messages`。
- [ ] A -> B 快速切换时，A 的 metadata / snapshot / catch-up 晚返回不能覆盖 B。
- [ ] A -> B -> A 快速切换时，旧 A attempt 晚返回不能覆盖新的 A attempt。
- [ ] 切换到不存在或无权限 session 时，不保留上一个 session 的消息。

#### 离线 Gateway 回归

- [ ] owner Gateway 离线时，`/messages` 仍会发出。
- [ ] owner Gateway 离线时，当前 session 历史可以展示。
- [ ] owner Gateway 离线时，输入框禁用。
- [ ] owner Gateway 离线时，不跳回 `/chats`。
- [ ] owner Gateway 离线时，不自动切到其他在线 Gateway。
- [ ] `gateway_unavailable` 只影响当前 session 的实时状态，不清空当前历史。

#### 在线 Gateway 回归

- [ ] owner Gateway 在线时，切换 session 后能正常 subscribe。
- [ ] 收到 `subscription.ack` 后进入 live ready。
- [ ] live frame 与 Server catch-up 重叠时，不重复显示消息。
- [ ] Gateway 断开再恢复后，当前 session 能重新 subscribe。
- [ ] 恢复在线后继续发送消息，仍发往 owner Gateway。

#### 时序回归

- [ ] snapshot 使用 `snapshotEventSeq` 初始化水位。
- [ ] `/events?after=snapshotEventSeq` 返回的事件按 `eventSeq ASC` 合并。
- [ ] 重复 `eventSeq` 被 reducer 丢弃。
- [ ] 同一 `turnId` 的 delta/result/tool/permission 仍归位到同一轮。
- [ ] optimistic user 仍按 `clientRequestId` 合并，不按文本去重。
- [ ] 不重新引入 `gateway.chat-catchup` blob 写 streaming assistant。
- [ ] 不重新引入 `lastDeltaEventIdRef`、`currentAgentIdRef`、`historySnapshotLooksOlder()` 这类旧启发式生产路径。

#### 新建 Chat 回归

- [ ] 新建 chat 仍要求选择在线 Gateway。
- [ ] 没有在线 Gateway 时不能发送第一条消息。
- [ ] 新建 session 的 optimistic message 不被 `activeSessionId` 切换清理误删。
- [ ] `gateway.session-created` 到达后仍能 replace 到 `/chats/:sessionId`。

#### 范围回归

- [ ] 第一阶段不改 Relay 后，左侧 session list 不因某台 Gateway 离线被误清空。
- [ ] 第一阶段不改 Gateway 后，已有 chat runner 行为不变。
- [ ] 第一阶段不改 Protocol 后，类型检查通过。

### 最小命令

第一阶段已运行：

```bash
pnpm --filter @tether/web test
pnpm --filter @tether/web typecheck
```

结果：

- [x] `pnpm --filter @tether/web test`：通过，65 个测试全部通过。
- [x] `pnpm --filter @tether/web typecheck`：通过。

如果修改 Relay：

```bash
pnpm --filter @tether/relay test
pnpm --filter @tether/relay typecheck
```

如果修改共享协议：

```bash
pnpm --filter @tether/protocol typecheck
pnpm test
```

## 人工 UAT 验证项目

### UAT 1：Chat session 离线可进入

前置：

- 账号下至少有两台 Gateway：A、B。
- A 曾创建过一个 chat session。
- A Gateway 停止或断开 Relay。
- B Gateway 保持在线。

步骤：

1. 打开 Web `/chats`。
2. 在左侧点击 A Gateway 所属 chat session。

预期：

- URL 切到 `/chats/:sessionId`。
- 左侧高亮对应 session。
- 浏览器 Network 能看到当前 session 的 `/api/server/chat-sessions/:sessionId/messages` 请求。
- 右侧显示该 session 的历史或明确的历史加载状态。
- 右侧不再显示上一个 session 的消息。
- 页面显示 A Gateway 离线。
- 输入框禁用。
- 不会自动切到 B Gateway。

### UAT 2：Chat session 恢复在线后可继续

前置：

- 继续 UAT 1 的页面。

步骤：

1. 启动或恢复 A Gateway。
2. 等待 Relay 收到 `gateway.status connected`。

预期：

- 页面自动恢复实时订阅。
- 输入框恢复可用。
- 继续发送消息会发往 A Gateway。
- 不会发往 B Gateway。

### UAT 3：Terminal session 离线可进入

前置：

- A Gateway 曾创建过 terminal session。
- A Gateway 离线。
- B Gateway 在线。

步骤：

1. 打开 Web `/terminal`。
2. 在左侧点击 A Gateway 所属 terminal session。

预期：

- URL 切到 `/terminal/:sessionId`。
- 页面显示该 terminal session。
- 输入 / resize / stop 等实时控制禁用。
- 页面显示 A Gateway 离线。
- 不会自动切到 B Gateway。

### UAT 4：新建 session 仍要求在线 Gateway

步骤：

1. 打开 `/chats` 新建态。
2. 打开 Gateway selector。
3. 尝试选择离线 Gateway。

预期：

- 离线 Gateway 不可用于新建。
- 没有在线 Gateway 时不能发送第一条消息。
- 有在线 Gateway 时新建 session 正常。

### UAT 5：左侧列表不因离线清空

步骤：

1. 打开 Web，确保左侧有历史 sessions。
2. 断开某台 Gateway。
3. 观察左侧列表。

预期：

- 该 Gateway 的 session 可以标记为离线 / 非实时。
- 历史 session 不应因为 `gateway_unavailable` 突然全部消失。
- 其他在线 Gateway 的 session 不受影响。

## 风险与边界

### 主要风险

| 风险 | 说明 | 约束 |
| --- | --- | --- |
| Web 把 `gateway_unavailable` 当全局错误 | 可能导致页面退出或列表清空 | 必须降级成 session-level offline |
| 自动 fallback 到其他 Gateway | 会造成跨电脑串路由 | 明确禁止 |
| Chat 修了但 Terminal 没修 | 用户在 Terminal 仍感知“切不过去” | Chat / Terminal 都要覆盖 |
| Gateway 恢复后不重订阅 | 页面停留在只读态 | 需要 connected 后 retry subscribe |
| 历史读取依赖 Gateway 在线 | 离线只读体验无法成立 | 历史应尽量依赖 Server |
| 离线修复污染 Chat 时序 | 可能重新引入文本合并、旧 catch-up 或重复恢复路径 | 必须遵守 `apps/web/CLAUDE.md` 的 Chat 时序规范 |
| snapshot 与 live frame 交叠 | 在线 Gateway 下 Server path 与 live path 可能同时返回同一段事件 | 必须通过 `eventSeq` 去重和 restore attempt guard 合流 |

### 不进入本方案的范围

- 不重构 Chat 事件时序。
- 不调整 Gateway runner。
- 不新增跨 Gateway session 迁移能力。
- 不做离线编辑 / 离线发送队列。
- 不改变多账户认证模型。

## 决策待确认

- [x] 离线 Gateway 下 Chat 历史读取应以 Server 为事实源，不能等待 Gateway live subscribe。
- [ ] Terminal 离线时是否展示历史 replay，还是只展示空 terminal + 离线提示？
- [ ] Relay 是否应停止发送 `sessions: []`，改为只发送 `gateway_unavailable`？
- [ ] 左侧 session item 是否需要显式显示 owner Gateway 名称和 offline 状态？
- [x] 第一阶段作为独立 Chat bugfix 处理，不等待 Relay / Terminal 完整方案。
- [x] 方案确认后需要同步更新 `apps/web/CLAUDE.md` 的 Restore Flow 长期规范。
