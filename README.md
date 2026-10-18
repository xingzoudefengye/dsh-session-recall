# dsh-session-recall

为 DeepSeek Harness 提供一份有界、零模型的会话史书，并按你的 harness 精确版本打开上游那 5 个只读会话历史工具。

> English: dsh-session-recall is an MIT-licensed DeepSeek Harness plugin that adds a bounded, model-free session chronicle plus an optional switch for the harness's own workspace-authorized session-history tools. The chronicle is a pure projection of the session's durable event log: no storage, no schema, no background work, no model calls, and a hard 6,000-character render budget. The switch installs the two upstream query packages at the harness's exact version and mounts them in an isolated group. This README is written so a stranger on Windows 11 (PowerShell) or macOS (zsh) can install, verify, configure, troubleshoot, and uninstall it from this page alone.

## 兼容性

| 平台 | 支持 | 说明 |
|---|---|---|
| Windows 10/11（PowerShell） | ✅ 支持 | 史书与全部 `scripts/*.mjs` 可用。Windows 上 `dsh` 通常是 `dsh.cmd`，脚本通过 `cmd.exe /d /s /c` 调用它，安装路径含空格也能用。 |
| macOS（zsh） | ✅ 支持 | 同上；`scripts/*.sh` 也可直接用。 |
| Linux（bash/zsh） | ✅ 支持 | 同上；`scripts/*.sh` 也可直接用。 |

**Node**：`package.json` 的 `engines.node` 是 `>=22`。用 `node --version` 确认。

**DSH**：`peerDependencies` 声明的是

```json
"@deepseek-ai/cordis": "*",
"@deepseek-ai/dsh-tools": "*"
```

`*` 表示**不声明最低版本**，也不锁定版本。插件实际要求宿主提供 `defineTool`、`ctx.tools.register` 和 cordis 的 `Service`，并能通过 `session.snapshotEvents()` 读到会话事件日志。上游那两个读工具则相反：必须与 `@deepseek-ai/dsh-base` 的版本**完全相等**，由 `enable-read-tools.mjs` 按该版本安装、`check.mjs` 严格比对。

**前置命令**：`node`、`dsh`、`pnpm` 都要在 `PATH` 上（`dsh plugin` 会把参数转发给 pnpm）。先跑一遍 `node --version`、`dsh --version`、`pnpm --version`。

> Windows 上不需要为了本仓库装 bash。`scripts/*.sh` 只是 macOS/Linux 的等价入口；Windows 请用同名的 `.mjs`。

## 安装

本仓库有两块**彼此独立**的东西：史书（随插件安装）和可选的上游 5 个只读历史工具（单独开启）。可以只装第一块。

### 1. 史书

```powershell
dsh plugin --profile web add github:xingzoudefengye/dsh-session-recall
```

`web` 是默认 profile 名，换成你自己的即可。装完**重启宿主**：

```powershell
dsh web
```

插件在宿主启动时被 import，`dsh plugin add` 只改 profile 的依赖与挂载，不会给已经跑着的进程热加载新包。

### 2. 可选：打开上游的 5 个只读历史工具

装完第 1 步后，在任意目录执行（PowerShell 与 zsh 通用）：

```powershell
node "$HOME/.dsh/profiles/web/node_modules/dsh-session-recall/scripts/enable-read-tools.mjs" web
```

如果设置了 `DSH_HOME`，把 `$HOME/.dsh` 换成它（PowerShell 里是 `$env:DSH_HOME`）。在仓库克隆里也可以直接跑 `node scripts/enable-read-tools.mjs web`。

它做四件事：

