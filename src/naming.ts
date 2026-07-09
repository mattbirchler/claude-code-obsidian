import type { Session } from "./parser";

// Control chars are intentionally matched: they're illegal in Windows filenames.
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_LENGTH = 80;

export function sanitizeName(name: string): string {
  let out = name.replace(ILLEGAL, " ").replace(/\s+/g, " ").trim();
  if (out.length > MAX_LENGTH) out = out.slice(0, MAX_LENGTH);
  out = out.replace(/[. ]+$/g, "");
  if (!out || RESERVED.test(out)) return "";
  return out;
}

export function noteBaseName(session: Session): string {
  const title = session.title ? sanitizeName(session.title) : "";
  if (!title) return session.id;
  const datePrefix = session.startedAt ? `${session.startedAt.slice(0, 10)} ` : "";
  return `${datePrefix}${title}`;
}
