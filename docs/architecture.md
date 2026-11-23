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

- **手机端拆开做减法**：Clock、Calendar、Notes 是三个独立 Android App（各自独立图标、包名、版本号与 GitHub Release），日常在手机上点开 Clock 只做闹钟相关操作，不被笔记和日程稀释。**首轮工程落地先聚焦 Clock 与 Calendar 两个应用**，Notes 待后续专项打磨完产品细节后再接入。
- **电脑端合起来提效率**：提供 1 个统一的 Web 工作台（`apps/web`，由 `pocket-cloud` 同源静态托管），直接组合挂载 Clock 与 Calendar 视图模块（零 `<iframe>`），集中完成配 Agent、写 Prompt 计划、排日程、管 Todo 和远程给手机设闹钟。**Web 工作台本身不响铃**，普通闹钟同步给手机 Clock App 执行并等待手机返回真实 `EXECUTED`。
- **客户端实现路线（已核验拍板）**：
  - **前端工程层**：通过轻量 `Vite` 构建抽离共享 `packages/client-core`（RPC 客户端、幂等键、WebSocket `Link` 同步与 `PocketRuntime` 适配接口），一套模块化界面源码同时编译出电脑统一 `apps/web` 与各 Android App 的自包含静态包。
  - **Android 容器与原生边界**：采用 **Capacitor 8.6（`targetSdk 36 / minSdk 26`）+ Kotlin 薄层原生插件**。**只有 Clock 持有重度响铃引擎**——权威 `alarms` 与离线 `outbox` 存入 Android **设备加密区（Device-Protected Storage）原生 SQLite**（不使用社区 WebView SQLite 插件），支持手机夜间重启未解锁（Direct Boot `LOCKED_BOOT_COMPLETED`）恢复闹钟，统一使用 `USE_EXACT_ALARM` + `AlarmManager.setAlarmClock()`、全屏锁屏唤醒与前台响铃服务，并内置 ColorOS 权限自检引导。
  - **手机双独立 App 本机直连**：Calendar 不重复实现闹钟响铃引擎；同一台手机上 Calendar 创建强提醒或 `@me` Todo 时，除写入离线队列同步 Cloud 外，还通过同签名（`signature` 权限）显式广播直接唤醒本机 Clock 原生层落库设闹钟，断网飞行模式下依然可靠生效。
  - **远程下发诚实边界**：自托管默认不依赖商业厂商推送通道；手机端后台被冻结时，电脑端远程新建闹钟如实停留为 `OFFLINE_QUEUED`，待 Clock 前台打开或原生 `WorkManager` 周期拉取写入系统闹钟后才推进为 `EXECUTED`。

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

## 5. 分阶段落地路线（先做 Clock + Calendar，Notes 后续专项设计）

1. **Step 1（Cloud 第一期：核心底座 + Agent 计划与日历/Todo 契约）**：搭建 Python 3.12 + FastAPI + PostgreSQL 后端，跑通初始主密钥鉴权、Agent 绑定加密管理、单次/周期 Agent 计划调度投递闭环，以及 Calendar `events / todos`（含 `@me / @agent` 单一引用关联）接口与真实 Docker PG 集成测试。
2. **Step 2（前端去原型债 + 电脑统一 Web 工作台首版）**：用 `Vite` + `packages/client-core` 将 Clock 与 Calendar 单文件原型拆为可复用模块，组装出 `apps/web` 统一工作台并接入真实 Cloud 接口跑通日常使用。
3. **Step 3（Cloud 第二期同步 + Clock & Calendar 双 Android 客户端）**：补齐 6 位配对码、WebSocket `Link` 断线补发、普通闹钟同步与本机锁冲突处理；用 Capacitor 8.6 + Kotlin 原生插件打包 `Clock`（含 DE 原生 SQLite、`setAlarmClock`、Direct Boot 恢复、ColorOS 自检卡）与 `Calendar`（含离线缓存与同机唤醒 Clock 快通道）两个独立 APK 上真机验收。
4. **Step 4（Notes 专项设计与扩展）**：单独打磨完善 Notes 的编辑、组织与细粒度 Agent 授权体验后，再接入 Cloud、Web 工作台与第三个独立 Android App。
