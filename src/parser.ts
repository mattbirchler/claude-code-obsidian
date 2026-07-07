export interface ToolCall {
  name: string;
  input: unknown;
}

export interface Turn {
  role: "user" | "assistant";
  timestamp: string | null;
  text: string;
  thinking: string[];
  tools: ToolCall[];
}

export interface Session {
  id: string;
  title: string | null;
  project: string | null;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  turns: Turn[];
}

const SYSTEM_NOISE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

export function parseSession(jsonl: string, sessionId: string, fallbackProject: string): Session {
  const session: Session = {
    id: sessionId,
    title: null,
    project: fallbackProject || null,
    cwd: null,
    startedAt: null,
    updatedAt: null,
    turns: [],
  };
  let summaryTitle: string | null = null;

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue; // malformed line (possibly a torn mid-write read): skip, never fatal
    }
    if (!obj || typeof obj !== "object") continue;
    const rec = obj as Record<string, unknown>;

    if (rec.type === "ai-title" && typeof rec.aiTitle === "string") {
      session.title = rec.aiTitle;
      continue;
    }
    if (rec.type === "summary" && typeof rec.summary === "string") {
      summaryTitle = summaryTitle ?? rec.summary;
      continue;
    }
    if (rec.type !== "user" && rec.type !== "assistant") continue; // unknown types fail soft
    if (rec.isSidechain === true) continue; // subagent transcripts are not the user's conversation

    if (typeof rec.cwd === "string" && rec.cwd && !session.cwd) {
      session.cwd = rec.cwd;
      const base = basename(rec.cwd);
      if (base) session.project = base;
    }

    const turn = toTurn(rec);
    if (!turn) continue;
    if (turn.timestamp) {
      if (!session.startedAt) session.startedAt = turn.timestamp;
      session.updatedAt = turn.timestamp;
    }
    session.turns.push(turn);
  }

  if (!session.title && summaryTitle) session.title = summaryTitle;
  return session;
}

export function hasConversation(session: Session): boolean {
  return (
    session.turns.some((t) => t.role === "user") &&
    session.turns.some((t) => t.role === "assistant")
  );
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function toTurn(rec: Record<string, unknown>): Turn | null {
  const msg = rec.message;
  if (!msg || typeof msg !== "object") return null;
  const content = (msg as Record<string, unknown>).content;

  const turn: Turn = {
    role: rec.type as "user" | "assistant",
    timestamp: typeof rec.timestamp === "string" ? rec.timestamp : null,
    text: "",
    thinking: [],
    tools: [],
  };

  const texts: string[] = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        texts.push(b.text);
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        turn.thinking.push(b.thinking);
      } else if (b.type === "tool_use") {
        turn.tools.push({ name: typeof b.name === "string" ? b.name : "tool", input: b.input });
      }
      // tool_result and unknown block types: skipped (tool acks, not conversation)
    }
  } else {
    return null;
  }

  turn.text = texts.join("\n\n").replace(SYSTEM_NOISE, "").trim();
  if (!turn.text && turn.thinking.length === 0 && turn.tools.length === 0) return null;
  return turn;
}
