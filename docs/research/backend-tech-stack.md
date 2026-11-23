# Pocket 后端与客户端技术选型（已定稿）

日期：2026-11-23  
状态：**已确认定稿**

---

## 1. 最终拍板技术栈

### Pocket Cloud（后端与自托管服务，`cloud/`）

```text
Runtime & 包管理 : Python 3.12 + uv (pyproject.toml + uv.lock)
Web & 协议契约   : FastAPI + Pydantic v2 + Uvicorn (HTTP JSON RPC + WebSocket)
数据库与迁移     : PostgreSQL + psycopg v3 (async pool) + 显式顺序 SQL migrations
定时与后台投递   : PostgreSQL 权威表 + 轻量 asyncio Worker (FOR UPDATE SKIP LOCKED) + croniter + zoneinfo
出站 HTTP 客户端 : httpx.AsyncClient
测试与代码规范   : pytest + pytest-asyncio + 真实 Docker PostgreSQL + bits-style v0.3.5
部署形态         : Docker Compose (cloud/docker-compose.yml，个人自托管优先)
```

### 客户端应用（两个按场景彻底分离的独立软件，`apps/`）

```text
前端构建与模块化 : Vite + 原生 ES Modules / TS（不引 React/Vue 重框架）+ packages/client-core + packages/design-system
独立软件 1       : apps/calendar（时间与日程：今日日程 / 月历 / Todo 统一管 @me 闹钟与 @agent 计划，同时输出网页端与 Android APK）
独立软件 2       : apps/notes（独立笔记：下一阶段单独打磨，安装包与界面入口完全独立）
Android 打包底座 : Capacitor 8.6 (compileSdk 36 / targetSdk 36 / minSdk 26 / AGP 8.13 / JDK 21) + Kotlin 薄原生插件
原生响铃安全库   : Device-Protected Storage 原生 SQLite + directBootAware 锁屏未解锁恢复 + USE_EXACT_ALARM / setAlarmClock + 全屏响铃服务
分发方式         : 客户端产物统一发布至 GitHub Releases (calendar-v* / notes-v*)
```

---

## 2. 关键选型理由与技术债核验

1. **后端 Python 3.12 + FastAPI + 显式 SQL + PG 驱动循环**：
   - 自动生成精确 OpenAPI / JSON Schema 契约，且 `bits-style v0.3.5` 原生支持 Python；
   - 不用重 ORM 与 APScheduler，直接用 PostgreSQL 权威表 + `FOR UPDATE SKIP LOCKED` 30 秒短事务租约抢占后在事务外发请求，零额外中间件同时满足防崩溃恢复、幂等重试与 `missed_policy` 控制。
2. **产品合并与单文件原型债清偿（`Vite` + `packages/client-core`）**：
   - 闹钟、Agent 计划、日程与月历已统一收口进 **Pocket Calendar** 三栏界面（`今日日程 / 月历 / Todo`），消除旧独立闹钟页面与跨软件同步负担；**Pocket Notes** 保持彻底独立的第二个应用；
   - 用轻量 `Vite` 拆分单文件原型，同一份代码同时输出网页端与 Capacitor 自包含静态目录。
3. **Android 14–16 (`targetSdk 36`) 与夜间自动重启（Direct Boot）防护**：
   - 不使用社区 WebView SQLite 插件；Kotlin 原生层使用 `Context.createDeviceProtectedStorageContext()` 在设备加密区（DE）直接维护原生 `SQLiteOpenHelper`，静态广播声明 `android:directBootAware="true"` 监听 `LOCKED_BOOT_COMPLETED`，确保手机半夜自动重启未输锁屏密码也能恢复晨间闹钟；
   - 统一调用 `AlarmManager.setAlarmClock()`（配合侧载 APK 声明 `USE_EXACT_ALARM`），响铃前台服务声明 `foregroundServiceType="systemExempted|mediaPlayback"`，弹出仅含「关闭本次 / 10 分钟后再响」的全屏页，并在设置页内置 4 项真机权限自检跳转卡。

---

## 3. 分阶段实施路线

完整五步推进计划（后端 3 步含配套调试 CLI → 第 4 步网页端接入 → 第 5 步安卓打包发布至 GitHub Releases）统一记录在 [整体开发方案与分步路线](../development-plan.md)，后端建表与接口细则见 [后端实施手册](../cloud/implementation-plan.md)。
