import type { ButtonHTMLAttributes, ReactNode } from "react";

/** One button contract preserves keyboard and disabled behavior across both applications. */
export function Button({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return <button type="button" className={`button button-${variant} ${className}`} {...props} />;
}

/** Status labels retain words so color is never the only source of information. */
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "error" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** Empty collections explain the real state instead of substituting example records. */
export function EmptyState({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-symbol" aria-hidden="true">◇</div><h3>{title}</h3><p>{description}</p>{children}</div>;
}

/** A field can be reused with an explicit id so error messages remain addressable. */
export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return <div className="field"><label htmlFor={htmlFor}>{label}</label>{children}{hint ? <p className="field-hint">{hint}</p> : null}</div>;
}
