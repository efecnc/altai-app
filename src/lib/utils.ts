import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Format a count with its noun, naively pluralizing with a trailing "s".
 * e.g. `plural(1, "artifact")` → "1 artifact", `plural(2, "subagent")` → "2 subagents".
 */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}
