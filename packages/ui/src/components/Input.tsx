import type { InputHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export function Input({ invalid = false, className, ...rest }: InputProps) {
  const classes = ["il-input", invalid && "il-input--invalid", className].filter(Boolean).join(" ");
  return <input className={classes} {...rest} />;
}
