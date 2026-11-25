# ReadAny 测试计划与测试矩阵

> 配套文档：[修复流程规范](fix-workflow.md)。
> 本文定义测试层级、T1–T6 的测试矩阵、必测场景、fixture 规范、覆盖率与 flaky 策略，以及桌面/移动手动验收清单。

## 1. 测试层级

| 层级 | 范围 | 工具 | 命令 | CI job |
| --- | --- | --- | --- | --- |
| core 单元 / 集成 | `packages/core/src/**` | Vitest 4（`environment: node`） | `pnpm --filter @readany/core test` | `test-core` |
| 同步集成 | 本地 mock WebDAV HTTP server + `ISyncBackend` | Vitest + `node:http` | 同上 | `test-core` |
| app 类型 / 构建 | `packages/app/src/**` | `tsc --noEmit`、Vite build | `pnpm --filter app exec tsc --noEmit` | `typecheck-app` |
| Rust | `packages/app/src-tauri/**` | `cargo check` / `cargo test` | 见第 9 节 | `cargo-check` |
| 规范 / CI | 文档、workflow、脚本 | Biome（仅变更文件）、YAML 解析、`version:check` | `pnpm lint:changed` | `lint` |
| 手动验收 | 桌面 Tauri、WebView2、移动端、真实 WebDAV | 人工 | 见第 10 节 | 不在 CI |

约束：

- app 目前没有独立测试运行器；能在 core 中测的纯逻辑（worker 选择、错误归一化等）优先放 core。app 组件的自动化测试作为后续增强，不阻塞当前修复。
- Rust 测试如未配置独立 `cargo test` 目标，至少保证 `cargo check` 通过；新增 Rust 逻辑时补 `#[cfg(test)]` 单元测试。

## 2. 基线（2026-11-25）

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm --filter @readany/core test` | **通过** | 85 个测试文件 / 628 个用例全部通过 |
| `pnpm --filter app exec tsc --noEmit` | **通过** | 无输出，退出码 0 |
| `cargo check --manifest-path packages/app/src-tauri/Cargo.toml` | **通过** | 前置条件：先执行 `pnpm --filter @readany/cli build`，否则 Tauri build script 报 `resource path ../../cli/dist doesn't exist` |
| `pnpm lint`（全量） | **失败（预存债务）** | 默认 20 条诊断：1661 errors / 288 warnings；全量诊断：2628 errors / 575 warnings |
| CRLF 文件 | 913 / 917 | `core.autocrlf=true` 且此前无 `.gitattributes`，与 Biome 的 LF 期望不符 |
| `pnpm lint:changed` | **通过** | PR 门禁；只检查相对 `origin/main` 的变更文件 |

全量 lint 的主要债务来源：`packages/foliate-js`（约 1632 errors）、`packages/app/public/vendor`（约 515 errors）、`packages/app/src`（约 199）、`packages/core/src`（约 129）。清理另开 issue，不作为功能修复 PR 的门禁。

## 3. T1–T6 测试矩阵

> T1–T6 对应仓库 label：`track:1-transport`、`track:2-sync-trust`、`track:3-pdf-runtime`、`track:4-onboarding`、`track:5-docs-release`、`track:6-structure`。

### T1 传输层（WebDAV）

| 测什么 | 测试文件 | fixture / mock | CI job |
| --- | --- | --- | --- |
| PUT 首次返回 409/404 → 创建父集合（MKCOL）→ 重试一次成功 | `packages/core/src/sync/webdav-client.test.ts`、`webdav-backend.test.ts` | `installFetchStub` 记录 method/url 序列；第一次 PUT 返回 409，MKCOL 返回 201/405，第二次 PUT 返回 201 | `test-core` |
| 409 在多层父目录缺失时逐级 MKCOL | `packages/core/src/sync/webdav-client.test.ts` | fetch stub 对 `mkcolChain` 的每个 segment 返回 201 | `test-core` |
| 非 409/404 的 PUT 失败不被吞掉（403、500 直接抛出） | 同上 | fetch stub 固定状态码 | `test-core` |
| 本地化错误消息下仍按状态码分支 | `packages/core/src/sync/webdav-client.test.ts` | 切换 i18n 到 `zh`，断言 `WebDavError.status` / `kind`，不匹配文案 | `test-core` |
| 401 重试、429/5xx 退避策略不影响超时/网络错误 | 同上 | 假计时器或注入 backoff；禁止真实 sleep | `test-core` |

### T2 同步可信度

