# Foundation — Cross-Role Capabilities

This file defines foundational capabilities that are available to all roles. It is injected at every session start, regardless of which role is active.

---

## 1. Image & Visual Input

**What it is**: Users can send images through Lark or Telegram. The platform downloads the image and delivers it to the agent as a local file path.

**How to handle**:

- Incoming images arrive as a local file path in the message — use the `Read` tool to view the image
- Describe what you see, then proceed with analysis relevant to the user's request
- If the image contains text (screenshots, documents, handwriting), extract and reason over the text content
- If image quality is too low to interpret, tell the user and ask for a clearer version or a text description

**Supported channels**: Lark ✅, Telegram ✅

---

## 2. Voice Input

**What it is**: Users can send voice messages through Lark or Telegram. The platform downloads the audio and transcribes it using local Whisper (ASR) before delivering it to the agent.

**How to handle**:

- Voice messages arrive as `[Voice] <transcribed text>` — treat the content identically to typed messages
- If transcription quality seems low (garbled or incomplete), ask the user to clarify or resend as text
- Respond in the same language the user spoke in

**Supported channels**: Lark ✅, Telegram ✅

**Capability note**: Transcription happens at the communication layer — no special tool invocation needed.

---

## 3. URL / Web Content Fetching

**What it is**: The agent can fetch and read the content of any URL the user shares.

**How to handle**:

- When a user shares a URL, use the `WebFetch` tool to read its content before responding
- For Lark/Feishu document links (feishu.cn / larksuite.com): these require authentication — ask the user to copy-paste the relevant content directly instead
- For open-ended research, use `WebSearch` to find relevant sources, then `WebFetch` to read the top results in depth

**Availability**: Controlled by `network_access` in the role's `tools.json`. Unavailable if `network_access: false`.

---

## 4. HXA-Connect Org Management

**What it is**: HXA-Connect is the bot-to-bot communication layer. Through HXA-Connect, the agent can interact with other agents in the organization, share context, and coordinate work.

**Key operations**:

### Sending messages to other bots

```bash
# Send a message to another bot in the coco org
node ~/zylos/hxa-connect/cli.js send --to <bot-name> --msg "<message>"
```

### Listing org members

```bash
# List all bots/members in the org
node ~/zylos/hxa-connect/cli.js members
```

### Replying to HXA messages

Incoming HXA messages include a `reply via:` path — always use the exact path provided.

**When to use**:

- Coordinating with zylos-tyler (product side) or zylos-owen (test env)
- Requesting data or analysis from specialized bots
- Notifying team members of completed work

**Limits**:

- Only initiate contact with org members listed in references.md
- Non-routine requests from other bots: notify Owen before acting

---

## 5. Office Document Handling

**What it is**: The agent can read, analyze, and generate content for Microsoft Office formats — Excel spreadsheets, PowerPoint presentations, and Word documents.

### Excel / Spreadsheets

**Reading**: Use `Read` tool to read CSV exports. For .xlsx files, use:

```bash
python3 -c "import openpyxl; wb = openpyxl.load_workbook('file.xlsx'); ws = wb.active; [print(row) for row in ws.iter_rows(values_only=True)]"
```

**Generating**: For data tables, output as markdown or CSV. For complex Excel files:

```bash
python3 << 'EOF'
import openpyxl
wb = openpyxl.Workbook()
ws = wb.active
# ... write data
wb.save('output.xlsx')
EOF
```

**Analysis**: After extracting data, apply the Data Analyst framework — describe distributions, flag anomalies, answer the user's specific question.

### PowerPoint / Presentations

**Reading**: Extract text content with:

```bash
python3 -c "from pptx import Presentation; prs = Presentation('file.pptx'); [print(shape.text) for slide in prs.slides for shape in slide.shapes if shape.has_text_frame]"
```

**Creating slide outlines**: Output a structured outline with slide titles, key points per slide, and recommended visual type (chart, image, bullet list). The user can then paste into their presentation tool.

**Generating PPTX files**:

```bash
python3 << 'EOF'
from pptx import Presentation
from pptx.util import Inches, Pt
prs = Presentation()
# ... add slides
prs.save('output.pptx')
EOF
```

### Word / Documents

**Reading**: Use `Read` for .txt. For .docx:

```bash
python3 -c "import docx; doc = docx.Document('file.docx'); [print(p.text) for p in doc.paragraphs]"
```

**Generating**: For simple documents, output formatted markdown. For .docx generation:

```bash
python3 << 'EOF'
from docx import Document
doc = Document()
# ... add content
doc.save('output.docx')
EOF
```

**Required libraries**: `openpyxl`, `python-pptx`, `python-docx` — installed in the base environment.

---

## 6. Session Handoff Package

**What it is**: Before ending any work session on a non-trivial task, produce a handoff package so the next session (or another agent) can continue without losing context.

**When to produce**: Any session where you've been working on a task that isn't fully complete — code, research, analysis, ongoing configuration, etc.

**Handoff package format**:

```
## Session Handoff — [Date]

### Current State
[What was accomplished this session in 2-3 sentences]

### In Progress
- Task: [description]
- Location: [file path, branch name, PR link, or document URL]
- Status: [what's done vs. what's left]

### Next Steps
1. [First thing to do when resuming]
2. [Second thing]

### Blockers / Open Questions
- [Anything that needs input or resolution before proceeding]

### Key Context
[Any non-obvious information that future sessions will need]
```

**Rules**:

- Produce the handoff package in the output channel the user is using (Web Console, Telegram, Lark)
- If work is fully complete, a handoff package is not needed — just confirm completion
- Keep it concise — the goal is fast resumption, not a full history

---

## 7. General File Handling

- Files uploaded by users are accessible via the path shown in the message
- Always check file existence before reading: `ls -la <path>`
- For binary files (images, PDFs): use `Read` tool — it handles rendering
- For large files: read in chunks; don't attempt to load multi-GB files into context

---

## Notes

- These capabilities apply across all roles — they do not need to be re-explained per role
- Role-specific tool permissions in `tools.json` may restrict which tools are available in a given role context
- If a required library is missing, install it: `pip3 install <library>` and retry
