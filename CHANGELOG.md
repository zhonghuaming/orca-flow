# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-11-26

### 原生迁移

- 新独立插件 `zhonghuaming.flow-native`，中文显示名 Orca Flow。
- 移除供应商账号、登录、额度与 agy 启动链路，去掉自由 CLI flags 和私有团队队列。
- 改为四个已有 Orca 原生 Bot：产品、架构、开发、测试；不创建机器人，不修改权限。
- 保留中文敏捷看板、迭代、史诗、关联任务和工作流目标/模板；新存储与旧插件隔离。
- 使用原生消息回执、Run 和依赖任务查询，不以投递成功或 Bot 空闲冒充任务完成。
- 加入启动去重、未知投递不重放、冻结工作区核对、IPC 校验及假 CLI/面板离线回归。

以下为上游历史版本记录，不代表当前运行功能。

## [1.1.0] - 2026-11-24

### Added

- **Beginner-friendly "Start Here" onboarding tab**: Live 3-step readiness checklist (Orca Workspace detection, Antigravity account sign-in status with 1-click **Sign In Now**, and Team Mode selector), **1-Click Starter Missions** (*Launch Sprint Team*, *Launch Hotfix*, *Launch Spike*), a header quick-jump button, and a built-in **New to Orca? Quick Guide** glossary.
- **Dual team execution modes & goal-driven workflow launches**:
  - **Auto Agent Team (`auto-agents`, 100% Automatic)**: Spawns isolated `agy` persona terminals with a shared coordination room (`GOAL.md`, `ROSTER.md`, `THREAD.md`, live `PEERS.json` containing spawned terminal IDs, per-step `inbox/<step>.md`, and a zero-dependency `team-chat.mjs` CLI) so personas automatically discuss, question, and hand off work to each other via shared thread/inboxes and `orca orchestration send`.
  - **Orca Bots Team (`orca-bots`, Semi-Auto)**: Discovers local Orca Bots from `~/.orca/bots/*/bot.json` and `SOUL.md` (`bots.list`), supports explicit per-step bot mapping or automatic round-robin assignment across available local bots by default, dispatches personalized peer-to-peer handoffs (`orca orchestration send --to bot:<name>`), and includes ready-to-run `orca bot create --offer` commands when dedicated persona bots do not exist yet.
  - **Mission Goal Targets**: Target a full **Sprint**, **Epic**, **Single Work Item**, or **General Mission** with optional *Definition of Done* instructions before launching.
- **Real-time Agent-to-Board status synchronization**:
  - Subscribed to Orca's `agent.status.changed` event and added `agent:read` + `terminal:read` capabilities in `orca-plugin.json`.
  - Automatically links spawned work-item and workflow terminals to Agile Board work items and maps live terminal states + output tails (`working` -> `In Progress`, `waiting`/`blocked` or review requests -> `In Review`, clean `done` -> `Done`), with desktop notifications on `In Review` and `Done`.
  - Added explicit agent self-reporting (`node team-chat.mjs board --item <id> --status ...`) and an on-demand **Sync Agents** button (`board.syncFromAgents`) on the Agile Board header.

### Changed

- Simplified Startup Workflows labels, descriptions, and beginner guidance callout for newcomers to Orca, and removed unsupported `padding`/`style` props from declarative UI layout components.
- Updated `README.md` with the Quick Start guide, dual execution modes, default agent/bot communication, real-time board sync, and automatic OAuth email sync.

### Fixed

- Fixed mismatched/stale account emails in **Configured Accounts** by replacing racy concurrent per-account storage writes in `fetchAccountQuota` with an atomic `syncAccountsEmailsFromAuth()` reconciliation run on `accounts.list` and `quota.getAccountQuota`, clearing stale emails on unsigned accounts, and displaying the verified email badge on each **Configured Accounts** card.

## [1.0.2] - 2026-11-24

### Added

