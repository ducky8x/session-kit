/** A hook's JSON input from stdin, or null when it is not a JSON object with a session id. */
export function parseHookInput(text: string): Record<string, unknown> & { session_id: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.session_id !== "string" || input.session_id === "") return null;
  return input as Record<string, unknown> & { session_id: string };
}

export function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}
