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
    <a href="#界面一览">界面一览</a> ·
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

### 1. 在 Todo 里直接 `@` 你的 Agent，到点自动唤醒它干活
不用把“个人闹钟”和“AI 定时任务”拆成两套系统。在同一行待办里：
- 选 **`@me 07:30`** → 同步到手机系统闹钟准点响铃（断网可用、半夜重启也能恢复）；
- 选 **`@work-agent 16:00`** → 到点由私有云直接把这条内容通过 HTTP 发给你的 Agent 去跑，**不要求手机亮屏在线**，跑完的结果摘要直接挂回原待办下面。

### 2. AI 也能反过来帮你排日程、设真机闹钟
给你的 Agent 配一把受限密钥，它就能直接调接口查你的空档、建日程、加待办或设手机闹钟。状态完全诚实——只有手机真正写进系统闹钟后才返回 `EXECUTED`，手机离线排队或失败都会如实告知，不报假喜。

### 3. 给关键事项留“人类护栏”：本机锁与按需授权
- **本机锁（`LOCKED`）**：像早起赶高铁这种不能出岔子的闹钟，在手机上打开本机锁后，AI 和远端一律不能修改或关闭，防误操作。
- **按开关细粒度授权**：哪个 Agent 只允许读日程、哪个允许改待办、或者（后续）只允许读哪几篇笔记，全部单独开关控制，随时可撤回。

### 4. 纯 HTTP 接入，不绑死任何 AI 框架
不管你用的是自建 Agent、Claude / Codex 脚本还是自动化工作流，只要能收发普通 HTTP JSON 请求，填一个地址和密钥就能连进来。

---

## 界面一览

<p align="center">
  <img src="docs/assets/pocket-screens.png" alt="Pocket Calendar 三栏界面：今日日程、月历、统一 Todo" width="100%">
</p>

| 栏位 | 说明 |
| --- | --- |
| **`[d]` 今日日程** | 只显示今天当天的安排（下一场主角卡 + 今日其余场次 + 时间重叠提醒），不被跨天事项干扰。 |
| **`[m]` 月历** | 7 列等宽月历，区分强提醒响铃与普通日程，点选任意日期查看或新建。 |
| **`[t]` Todo** | 一套输入同时管普通待办、`@me` 手机闹钟与 `@agent` 定时任务；单次事项打勾归档，周期任务用开关启停并支持跳过下一次。 |

支持浅色暖亚麻纸与夜间深炭纸两种主题（按键 `b` 切换）。

---

## 两个独立应用

使用场景不同的工具不硬塞进一个臃肿软件里。Pocket 拆成两个完全独立的应用，共用同一套个人私有云端：

| 应用 | 定位 | 状态 |
| --- | --- | --- |
| **Pocket Calendar** | 日程、月历、手机闹钟与 Agent 定时任务合一 | 原型与架构已定稿 · 主线开发中 |
| **Pocket Notes** | 独立笔记应用，支持按篇勾选授权给指定 Agent 读取 | 规划中（独立安装包与入口） |

---

## 下载与部署

### 客户端
前往 **[GitHub Releases](https://github.com/12bitsD/pocket/releases)** 下载对应应用的独立安装包（`calendar-v*` / `notes-v*`）。  
本地直接预览交互原型：浏览器打开 [`apps/calendar/index.html`](apps/calendar/index.html) 即可体验。

### 私有云端
后端配置统一放在 [`cloud/`](cloud) 目录：

```sh
cp cloud/.env.example cloud/.env
docker compose -f cloud/docker-compose.yml up -d
```

---

## 目录结构

```text
pocket/
├── apps/
│   ├── calendar/       独立应用 1：日程、闹钟与 Agent 待办
│   └── notes/          独立应用 2：独立笔记（规划中）
├── cloud/              私有云端配置与后端服务
├── packages/           共享定时契约与纸墨终端样式
├── docs/               架构设计、设计标准与发布约定
└── scripts/            校验与 Release 打包脚本
```

需要了解底层设计细节可查看 [`docs/architecture.md`](docs/architecture.md) 与 [`docs/design-standard.md`](docs/design-standard.md)。