- Sprint deletion in both the **Agile Board** and **Roadmap & Sprints** tabs with inline confirmation, allowing users to move a sprint's work items and epic `targetSprintId` links to another sprint or delete them with the sprint (`board.deleteSprint`, documented in `README.md`).
- Cover image banner (`assets/cover.png`) in `README.md`.

### Fixed

- Omitted `undefined` fields from JSON IPC payloads (workflow execution and saving, work-item creation and summoning, and sprint/epic saving) and worker activity/usage records so requests pass Orca's strict JSON schema validation.
- Clamped terminal titles to Orca's 512-character limit across direct summons, Google sign-in, workflow steps, and Agile task launches.
- Prevented default starter sprints from re-seeding automatically after all sprints are deleted.
- Made `workspaceId` optional in `workflows.execute` to match automatic active-workspace resolution, validated `workflowId`, and synchronized panel sprint selection and confirmation state whenever sprints change or are deleted.

## [1.0.1] - 2026-11-23

### Changed

- Bumped the `orca-plugin.json` manifest version from `1.0.0` to `1.0.1` with no code, documentation, or asset changes.

## [1.0.0] - 2026-11-23

Initial release of Antigravity Flow, an Orca sidebar plugin for Agile sprint planning, multi-agent startup workflows, isolated Antigravity CLI accounts, and live token quota monitoring.

### Added

- **Orca plugin and sidebar panel**: Manifest v2 `trusted-worker` plugin (`antigravity-flow`, Orca `>=1.4.248`, MIT) contributing the right-sidebar **Antigravity Flow** panel (*Agile Board*, *Roadmap & Sprints*, *Startup Workflows*, *Accounts & Personas*, and *Usage & Quota* tabs), the `Antigravity: Open Antigravity Flow` command (`antigravity.openFlow`), live `workspace.changed` tracking, and `accountsBaseDir` and `agyCommand` settings.
- **Agile Board and Workspace Board integration**: Four Kanban lanes synced 1:1 with Orca (`Todo`, `In Progress`, `In Review`, and `Done`), lane filters, one-click lane transitions, work-item CRUD with story points and assignments, a one-click native **Workspace Board** launcher, and **Run with Agent** to launch `agy` with sprint, epic, and persona markdown context while moving `todo` items to `in-progress`.
- **Roadmap and Sprints lifecycle**: Strategic Epics CRUD with story-point velocity progress bars, sprint creation with goals, dates, and target points, **Complete Sprint** with unfinished-task rollover, and pre-seeded starter sprints, epics, and work items.
- **Multi-agent startup workflows**: Built-in pipelines (*Agile Sprint: Feature Epic Delivery*, *Agile Hotfix: Rapid Bugfix & Patch*, and *Agile Spike: Architecture & Tech Evaluation*) plus custom multi-step workflow creation, deletion, and execution.
- **Isolated accounts, personas, and CLI summoning**: Per-account isolated `HOME` and `GEMINI_HOME` directories (`~/.gemini-accounts/<id>/`), headless OAuth fallback flags, an interactive Google sign-in terminal, direct `agy` summoning with markdown prompts, dynamic CLI flags (`--dangerously-skip-permissions` toggle and custom flags), optional non-destructive symlinking of host global skills, and five pre-seeded plus custom personas synced to `AGENTS.md` and `PERSONA.md`.
- **Live token quota and feature usage monitoring**: Zero-cost quota checks via `agy -p /usage --output-format json` covering 5-hour and weekly limits across Gemini and Claude/GPT buckets with color-coded badges and auth/email auto-detection, per-account and team usage analytics (summons, workflow steps, completed tasks and story points, symlink-excluded disk usage, and session counts), a chronological activity stream, and history reset.

[Unreleased]: https://github.com/mqnoy/orca-antigravity-flow/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/mqnoy/orca-antigravity-flow/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/mqnoy/orca-antigravity-flow/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/mqnoy/orca-antigravity-flow/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/mqnoy/orca-antigravity-flow/releases/tag/v1.0.0
