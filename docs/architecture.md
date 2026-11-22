# Pocket 总体架构

状态：**已对齐，2026-11-23。**

Pocket 由三个独立 Android App、一个共享 Cloud，以及外部 Agent 的接入契约组成。本文只描述系统级职责和关系；Cloud 内部设计见 [Cloud 架构](cloud/architecture.md)，各领域设计见对应领域文档。

## 1. 系统结构

```text
                    ┌──────────────────────────┐
                    │       External Agent     │
                    │  Prompt / Run / Session  │
                    └────────────▲─────────────┘
                                 │ HTTP Prompt Delivery
                                 │
┌────────────────────────────────┴────────────────────────────────┐
│                         Pocket Cloud                            │
│  Identity / Permission / Link / Sync / Scheduler / Delivery     │
└───────────────▲────────────────▲────────────────▲───────────────┘
                │                │                │
       ┌────────┴────────┐  ┌────┴──────────┐  ┌──┴─────────┐
       │    Clock App    │  │ Calendar App  │  │ Notes App  │
       │ Android + Clock │  │ Android+Event │  │ Android+MD │
       └─────────────────┘  └───────────────┘  └────────────┘
```

三个 App 各自拥有 UI、Android 包名、本地数据、原生能力、版本和 release。Cloud 提供共享后端能力，不把三个 App 合并为一个客户端。

Agent 独立负责接收 Prompt、创建 Run、管理 Session 和展示结果。Pocket 通过绑定的 Agent EP 投递内容，不介入 Agent 的运行过程。

## 2. 职责划分

| 对象 | 核心职责 |
| --- | --- |
| Pocket Cloud | User ID、权限、Link、数据同步、定时触发、操作记录、Agent 投递 |
| Clock App | 闹钟、世界时钟、秒表、计时器、本地执行、Lock、离线 outbox |
| Calendar App | Event、提醒策略、与 Clock 的提醒关联 |
| Notes App | 笔记内容、版本、同步范围和访问授权 |
| External Agent | 接收 Prompt、创建 Run、管理 Session、处理并可选回写结果 |

各领域的表和业务规则由对应模块拥有。共享权限和操作协议不改变数据所有权。

## 3. 两条主流程

### 普通设备动作

```text
本地／Agent／Calendar 入口
→ Pocket Cloud 同步操作
→ 对应 Android App 应用并执行
→ Cloud 记录真实执行结果
```

Cloud 受理与 Android 执行分开。普通闹钟只有 Clock App 返回 `EXECUTED` 才算设备设置成功。

### Agent Alarm

```text
用户在 Pocket 编辑 Prompt 与触发计划
→ Cloud 到点生成投递
→ POST 到绑定的 Agent EP
→ Agent 接收并返回 202 Accepted
→ Pocket 将本次投递标记完成
```

手机是编辑入口，云端触发不依赖手机在线。`202 Accepted` 表示 Agent 已接收并持久化或排队，不代表 Prompt 已处理完。

Agent 可通过 `result_callback_url` 可选回写结果；结果也可以只出现在 Agent 自己的 Session 中。

## 4. Cloud 共享能力

- **Identity & Permission**：随机 User ID、设备、Link、动作与资源权限。
- **Link**：客户端主动建立 WebSocket，心跳、重连和在线状态。
- **Sync**：当前快照、操作日志、持久 outbox、revision 和断点补同步。
- **Scheduler**：保存并触发单次或周期计划，云端是定时触发权威。
- **Prompt Delivery**：绑定 Agent EP、凭证、订阅源、投递和可选结果回写。
- **Operation Record**：来源、幂等、因果链、客户端回执和投递状态。

这些能力通过稳定的领域接口向 Clock、Calendar、Notes 复用。

## 5. 领域扩展方式

新增领域时，依次增加：

1. 领域数据与业务规则。
2. 该领域的 HTTP 能力和权限动作。
3. 对应的独立 Android App 与本地执行适配。
4. 与共享 Sync、Link、Scheduler 的接入。
5. 端到端验收场景。

当前首先完成 [Clock 领域架构](cloud/clock.md)。Calendar 和 Notes 后续分别新增领域文档，不改变本页的系统结构。

## 6. 文档层级

- [Pocket 总体架构](architecture.md)：系统对象、职责、主流程和扩展方式。
- [Cloud 架构](cloud/architecture.md)：共享后端模块、数据、同步、权限、调度与投递。
- [Clock 领域架构](cloud/clock.md)：普通闹钟、Lock、多设备、Agent Alarm 和客户端行为。
- [发布规则](releases.md)：各 App 独立版本与 GitHub Release。
