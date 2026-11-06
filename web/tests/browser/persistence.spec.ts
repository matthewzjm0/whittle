import { expect, test } from "@playwright/test";
import { jsPDF } from "jspdf";
import { Document, Packer, Paragraph } from "docx";

const key = "pipeline-studio.v1";

test("attach text, PDF and DOCX locally to a chat conversation", async ({ page }) => {
  await page.goto("/builder?tab=chat");
  await page.getByRole("complementary", { name: "Conversations" }).getByRole("button", { name: "+ New conversation" }).click();
  const input = page.getByLabel("Choose file for chat");
  const draft = page.getByRole("textbox", { name: "Message" });
  await input.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Research notes") });
  await expect(page.getByRole("listitem", { name: "notes.txt" })).toBeVisible();
  await expect(draft).toHaveValue("");
  const pdf = new jsPDF();
  pdf.text("Research PDF", 20, 20);
  await input.setInputFiles({ name: "paper.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdf.output("arraybuffer")) });
  await expect(page.getByRole("listitem", { name: "paper.pdf" })).toBeVisible();
  const doc = new Document({ sections: [{ children: [new Paragraph("Research DOCX")] }] });
  await input.setInputFiles({ name: "paper.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await Packer.toBuffer(doc) });
  await expect(page.getByRole("listitem", { name: "paper.docx" })).toBeVisible();
});

test("attachments report scanned PDFs, oversize files, and truncation", async ({ page }) => {
  await page.goto("/builder?tab=chat");
  await page.getByRole("complementary", { name: "Conversations" }).getByRole("button", { name: "+ New conversation" }).click();
  const input = page.getByLabel("Choose file for chat");
  const blank = new jsPDF();
  await input.setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from(blank.output("arraybuffer")) });
  await expect(page.getByText(/No extractable text found/)).toBeVisible();
  await input.setInputFiles({ name: "large.txt", mimeType: "text/plain", buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 65) });
  await expect(page.getByText(/exceeds the 5 MB upload limit/)).toBeVisible();
  await input.setInputFiles({ name: "long.txt", mimeType: "text/plain", buffer: Buffer.from("a".repeat(70_000)) });
  await expect(page.locator("footer[role=status]")).toContainText("truncated");
  await expect(page.getByRole("listitem", { name: "long.txt" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
});

test("attached text is sent through a saved pipeline", async ({ page }) => {
  await page.goto("/builder");
  await page.getByRole("textbox", { name: "Pipeline name" }).fill("File pipeline");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("complementary", { name: "Conversations" }).getByRole("button", { name: "+ New conversation" }).click();
  await page.getByLabel("Chat execution").selectOption({ label: "File pipeline" });
  await page.getByLabel("Choose file for chat").setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("Evidence from attachment") });
  await expect(page.getByRole("listitem", { name: "notes.md" })).toBeVisible();
  await page.getByRole("button", { name: /^Send/ }).click();
  await expect(page.locator("article").last()).toContainText("Evidence from attachment");
});

test("edits survive switching, save and reload", async ({ page }) => {
  await page.goto("/builder");
  const name = page.getByRole("textbox", { name: "Pipeline name" });
  await name.fill("First workflow");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "+ New pipeline" }).click();
  await name.fill("Second draft");
  await page.getByRole("button", { name: /First workflow/ }).click();
  await expect(name).toHaveValue("First workflow");
  await page.getByRole("button", { name: /Second draft/ }).click();
  await expect(name).toHaveValue("Second draft");
  await expect.poll(() => page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? '{"pipelines":[]}').pipelines.length, key)).toBe(2);
  await page.reload();
  await expect(name).toHaveValue("Second draft");
  await expect(page.getByText(/UNSAVED WORKFLOW/)).toBeVisible();
  await page.getByRole("button", { name: /First workflow/ }).click();
  await expect(page.getByText(/SAVED WORKFLOW/)).toBeVisible();
});

test("malformed browser storage is not overwritten", async ({ page }) => {
  const broken = "{broken workspace";
  await page.addInitScript(({ storageKey, raw }) => localStorage.setItem(storageKey, raw), { storageKey: key, raw: broken });
  await page.goto("/builder");
  await expect(page.locator("footer[role=status]")).toContainText("left untouched");
  await page.getByRole("textbox", { name: "Pipeline name" }).fill("Do not overwrite");
  await expect.poll(() => page.evaluate((storageKey) => localStorage.getItem(storageKey), key)).toBe(broken);
});

