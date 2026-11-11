# 05 · API 契约

| 项 | 值 |
|---|---|
| 状态 | 设计稿，未实施 |
| 关联 | [01 架构](01-architecture.md)（ADR-01 / ADR-05） · [03 解析协议](03-source-documents.md) · [04 一致性](04-consistency.md) |

## 1. 定位与铁律

API 是**录入编排层与查询层**，不是数据真源。

> **铁律：任何写入请求都不能直接 `INSERT` / `UPDATE` 派生表。**
> 所有写入最终必须落到「写 Markdown 文件 → git commit → 解析重建」这条链路，数据库只由 splitter 派生。

这条约束保证 [04](04-consistency.md) 的「单一写入口」成立。若某天为了实时性绕过它直接写库，就会重新引入双真源，整套 hash 校验随之失效。

技术栈建议与站点同栈：Node + Hono/Fastify + `better-sqlite3`；若更想复用现有 Python 脚本生态，FastAPI + SQLAlchemy 同样可行。SQL 方言约束见 [02](02-data-model.md) §6。

## 2. 两种录入入口

| 入口 | 适用 | 服务端行为 |
|---|---|---|
| **A · 原文入口** `POST /api/source-documents` | agent、Markdown 编辑器、历史批量导入 | 接收完整 md 文本 → 写文件 → commit → 重建 |
| **B · 结构化入口** `POST /api/attempts:batch` | 表单、移动端快速录入判定表与错因 | 按 [03](03-source-documents.md) 的模板**渲染成 Markdown** 追加到对应 `answer*.md` → commit → 重建 |

入口 B 不是「直接写库」：它只是把结构化输入翻译成符合现有约定的 Markdown，真源仍是文件。这样录入者不必在网页里手写 LaTeX，agent 也不必改变工作方式。

实现顺序建议：先做 A（与现有工作流几乎一致），B 放到 P3 之后。

## 3. 端点清单

### 3.1 源文件与重建

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 存活检查 |
| `POST` | `/api/source-documents` | 提交 md 全文（入口 A）；body 含 `path` / `content` / `kind` / `client_request_id` |
| `PUT` | `/api/source-documents/{file_id}` | 更新已有文件；`documents.version + 1`，前后 hash 由 `snapshots` 记录 |
| `GET` | `/api/source-documents/{file_id}/raw` | 返回原文 + `content_sha256` + `current_path` |
| `GET` | `/api/source-documents` | 列出注册表，可按 `kind` / `stale` 过滤 |
| `POST` | `/api/attempts:batch` | 结构化录入（入口 B） |
| `POST` | `/api/rebuild` | 触发重建；可选 `git_commit` / `force`；返回 `snapshot_id` |
| `GET` | `/api/status` | 当前 `snapshot_id`、`parser_version`、stale 文件数、落后 commit 数、最近一次校验结果 |

### 3.2 查询（取代 `scripts/query.py`）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/questions` | 支持 `topic` / `topicId` / `volume` / `errorTag` / `redo` / `question` / `csv` |
| `GET` | `/api/questions/{id}` | 含 `source_anchor` 原文回链、知识点路径、`origin` |
| `GET` | `/api/sessions` | 按日期 / 卷 / `timingMode` 过滤 |
| `GET` | `/api/attempts` | 按题目 / 场次 / 日期 / 判定 / `isRedo` 过滤 |
| `GET` | `/api/diagnoses` | 按错因标签、销账状态、待重做状态过滤 |
| `GET` | `/api/blocks?kind=insight` | 跨题归纳与口诀，按 `topicId` / `questionId` 过滤 |
| `GET` | `/api/redo-queue` | 待重做台账与重做记录（`redo_queue` 视图） |

所有查询结果必须带 `source_file_id` + `source_anchor`，**结论仍可回原文核验**——这是原 `question-bank.md` 的核心约定，不因换成数据库而取消。

