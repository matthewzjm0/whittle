export const FORMAT_FOR_EXPORT = `Format for export:
Return one strict JSON object, without commentary, using exportVersion: 1.
Never include passwords, credentials, API keys, authorization headers, code to execute, raw HTML/SVG objects, URLs to fetch, or renderer options.
Choose one shape:
document: {"exportVersion":1,"kind":"document","title":"Report","blocks":[{"type":"heading","level":1,"text":"Overview"},{"type":"paragraph","text":"Your answer here"}]}
slides: {"exportVersion":1,"kind":"slides","slides":[{"title":"Overview","blocks":[{"type":"list","ordered":false,"items":["Point one"]}]}]}
sheets: {"exportVersion":1,"kind":"sheets","sheets":[{"name":"Results","rows":[["Metric","Value"],["Count",3]]}]}
files: {"exportVersion":1,"kind":"files","files":[{"name":"report.txt","format":"txt","content":{"exportVersion":1,"kind":"document","blocks":[{"type":"paragraph","text":"Answer"}]}}]}
Document blocks: heading (level 1-6,text), paragraph (text), list (ordered boolean,items of text), code (text,optional language), or table (rectangular rows).
Slide bodies use the same blocks except headings; use each slide's title instead. Sheet/table cells are strings, finite numbers, booleans, or null, never formulas or objects.
Only declared fields are allowed. No duplicate JSON keys, prototype-related keys, nested file bundles, or binary payloads.
Limits across the entire spec: 131072 source characters, 512 KiB UTF-8, 12 JSON levels, 20000 JSON nodes, 256 blocks, 32 slides, 8 sheets/tables, 10000 cells, 16 files. Each table: 1000 rows, 32 columns; each cell: 2048 characters. Titles: 120 characters; each slide body: 2500 characters and must fit a fixed layout. Decoded text: 2048 lines and 8192 characters per line.
Names: unique flat ASCII filenames, starting with a letter or digit, at most 80 characters with the matching lowercase extension; no paths, leading dots, reserved device names, doubled dots, trailing spaces, or duplicates ignoring case. File formats: pdf,docx,pptx,xlsx,csv,html,md,txt,json,svg. Sheet names: unique safe names of 1-31 characters.
Files manifests support Download as ZIP for a local bundle or JSON for the validated manifest. ZIP accepts 1-16 files, up to 4 MiB per generated file and 16 MiB total; nested ZIPs are forbidden.`;
