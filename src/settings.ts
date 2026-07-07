import { App, PluginSettingTab, Setting } from "obsidian";
import type ClaudeCodeSyncPlugin from "./main";

export interface ClaudeCodeSyncSettings {
  sourcePath: string;
  targetFolder: string;
  intervalMinutes: number;
  includeTools: boolean;
  includeThinking: boolean;
}

export const DEFAULT_SETTINGS: ClaudeCodeSyncSettings = {
  sourcePath: "~/.claude/projects",
  targetFolder: "Claude Code",
  intervalMinutes: 5,
  includeTools: true,
  includeThinking: true,
};

export class ClaudeCodeSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ClaudeCodeSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Source path")
      .setDesc("Where Claude Code stores its sessions. ~ expands to your home folder.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.sourcePath)
          .setValue(this.plugin.settings.sourcePath)
          .onChange(async (value) => {
            this.plugin.settings.sourcePath = value.trim() || DEFAULT_SETTINGS.sourcePath;
            await this.plugin.savePersisted();
          })
      );

    new Setting(containerEl)
      .setName("Target folder")
      .setDesc("Vault folder the session notes are written into.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.targetFolder)
          .setValue(this.plugin.settings.targetFolder)
          .onChange(async (value) => {
            this.plugin.settings.targetFolder =
              value.trim().replace(/\/+$/, "") || DEFAULT_SETTINGS.targetFolder;
            await this.plugin.savePersisted();
          })
      );

    new Setting(containerEl)
      .setName("Sync interval (minutes)")
      .setDesc("How often to sync automatically. 0 means manual only.")
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.intervalMinutes))
          .onChange(async (value) => {
            const n = Number(value);
            this.plugin.settings.intervalMinutes = Number.isFinite(n) && n >= 0 ? n : 5;
            await this.plugin.savePersisted();
            this.plugin.applyInterval();
          })
      );

    new Setting(containerEl)
      .setName("Include tool calls")
      .setDesc("Show what Claude did (edits, commands) as collapsed callouts.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeTools).onChange(async (value) => {
          this.plugin.settings.includeTools = value;
          await this.plugin.savePersisted();
        })
      );

    new Setting(containerEl)
      .setName("Include thinking")
      .setDesc("Show Claude's internal reasoning as collapsed callouts.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeThinking).onChange(async (value) => {
          this.plugin.settings.includeThinking = value;
          await this.plugin.savePersisted();
        })
      );
  }
}
