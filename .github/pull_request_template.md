## 关联 issue

Closes #

<!-- 一个 PR 对应一个主 issue；相关但未关闭的 issue 用 Refs #N 列出。 -->

## 变更范围

- 路线 / label：
- 主要文件：
- 明确不包含：

## 测试证据

| 命令 | 结果 |
| --- | --- |
| `pnpm lint:changed` | |
| `pnpm --filter @readany/core test` | |
| `pnpm --filter @readany/cli test` | |
| `pnpm --filter app exec tsc --noEmit` | |
| `pnpm --filter @readany/cli build` + `pnpm --filter app build` + `cargo check --manifest-path packages/app/src-tauri/Cargo.toml --features tauri/custom-protocol` | N/A / 通过 |

回归测试（先红后绿）：

- 修复前失败用例：
- 修复后通过用例：

## 风险与回滚

- 风险：
- 回滚方式：

## 截图 / 录屏（UI、PDF、移动端改动必填）

<!-- 贴图或链接；不要包含真实账号、token、内网地址。 -->

## 检查清单

- [ ] 已关联 issue，并写了 `Closes #N`
- [ ] `pnpm lint:changed` 通过（Biome 只检查本次变更文件）
- [ ] `pnpm --filter app exec tsc --noEmit` 通过
- [ ] `pnpm --filter @readany/core test` 通过
- [ ] `pnpm --filter @readany/cli test` 通过（以 Linux CI 为准；Windows 平台限制见 `test-plan.md` §2）
- [ ] 涉及 Rust 时 `cargo check --features tauri/custom-protocol` 通过（前置 `pnpm --filter @readany/cli build` 与 `pnpm --filter app build`）
- [ ] 回归测试先红后绿，测试证据已写入本文
- [ ] 无真实 WebDAV 密码、token、内网地址、个人路径
- [ ] 文档已同步（行为、配置、错误语义有变化时）
- [ ] 未触碰的文件没有无关格式化或重构；预存债务文件已按 §2 单独 `style:` 提交并在描述中注明
- [ ] 已 rebase `upstream/main`（或说明无需 rebase）
