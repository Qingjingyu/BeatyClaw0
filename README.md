# Zylos — 持久化 AI 智能体平台

Zylos 是一个运行在云服务器上的 **自主 AI 智能体**。它不是一个一次性的问答机器人，而是一个能持久记忆、自主调度、多通道通讯的 AI 工作伙伴。每次对话都建立在之前的基础上，能真正帮你持续推进工作。

## 核心特点

- **持久记忆** — 记住你说过的每件事，跨会话保持上下文
- **多通道通讯** — 支持微信、企业微信、Web 控制台等多个渠道同时在线
- **自主调度** — 可以设定定时任务，到点自动执行，不需要你来提醒
- **多角色切换** — 内置 15 个专家角色，按需切换不同能力
- **24 小时在线** — 自动健康监控和故障恢复，持续运行不间断
- **安全防护** — 凭证加密存储，敏感信息自动隔离

---

## 目录结构

```
~/zylos/
├── .claude/                    # Claude 运行时配置与技能
│   ├── settings.json           # Claude Code 权限和配置
│   └── skills/                 # 技能模块（详见下方）
│
├── capabilities/               # 专家角色定义（详见下方）
│   ├── general-assistant/      # 通用助手
│   ├── code-review/            # 代码审查专家
│   ├── data-analyst/           # 数据分析师
│   ├── product-manager/        # 产品经理
│   ├── ... (共 15 个)
│   └── role-manager/           # 角色切换管理器
│
├── components/                 # 通讯组件运行时数据
│   ├── wechat/                 # 微信通道配置与账号数据
│   └── wecom/                  # 企业微信通道配置
│
├── memory/                     # 持久记忆系统
│   ├── identity.md             # 身份定义（性格、原则）
│   ├── state.md                # 当前工作状态
│   ├── references.md           # 配置索引和指针
│   ├── active-role.md          # 当前激活的角色
│   ├── foundation.md           # 基础能力定义
│   ├── reference/              # 长期参考信息
│   │   ├── decisions.md        # 已做的决策记录
│   │   ├── projects.md         # 项目跟踪
│   │   ├── preferences.md      # 团队偏好设置
│   │   └── ideas.md            # 想法与探索
│   ├── sessions/               # 会话记录
│   ├── users/                  # 用户档案（每人一个文件）
│   └── archive/                # 历史归档
│
├── comm-bridge/                # C4 通讯桥数据库
│   └── c4.db                   # 消息队列数据库
│
├── scheduler/                  # C5 任务调度器数据
│   └── scheduler.db            # 定时任务数据库
│
├── activity-monitor/           # 活动监控运行时状态
│
├── http/                       # HTTP 服务
│   └── public/                 # 可公开访问的文件
│
├── workspace/                  # 工作区（克隆的仓库、实验、临时文件）
│
├── bin/                        # 工具脚本
│   └── transcribe              # 语音转文字入口
│
├── pm2/                        # PM2 服务配置
│   └── ecosystem.config.cjs    # 所有 PM2 服务的统一配置
│
├── external/                   # 外部代码备份
│   ├── ops-agent/              # 运维代理（编译后的代码快照）
│   └── coco/                   # 平台层脚本快照
│
├── logs/                       # 日志目录
├── ZYLOS.md                    # 核心指令文件（运行时无关）
├── CLAUDE.md                   # Claude Code 运行时指令（自动生成）
├── .env                        # 环境变量（密钥、配置，不入 Git）
└── .gitignore                  # Git 排除规则
```

---

## 技能模块 (Skills)

技能模块是 Zylos 的"能力引擎"，位于 `.claude/skills/` 目录下。每个技能由代码脚本和 SKILL.md 说明文件组成。

| 技能 | 代码量 | 作用 |
|------|--------|------|
| **activity-monitor** | 11,830 行 | 守护进程，监控 AI 运行状态，异常时自动重启 |
| **comm-bridge** | 5,409 行 | C4 通讯桥 — 所有外部消息的收发中枢 |
| **wechat** | 5,471 行 | 微信通讯通道，支持私聊和多账号管理 |
| **wecom** | 4,291 行 | 企业微信通讯通道，WebSocket 长连接模式 |
| **scheduler** | 2,941 行 | C5 任务调度器，支持定时、循环、延迟任务 |
| **web-console** | 963 行 | Web 管理控制台，浏览器直接与 AI 对话 |
| **zylos-memory** | 981 行 | 记忆同步系统，将对话内容整理存入记忆文件 |
| **http** | 143 行 | Caddy HTTP 服务，文件共享和健康检查 |
| **create-skill** | 311 行 | 技能脚手架，快速创建新技能模块 |
| **upgrade-claude** | 132 行 | Claude Code 升级工具 |
| **check-context** | — | 上下文/Token 用量检查 |
| **health-check** | — | 系统健康检查（PM2、磁盘、内存） |
| **new-session** | — | 上下文过满时切换新会话 |
| **restart-claude** | — | 重启 Claude Code |
| **shell** | — | CLI 交互模式通道 |
| **component-management** | — | 组件安装/升级/卸载指南 |
| **role-manager** | — | 角色切换管理 |

---

## 专家角色 (Capabilities)

Zylos 内置 15 个专家角色，每个角色有独立的系统提示词和模板。位于 `capabilities/` 目录下。

### 当前可用角色

