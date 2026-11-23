<div align="center">
  <img src="docs/assets/pocket-hero.png" alt="Pocket — 把时间留给自己，也分给你的 Agent" width="100%">
  <br><br>
  <p>
    <a href="https://github.com/12bitsD/pocket/actions/workflows/test.yml"><img src="https://img.shields.io/github/actions/workflow/status/12bitsD/pocket/test.yml?branch=main&style=flat-square&label=checks&color=1a1917" alt="Checks"></a>
    <a href="https://github.com/12bitsD/pocket/releases"><img src="https://img.shields.io/github/v/release/12bitsD/pocket?include_prereleases&style=flat-square&label=releases&color=1a1917" alt="Releases"></a>
    <img src="https://img.shields.io/badge/client-Android_%2B_Web-1a1917?style=flat-square" alt="Android and Web">
    <img src="https://img.shields.io/badge/cloud-self--hosted-c44326?style=flat-square" alt="Self-hosted">
  </p>
  <p>
    <a href="#一套语法叫醒不同的人">核心概念</a> ·
    <a href="#界面一览">界面一览</a> ·
    <a href="#两个独立工具">产品构成</a> ·
    <a href="#下载与部署">下载与部署</a> ·
    <a href="#目录结构">目录结构</a>
  </p>
</div>

---

## 一套语法，叫醒不同的人

无论「定个手机闹钟」还是「给 AI Agent 排个定时任务」，本质上都是**在指定时间做一件事**——唯一的区别只是**到点叫醒谁**。

Pocket 把它们收进同一行待办里，不再拆成两套割裂的表单：

```text
补充环境变量说明                 →  仅待办        做完打勾归档
@me 07:30 早起赶高铁             →  手机准点响铃  离线可用 · 锁屏唤醒 · 防误改本机锁
@work-agent 16:00 整理本周进展   →  Agent 执行    云端准点投递 · 执行摘要直接挂回原条目
```

- **单次与循环自然区分**：一次性事项配完成方框，做完即划掉；每天/每周循环项自动变为启停开关，支持「跳过下一次」与防远程误改的「本机锁」。
- **诚实状态，不报假喜**：只有手机真正写进系统闹钟、或外部 Agent 明确接收任务后，才会点亮就绪状态。

---

## 界面一览

<p align="center">
  <img src="docs/assets/pocket-screens.png" alt="Pocket Calendar 三栏界面：今日日程、月历、统一 Todo" width="100%">
</p>

| 栏位 | 做什么 |
| --- | --- |
| **`[d]` 今日日程** | **只看今天**。顶部白卡聚焦下一场安排，下方列出今日其余场次与时间冲突提醒，不被跨天杂事打扰。 |
| **`[m]` 月历** | **全局排期**。7 列等宽月历，用朱砂与墨点区分强提醒与普通日程，点选任意日期查看或新建。 |
| **`[t]` Todo** | **统一指派**。同一个输入框与时间选择器（支持直接键入 `@me 07:30` 识别），一处管好待办、闹钟与 Agent 计划。 |

内置暖亚麻浅色纸面与夜间深炭纸两种主题（快捷键 `b` 一键切换）。

---

## 两个独立工具

Pocket **不做把所有功能塞进一个图标的臃肿全家桶**，而是按使用场景彻底拆成两个独立应用，共用同一套个人私有云端：

| 应用 | 场景与定位 | 当前状态 |
| --- | --- | --- |
| **Pocket Calendar** | 日常时间、日程、手机闹钟与 Agent 定时任务（`今日日程 / 月历 / Todo`） | 原型与架构已定稿 · 主线开发中 |
| **Pocket Notes** | 独立写作与知识沉淀，支持按篇授权给指定 Agent 读取 | 规划中（独立安装包与入口） |

---

## 下载与部署

### 1. 获取客户端

前往 **[GitHub Releases](https://github.com/12bitsD/pocket/releases)** 下载对应应用的独立发布包（`calendar-v*` / `notes-v*`）。

想直接在本地浏览器体验交互原型，无需安装构建，直接打开 [`apps/calendar/index.html`](apps/calendar/index.html) 即可（支持键盘 `d / m / t / n / c / b` 操作）。

### 2. 部署私有云端

服务端配置集中在 [`cloud/`](cloud) 目录，一条命令拉起数据库与同步调度服务：

```sh
cp cloud/.env.example cloud/.env
docker compose -f cloud/docker-compose.yml up -d
```

电脑端使用初始密钥登录，手机端输入 **5 分钟有效的 6 位配对码** 即可完成绑定。

---

## 目录结构

```text
pocket/
├── apps/
│   ├── calendar/       独立应用 1：时间与日程（今日日程 / 月历 / Todo）
│   └── notes/          独立应用 2：独立笔记（规划中）
├── cloud/              私有云端配置与后端服务（Docker Compose / 环境变量）
├── packages/
│   ├── agent-core/     共享定时与 @指派解析逻辑
│   └── design-system/  共享活字工单 × 终端视觉样式
├── docs/               架构设计、持续演进的设计标准与发布说明
└── scripts/            校验与 Release 打包脚本
```

本地开发校验：

```sh
npm test && npm run check
```

更深入的系统设计细节见 [`docs/architecture.md`](docs/architecture.md) 与 [`docs/design-standard.md`](docs/design-standard.md)。
