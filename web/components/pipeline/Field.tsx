import { cloneElement, isValidElement, useId } from "react";
import type { ReactElement, ReactNode } from "react";
import s from "./studio.module.css";

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  const control = isValidElement(children) && typeof children.type === "string" && ["input", "textarea", "select"].includes(children.type)
    ? cloneElement(children as ReactElement<{ "aria-labelledby"?: string; "aria-describedby"?: string }>, { "aria-labelledby": id, "aria-describedby": hint ? `${id}-hint` : undefined })
    : children;
  return <label className={s.field}><span id={id}>{label}</span>{control}{hint && <small id={`${id}-hint`}>{hint}</small>}</label>;
}

