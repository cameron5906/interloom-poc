import type { TextareaHTMLAttributes } from "react";

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function TextArea({ invalid = false, className, ...rest }: TextAreaProps) {
  const classes = ["il-textarea", invalid && "il-textarea--invalid", className]
    .filter(Boolean)
    .join(" ");
  return <textarea className={classes} {...rest} />;
}