| 角色 | 目录 | 能力描述 |
|------|------|----------|
| **通用助手** | `general-assistant/` | 默认角色。信息检索、文档处理、写作辅助、任务规划 |
| **代码审查专家** | `code-review/` | 发现真正的 bug、安全漏洞和架构问题，不纠结代码风格 |
| **数据分析师** | `data-analyst/` | 数据清洗、探索性分析、统计检验、可视化建议 |
| **产品经理** | `product-manager/` | PRD 撰写、用户故事、路线图规划、需求优先级排序 |
| **研究分析师** | `research-analyst/` | 多源深度研究，信噪分离，结构化研究报告 |
| **财务分析师** | `financial-analyst/` | 财务报表分析、比率分析、趋势判断、投资建议 |
| **竞品分析师** | `competitive-intelligence/` | 竞争对手动态监控，可执行的情报报告 |
| **合同审查专家** | `contract-review/` | 法律风险识别、不利条款预警、合同审查 |
| **文档分析助手** | `document-analysis/` | 上传文件即刻分析 — 合同、报告、论文、财报 |
| **招聘助手** | `recruitment/` | 职位描述撰写、简历筛选评估、人才市场调研 |
| **社交媒体专家** | `social-media/` | 小红书/微博/公众号/抖音/LinkedIn 内容策略与创作 |
| **SEO 策略师** | `seo-strategist/` | 技术 SEO、内容策略、关键词分析、竞品 SEO 对比 |
| **技术研究员** | `tech-researcher/` | 技术选型评估、框架对比、API 调研、实施方案 |
| **角色管理器** | `role-manager/` | 管理和切换上述所有角色 |
| **基础能力** | `foundation/` | 跨角色共享的基础能力定义（图片识别、语音输入等） |

### 如何切换角色

角色通过 `role-manager` 管理。每个角色包含：
- `system-prompt.md` — 角色的系统提示词（定义角色身份和行为）
- `templates/` — 该角色专用的输出模板（如 PRD 模板、研究报告模板等）

当前激活的角色记录在 `memory/active-role.md` 中。

---

## 记忆系统 (Memory)

受电影《头脑特工队》(Inside Out) 启发设计，分层存储：

| 层级 | 文件 | 用途 | 加载时机 |
|------|------|------|----------|
| **身份** | `identity.md` | 性格、原则、数字资产 | 每次启动 |
| **状态** | `state.md` | 当前工作、待办任务 | 每次启动 |
| **索引** | `references.md` | 配置文件路径、服务信息 | 每次启动 |
| **用户档案** | `users/<id>/profile.md` | 每个用户的偏好和信息 | 按需加载 |
| **参考资料** | `reference/*.md` | 决策记录、项目跟踪、偏好、想法 | 按需加载 |
| **会话** | `sessions/current.md` | 当天事件日志 | 按需加载 |
| **归档** | `archive/` | 历史数据冷存储 | 极少使用 |

记忆会在对话中实时更新，并通过 Memory Sync 机制定期整理和归档。

---

## 运行服务

Zylos 通过 PM2 管理 5 个常驻服务：

| 服务 | 作用 | 内存占用 |
|------|------|----------|
| `scheduler` | 定时任务调度守护进程 | ~82MB |
| `web-console` | Web 管理控制台 | ~79MB |
| `c4-dispatcher` | C4 消息分发守护进程 | ~67MB |
| `activity-monitor` | AI 活动状态监控 | ~76MB |
| `ops-agent` | 运维健康检测代理 | ~73MB |

常用管理命令：
```bash
zylos status          # 查看所有服务状态
zylos start           # 启动所有服务
zylos stop            # 停止所有服务
zylos restart         # 重启所有服务
zylos logs <service>  # 查看某个服务的日志
```

---

## 外部代码备份 (external/)

为防止文件丢失，以下外部代码已备份到仓库中：

### ops-agent（运维代理）
- 位置：`external/ops-agent/`
- 作用：VM 级别的健康检测和自动修复
- 功能：凭证检测、运行时监控、资源监控、通道健康检查、L1 自愈、心跳上报
- 注意：这是从 TypeScript 编译后的代码，原始源码不在服务器上

### coco 平台层
- 位置：`external/coco/`
- 作用：底层平台管理脚本
- 包含：启动引导 (bootstrap)、Token 轮换、凭证同步、语音转文字 (ASR)、日志上报、能力注册

---

## 技术栈

- **运行时**: Node.js v22 (ES Modules)
- **AI 引擎**: Claude Opus 4.6 (Anthropic)
- **进程管理**: PM2
- **数据库**: SQLite（消息队列和调度器）
- **HTTP**: Caddy（反向代理 + 自动 HTTPS）
- **通讯协议**: WebSocket (企业微信)、HTTP 轮询 (微信)
- **语音识别**: Whisper (本地 ASR)
- **服务器**: GCP, 4 核 AMD EPYC, 16GB RAM, 58GB SSD

---

## 快速开始

### 与 Zylos 对话
- **微信**: 添加绑定的微信账号，直接发消息
- **企业微信**: 在企业微信中找到机器人，发送消息
- **Web 控制台**: 通过浏览器访问 Web 控制台界面
- **命令行**: 运行 `zylos shell` 进入交互模式

### 开发与修改
```bash
# 查看代码变更
git diff

# 提交修改
git add <file>
git commit -m "描述你的改动"

# 推送到 GitHub
git push origin main

# 创建新技能
# 在对话中输入 /create-skill <名称>
```

---

## 安全说明

- `.env` 文件包含所有密钥和 Token，**不会被 Git 追踪**
- 数据库文件 (`.db`) 和日志 (`.log`) 也不入 Git
- 微信账号凭证和登录会话数据被排除
- 只有仓库所有者才能通过私聊获取敏感信息

---

## 项目状态

- **版本**: v0 (初始基线)
- **代码量**: 550 个文件，65,657 行
- **状态**: 生产运行中，持续开发