test("workspace export can be imported and restored", async ({ page }) => {
  await page.goto("/builder");
  const name = page.getByRole("textbox", { name: "Pipeline name" });
  await name.fill("Exported workflow");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  await name.fill("Changed workflow");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles(path);
  await expect(name).toHaveValue("Exported workflow");
  await page.reload();
  await expect(name).toHaveValue("Exported workflow");
});

test("model and custom block dialogs open and close", async ({ page }) => {
  await page.goto("/builder");
  await page.getByRole("complementary", { name: "Block library" }).getByRole("button", { name: "+ Add model", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close model connection" }).click();
  await page.getByRole("button", { name: "+ Create custom block" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("custom HTTP blocks keep fixed request headers across a reload", async ({ page }) => {
  await page.goto("/builder");
  await page.getByRole("button", { name: "+ Create custom block" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Block name").fill("Notion write");
  await dialog.getByLabel("Action").selectOption("http");
  await dialog.getByLabel("Request URL").fill("https://api.notion.com/v1/pages");
  await dialog.getByLabel("Additional request headers (optional)").fill("Notion-Version: 2026-03-11");
  await dialog.getByRole("button", { name: "Create block" }).click();
  await expect(page.getByRole("button", { name: "Edit custom block Notion write" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Edit custom block Notion write" }).click();
  await expect(page.getByLabel("Additional request headers (optional)")).toHaveValue("Notion-Version: 2026-03-11");
});

test("chat runs a saved pipeline and shows the output", async ({ page }) => {
  await page.goto("/builder");
  await page.getByRole("textbox", { name: "Pipeline name" }).fill("Pass through");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("complementary", { name: "Conversations" }).getByRole("button", { name: "+ New conversation" }).click();
  await page.getByLabel("Chat execution").selectOption({ label: "Pass through" });
  await page.getByRole("textbox", { name: "Message" }).fill("hello from chat");
  await page.getByRole("button", { name: /^Send/ }).click();
  const reply = page.locator("article").last();
  await expect(reply).toContainText("Pass through");
  await expect(reply).toContainText("hello from chat");
  const formats = await reply.getByLabel("Output file format").locator("option").allTextContents();
  expect(formats).toContain("ZIP");
  expect(formats).not.toContain("SVG");
});

test("chat composer shows a rough run estimate for the selected pipeline", async ({ page }) => {
  await page.goto("/builder");
  await page.getByRole("textbox", { name: "Pipeline name" }).fill("Pass through");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("complementary", { name: "Conversations" }).getByRole("button", { name: "+ New conversation" }).click();
  await page.getByLabel("Chat execution").selectOption({ label: "Pass through" });
  const estimate = page.getByLabel("Estimated run cost");
  await expect(estimate).toContainText("No model calls");
  await expect(estimate).toContainText("0 in / 0 out");
});

test("chat refuses to send through an unsaved pipeline", async ({ page }) => {
  await page.goto("/builder");
  await page.getByRole("textbox", { name: "Pipeline name" }).fill("Pass through");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("complementary", { name: "Conversations" }).getByRole("button", { name: "+ New conversation" }).click();
  await page.getByLabel("Chat execution").selectOption({ label: "Pass through" });
  await page.getByRole("button", { name: "Pipeline", exact: true }).click();
  await page.getByRole("textbox", { name: "Pipeline name" }).fill("Pass through edited");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByText("This pipeline has unsaved changes")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Send/ })).toBeDisabled();
});

test("undo restores added and deleted blocks", async ({ page }) => {
  await page.goto("/builder");
  const canvas = page.getByRole("region", { name: "Pipeline canvas" });
  const library = page.getByRole("complementary", { name: "Block library" });
  await expect(canvas.getByText("2 blocks", { exact: true })).toBeVisible();
  await library.getByRole("button", { name: /Condition/ }).click();
  await expect(canvas.getByText("3 blocks", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(canvas.getByText("2 blocks", { exact: true })).toBeVisible();
  await canvas.getByRole("button", { name: /Select Output/ }).click();
  await page.keyboard.press("Delete");
  await expect(canvas.getByText("1 block", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(canvas.getByText("2 blocks", { exact: true })).toBeVisible();
});
