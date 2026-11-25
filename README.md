<div align="center">
  <img src="docs/assets/pocket-hero.png" alt="Pocket — 对 AI 友好的个人闹钟、日程与独立笔记" width="100%">
  <br><br>
  <p>
    <a href="https://github.com/12bitsD/pocket/actions/workflows/test.yml"><img src="https://img.shields.io/github/actions/workflow/status/12bitsD/pocket/test.yml?branch=main&style=flat-square&label=checks&color=1a1917" alt="Checks"></a>
    <a href="https://github.com/12bitsD/pocket/releases"><img src="https://img.shields.io/github/v/release/12bitsD/pocket?include_prereleases&style=flat-square&label=releases&color=1a1917" alt="Releases"></a>
    <img src="https://img.shields.io/badge/client-Android_%2B_Web-1a1917?style=flat-square" alt="Android and Web">
    <img src="https://img.shields.io/badge/cloud-self--hosted-c44326?style=flat-square" alt="Self-hosted">
  </p>
  <p>
    <a href="#为什么做-pocket">为什么做</a> ·
    <a href="#怎么接入-ai">怎么接入 AI</a> ·
    <a href="#界面与手机体验">界面与手机体验</a> ·
    <a href="#两个独立应用">产品构成</a> ·
    <a href="#下载与部署">下载与部署</a>
  </p>
</div>

---

## 为什么做 Pocket

现在市面上大部分闹钟、日历和待办软件，对 AI 其实都不太友好——数据关在各自的孤岛里，很难干净、稳定地接进自己的 Agent。

翻了一圈现有的开源项目，也没有找到顺手合适的方案，最后下定决心干脆自己烧 token 从头把这一套开发出来。

想法很朴素：**不在日常工具里硬塞一个难用的 AI 聊天窗口**，而是先把每天真要用的闹钟、日程、待办（以及后面独立的笔记）做干净，同时从底层把接口原生向你自己的 AI 敞开。

---

## 怎么接入 AI

Pocket 围绕「人和自己的 Agent 怎么配合管时间」设计了 4 个核心能力：

### 1. 在 Todo 里直接 `@` 你的 Agent，支持自然时间短语
不用把“个人闹钟”和“AI 定时任务”拆成两套系统。同一行待办支持直接写 `今天 / 明天 / 每天 / 工作日 / 每周三` 加时间，自动识别单次或周期计划：
- 写 **`早起赶车 @me 明天 07:30`** → 同步到手机系统闹钟准点响铃（`AlarmManager.setAlarmClock` 硬件级唤醒、Direct Boot 未解锁重启自动恢复、断网本地即设、锁屏全屏响铃与 10 分钟贪睡）；
- 写 **`整理日报 @work-agent 工作日 18:00`** → 到点由私有云直接通过 HTTP 把这条任务发给你的 Agent 去跑，**不要求手机亮屏在线**，跑完的结果摘要直接挂回原待办下面。

### 2. AI 也能反过来帮你排日程、设真机闹钟
给你的 Agent 配一把按权限受限的密钥（例如仅开放 `event.read,todo.write`），它就能直接调接口查空档、建日程、加待办或设手机闹钟。状态完全诚实——只有真机把闹钟写进系统后才回传 `EXECUTED`，手机离线排队（`QUEUED`）或系统权限缺失失败（`FAILED`）都会如实告知，不报假喜。

### 3. 给关键事项留“人类护栏”：本机锁与按需授权
- **本机锁（`LOCKED`）**：像早起赶高铁这种不能出岔子的闹钟，在手机上打开本机锁后，AI 和远端一律不能修改或关闭；手机离线期间改动的本机锁事项，也会在重连后通过 `LOCK_OVERRIDE` 优先覆盖云端。
- **按开关细粒度授权**：哪个 Agent 只允许读日程、哪个允许改待办、或者（后续）只允许读哪几篇笔记，全部独立签发与控制；密钥一旦撤回，活跃同步连接立即断开。

### 4. 纯 HTTP + WebSocket + CLI 胶水层，不绑死任何 AI 框架
不管你用的是自建 Agent、Claude / Codex 脚本还是自动化工作流，只要能收发普通 HTTP JSON 请求（`/v1/rpc`）、增量同步流（`/v1/link`）或直接调用 `pocket` CLI，填一个地址和密钥就能连进来。

---

## 界面与手机体验

<p align="center">
  <img src="docs/assets/pocket-screens.png" alt="Pocket Calendar 三栏界面：今日日程、月历、统一 Todo" width="100%">
</p>

| 栏位 | 说明 |
| --- | --- |
| **`[d]` 今日日程** | 只显示今天当天的安排（下一场主角卡 + 今日其余场次 + 时间重叠提醒），新建日程内置 `30m / 1h / 2h` 快捷时长档位。 |
| **`[m]` 月历** | 7 列等宽月历，区分强提醒响铃与普通日程；桌面端支持方向键跳转，手机端支持左右横滑切月。 |
| **`[t]` Todo** | 一套输入同时管普通待办、`@me` 手机闹钟与 `@agent` 定时任务；单次事项打勾归档，周期任务用开关启停并支持跳过下一次，已撤回事项自动折叠收纳。 |

