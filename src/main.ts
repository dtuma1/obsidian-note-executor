import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	requestUrl,
} from "obsidian";

interface NoteExecutorSettings {
	enabled: boolean;
	runJsBlocks: boolean;
	webhookUrl: string;
	folder: string;
}

const DEFAULT_SETTINGS: NoteExecutorSettings = {
	enabled: true,
	runJsBlocks: false,
	webhookUrl: "",
	folder: "",
};

export default class NoteExecutorPlugin extends Plugin {
	settings: NoteExecutorSettings;
	private processed = new Set<string>();

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new NoteExecutorSettingTab(this.app, this));

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFile) {
					void this.handleNewFile(file);
				}
			})
		);

		this.addCommand({
			id: "process-active-note",
			name: "Process active note",
			callback: () => {
				const file = this.app.workspace.getActiveFile();
				if (file) {
					void this.handleNewFile(file);
				}
			},
		});

		this.addCommand({
			id: "process-all-notes",
			name: "Process all notes in vault",
			callback: () => void this.processAllNotes(),
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private matchesFolder(file: TFile): boolean {
		const folder = this.settings.folder.trim().replace(/\/+$/, "");
		if (!folder) return true;
		return file.path === folder || file.path.startsWith(folder + "/");
	}

	async handleNewFile(file: TFile) {
		if (!this.settings.enabled) return;
		if (file.extension !== "md") return;
		if (!this.matchesFolder(file)) return;
		if (this.processed.has(file.path)) return;
		this.processed.add(file.path);

		const content = await this.app.vault.cachedRead(file);
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = (cache?.frontmatter ?? {}) as Record<string, unknown>;

		const wantsJs = frontmatter["run"] === "js" || frontmatter["execute"] === "js";
		if (wantsJs && this.settings.runJsBlocks) {
			await this.executeJs(file, content);
			return;
		}

		if (this.settings.webhookUrl.trim()) {
			await this.sendToWebhook(file, content, frontmatter);
		}
	}

	private extractJs(content: string): string {
		const match = content.match(/```(?:js|javascript)\n([\s\S]*?)```/i);
		return match ? match[1] : content;
	}

	private async executeJs(file: TFile, content: string) {
		const code = this.extractJs(content);
		try {
			const fn = new Function(
				"app",
				"plugin",
				"file",
				"content",
				`"use strict";\n${code}`
			);
			await fn(this.app, this, file, content);
			new Notice(`Note Executor: executed ${file.name}`);
		} catch (err) {
			console.error(err);
			new Notice(`Note Executor: error in ${file.name}: ${String(err)}`);
		}
	}

	private async sendToWebhook(
		file: TFile,
		content: string,
		frontmatter: Record<string, unknown>
	) {
		try {
			const res = await requestUrl({
				url: this.settings.webhookUrl.trim(),
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: file.path,
					name: file.name,
					frontmatter,
					content,
					ctime: file.stat.ctime,
					mtime: file.stat.mtime,
				}),
			});
			new Notice(`Note Executor: sent ${file.name} (HTTP ${res.status})`);
		} catch (err) {
			console.error(err);
			new Notice(`Note Executor: webhook failed for ${file.name}`);
		}
	}

	private async processAllNotes() {
		const files = this.app.vault.getMarkdownFiles();
		let count = 0;
		for (const file of files) {
			if (!this.processed.has(file.path)) {
				count++;
				await this.handleNewFile(file);
			}
		}
		new Notice(`Note Executor: processed ${count} note(s)`);
	}
}

class NoteExecutorSettingTab extends PluginSettingTab {
	plugin: NoteExecutorPlugin;

	constructor(app: App, plugin: NoteExecutorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Enabled")
			.setDesc("React to new notes")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Allow running JS from notes")
			.setDesc(
				"Dangerous: notes with `run: js` in frontmatter execute their code block. Off by default."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.runJsBlocks).onChange(async (value) => {
					this.plugin.settings.runJsBlocks = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Webhook URL")
			.setDesc("New notes are POSTed here as JSON when JS execution does not apply")
			.addText((text) =>
				text
					.setPlaceholder("https://example.com/hook")
					.setValue(this.plugin.settings.webhookUrl)
					.onChange(async (value) => {
						this.plugin.settings.webhookUrl = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Folder filter")
			.setDesc("Only react to notes in this folder (leave empty for the whole vault)")
			.addText((text) =>
				text
					.setPlaceholder("e.g. inbox/")
					.setValue(this.plugin.settings.folder)
					.onChange(async (value) => {
						this.plugin.settings.folder = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
