// Tiny classnames joiner — filters out falsy values so conditional
// classes read cleanly without pulling in a dependency.
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ")
}
