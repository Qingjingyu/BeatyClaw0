# Preset Agent Capabilities

This directory defines all pre-installed capabilities for coco Agents. Capabilities are organized in two layers:

## Two-Layer Architecture

### Layer 1 — General Software Skills (Foundation)

Platform-level capabilities that every Agent has, regardless of role. These are universal inputs/outputs and cross-role behaviors:

| Capability                                     | Status       | Notes                                                      |
| ---------------------------------------------- | ------------ | ---------------------------------------------------------- |
| Image/visual input (Lark, Telegram)            | ✅ Supported | Platform downloads image, agent reads via `Read` tool      |
| File input (PDF, Word, Excel, PPTX)            | ✅ Supported | Delivered as local path; agent reads directly              |
| URL/web content fetching                       | ✅ Supported | `WebFetch` — respects role `network_access` setting        |
| Office document generation (Excel, PPTX, DOCX) | ✅ Supported | Via python-pptx / openpyxl / python-docx                   |
| Voice input (Lark, Telegram)                   | ✅ Supported | Local Whisper ASR; arrives as `[Voice] <text>`             |
| Bot-to-bot coordination (HXA-Connect)          | ✅ Supported | Cross-agent org communication                              |
| Scheduled task dispatch                        | ✅ Supported | C5 Scheduler; controlled per role via `requires_scheduler` |
| Session handoff                                | ✅ Supported | Structured handoff package before session end              |

Defined in: [`foundation/foundation.md`](./foundation/foundation.md)

### Layer 2 — Professional / Industry Role Skills

Pre-installed role bundles that users activate to apply specialized expertise. Each role defines:

- A system prompt with domain-specific knowledge, SOPs, and output frameworks
- Tool permissions (`tools.json`) — which capabilities the role is allowed to use
- Quick Start templates for common tasks
- Initial memory configuration

**Current roles (13):**

| Role                       | Focus                                            | Scheduled |
| -------------------------- | ------------------------------------------------ | --------- |
| `general-assistant`        | All-purpose, full capabilities                   | —         |
| `competitive-intelligence` | Competitor monitoring + weekly reports           | ✅        |
| `social-media`             | Chinese social platform content creation         | ✅        |
| `recruitment`              | Resume parsing, JD writing, salary research      | —         |
| `document-analysis`        | Document extraction + cross-validation           | —         |
| `code-review`              | Bug detection, security review, code quality     | —         |
| `contract-review`          | Legal risk identification, contract analysis     | —         |
| `financial-analyst`        | Financial statement analysis, ratio modeling     | —         |
| `seo-strategist`           | Keyword strategy, SERP analysis, content briefs  | —         |
| `data-analyst`             | EDA, statistical testing, Python/pandas analysis | —         |
| `product-manager`          | PRD writing, feature prioritization, roadmapping | —         |
| `research-analyst`         | Deep multi-source research with citations        | —         |
| `tech-researcher`          | Technology evaluation, trade-off analysis        | —         |

Role definitions: `<role-id>/system-prompt.md` + `<role-id>/tools.json`
Role index: [`registry.json`](./registry.json)

## Directory Structure

```
capabilities/
├── README.md               # This file — architecture overview
├── registry.json           # Role index (names, icons, metadata)
├── foundation/             # Layer 1: cross-role capabilities
│   ├── foundation.md       # Injected at every session start
│   └── templates/          # Reusable prompt fragments
├── <role-id>/              # Layer 2: one directory per role
│   ├── system-prompt.md    # Role identity, SOP, output formats
│   ├── tools.json          # Tool permissions for this role
│   ├── memory-init.json    # Initial memory scaffold
│   └── templates/          # Role-specific Quick Start templates
└── role-manager/           # Role activation / switching scripts
```

## Adding a New Role

1. Create `<role-id>/` directory with `system-prompt.md`, `tools.json`, and `memory-init.json`
2. Add an entry to `registry.json`
3. Add Quick Start templates in `<role-id>/templates/` if applicable
4. Golden image rebuild required to deploy to live VMs
