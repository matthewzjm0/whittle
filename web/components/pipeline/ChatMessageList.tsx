"use client";

import { OutputExports } from "./OutputExports";
import type { ChatMessage } from "./studio-state";
import s from "./studio.module.css";

export function ChatMessageList({
  messages,
  onCopy,
  getSecrets,
}: {
  messages: ChatMessage[];
  onCopy: (content: string) => void;
  getSecrets: () => string[];
}) {
  return <div className={s.messages}>{messages.map((message) => <article key={message.id} className={`${s.message} ${message.role === "user" ? s.userMessage : ""}`}>
    <div className={s.messageMeta}>
      <strong>{message.role === "user" ? "You" : message.modelName || "Assistant"}</strong>
      <span>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      <button onClick={() => onCopy(message.content)}>Copy</button>
    </div>
    <div className={s.messageText}>{message.content}</div>
    {message.usage && <small className={s.usage}>{message.usage.input.toLocaleString()} input / {message.usage.output.toLocaleString()} output tokens{message.usage.cost !== undefined ? ` / $${message.usage.cost.toFixed(6)} reported` : ""}</small>}
    {message.role === "assistant" && <OutputExports text={message.content} name={message.modelName || "Assistant output"} getSecrets={getSecrets} />}
  </article>)}</div>;
}
