import * as fs from "fs";
import * as path from "path";

export interface SessionFile {
  path: string;
  sessionId: string;
  projectFolder: string;
  mtimeMs: number;
}

export function expandHome(p: string, homedir: string): string {
  if (p === "~") return homedir;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir, p.slice(2));
  return p;
}

export function findSessionFiles(sourcePath: string, homedir: string): SessionFile[] {
  const root = expandHome(sourcePath.trim(), homedir);
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SessionFile[] = [];
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(root, dir.name);
    let entries: string[];
    try {
      entries = fs.readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = path.join(dirPath, name);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        out.push({
          path: filePath,
          sessionId: name.slice(0, -".jsonl".length),
          projectFolder: dir.name,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  }
  return out;
}
