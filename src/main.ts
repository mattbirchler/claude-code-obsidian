import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import * as fs from "fs";
import * as os from "os";
import {
  ClaudeCodeSyncSettings,
  ClaudeCodeSyncSettingTab,
  DEFAULT_SETTINGS,
} from "./settings";
import { findSessionFiles } from "./discovery";
import { SyncEngine, SyncState, VaultAdapter, invalidateAll, renderSettingsKey } from "./sync";

interface PersistedData {
  settings: ClaudeCodeSyncSettings;
  state: SyncState;
  renderKey?: string;
}

export default class ClaudeCodeSyncPlugin extends Plugin {
  settings: ClaudeCodeSyncSettings = { ...DEFAULT_SETTINGS };
  state: SyncState = {};
  renderKey = "";
  private syncing = false;
  private intervalId: number | null = null;

  async onload() {
    await this.loadPersisted();
    this.addRibbonIcon("refresh-cw", "Sync Claude Code sessions", () => this.syncAll());
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.syncAll() });
    this.addSettingTab(new ClaudeCodeSyncSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      void this.syncAll();
      this.applyInterval();
    });
  }

  applyInterval() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.settings.intervalMinutes > 0) {
      this.intervalId = window.setInterval(
        () => void this.syncAll(),
        this.settings.intervalMinutes * 60_000
      );
      this.registerInterval(this.intervalId);
    }
  }

  async syncAll() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const files = findSessionFiles(this.settings.sourcePath, os.homedir());
      const currentRenderKey = renderSettingsKey(this.settings);
      if (this.renderKey !== currentRenderKey) invalidateAll(this.state);
      const engine = new SyncEngine(this.vaultAdapter(), (p) => fs.readFileSync(p, "utf8"));
      const result = await engine.run(files, this.settings, this.state);
      this.renderKey = currentRenderKey;
      await this.savePersisted();
      if (result.errors.length > 0) {
        console.error("Claude Code Sync errors:", result.errors);
        new Notice(`Claude Code Sync: ${result.errors.length} session(s) failed to sync.`);
      } else if (result.synced > 0) {
        new Notice(`Claude Code Sync: updated ${result.synced} note(s).`);
      }
    } finally {
      this.syncing = false;
    }
  }

  private vaultAdapter(): VaultAdapter {
    const vault = this.app.vault;
    return {
      exists: (p) => vault.getAbstractFileByPath(normalizePath(p)) !== null,
      createFolder: async (p) => {
        await vault.createFolder(normalizePath(p));
      },
      write: async (p, content) => {
        const norm = normalizePath(p);
        const existing = vault.getAbstractFileByPath(norm);
        if (existing instanceof TFile) await vault.modify(existing, content);
        else await vault.create(norm, content);
      },
      rename: async (oldPath, newPath) => {
        const file = vault.getAbstractFileByPath(normalizePath(oldPath));
        if (file instanceof TFile) {
          await this.app.fileManager.renameFile(file, normalizePath(newPath));
        }
      },
    };
  }

  async loadPersisted() {
    const data = (await this.loadData()) as Partial<PersistedData> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    this.state = data?.state ?? {};
    this.renderKey = data?.renderKey ?? "";
  }

  async savePersisted() {
    const data: PersistedData = { settings: this.settings, state: this.state, renderKey: this.renderKey };
    await this.saveData(data);
  }
}
