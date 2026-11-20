import {
	App,
	Notice,
	parseYaml,
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

interface NoteExecutorData extends NoteExecutorSettings {
	seen?: string[];
}

export default class NoteExecutorPlugin extends Plugin {
	settings: NoteExecutorSettings;
	private processed = new Set<string>();
	private static readonly MAX_SEEN = 1000;

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

		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
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
		const data = (await this.loadData()) as NoteExecutorData | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.processed = new Set(Array.isArray(data?.seen) ? data.seen : []);
	}

	async saveSettings() {
		const data: NoteExecutorData = { ...this.settings, seen: [...this.processed] };
		await this.saveData(data);
	}

	private markProcessed(path: string) {
		this.processed.add(path);
		while (this.processed.size > NoteExecutorPlugin.MAX_SEEN) {
			const oldest = this.processed.values().next().value;
			if (oldest === undefined) break;
			this.processed.delete(oldest);
		}
		void this.saveSettings();
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

		const content = await this.app.vault.cachedRead(file);
		if (!content.trim()) return;

		this.markProcessed(file.path);
		const frontmatter = this.parseFrontmatter(content);

		if (frontmatter["run"] === "js" && this.settings.runJsBlocks) {
			await this.executeJs(file, content);
			return;
		}

		if (this.settings.webhookUrl.trim()) {
			await this.sendToWebhook(file, content, frontmatter);
		}
	}

	private parseFrontmatter(content: string): Record<string, unknown> {
		const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!match) return {};
		try {
			return (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
		} catch (err) {
			console.error(err);
			return {};
		}
	}

	private extractJs(content: string): string | null {
		const match = content.match(/```[ \t]*(?:js|javascript)[ \t]*\r?\n([\s\S]*?)```/i);
		return match ? match[1] : null;
	}

	private async executeJs(file: TFile, content: string) {
		const code = this.extractJs(content);
		if (code === null) {
			new Notice(`Note Executor: no js code block in ${file.name}, skipped`);
			return;
		}
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
			.addText((text) => {
				text
					.setPlaceholder("https://example.com/hook")
					.setValue(this.plugin.settings.webhookUrl)
					.onChange((value) => {
						this.plugin.settings.webhookUrl = value;
					});
				text.inputEl.addEventListener("blur", () => void this.plugin.saveSettings());
			});

		new Setting(containerEl)
			.setName("Folder filter")
			.setDesc("Only react to notes in this folder (leave empty for the whole vault)")
			.addText((text) => {
				text
					.setPlaceholder("e.g. inbox/")
					.setValue(this.plugin.settings.folder)
					.onChange((value) => {
						this.plugin.settings.folder = value;
					});
				text.inputEl.addEventListener("blur", () => void this.plugin.saveSettings());
			});
	}
}
