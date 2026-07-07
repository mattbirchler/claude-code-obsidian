import type { Session, ToolCall, Turn } from "./parser";

export interface RenderOptions {
  includeTools: boolean;
  includeThinking: boolean;
}

const TOOL_BODY_LIMIT = 1000;
const HINT_KEYS = ["file_path", "path", "command", "pattern", "url"];

export function renderSession(session: Session, opts: RenderOptions): string {
  const parts: string[] = [frontmatter(session), `# ${heading(session)}`];
  for (const turn of session.turns) {
    const rendered = renderTurn(turn, opts);
    if (rendered) parts.push(rendered);
  }
  return parts.join("\n\n") + "\n";
}

function heading(session: Session): string {
  return session.title ?? `Session ${session.id.slice(0, 8)}`;
}

function frontmatter(session: Session): string {
  const lines = ["---", `session: ${JSON.stringify(session.id)}`];
  if (session.project) lines.push(`project: ${JSON.stringify(session.project)}`);
  if (session.cwd) lines.push(`cwd: ${JSON.stringify(session.cwd)}`);
  if (session.startedAt) lines.push(`date: ${session.startedAt.slice(0, 10)}`);
  if (session.updatedAt) lines.push(`updated: ${JSON.stringify(session.updatedAt)}`);
  lines.push("source: claude-code", "---");
  return lines.join("\n");
}

function renderTurn(turn: Turn, opts: RenderOptions): string {
  const speaker = turn.role === "user" ? "You" : "Claude";
  const time = turn.timestamp ? formatTime(turn.timestamp) : "";
  const parts: string[] = [`## ${speaker}${time ? ` · ${time}` : ""}`];
  if (opts.includeThinking) {
    for (const t of turn.thinking) parts.push(callout("thinking", "Thinking", t));
  }
  if (turn.text) parts.push(turn.text);
  if (opts.includeTools) {
    for (const tool of turn.tools) parts.push(toolCallout(tool));
  }
  if (parts.length === 1 && !turn.text) return parts[0];
  return parts.join("\n\n");
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function callout(kind: string, title: string, body: string): string {
  const quoted = body.split("\n").map((l) => `> ${l}`).join("\n");
  return `> [!${kind}]- ${title}\n${quoted}`;
}

function toolCallout(tool: ToolCall): string {
  const input =
    tool.input && typeof tool.input === "object" ? (tool.input as Record<string, unknown>) : {};
  const hint = firstString(input, HINT_KEYS);
  const title = hint ? `${tool.name} ${hint.replace(/\s+/g, " ").slice(0, 80)}` : tool.name;
  let body: string;
  try {
    body = JSON.stringify(tool.input, null, 2) ?? "";
  } catch {
    body = String(tool.input);
  }
  if (body.length > TOOL_BODY_LIMIT) body = body.slice(0, TOOL_BODY_LIMIT) + " …";
  return callout("tool", title, body);
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}
