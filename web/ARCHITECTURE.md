# Web app architecture map

This is a contributor map, not a product guide. For setup and user-facing behavior, see the root `README.md` and [`PIPELINE.md`](./PIPELINE.md).

## Main flow

- `app/builder/` renders the client-side app. `components/pipeline/PipelineStudio.tsx` is currently the top-level coordinator for editor, chat, persistence, execution, file attachment, and dialogs. Keep it as the owner of shared state unless a refactor establishes a smaller, tested boundary.
- `components/pipeline/studio-state.ts` defines workspace and conversation data, local-storage serialization/restoration, credential stripping, and chat-input formatting. The storage key and migrations are compatibility-sensitive.
- `components/pipeline/PipelineCanvas.tsx` renders and edits the graph. Supporting UI is in neighboring components; pure graph and execution logic belongs in `lib/pipeline/`.
- Chat can call a model directly or use a selected **saved** pipeline. A pipeline chat request formats the conversation into pipeline input; `components/pipeline/file-input.ts` extracts supported file text in the browser and puts it in the draft. Attachments are not uploaded until the user sends the message. `components/pipeline/ChatMessageList.tsx` isolates message-history rendering and output exports; orchestration remains in `PipelineStudio.tsx`.
- `app/api/pipeline/route.ts` is the thin Node.js route. `lib/pipeline/http.ts` validates requests and handles model discovery, direct chat, and streamed pipeline execution. `lib/pipeline/runner.ts` executes the graph; provider/network adapters are in `lib/pipeline/provider.ts`.
- `components/pipeline/OutputExports.tsx` and `components/pipeline/file-export/` validate output specs and produce downloadable artifacts.

## Invariants to preserve

- Pipeline editing and chat are distinct sections. Chat executes a saved pipeline; do not silently run an unsaved editor graph.
- API keys are held in live client state and sent only in the relevant request. `studio-state.ts` deliberately omits keys during serialization and strips them during restore. Never add credentials to local storage, exports, logs, or test fixtures with real secrets.
- Pipeline requests pass through the same-origin, bounded-request validation in `lib/pipeline/http.ts` and `lib/pipeline/validation.ts`. Do not bypass these with direct provider calls from the browser.
- File extraction is local, but sent message text is conversation content: it is persisted with the workspace and may be sent to configured model/HTTP endpoints after the user submits it.
- Keep `lib/pipeline/index.ts` browser-safe. Server networking is imported directly from `lib/pipeline/provider.ts` by server-side code.

## Tests and checks

- `npm test` runs `apps/web/scripts/pipeline-selftest.ts`. That file is the test runner/registry; domain suites are registered from neighboring `*-selftest.ts` files, while core API and runner coverage remains in the entry file.
- `npm run test:browser` runs Playwright flows in `apps/web/tests/browser/`; these cover user-visible persistence, editor, chat, and file-input behavior.
- Before and after behavior changes, run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and (for UI changes) `npm run test:browser`. See the root README for the browser executable setup.
- For a refactor, keep each extraction behavior-preserving and separately verifiable. Change one boundary at a time; do not combine structural cleanup with a feature change.

## Where to start

| Change | Start here |
| --- | --- |
| Workspace schema, save/restore, conversations | `components/pipeline/studio-state.ts`, then `PipelineStudio.tsx` |
| Graph validation, execution, providers, request security | `lib/pipeline/` and `app/api/pipeline/route.ts` |
| Chat, pipeline binding, file attachment | `PipelineStudio.tsx`, `studio-state.ts`, `file-input.ts` |
| Graph editor UI | `PipelineCanvas.tsx` and its neighboring inspector/dialog components |
| Run metrics and budgets | `run-stats.ts`, `run-goals.ts`, `useRunStats.ts`, related self-tests |
| Download formats and artifact rendering | `file-export/`, `OutputExports.tsx`, export self-tests |