| 测什么 | 测试文件 | fixture / mock | CI job |
| --- | --- | --- | --- |
| 部分文件上传/下载失败时，同步结果仍上报成功数与失败明细 | `packages/core/src/sync/__tests__/simple-sync.integration.test.ts`、`per-book-sync.test.ts` | `sync-files` mock 返回部分失败；DB mock 用内存行 | `test-core` |
| 远端书目索引存在，但对应书籍文件缺失时不崩溃、可恢复 | `packages/core/src/sync/__tests__/sync-files.test.ts` | `RemoteFileManifest` fixture 指向不存在的远端路径 | `test-core` |
| 单本书失败不阻断其他书 | `packages/core/src/sync/__tests__/simple-sync.integration.test.ts` | 两本书，其中一本 `hashFile`/`put` reject | `test-core` |
| 删除与上传并发时状态一致 | `packages/core/src/sync/__tests__/per-book-sync.test.ts` | 内存 DB + 固定 device id | `test-core` |

### T3 PDF 运行时

| 测什么 | 测试文件 | fixture / mock | CI job |
| --- | --- | --- | --- |
| PDF worker 路径选择：Tauri / Web / 低版本 WebView2 各自可用 | `packages/core/src/pdf/worker-polyfill.test.ts`（新增，纯函数） | 假 `navigator.userAgent`、`window.__TAURI__` 标志；不加载真实 PDF | `test-core` |
| worker 初始化失败时回退主线程 / 给出可重试错误 | 同上 | 注入抛错的 loader | `test-core` |
| PDF 章节解析回归 | `packages/core/src/pdf/chapter.test.ts` | 现有小型 PDF fixture | `test-core` |
| 错误边界展示友好文案，不暴露原始异常/堆栈/URL | `packages/app/src/components/common/__tests__/error-boundary.test.tsx`（目标文件；app 暂无测试运行器时先手动验收） | 抛错子组件；断言 DOM 不含 `Error:`、堆栈、凭据 | 手动验收；后续 app 测试就绪后纳入 CI |

### T4 新设备接入（Onboarding）

| 测什么 | 测试文件 | fixture / mock | CI job |
| --- | --- | --- | --- |
| 新设备首次同步时 `file-manifest.json` 404/409 不中断，回退目录扫描 | `packages/core/src/sync/__tests__/sync-files.test.ts` | `getJSON` 抛 `WebDavError(status: 404)` | `test-core` |
| 远端为空（全新账号）时可建立目录并写入首份快照 | `packages/core/src/sync/webdav-backend.test.ts` | fetch stub 全部返回 404 后按 MKCOL/PUT 成功 | `test-core` |
| 旧布局迁移到 per-book 布局 | `packages/core/src/sync/__tests__/legacy-migration.test.ts` | 旧 `file/`、`cover/` 路径 fixture | `test-core` |
| schema 过滤不把未来字段写回旧客户端 | `packages/core/src/sync/__tests__/schema-filtering.test.ts` | 含未知字段的 JSON | `test-core` |
| 书目文件夹命名/解析稳定 | `packages/core/src/sync/__tests__/sync-naming.test.ts` | 特殊字符、空标题、超长标题 | `test-core` |

### T5 文档与发布

| 测什么 | 测试文件 / 检查 | fixture / mock | CI job |
| --- | --- | --- | --- |
| 变更文件 lint 门禁可运行、无变更时成功退出 | `scripts/lint-changed.mjs`（自身） | 本地分支与 `origin/main` 对比 | `lint` |
| workflow YAML 可被解析 | `.github/workflows/ci.yml` | `yaml.safe_load` 或等价解析器 | 本地 / PR 检查 |
| 版本文案一致 | `pnpm version:check` | 仓库版本文件 | 发布前手动 |
| 文档链接与命令真实存在 | `docs/development/*` | 人工检查 | PR review |

### T6 增量同步与结构

| 测什么 | 测试文件 | fixture / mock | CI job |
| --- | --- | --- | --- |
| 大文件传输不把整文件展开成 `number[]`/`Array.from(fileBytes)` | `packages/core/src/sync/__tests__/sync-transfer.test.ts`（新增） | 运行时生成 32–64 MB `Uint8Array`（不提交二进制）；`vi.spyOn(Array, "from")` | `test-core` |
| 分块/流式路径按 chunk 推进并正确回调进度 | 同上 | 假 `uploadFile` 记录 chunk 大小与进度序列 | `test-core` |
| 增量清单比较（大小/hash）只处理变更项 | `packages/core/src/sync/__tests__/sync-files.test.ts` | `file-manifest.json` fixture | `test-core` |
| 并发布限与进度节流 | `packages/core/src/sync/__tests__/sync-transfer.test.ts` | 受控 Promise + 假计时器 | `test-core` |

## 4. 必测场景清单

以下场景至少各有一条自动化回归测试（无法自动化的列明手动步骤）：

