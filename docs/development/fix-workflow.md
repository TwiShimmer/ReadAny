# ReadAny 修复流程规范

> 适用范围：`track:0-standards` 及其余 6 条并行修复路线（T1–T6）。
> 目标：让每个修复都能被 review、被复现、被回归测试保护，并且可以安全地同步 upstream。

## 1. 分支策略

- 每条修复路线使用独立分支，从最新 `main` 创建：
  - `fix/t<N>-<slug>`：修复分支，`N` 为路线号，例如 `fix/t1-webdav-put-409`、`fix/t3-pdf-worker`。
  - `chore/<slug>`：规范、CI、文档、依赖等非缺陷变更，例如 `chore/dev-standards`。
- 一个分支只服务一个 issue / 一个主题；不要把多条路线的改动混在一个 PR。
- **禁止直接向 `main` 推送**。所有变更必须经过 PR，由维护者合并。
- 分支提交前先 rebase 到最新 upstream（见第 7 节），保持线性历史。

## 2. 提交规范

使用 Conventional Commits：

```text
<type>(<scope>): <summary>
```

常用 type：

| type | 用途 |
| --- | --- |
| `fix` | 缺陷修复 |
| `test` | 只增加/调整测试 |
| `docs` | 只改文档 |
| `ci` | CI / workflow |
| `chore` | 构建、脚本、依赖、规范 |
| `refactor` | 不改变行为的重构 |

常用 scope：`webdav`、`sync`、`pdf`、`onboarding`、`docs`、`release`、`dev`。

示例：

```text
fix(webdav): recreate parent collection before retrying PUT on 409
test(sync): cover partial failure reporting
docs(dev): add fix workflow and test management
ci: add lint test typecheck gates
```

要求：

- **一个提交只做一件事**。格式化、重命名、逻辑修复不要塞进同一个提交。
- 触及**预存 lint 债务**文件时，允许并应当单独提交 `style: format <file>`，并在 PR 描述注明“本文件为预存债务格式化”；不要把整文件格式化混进功能提交。
- 提交信息写“做了什么 + 为什么”，不要只写 `update`、`fix bug`。
- 不提交生成物、`node_modules`、本地数据库、日志、真实凭据。
- 不为了通过检查而批量格式化无关文件；Biome 只检查本次变更文件（见第 6 节）。

## 3. PR 流程

### 3.1 创建

- 使用 `.github/pull_request_template.md`，标题与提交风格一致，例如 `fix(webdav): 处理 PUT 409 并补回归测试`。
- 正文必须写 `Closes #<issue>`（一个 PR 对应一个主 issue；关联 issue 用 `Refs #N`）。
- 默认先开 **draft**，允许早期获得反馈，但 draft 不代表可合并。

### 3.2 draft → ready 的条件

同时满足以下条件才可标记 ready：

1. 关联 issue 已填写，范围与验收标准对得上。
2. 回归测试已先红后绿，命令与结果写进 PR 的“测试证据”。
3. `pnpm lint:changed`、`pnpm --filter @readany/core test`、`pnpm --filter @readany/cli test`、`pnpm --filter app exec tsc --noEmit` 全部通过；**CLI 测试以 Linux CI 为准**，Windows 已知平台限制见 `test-plan.md` §2；涉及 Rust 时 `cargo check` 通过。
4. 自己完整看过一遍 diff，没有调试输出、临时文件、无关格式化。
5. 涉及 UI / PDF / 移动端时，附截图或录屏。
6. 风险与回滚方式已写明。

### 3.3 合并

- 由维护者合并；合并前确认 CI 四个 job 全绿。
- 合并后确认 issue 自动关闭，并在 issue 留下测试证据评论（见 3.4）。
- 不 force-push 已进入 review 的分支；需要同步 upstream 时用 rebase 并说明。

### 3.4 issue 测试证据

每个修复 issue 至少回填一次：

- 复现步骤与修复前表现；
- 新增/修改的测试文件与用例名；
- 本地执行命令与结果（通过/失败数量）；
- 手动验收结果（如适用）；
- 已知限制与后续 issue。

## 4. 代码标准

- **TypeScript strict**：仓库已开启 `strict`、`noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`；不要用 `// @ts-ignore` 绕过。
- **禁止 `any`**：需要未知类型时用 `unknown` + 类型守卫 / zod；确实无法建模时先讨论，不要静默放宽。
- **禁止用错误文案匹配 HTTP 状态**：错误消息会本地化、会被改写。使用结构化错误（如 `WebDavError.status` / `kind`）判断 404、409、401；不要 `message.includes("409")`、不要正则匹配数字。
- **优先结构化错误**：跨层传递的错误应带 `status`、`kind`、`method`、`url` 等字段；UI 层根据字段决定文案与重试策略。
- **i18n 文案不写死**：用户可见文案走 `i18n.t(...)`，新增 key 至少覆盖 `zh` / `en`；错误对象里不要拼接面向用户的整句。
- **Biome 是唯一格式化 / lint 工具**：不引入 ESLint / Prettier 配置，不提交与其冲突的格式。
- **日志不含敏感信息**：URL 中的用户名、密码、token、完整内网地址必须脱敏；生产代码不保留 `console.log` 调试输出（现有诊断日志按既有约定处理）。