针对日常高频使用与 Android 真机场景做的体验打磨：

- **离线优先与断网重放**：飞行模式或弱网下照常新建、修改日程与本机锁闹钟；系统硬件闹钟本地立即落盘生效，恢复联网后自动按序重放离线队列与响铃回执。
- **单手触控与防误触**：适配全面屏顶部状态栏与底部手势安全区；支持底部抽屉下拉收起、Android 系统返回键逐层回退，以及删除事项后 `4.5s [撤销]` 恢复。
- **冷热秒开与后台省电**：首次冷启动通过 `sync.bootstrap` 单次请求拉齐快照，本地缓存热启动 `0` 网络请求直出首屏；锁屏退入后台后自动排空在途确认并挂起 WebSocket 射频（`IDLE · SAVING`），锁屏响铃时钟按整分边界每分钟仅唤醒 1 次。
- **双纸墨主题与 4 项权限自检**：支持暖亚麻浅色纸与深炭夜间纸（按键 `b` 切换）；Android 端 `cfg` 页内置精确闹钟、通知、全屏锁屏唤醒、电池无限制 4 项权限实时自检与系统设置直跳卡。

---

## 两个独立应用

使用场景不同的工具不硬塞进一个臃肿软件里。Pocket 拆成两个完全独立的应用，共用同一套个人私有云端：

| 应用 | 定位 | 状态 |
| --- | --- | --- |
| **Pocket Calendar** | 日程、月历、手机闹钟与 Agent 定时任务合一 | 已交付（[`calendar-v0.2.0`](https://github.com/12bitsD/pocket/releases/tag/calendar-v0.2.0) · Web 独立包 + Android 签名 APK） |
| **Pocket Notes** | 独立笔记应用，支持按篇勾选授权给指定 Agent 读取 | 规划中（独立安装包与入口 · `notes-v*`） |

---

## 下载与部署

### 客户端（Android APK & Web）
前往 **[GitHub Releases](https://github.com/12bitsD/pocket/releases)**（最新：[`calendar-v0.2.0`](https://github.com/12bitsD/pocket/releases/tag/calendar-v0.2.0)）直接下载：
- **`pocket-calendar-0.2.0.apk`** — Android 真机签名安装包（含 Capacitor 容器与 Kotlin Direct Boot 系统闹钟原生插件）
- **`calendar-0.2.0.zip`** — 独立网页端静态包（可托管在任意静态服务器或本地打开）

**Android 真机三步上手：**
1. 安装 `pocket-calendar-0.2.0.apk`，打开底栏 **`cfg`** 页面确认 4 项响铃权限全部为 `OK`；
2. 在已登录云端的电脑网页 `cfg` 页点击「生成 6 位配对码」（或在服务端执行 `pocket pair create`）；
3. 在手机端填入私有云地址与 6 位数字配对码即可绑定本机，无需在手机上手动粘贴长密钥。

本地开发、打包与全链路验证：

```sh
npm install
npm --workspace @pocket/calendar run dev     # 本地启动 Vite 预览（未连云端时自动进入 DEMO 演示态）
npm test                                     # 运行前端、离线同步与定时契约单元测试
npm run build                                # 构建网页端静态包 apps/calendar/dist/
bash scripts/build-android-apk.sh 0.2.0      # 构建并单测签名版 Android APK -> dist/pocket-calendar-0.2.0.apk
bash scripts/verify.sh --step all            # 一键跑完前后端单测、PG 集成、首屏/省电基准与静态审计
```

### 私有云端与 CLI
后端服务与命令行工具统一放在 [`cloud/`](cloud) 目录：

```sh
cp cloud/.env.example cloud/.env
# 启动前请将 cloud/.env 中的 POCKET_BOOTSTRAP_KEY、POCKET_SECRET_KEY、POSTGRES_PASSWORD（及 DATABASE_URL）替换为真实密钥
docker compose -f cloud/docker-compose.yml up -d --build

# 使用 pocket CLI（别名 pocket-cloud）管理配对码、日程、Todo、触发调试与同步监听
docker compose -f cloud/docker-compose.yml exec pocket-cloud sh -c '
  export POCKET_TOKEN="$POCKET_BOOTSTRAP_KEY"
  pocket status
  pocket pair create
  pocket todo add "早起赶车 @me 07:30" --date 2026-11-26
  pocket sync watch --from-seq 0 --limit 5
'
```

---

## 目录结构

```text
pocket/
├── apps/
│   ├── calendar/       独立应用 1：Web 模块化界面 + Capacitor/Kotlin 安卓真机响铃容器
│   └── notes/          独立应用 2：独立笔记（规划中）
├── cloud/              私有云端服务（FastAPI + PostgreSQL）与 pocket CLI
├── packages/           共享定时契约与纸墨终端样式（Paper Teletype）
├── docs/               架构设计、设计标准与发布约定
└── scripts/            全链路验证、静态审计与 Web/APK Release 打包脚本
```

需要了解完整开发路线与底层设计细节，可查看 [`docs/development-plan.md`](docs/development-plan.md)、[`docs/architecture.md`](docs/architecture.md)、[`docs/releases.md`](docs/releases.md) 与 [`docs/design-standard.md`](docs/design-standard.md)。