1. **PUT 409 → 父目录 MKCOL → 重试**：断言请求序列为 `PUT(409) → MKCOL(parent) → PUT(2xx)`。
2. **本地化错误消息下的状态码分支**：i18n 为中文时错误文案变化，但 `status === 404/409` 判断仍正确。
3. **大文件不走整文件 `Array.from`**：对文件字节展开调用 `Array.from` 视为失败；只允许对小型元数据使用。
4. **同步部分失败仍上报**：至少一本书失败时，结果包含成功/失败计数与失败原因，UI 不显示“全部成功”。
5. **远端书目存在但文件缺失**：索引有条目、远端文件 404 时，标记缺失并可重新上传/下载，不抛未捕获异常。
6. **`file-manifest.json` 404 不中断**：回退目录扫描，后续同步继续。
7. **PDF worker polyfill 生效**：Tauri/Web/低版本 WebView2 均能选中可用 worker；失败时有回退。
8. **错误边界不暴露原始异常**：页面只显示本地化提示，DOM 不含堆栈、内部路径、URL 凭据。

## 5. 测试数据与 fixture 规范

- 目录：`packages/core/src/sync/__fixtures__/`（按需创建），小型 JSON fixture 可提交；**大二进制不提交**，在测试运行时生成。
- 命名：`<场景>-<期望>.json`，例如 `manifest-missing-file.json`、`sync-index-minimal.json`。
- 禁止联网：所有 WebDAV / S3 / HTTP 调用必须走 fetch stub 或本地 mock server。
- 禁止 `sleep` / 固定等待：用事件、Promise、假计时器（`vi.useFakeTimers()`）同步。
- mock server 端口使用 `0`（系统分配随机空闲端口），从 `server.address()` 读取，不硬编码 3000/8080。
- 测试结束后关闭 server、清理临时目录；不写用户真实数据目录。
- 凭据一律使用占位值（`https://dav.example.com/dav`、`test-password`），不出现真实账号、token、内网地址。

推荐的 mock WebDAV server 位置：`packages/core/src/sync/__tests__/helpers/mock-webdav-server.ts`，提供 `startMockWebDav()` / `stop()`，按路径与方法返回可编程响应。

## 6. 覆盖率策略

- 暂不设置全库硬阈值，避免为了数字写无意义测试。
- **P0 修复必须有回归测试**：先复现失败，再修复到绿。
- 新增分支必须被覆盖：新增的 `if/else`、错误分支、降级路径至少一条用例。
- 修改错误处理时，同时覆盖“正常返回”和“抛错返回”。
- 需要量化时再引入 `@vitest/coverage-v8`；未引入前以“回归测试 + 分支审查”为准，不伪造覆盖率数字。

## 7. Flaky 处理

- 禁止用“重跑直到绿”掩盖问题。
- 失败即定位：是测试假设错误、时序问题还是产品缺陷；修复测试或产品代码。
- 暂时无法修复时：标记 `it.fails`/`describe.skip` 并在同一 PR 或新 issue 中记录原因、负责人和恢复条件。
- 网络、时间、随机数、并发是常见来源；测试中必须可注入、可控制。

## 8. 本地运行命令

```bash
# 安装（CI 使用 frozen lockfile）
pnpm install --frozen-lockfile

# PR 门禁：只检查变更文件
pnpm lint:changed

# core 全量测试（85 文件 / 628 用例基线）
pnpm --filter @readany/core test

# app 类型检查
pnpm --filter app exec tsc --noEmit

# Rust 检查（先构建 CLI 资源）
pnpm --filter @readany/cli build
cargo check --manifest-path packages/app/src-tauri/Cargo.toml

# 发布前版本一致性
pnpm version:check
```

## 9. CI 对照

`.github/workflows/ci.yml` 包含四个 job：

| job | 命令 | 说明 |
| --- | --- | --- |
| `lint` | `pnpm lint:changed` | 只检查相对 `origin/main`（PR 使用 `GITHUB_BASE_REF`）的变更文件；无变更成功退出 |
| `test-core` | `pnpm --filter @readany/core test` | 85 文件 / 628 用例基线 |
| `typecheck-app` | `pnpm --filter app exec tsc --noEmit` | 已验证命令可用 |
| `cargo-check` | `pnpm --filter @readany/cli build` → `cargo check --manifest-path packages/app/src-tauri/Cargo.toml` | 先构建 CLI，Tauri build script 需要 `packages/cli/dist` 资源；Ubuntu 依赖与 `release.yml` 一致 |

## 10. 手动验收清单

每条至少执行一次，并在 PR / issue 留下结果（截图或日志摘要）：

- [ ] **桌面 Tauri**：Windows 或 macOS 安装包启动，打开一本书，执行一次 WebDAV 同步，退出重进数据仍在。
- [ ] **WebView2 低版本**：在较低版本 WebView2 环境打开 PDF，确认 worker polyfill 生效、无白屏、错误边界只显示友好提示。
- [ ] **移动端**：Expo / Android（或 iOS）打开书籍与同步设置页，确认无崩溃、文案本地化正确。
- [ ] **真实 WebDAV**：使用 `wsgidav` 或 Nextcloud 测试账号（测试环境，不写真实凭据到仓库），验证首次同步自动建目录、409 重试、断网恢复。
