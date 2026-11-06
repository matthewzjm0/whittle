# Pipeline Studio

Run `npm run dev` from this project's root and open `http://localhost:3000/builder`. The root URL redirects here.

## Models

There are no default or preselected LLMs. **Add model** opens a short provider connection menu: choose OpenRouter, OpenAI, DeepSeek, or an OpenAI-compatible endpoint; enter its API key; then choose a model from the searchable list returned by `GET /models`. If the provider does not expose a model list, enter its model ID manually. Context size is filled from provider metadata when available, otherwise it defaults to 32K and can be changed under advanced settings. Optional input and output costs (USD per 1M tokens) can also be set there; existing saved Delegated workflows use them to rank models. Native Anthropic/Gemini APIs are not supported unless accessed through an OpenAI-compatible gateway.

Model and custom HTTP API keys remain in page memory. They are sent only to the app server and the endpoint you configure, and are excluded from local storage and exports. Re-enter keys after reloading the page. Chats, model metadata, custom block settings, and pipelines are saved unencrypted in this browser. Export a backup before clearing browser data; Import replaces the current workspace after confirmation.

Loopback model and custom HTTP endpoints, including local OpenAI-compatible servers, are disabled by default. On a trusted local server only, set `PIPELINE_ALLOW_LOOPBACK=true` before starting Next. For example, in PowerShell:

```powershell
$env:PIPELINE_ALLOW_LOOPBACK = 'true'
npm run dev --workspace=apps/web -- --hostname 127.0.0.1
```

This studio is a single-user local tool, not a hosted multi-user service. Do not expose a loopback-enabled app to an untrusted network. Production hosting needs authentication, authorization, and per-user storage first. Non-loopback private addresses, unsafe DNS results, and provider redirects are blocked.

## Pipelines

Create, name, duplicate, switch, save, and delete pipelines in the Pipeline editor. Draft edits are recovered from local storage, but you must click **Save** before a pipeline can run in Chat. Editing its graph or name, or an associated custom block definition, makes it unsaved again. Pipelines from older workspaces must be saved once because older versions did not record explicit saves. Model configuration and credentials remain shared workspace settings, not part of a pipeline snapshot.

Use **Generate pipeline from task** to describe a project, choose an orchestrator, optionally choose worker models, and set a **Series ↔ Parallel** preference. At 0, the planner must use sequential model steps. Higher settings encourage delegated workers and raise their generated cap up to 8; workers execute internally in parallel inside the delegated block, then the orchestrator reviews the synthesis. The selected model returns a strict bounded JSON plan; the app validates allowed model IDs and the graph before adding a draft pipeline. Review and save its prompts and connections before running it in Chat. This creates text-model workflows only; it does not browse or generate image files by itself. Keys are sent only through the existing pipeline API path and never added to the generated pipeline.

Open **Starter blueprints** in the library for four model-neutral workflows. Choose a model explicitly to create a separate saved pipeline, or use **Simulated preview** offline without registering or saving a demo model. The demo is not factual research and reports no real usage or billing. After real runs, block badges show client-observed cumulative elapsed time and highlight the slowest block. Expand **Last run** for reported cost/tokens and a numeric-only CSV download; unknown values are blank in CSV. Delegated model-call counts are Unknown because current run events do not report them. Statistics stay in page memory and are excluded from workspace exports.

Optional **Challenges** set maximum reported cost and model-call goals for the next run. The summary scores the proportion of satisfied goals, not answer quality. Missing measurements produce Unknown, and failed/stopped runs are not evaluated. Goals are captured at run start, remain in page memory, and do not enforce execution limits or cap provider billing.

Create reusable **Custom blocks** from the pipeline palette. A custom block can be a **Model step** with its own model and instructions; a **Text / template** transform; a **Number operation** (add, subtract, multiply, divide); an **HTTP API** request; or a **Cost so far** step. Add a saved block to a pipeline by clicking or dragging it. Edit a definition in the library and its placed instances use the updated definition.

Add a **Team** block from the library or canvas menu. The leader plans independent workers, assembles their results, and sends the draft to the **Validator model**; leaving the validator on “Use leader” reuses the coordinator. Workers are instructed to return only complete assigned deliverables, without extra explanation. Their requested output shares an 8,192-token budget per team run, and coordinator/validator requests are each capped at 8,192 tokens. The planner retries once with stricter JSON instructions if its worker plan is invalid. The validator statically reviews and corrects the assembled draft but cannot execute code or run tests. A run uses one planning call (plus at most one repair call), one per worker, one synthesis call, and one validation call.

