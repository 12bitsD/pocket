# Calendar 领域架构（日程 · 月历 · 统一 Todo 与闹钟/Agent 调度）

状态：**已定稿，2026-11-23。**

**Pocket Calendar** 将原先分散的闹钟、Agent 计划、今日日程与月历收敛为同一个独立应用内的三栏结构（`[d] 今日日程 / [m] 月历 / [t] Todo`），视觉与交互遵循 [Pocket 设计标准](../design-standard.md)。

## 1. 领域对象

| 对象 | 核心内容 |
| --- | --- |
| `Event` | 日期、起止时间、标题、地点／备注、重复规则、提醒策略（静默 / 普通通知 / 强提醒响铃）、`revision` |
| `Todo` | 正文（选 `@agent` 时直接作为发送 Prompt）、完成态（单次项）或启停态（周期项）、指派对象（`none / @me / @agent_id`）、关联 `linked_alarm_id` 或 `linked_schedule_id` |
| `Alarm` | 触发时间、指定日期或重复周期、`cloud_locked`（本机锁）、`skip_next`（跳过下次）、目标设备策略、`EXECUTED` 回执 |
| `Agent Schedule & Delivery` | 关联 `agent_binding_id`、单次 `run_at`（配截止时间 `expires_at`）或五段 `cron`（配相对有效时长 `ttl_seconds`）、`delivery_id`、一次性 `callback_token` 与可选回传摘要 |

## 2. Todo 统一 `@指派` 路由与单次／周期区分

同一条 Todo 共用一套输入框与时间选择器，仅切换**到点叫醒谁**：

- **`仅待办 (none)`**：纯待办事项，左边显示完成方框 `[☐]`，勾选即归档。
- **`@me`（手机响铃）**：事务内同步创建／更新 `Alarm`，由手机原生层注册系统精确闹钟并返回真实 `EXECUTED`。
- **`@agent_id`（Agent 自动执行）**：事务内同步创建／更新 `Schedule`，到点由云端将 Todo 正文 POST 给对应 Agent，收到 `202 Accepted` 记 `COMPLETED`，回传结果直接挂在该条 Todo 下方。
- **单次事项 vs 周期循环项**：
  - **单次事项**（不设时间，或选 `今天 / 明天 / 指定日期`）：左侧为**完成打勾框**，做完打勾归档并清理未触发提醒。
  - **周期循环项**（选 `每天 / 工作日 / 每周`）：左侧自动变为**启停开关 `ON / OFF`**，不混入未完成待办计数；支持**跳过下一次**与**本机锁 `LOCKED`**（开启后禁止远程或 Agent 修改该条闹钟）。

## 3. 真机响铃、贪睡与错过规则

- **全屏锁屏响铃页**：到点弹出极简大字全屏界面，仅保留 **「关闭本次」** 与 **「10 分钟后再响」** 两个大尺寸防误触操作。
- **诚实错过语义**：连续响铃超时无人处理自动停止并标记 `MISSED`（不假装已完成）；设备关机错过的普通闹钟只标 `MISSED` 不补响，周期闹钟自动排下一次。

## 4. Agent 投递协议

```http
POST {agent_endpoint}/webhooks/pocket
Authorization: Bearer <credential>
Content-Type: application/json
```

```json
{
  "version": "v1",
  "delivery_id": "dlv_01XYZ",
  "source": "pocket.calendar",
  "type": "prompt.requested",
  "prompt": "整理本周日程与进展，生成复盘摘要",
  "scheduled_for": "2026-11-23T08:00:00Z",
  "triggered_at": "2026-11-23T08:00:01Z",
  "result_callback_url": "https://pocket.example.com/v1/deliveries/dlv_01XYZ/result",
  "callback_token": "cbk_one_time_token"
}
```

Agent 接收排队后返回 `202 Accepted` 即记为 `COMPLETED`；网络错误或 5xx 按退避重试并复用同一 `delivery_id` 去重；超过有效窗口标记 `EXPIRED` 停止发送。