1. 从 profile 的 `@deepseek-ai/dsh-base` 读 harness 版本；该 manifest 不存在时回退到 `dsh --version`。
2. 在 profile 目录里 `pnpm add` 两个包：`@deepseek-ai/dsh-tool-session-query` 与 `@deepseek-ai/dsh-session-query-sqlite`，版本与 harness **精确相等**，零漂移。
3. 把 `cordis.patch.yml` 备份成 `cordis.patch.yml.bak-<YYYYMMDD-HHMMSS>`，再追加一个 `optional-session-search` 隔离组（照抄上游 `dsh-experimental-session-search` bundle 的挂载方式）。
4. 打印 `mounted the read tools in …`，提示重启。

重复运行不会重复追加（已经挂载时打印 `read tools are already mounted … — nothing to do`）；但脚本与 `.sh` 一样在检查幂等之前先跑 `pnpm add`，所以每次都会碰一次包管理器。

之后同样重启：

```powershell
dsh web
```

macOS/Linux 也可以用 bash 版：

```zsh
~/.dsh/profiles/web/node_modules/dsh-session-recall/scripts/enable-read-tools.sh web
```

## 验证

```powershell
node scripts/check.mjs web
```

（在已安装的 profile 里则是 `node "$HOME/.dsh/profiles/web/node_modules/dsh-session-recall/scripts/check.mjs" web`。参数省略时默认 `web`。）

它检查三件事：两个史书 row 是否在合成树里；上游读工具是否已挂载；若已挂载，两个包的版本是否与 harness 精确相等。退出码 `0` 表示没有 `FAIL`，`1` 表示有 `FAIL`（或 profile / `dsh` 不存在）。

已挂载时，本机（harness `0.2.1-rc.2`）的真实输出：

```text
ok:   session-chronicle is in the composed tree
ok:   tool-session-chronicle is in the composed tree
ok:   upstream read tools are mounted (harness 0.2.1-rc.2)
ok:   @deepseek-ai/dsh-tool-session-query@0.2.1-rc.2 matches the harness
ok:   @deepseek-ai/dsh-session-query-sqlite@0.2.1-rc.2 matches the harness
```

你机器上的版本号会不同；关键是 **harness 与两个包这三处版本必须一致**。

没有开启读工具时：

```text
ok:   session-chronicle is in the composed tree
ok:   tool-session-chronicle is in the composed tree
note: upstream read tools are not mounted (run scripts/enable-read-tools.mjs web to add them)
```

版本漂移时：

```text
FAIL: @deepseek-ai/dsh-tool-session-query@0.2.0-rc.2 does not match the harness (0.2.1-rc.2) — re-run scripts/enable-read-tools.mjs web
```

自检（开发用，纯离线）：

```powershell
npm test
```

12 个用例，覆盖折叠、终态词汇、容量上限、脱敏、渲染预算与畸形事件。

## 配置

史书本身**没有任何配置键**：它是对会话事件日志的纯函数投影，不落盘、不建索引、不跑后台任务。真正可调的只有下面三处。

### 工具参数（每次调用）

| 参数 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `lastTurns` | integer | 不传 = 全部 | 只返回最新的 N 条回合记录；非正整数按不传处理。 |
| `maxChars` | integer | `6000` | 返回文本的字符预算，上限也是 `6000`；低于 `64` 时按 `64` 渲染。 |

`maxChars` 限制的是**渲染出来的史书文本**；API 返回的对象另有 `12000` 字符的传输上限，不会为了它删除读者还有额度容纳的回合。

### 挂载点

bundle 默认插入两行（见 [`cordis.patch.yml`](cordis.patch.yml)）：

```yaml
- insert:
    - id: session-chronicle
      name: 'dsh-session-recall/service'

    - id: tool-session-chronicle
      name: 'dsh-session-recall/tool'
```

- `session-chronicle` 提供 `ctx.sessionChronicle` 服务，供其他插件消费，本身不占模型请求。
- `tool-session-chronicle` 注册模型可调用的 `session_chronicle` 工具，每个请求多一个 tool schema。

只想关掉模型工具、保留服务，在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: tool-session-chronicle
  disabled: true
