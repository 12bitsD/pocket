# Pocket 总体架构

状态：**已对齐，2026-11-23。**

Pocket 面向个人自托管优先场景，由**手机端三个独立 Android App**、**电脑端一个统一 Web 工作台**、**共享 Pocket Cloud**，以及**外部 Agent 接入契约**组成。本文描述系统级形态、职责和主流程；Cloud 内部设计见 [Cloud 架构](cloud/architecture.md)，Clock 领域设计见 [Clock 领域架构](cloud/clock.md)，界面规范见 [Pocket 设计标准](design-standard.md)。

## 1. 系统结构与产品形态

```text
                        ┌──────────────────────────┐
                        │       External Agent     │
                        │  Prompt / Run / Session  │
                        └──────▲────────────┬──────┘
          HTTP Prompt Delivery │            │ 受限 Token 拉取授权笔记/日程
                               │            ▼
┌──────────────────────────────┴────────────┴──────────────────────────┐
│                     Pocket Cloud (Docker 自托管)                      │
│   Identity / Pairing / Link / Sync / Scheduler / Delivery / Web UI   │
└────────▲─────────────────▲──────────────────▲────────────────▲───────┘
         │                 │                  │                │
  ┌──────┴───────┐  ┌──────┴───────┐  ┌───────┴──────┐  ┌──────┴─────────┐
  │  Clock App   │  │ Calendar App │  │  Notes App   │  │  Web 工作台     │
  │ Android 独立 │  │ Android 独立 │  │ Android 独立 │  │ 电脑统一管理端  │
  └──────────────┘  └──────────────┘  └──────────────┘  └────────────────┘
```

- **手机端拆开做减法**：Clock、Calendar、Notes 是三个独立 Android App（各自独立图标、包名、版本号与 GitHub Release），日常在手机上点开 Clock 只做闹钟相关操作，不被笔记和日程稀释。
- **电脑端合起来提效率**：提供 1 个统一的 Web 工作台（可由 `pocket-cloud` 同源托管），集中完成配 Agent、写长段 Prompt 计划、写 Markdown 笔记、排日程和远程给手机设闹钟。**Web 工作台本身不响铃**，普通闹钟同步给手机 Clock App 执行并等待手机返回真实 `EXECUTED`。
- **客户端实现路线**：界面与交互统一复用 Web 模块与 `packages/design-system`；手机端通过 **Capacitor + Kotlin 薄层原生插件** 打包运行——其中手机端权威闹钟表与离线 `outbox` 直接落在 Android 原生本地 SQLite 中，精确闹钟（`AlarmManager`）、锁屏全屏响铃、开机广播恢复和 ColorOS 权限跳转由 Kotlin 原生层负责，不依赖浏览器缓存存活。

## 2. 职责划分

| 对象 | 核心职责 |
| --- | --- |
| Pocket Cloud | 账号与配对、设备独立凭证、Link、数据同步、定时触发、Agent 投递、托管电脑 Web 工作台 |
| Web 工作台 | 电脑端统一编辑与查看闹钟、Agent 计划、日历、笔记、设备列表和 Agent 绑定（不直接响铃） |
| Clock App (Android) | 闹钟、Agent 计划入口、世界时钟、Kotlin 原生响铃与重启恢复、本机锁（Lock）、原生 SQLite 离线 outbox |
| Calendar App (Android) | Event、提醒策略、与 Clock 的提醒关联 |
| Notes App (Android) | Markdown 笔记、版本同步、按条目给 Agent 开放读取授权 |
| External Agent | 接收定时 Prompt、创建 Run、管理 Session、可选回传结果摘要，按需凭受限密钥拉取已授权笔记或日程 |

各领域的表和业务规则由对应模块拥有；所有核心表保留 `user_id` 字段，首版按个人 Docker Compose 一键自托管运行，后续扩展多用户无需重构表结构。

## 3. 免注册登录与多端配对

- **首台设备初始化**：Pocket Cloud 首次启动生成初始主密钥，用于登录电脑 Web 工作台。
- **短时配对码绑定新设备**：在已登录端点击「添加设备」生成 5 分钟有效的 **6 位配对码（或二维码）**；手机 App 输入该配对码后，自动换取该台手机专属的长期设备 Token 并绑定 `device_id` 与 `link_id`。
- **按设备独立吊销**：每台手机与浏览器拥有独立凭证；更换或遗失设备时，可在 Web 工作台单独吊销对应设备，不影响其他端。

## 4. 两条主流程与 Agent 数据边界

### 普通设备动作（设备响铃）

```text
手机本地 ／ 电脑 Web 工作台 ／ Agent ／ Calendar 入口
→ Pocket Cloud 持久化并同步操作
→ 目标手机 Clock App 原生层落库并写入系统闹钟
→ Cloud 记录真实 EXECUTED / FAILED 回执
```

Cloud 受理（`ACCEPTED`）与手机原生执行（`EXECUTED`）严格分开。

### Agent 计划（云端定时投递 Prompt）

```text
用户在 Web 工作台或手机编辑 Prompt 与单次/周期计划（引用已保存的 Agent 绑定）
→ Cloud 到点生成唯一 delivery_id 与一次性回调密钥
→ HTTP POST 到绑定的 Agent EP
→ Agent 接收并返回 202 Accepted
→ Pocket 将本次投递标记 COMPLETED（可选通过回调密钥回传摘要）
```

手机和电脑只是编辑入口，云端触发不依赖客户端在线。

### Agent 读取笔记与日程（按需拉取）

后续接入 Notes 与 Calendar 时，用户在工作台为指定 Agent 勾选允许访问的笔记范围或日历读取权限，签发受限密钥供 Agent 调用 `note.read` / `event.list`；未授权内容不可读取，Pocket 仍不介入 Agent 内部运行过程。

## 5. 分阶段落地路线

1. **Step 1（Cloud 第一期）**：搭建 Python 3.12 + FastAPI + PostgreSQL 后端，跑通初始密钥鉴权、Agent 绑定加密管理、单次/周期 Agent 计划调度、投递重试与回调回执闭环。
2. **Step 2（电脑 Web 工作台首版）**：将已定稿的 Clock 界面接入真实 Cloud 接口，先在电脑浏览器端跑通真实日常使用。
3. **Step 3（Cloud 第二期 + Clock Android 客户端）**：补齐 6 位配对码、WebSocket Link 断线补发、普通闹钟同步与本机锁冲突处理，并用 Capacitor + Kotlin 原生闹钟插件打出首个 Android 安装包上真机验收。
4. **Step 4（Calendar & Notes 扩展）**：沿同一模块结构新增日历与笔记领域表、Web 工作台分栏与独立 Android App。