Model, Team, and custom model block instances have a **Reasoning effort** setting: Provider default, Low, Medium, High, XHigh, or Max. Provider default sends no effort parameter and preserves existing workflows. A Team's setting applies to its planner, workers, synthesis, and validator. OpenRouter requests use `reasoning.effort`; other OpenAI-compatible endpoints receive `reasoning_effort`. Model and provider support varies: unsupported levels, particularly Max on non-OpenRouter endpoints, can be rejected or ignored. Reasoning tokens can increase cost and count against output limits, leaving less room for the final answer.

Model steps are useful for named tasks like Research, Fact check, and “Explain the progress so far,” but a prompt does not provide web access by itself. An HTTP block can call a JSON API such as a slide-generation service using GET/POST/PUT/PATCH/DELETE, templated JSON bodies, an optional response path, one credential header, and up to eight fixed request headers for APIs that require them (for example `Notion-Version: 2026-03-11`). Fixed headers are saved with the block and are visible in exports, so keep secrets in the API key field, which stays in memory only. Transport headers such as `Host`, `Content-Type`, `Content-Length`, `Cookie`, and `Authorization` cannot be overridden. The block never executes arbitrary code; only the configured endpoint is called. The destination must be HTTPS on a public host, or explicit loopback on a trusted local server. Private-network destinations, unsafe DNS results, and redirects are blocked. Many APIs requiring OAuth handshakes, request signing with computed signatures, file uploads, or non-JSON payloads are not directly supported.

The **Cost so far** block totals provider-reported per-call USD costs for model calls in the current run. If the provider does not return cost for every model call, it outputs Unknown rather than estimating from manual token rates. This is per-run cost, not the remaining OpenRouter account balance. To inspect account-level OpenRouter key usage, use an HTTP block against `https://openrouter.ai/api/v1/key` with an OpenRouter key; account usage is not the same as the current pipeline's cost.

Add blocks with a click or drag them from the library. Drag block headers to move them. Connect an output port to an input port with two clicks. One output port can connect to multiple inputs: the block runs once, then each connection forks an independent downstream branch with a copy of its value and variables. If branches reconverge, the shared downstream block runs once per arriving branch. Multiple terminal results are labeled and collected. Runs are bounded to 128 pending branches, 512 node executions, and 256 model calls. Delete a selected block or wire with Delete, Backspace, or the canvas Delete button.

The initial Start-to-Output pipeline passes the input through without a model call. Before a run, the app alerts when blocks are unreachable from Start, lists them, selects the first loose block, and asks you to remove or connect them; it never deletes them automatically. This also applies to pipeline-backed Chat runs. The workspace is a large scrollable canvas with zoom controls in the toolbar: use the − and + buttons, click the percentage to reset to 100%, or hold Ctrl (Cmd on macOS) and scroll to zoom at the pointer. Model blocks receive their instructions as a system message and the preceding value as a user message. Conditions compare literal case-sensitive text and follow one branch; no confidence is fabricated. Every reachable path must terminate at Output. Variables save and replace the current value using templates: `{{input}}`, `{{value}}`, or a previously named variable. Loops are rejected.

Settings include **Response detail** and **Output token reservation**. Minimal/Detailed adds a corresponding instruction to direct chat, pipeline model steps, and custom model steps. Auto (default) reserves up to 512 tokens for Minimal or 4096 for Detailed, clamped to the estimated remaining model context; the provider only generates what it needs up to that cap. Manual mode exposes the existing numeric reservation. The same numeric request field and server-side context/safety checks remain in use.

Run events show actual step outputs and provider-reported usage when available. While a run is active, the canvas follows the current block and highlights it; completed, failed, and stopped blocks keep distinct status badges. Arithmetic and templates are deterministic local steps; model and HTTP API blocks make network calls. Stop aborts the active request and prevents later steps; a provider may still bill work it already performed. Network calls time out after two minutes.

After a run, **Download as** defaults to Auto detect and offers PDF, DOCX, PPTX, XLSX, CSV, HTML, Markdown, TXT, JSON, SVG, and ZIP for structured file bundles; manual format selection remains available. Auto maps document specs/prose to DOCX, slide specs or multiple level-one Markdown headings to PPTX, sheet specs to XLSX, files specs to ZIP, one Markdown table to CSV, and multiple Markdown tables to XLSX. Everything is generated locally in the browser; no export content is uploaded. Headings start PPTX slides; markdown tables become XLSX sheets or a single CSV sheet. Without a table, spreadsheets use a one-column Content sheet. Formula-looking spreadsheet strings are prefixed with an apostrophe and remain literal text. HTML and SVG are escaped downloads only, never inline previews. Exports reject oversized content, unsupported layouts, recognized credentials, and configured in-memory keys with clear errors; no credential fields are sent to writer libraries. General limits are 131072 source characters, 512 KiB UTF-8 input, 256 blocks, 2048 lines, 8192 characters per line, and 4 MiB per generated file. Office limits are 32 slides (120 title / 2500 body characters plus layout fit), 8 sheets/tables, 1000 rows per sheet, 32 columns, 10000 total cells, and 2048 characters per cell. SVG is limited to 160 wrapped lines. CSV requires exactly one sheet. ZIP accepts 1-16 files, up to 4 MiB each and 16 MiB total. DOCX preserves Unicode; PDF still uses built-in WinAnsi fonts and warns when unsupported characters are replaced with `?`.