## 5. Definition of Done

一个修复只有全部满足才算完成：

- [ ] **回归测试先红后绿**：修复前能复现失败，修复后通过；测试名能说明场景。
- [ ] `pnpm lint:changed` 通过（只检查相对 `origin/main` 的变更文件）。
- [ ] `pnpm --filter app exec tsc --noEmit` 通过。
- [ ] `pnpm --filter @readany/core test` 与 `pnpm --filter @readany/cli test` 通过（CLI 测试以 Linux CI 为准；Windows 平台限制见 `test-plan.md` §2）；涉及 Rust 时 `cargo check --manifest-path packages/app/src-tauri/Cargo.toml --features tauri/custom-protocol` 通过。
- [ ] issue 已回填测试证据（命令 + 结果 + 手动验收）。
- [ ] 文档同步：行为、配置、错误语义变化时更新对应 `docs/`。
- [ ] 无密钥：diff、测试 fixture、issue、日志中都没有真实密码、token、内网地址。
- [ ] 不得对**未触碰**的文件做无关格式化；触碰预存债务文件时按第 2 节单独提交 `style:`。变更范围之外没有无关重构。

## 6. Lint 门禁与预存债务

当前仓库的**全量** `pnpm lint` 是红的，这是预存债务，不应由单个修复 PR 承担：

| 指标（2026-11-25，Windows 检出） | 数值 |
| --- | --- |
| 默认诊断数 | 20 |
| 默认诊断下的 errors / warnings | 1661 / 288 |
| 全量诊断下的 errors / warnings | 2628 / 575 |
| 因 CRLF 与 Biome 期望 LF 不符的文件 | 913 / 917 |

主要原因：

1. `core.autocrlf=true` 且仓库此前没有 `.gitattributes`，检出为 CRLF，Biome 期望 LF。
2. 第三方/内嵌代码此前未被忽略：`packages/foliate-js` 约 1632 errors、`packages/app/public/vendor` 约 515 errors；`packages/app/src` 约 199、`packages/core/src` 约 129。

因此：

- **PR 门禁使用 `pnpm lint:changed`**，默认相对 `origin/main`（可用 `--base` 或 `LINT_BASE_REF` 指定，fork 场景传 `upstream/main`），只对变更的、Biome 支持的文件跑 `biome check`；无变更时成功退出。
- 全量 `pnpm lint` 仍然保留，用于债务清理；清理工作另开 issue，不与功能修复混在一起。
- 新增 `.gitattributes`（`* text=auto eol=lf`）只影响**后续检出**，不承诺一次性修完历史 CRLF 文件，也不执行全库 renormalize。
- `biome.json` 只新增 `files.ignore`（第三方/内嵌代码、构建产物、`target`），不调整规则、不批量改代码。
- Linux CI 检出为 LF；Windows 本地若因 `core.autocrlf` 出现 CRLF，**本地全量 lint 红 ≠ CI 红**，以 `lint:changed` 和 CI 结果为准。

### 6.1 CI 必过检查（required checks）

`.github/workflows/ci.yml` 的四个 job 显示名固定为：

1. `Lint (changed files)`
2. `Test core`
3. `Typecheck app`
4. `Cargo check (release features)`

分支保护里配置 required checks 时使用上述显示名；修改 job 的 `name` 或 job id 必须同步检查分支保护，否则 required check 会一直 pending 或失效。

## 7. 与 upstream 同步

```bash
git fetch upstream
git rebase upstream/main
```

- 解决冲突时保留双方意图：先看 upstream 变更目的，再决定是否保留本地修复；不要用 `-X ours/theirs` 一把梭。
- rebase 后重新跑 lint / typecheck / 测试，确认没有语义冲突。
- **禁止把 upstream/main 合并进功能分支**（不要 `git merge upstream/main`），保持线性历史；禁止把 upstream 分支直接推回 fork 的 main。
- 推送 rebase 后的分支需要 `git push --force-with-lease`，并在 PR 中说明。

## 8. 安全与隐私

- issue、PR、日志、测试 fixture、截图里**禁止**出现：真实 WebDAV 密码、token、Cookie、私钥、内网 IP / 域名、个人路径。
- 测试统一使用占位值，例如 `https://dav.example.com/dav`、`user@example.com`、`test-password`。
- 需要在 CI 使用的凭据只能放 GitHub Secrets，不写入 workflow 明文。
- 提交前自查：`git diff` 中是否出现 `password=`、`Bearer `、`token=`、`192.168.`、`10.` 等模式。

## 9. 相关文档

- [测试计划与测试矩阵](test-plan.md)
- [开发文档索引](README.md)
- [同步设计](../sync-design.md)