```

### 读工具开关

`enable-read-tools.mjs` 追加的组长这样：

```yaml
- insert:
    - id: optional-session-search
      name: cordis:group
      group: true
      isolate:
        sessionQuery: true
      config:
        - id: optional-session-query-sqlite
          name: '@deepseek-ai/dsh-session-query-sqlite'
          config:
            path: ':memory:'
            openAt: first-search
        - id: optional-tool-session-query
          name: '@deepseek-ai/dsh-tool-session-query'
```

`isolate.sessionQuery` 让这个组开自己的 `sessionQuery`，所以 profile 里原有的 `sessionQuery` 行保持自己的配置；组内用 `:memory:` 索引，且到第一次搜索才打开（`openAt: first-search`）。

**代价**：这 5 个工具是上游的 opt-in 功能，每个模型请求固定多出 **5 个 tool schema 加一段引导文字**，即使这一轮根本不搜历史。不需要跨会话检索就不要开。

### `DSH_HOME`

脚本用 `DSH_HOME` 定位 profile；未设置时是 `~/.dsh`。这不是插件的配置键，只是脚本与 `dsh` 共用的环境变量。

## 卸载

### 1. 移除插件

```powershell
dsh plugin --profile web remove dsh-session-recall
```

### 2. 撤销读工具（如果开过）

脚本每次追加前都写了备份，恢复最近一份即可。

PowerShell：

```powershell
$patch = "$HOME/.dsh/profiles/web/cordis.patch.yml"
$bak = Get-ChildItem "$patch.bak-*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Copy-Item $bak.FullName $patch
```

zsh：

```zsh
cd ~/.dsh/profiles/web
cp "$(ls -t cordis.patch.yml.bak-* | head -1)" cordis.patch.yml
```

也可以手工编辑 `cordis.patch.yml`，删掉以 `# --- dsh-session-recall: ...` 开头的那一段——它下面的 `- insert:` 里就是 `optional-session-search` 组，直到 `name: '@deepseek-ai/dsh-tool-session-query'` 为止。

如果不再需要这两个上游包，顺手移除：

```powershell
dsh plugin --profile web remove @deepseek-ai/dsh-tool-session-query @deepseek-ai/dsh-session-query-sqlite
```

### 3. 重启

```powershell
dsh web
```

### 磁盘上剩下什么

- `cordis.patch.yml.bak-*` 备份文件（脚本写的，不会自动清理，可手删）。
- 若跳过了上面的可选移除：profile 的 `node_modules`、`package.json`、`pnpm-lock.yaml` 里仍有那两个上游包。
- **会话日志本身**：史书不写任何数据，插件卸载不会删除或改变 `~/.dsh` 下的会话记录。
- 插件自己的 `node_modules/dsh-session-recall` 会随 `dsh plugin remove` 一起消失。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 插件装好了，模型看不到 `session_chronicle` | 插件在宿主启动时 import；`dsh plugin add` 只改 profile，不会热加载新包 | 完全退出并重启 `dsh web`。刷新浏览器页面不算重启宿主。 |
| 改了 `lib/*.js`，行为没变 | Node 的 ESM 模块缓存按进程生效，宿主还拿着旧模块 | 重启宿主。不需要清缓存或重装。 |
| `dsh plugin add` 超时、403 或卡住 | `dsh plugin` 把参数转发给 pnpm，需要同时访问 GitHub 与 npm registry；代理或纯内网会失败 | 换到能访问的网络重试，或先给 pnpm 配好代理与 registry。 |
| 读工具已挂载，但模型调不到 | 宿主没重启；或两个包没装进 profile；或版本漂移 | 先重启，再跑 `node scripts/check.mjs web`。`not installed` 就重跑 `enable-read-tools.mjs`；版本不等就重装。 |
| `check` 报版本不匹配 | 两个上游包必须与 `@deepseek-ai/dsh-base` **精确相等**。它们与 harness 同批发布，rc 与 rc 之间也可能不兼容，所以检查用字符串严格相等，而不是 semver 范围 | 重跑 `node scripts/enable-read-tools.mjs web`，它会按当前 harness 版本重装。 |
| 新会话里史书是空的 | 史书只记录真人开过的回合（`source.kind === "user"`）；注入的上下文、工具结果、子 agent 消息都不算。新会话还没有真人消息时就是 0 条 | 先发一条真人消息；回合进行中会显示「回合进行中」，结束之后才有结论。空史书会明确写「本会话还没有记录到带真实用户输入的回合」。 |
| 本地路径安装后报找不到 `@deepseek-ai/cordis` | `dsh plugin add /abs/path` 装的是 `link:` 依赖，ESM 跟随软链到仓库真实路径后，解析不到 profile 的 `node_modules` | 开发时先跑 `node scripts/dev-link.mjs`；正常安装请用 `github:` 地址。 |
| `scripts/*.sh` 在 Windows 报 `set: pipefail: invalid option name` | checkout 用了 CRLF（`core.autocrlf=true` 时常见），bash 把 `pipefail\r` 当成选项名 | 用同名的 `.mjs` 脚本；或 `dos2unix scripts/*.sh` 后在 WSL / Git Bash 里跑。 |