The embedded Unicode PDF option was evaluated and skipped: the full CJK font candidate is 17,772,300 bytes (about 16.95 MiB) before PDF generation, which is not a modest asset even when loaded on demand. PDF therefore keeps its explicit replacement warning rather than silently claiming Unicode support. Use DOCX or HTML when non-Latin text must be preserved.

### Structured Export

Click **Format for export** to copy instructions into a model block. If clipboard access fails, the same instructions appear in a read-only text box. Export detects an exact JSON specification or a whole `json` code fence; ordinary markdown and ordinary JSON remain text input. A root `exportVersion` or `kind` field opts into strict validation, so malformed specifications never silently fall back to markdown. No generated code is evaluated.

Supported root shapes (optional `title` is allowed on each):

```json
{"exportVersion":1,"kind":"document","title":"Report","blocks":[{"type":"heading","level":1,"text":"Overview"},{"type":"paragraph","text":"Answer"}]}
```

```json
{"exportVersion":1,"kind":"slides","slides":[{"title":"Overview","blocks":[{"type":"list","ordered":false,"items":["Point one"]}]}]}
```

```json
{"exportVersion":1,"kind":"sheets","sheets":[{"name":"Results","rows":[["Metric","Value"],["Count",3]]}]}
```

```json
{"exportVersion":1,"kind":"files","files":[{"name":"report.txt","format":"txt","content":{"exportVersion":1,"kind":"document","blocks":[{"type":"paragraph","text":"Answer"}]}}]}
```

Document blocks are exactly `heading` (`level` 1-6, `text`), `paragraph` (`text`), `list` (`ordered` boolean, nonempty text `items`), `code` (`text`, optional `language`), or `table` (`rows`). Slide bodies accept the same blocks except headings; use slide titles instead. Cells must be strings, finite numbers, booleans, or null, never formula/action objects. Sheets require unique safe names of 1-31 characters. Files require a name, one of the listed lowercase format identifiers (`md` means Markdown), and a non-files specification in `content`; raw binary payloads and recursive bundles are forbidden. Files manifests support **Download as ZIP** for a local bundle or **JSON** for the validated manifest. Single documents require a `files` specification before ZIP can be selected.

Unknown fields, duplicate decoded keys, prototype-sensitive keys, nonfinite numbers, unsupported controls, unpaired Unicode, excessive nesting, and invalid matrices are rejected before writing. JSON is bounded to 12 container levels, 20000 lexical nodes (including keys), and 10000 items per array. Declared blocks, cells, slides, sheets/tables, decoded text, and the 16-file cap apply across a whole specification, not separately to each member. Filenames are flat ASCII basenames of at most 80 characters, starting with a letter or digit, ending in the matching format extension; paths, percent escapes, hidden files, device names, doubled dots, spaces next to dots, trailing spaces/dots, and case-insensitive duplicates are rejected.

ZIP generation uses a dynamically loaded local writer and performs no uploads. It accepts 1-16 generated files, enforces the existing 4 MiB limit on each generated member, and caps aggregate uncompressed contents and the final ZIP at 16 MiB. Every member passes filename validation again before archiving. Duplicate names are rejected rather than overwritten, nested ZIP entries are not supported, and the same credential, formula-injection, markup-escaping, and format-specific layout checks apply to each member. Oversized bundles fail with an explicit error.

## Chat

Open **Chat**, create a conversation, choose **Direct model** or a saved pipeline under **Run with**, and send a prompt. The chat composer supplies pipeline input, and replies and download controls appear in the conversation. Pipeline chat passes the configured recent conversation turns as pipeline input and adds the conversation's system prompt to model steps and delegated coordinators/workers. Each conversation has independent logs, execution selection, a system prompt, and a recent-message limit. Context settings show the estimated next input, reserved output, model window, and an inspectable request preview. Older messages outside the explicitly selected history depth remain in the logs but are not sent. Oversized context is rejected instead of silently truncated.

Token estimates are conservative approximations, not a model-specific tokenizer. Actual input/output counts appear under replies when the provider returns them. Replies are displayed as plain text, preserving code and whitespace without executing model-generated HTML.

## Verification

```powershell
npm run pipeline:test --workspace=apps/web
npm exec --workspace=apps/web -- tsc --noEmit --incremental false
npm run lint --workspace=apps/web
npm run build --workspace=apps/web
```

Pipeline self-tests are offline and use an explicit loopback fixture, not a paid provider.
