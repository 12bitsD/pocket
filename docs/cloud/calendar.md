# Calendar 领域架构

状态：**已对齐，2026-11-23。**

Calendar 采用「**今日日程 + 月历 + 统一 Todo**」三栏结构：既管理带起止时段的日程（Event），又通过 **Todo 的 `@指派对象` 机制** 用同一套交互统一配置个人闹钟（`@me`）与外部 Agent 定时计划（`@agent`），避免拆分两套割裂表单。视觉与交互遵循 [Pocket 设计标准](../design-standard.md)。

## 1. 领域对象

| 对象 | 内容 |
| --- | --- |
| Event | 日期（`date`）、起止时间（`start_time / end_time`）、标题、地点／备注、重复规则、提醒策略、来源、`revision` |
| Todo | 文本内容（同时作为待办标题或发给 Agent 的 Prompt）、完成态（`done`）、指派目标（`none / @me / @agent_id`）、触发时间与周期、关联回执 |
| Reminder & Route Link | Event 强提醒或 Todo `@me` 单向生成 Clock `alarm`；Todo `@agent` 单向生成 Cloud `schedule` |

## 2. 统一 `@指派` 路由（一套交互管闹钟与 Agent 计划）

同一条 Todo 共用同一个文本输入框与同一套时间／周期控件，仅通过切换**唤醒对象（Assignee）**决定后端去向：

- **`仅待办 (none)`**：纯待办事项，不触发响铃或远程请求，勾选即完成。
- **`@me`（手机响铃）**：在同一事务中同步生成／更新关联的 Clock Alarm，到点由手机 Clock App 响铃并返回真实 `EXECUTED` 状态。
- **`@agent_id`（Agent 自动执行）**：在同一事务中同步生成／更新 Cloud 定时计划（`schedules`），到点将该条 Todo 正文作为 Prompt POST 给对应 Agent EP，收到 `202` 标为完成，并将可选回传摘要直接挂在该条 Todo 下方展示。
- **内联快速指派**：输入框支持直接键入 `@me 07:30 ...` 或 `@work-agent 16:00 ...` 自动识别对象与时间。

## 3. 今日日程与月历边界

- **`[d] 今日日程（Today Agenda）`**：**仅显示当天的日程**（顶部唯一白底主角卡展示今日下一场／当前进行中日程，下方展示今日其余场次与重叠提示），不被跨天未来日程稀释注意力。
- **`[m] 月历（Month）`**：7 列等宽月历矩阵（朱砂微点表示含 Clock 强提醒日程，墨色微点表示普通日程），点选任意日期查看该日安排并支持在该日新建日程。
- **非阻断区间冲突提示**：同一日期内若存在 $I_i \cap I_j \neq \emptyset$，显式标记「时间重叠」，允许用户知情保存。

## 4. HTTP 能力契约

```text
event.list / event.read / event.set / event.cancel
todo.list / todo.set / todo.toggle / todo.cancel
```

`todo.set` 根据 `target` 在同一数据库事务内协调 Clock `alarms` 或 Scheduler `schedules`，取消或删除 Todo 时同步清理未触发的关联闹钟或计划。