## 设计

### 它补的是哪一步

Harness 里其实已经有四样相近的东西，但都差一步：

| 已有 | 缺的那一步 |
|---|---|
| `dsh-session-turn-outline`：每回合 prompt + response 折叠 | 只给客户端导航，**模型永远看不到**，而且**没有容量上限**（随会话线性增长） |
| `ctx.sessionQuery` + `dsh-session-query-sqlite`：跨会话读取与全文检索 | 默认 `openAt: never`，而且只是服务层，模型调不到 |
| `@deepseek-ai/dsh-tool-session-query`：5 个模型可调用的只读历史工具 | 出厂关闭（每次请求有固定开销），且没被 CLI 收进依赖树 |
| 压缩：旧历史替换成一条 summary | 被遮蔽的内容虽在日志里，但模型不会主动回头读 |

补上的就是这两步：**一个便宜、有界、模型读得懂的史书**，以及**一条把它和上游现成工具接上的正确接线**。

### 组成

| 部分 | 是什么 | 每次请求的固定开销 |
|---|---|---|
| `session_chronicle` 工具 | 一次调用返回本会话逐回合的 状态 / 目标 / 结论 | 一个 tool schema |
| `ctx.sessionChronicle` 服务 | 同一个折叠，供其他插件消费（[dsh-compaction-local-handoff](https://github.com/xingzoudefengye/dsh-compaction-local-handoff) 会把它写进压缩交接） | 无 |
| `scripts/enable-read-tools.mjs` | 按你 harness 的**精确版本**安装并挂载上游那 5 个历史工具 | 固定引导段 + 5 个 tool schema |

史书本身**不新增任何存储**：它是会话自己那份不可变日志的纯函数投影，冷恢复重算一遍就是同一个结果，因此没有 schema、没有迁移、没有后台任务、没有索引。

### 史书长什么样

模型调用 `session_chronicle`，拿到的是这样一段（真实运行输出）：

```text
会话史书（本地生成，未调用模型）：3/3 条回合记录
- #1 09:02 回合完成（目标未核验）；目标：把超时改成 30 秒；回复：已改完并跑过测试
- #2 09:15 回合取消（未完成）；目标：再跑一遍全量测试
- #3 09:20 回合进行中；目标：给这次改动补个 README
（需要原文时用 session_event_search / session_event_read 按回合或 seq 定位。）
```

### 容量与规则

| 规则 | 取值 |
|---|---|
| 条目上限 | 22 条（超出先粗化，再逐层丢弃） |
| 文本上限 | 6000 字符（**渲染出来的史书**，也只有这个决定了读者会失去什么） |
| 取值上限 | 12000 字符（API 返回的对象本身，含与文本重复的 `goal`/`response` 字段；它是传输上限，不会拿读者的额度去删回合） |
| 分层 | recent 12 / earlier 6 / oldest 4，每层摘要 160 / 100 / 60 字符 |
| 压缩顺序 | 额度紧张时**先丢样板、最后才丢内容**：`回合完成（目标未核验）` → `完成`，目标最后才被截断 |
| 合并粒度 | 4 条并 1 条，摘要取首/中/尾抽样 |
| 只记录 | **真人开过的回合**（`source.kind === "user"`）。注入的上下文、工具结果、子 agent 消息都不算，也不会被当成「目标」 |
| 终态 | 用 DSH 自己的 `TurnEndReason`：`completed` / `aborted` / `blocked` / `error` / `max-tokens` / `interrupted`，另加「进行中」 |
| 结论 | **只有 `completed` 回合才记回复**：取消/失败的半截回复可能自称成功，不能当结论 |

安全：私钥、认证头、token/密钥/密码、邮箱、代码块都会被替换（`[已脱敏]` / `[代码省略]`）。**路径和 URL 刻意保留**——它们是编码会话真正的产物，容量已经由条目预算兜住。

### 与 ComeCode 史书的差异（有意为之）

| | ComeCode | 这里 | 原因 |
|---|---|---|---|
| 存储 | SessionStore 里一个覆盖写的 entry，定长 tuple，兼容 7 元组旧格式 | 不落盘，从不可变日志重算 | 省掉一套 schema、版本兼容和迁移；冷恢复天然一致 |
| 终态 | 成功/取消/失败/阻止 | DSH 的 6 种 `TurnEndReason` + 进行中 | 用宿主自己的词汇，不另造一套 |
| 脱敏 | 路径、URL、邮箱全部省略 | 只脱敏密钥/代码块，保留路径和 URL | 跨项目史书需要抹掉路径；本会话史书不需要，路径是有用信息 |
| 分支 | 带 `branchGeneration`，跨分支按锚点严格过滤 | 无 | DSH 的会话日志是线性的 |

它保留下来的核心设计：**纯本地零模型**、**近期细/旧层粗/容不下就丢**、**只记真人回合**、**取消的回复不算结论**、**只由工具按需读、不每轮注入**。

### 已知限制

- 史书**只覆盖本会话**。跨会话检索是上游那 5 个工具的事（`session_search` 等），本仓库不重复实现。
- 上游 5 个工具要求目标会话与调用方 **cwd 精确相等**；没有 cwd 的调用方只能看自己。
- 上游工具如需要**有界输出**，得另装 `@deepseek-ai/dsh-spill-policy`——它自己不做字节截断。
- 用**本地路径**安装（`dsh plugin add /abs/path`）时，pnpm 会软链到仓库真实路径，ESM 便找不到 `@deepseek-ai/cordis`。开发时先跑 `node scripts/dev-link.mjs`；正常安装请用 git 地址。
- 你装的 harness 若升级到新版，第 2 步装的那两个上游包要跟着重跑一次（`node scripts/check.mjs` 会发现不一致）。**史书那部分与 harness 版本无关，升级不会失效。**

## 相关插件

- [dsh-browser](https://github.com/xingzoudefengye/dsh-browser) — 在会话里驱动浏览器。
- [dsh-web-search-failover](https://github.com/xingzoudefengye/dsh-web-search-failover) — 网页搜索的后备链。
- [dsh-compaction-local-handoff](https://github.com/xingzoudefengye/dsh-compaction-local-handoff) — 本地压缩交接，消费 `ctx.sessionChronicle`。
- [dsh-project-memory](https://github.com/xingzoudefengye/dsh-project-memory) — 项目级记忆。
- [dsh-resume-budget](https://github.com/xingzoudefengye/dsh-resume-budget) — 续聊预算。

## 许可

MIT，见 [LICENSE](LICENSE)。