### 3.3 导出、校验与运维

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/export/index.json` | 同格式导出，供站点构建；响应头带 `X-Snapshot-Id` |
| `GET` | `/api/export/volumes.json` | 同格式卷配置，站点卷清单仍从它派生 |
| `GET` | `/api/export/markdown` | 打包只读 md（带 `generated from snapshot <hash>` 文件头） |
| `POST` | `/api/validate` | 跑 L1 / L2 / L3，返回 report id |
| `GET` | `/api/validation-reports/{id}` | 校验明细与 `issues_json` |
| `GET` | `/api/snapshots` | 快照历史，支持按 `snapshot_id` 回溯 |
| `POST` | `/api/overrides` | 登记人工覆写（需 `reason` + `verified_by`） |

## 4. 幂等与冲突

| 键 | 语义 |
|---|---|
| `client_request_id` | 客户端生成的请求 ID；重复请求返回首次结果，不重复写文件 |
| `(file_id, content_sha256)` | 内容完全相同 → 直接返回既有 `snapshot_id`，不触发重建 |
| `(session_id, question_id)` | 防止一次批改重复上传生成两条 attempt |

冲突响应统一 `409`，body 带 `conflict_type`：`DUPLICATE_REQUEST` / `REBUILD_IN_PROGRESS` / `GIT_NON_FAST_FORWARD` / `STALE_SNAPSHOT`。git 无法快进时**拒绝并要求 rebase**，不静默覆盖。

## 5. 鉴权

- 公网部署（`geyuqi.me`）一律 HTTPS + API Token（请求头 `Authorization: Bearer <token>`），写接口必须鉴权；读接口可按需要公开。
- 本地开发可关闭鉴权，但配置必须显式写明 `AUTH_DISABLED=true`，避免误带到生产。
- P0–P3 **不引入账号系统、角色权限、多用户隔离**（见 [01](01-architecture.md) §5）。

## 6. 状态机

```text
                  ┌──────────────────────────────┐
                  │                              ▼
pending → committed → rebuilding → consistent ──→ (下一次提交)
              │            │
              │            ├── stale   （hash 不匹配 / 重建未完成）
              │            └── failed  （L1/L2/L3 不通过，库保持上一状态）
              └── rejected （鉴权失败 / 冲突 / 无法快进）
```

`GET /api/status` 是唯一的状态出口，站点发布闸门与运维都读它，不各自判断。

## 7. 错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | `INVALID_MARKDOWN` | front-matter 或结构不符合 [03](03-source-documents.md) 约定 |
| 401 | `UNAUTHORIZED` | Token 缺失或无效 |
| 404 | `FILE_NOT_FOUND` / `QUESTION_NOT_FOUND` | 注册表或题目不存在 |
| 409 | `DUPLICATE_REQUEST` / `REBUILD_IN_PROGRESS` / `GIT_NON_FAST_FORWARD` / `STALE_SNAPSHOT` | 见 §4 |
| 422 | `VALIDATION_FAILED` | 校验不通过，body 带 report id 与 issues |
| 500 | `REBUILD_FAILED` | 重建事务回滚，库保持上一一致状态 |

## 8. 导出契约（站点零改动的关键）

`GET /api/export/index.json` 产出的 JSON **结构完全不变**：顶层仍为 `meta` / `knowledgeTree` / `questions` / `sessions` / `attempts`，字段名、类型、枚举值与 `mem/data/index.json` 一致。

只**新增**三个 `meta` 字段，不修改任何既有字段：

```json
{
  "meta": {
    "generatedAt": "...",
    "generator": "mem_new/api",
    "sourceFiles": 56,
    "coverage": { "questions": 328, "attempts": 317, "sessions": 40, "redoRows": 12 },
    "timing": { "session": 23, "per-question": 0, "mixed": 1, "none": 16 },
    "errors": [],
    "snapshotId": "sha256:...",
    "parserVersion": "20261111.1",
    "sourceCommit": "ad4f3ff"
  }
}
```

站点 `scripts/build/index.mjs` 只读 `questions` / `attempts` / `knowledgeTree`，新增 `meta` 字段无副作用；卷清单仍从 `volumes.json` 派生，因此 `GET /api/export/volumes.json` 也需提供同格式文件。

## 9. 非目标

- 不做录入 UI / CMS（P0–P3）。
- 不做账号、角色、多租户。
- 不做实时推送 / WebSocket；一致性状态靠轮询 `GET /api/status`。
- 不提供直接修改派生表的写接口（见 §1 铁律）。
- 不改变站点现有的静态构建与 5 分钟部署节奏。
