import type { SessionFile } from "./discovery";
import { hasConversation, parseSession } from "./parser";
import { renderSession } from "./renderer";
import { noteBaseName, sanitizeName } from "./naming";

export interface VaultAdapter {
  exists(path: string): boolean;
  createFolder(path: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export interface FileState {
  mtimeMs: number;
  notePath: string;
}

export type SyncState = Record<string, FileState>;

export interface SyncSettings {
  targetFolder: string;
  includeTools: boolean;
  includeThinking: boolean;
}

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: string[];
}

export class SyncEngine {
  constructor(
    private vault: VaultAdapter,
    private readFile: (path: string) => string
  ) {}

  async run(files: SessionFile[], settings: SyncSettings, state: SyncState): Promise<SyncResult> {
    const result: SyncResult = { synced: 0, skipped: 0, errors: [] };

    for (const file of files) {
      try {
        const prev = state[file.path];
        if (prev && prev.mtimeMs >= file.mtimeMs) {
          result.skipped++;
          continue;
        }

        const session = parseSession(this.readFile(file.path), file.sessionId, file.projectFolder);
        if (!hasConversation(session)) {
          // remember the mtime so we don't reparse it every pass, but write nothing
          state[file.path] = { mtimeMs: file.mtimeMs, notePath: prev?.notePath ?? "" };
          result.skipped++;
          continue;
        }

        const projectName = sanitizeName(session.project ?? "") || file.projectFolder;
        const folder = `${settings.targetFolder}/${projectName}`;
        let notePath = `${folder}/${noteBaseName(session)}.md`;
        notePath = this.resolveCollision(notePath, file.path, session.id, state, prev?.notePath);

        await this.ensureFolder(settings.targetFolder);
        await this.ensureFolder(folder);

        if (prev?.notePath && prev.notePath !== notePath && this.vault.exists(prev.notePath)) {
          await this.vault.rename(prev.notePath, notePath);
        }
        await this.vault.write(notePath, renderSession(session, settings));

        state[file.path] = { mtimeMs: file.mtimeMs, notePath };
        result.synced++;
      } catch (e) {
        result.errors.push(`${file.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return result;
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!this.vault.exists(path)) await this.vault.createFolder(path);
  }

  private resolveCollision(
    notePath: string,
    sourcePath: string,
    sessionId: string,
    state: SyncState,
    prevNotePath: string | undefined
  ): string {
    const ownedByOther = Object.entries(state).some(
      ([src, st]) => src !== sourcePath && st.notePath === notePath
    );
    const untrackedExisting =
      !ownedByOther && notePath !== prevNotePath && this.vault.exists(notePath);
    if (!ownedByOther && !untrackedExisting) return notePath;
    return notePath.replace(/\.md$/, ` (${sessionId.slice(0, 8)}).md`);
  }
}
