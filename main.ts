import { App, Editor, MarkdownView, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, debounce } from 'obsidian';
import { AIService, AIServiceType } from './services/aiService';
import { FrontmatterService } from './services/frontmatterService';

/**
 * 保存配置对话框
 */
class SaveConfigModal extends Modal {
	private configName: string = '';
	private onSubmit: (configName: string) => void;

	constructor(app: App, onSubmit: (configName: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: '保存 API 配置' });

		new Setting(contentEl)
			.setName('配置名称')
			.setDesc('为当前 API 配置设置一个名称')
			.addText(text => text
				.setPlaceholder('输入配置名称')
				.onChange(value => {
					this.configName = value;
				})
			);

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('保存')
				.setCta()
				.onClick(() => {
					if (this.configName.trim()) {
						this.onSubmit(this.configName.trim());
						this.close();
					} else {
						new Notice('请输入配置名称');
					}
				})
			)
			.addButton(button => button
				.setButtonText('取消')
				.onClick(() => {
					this.close();
				})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * 确认对话框
 */
class ConfirmModal extends Modal {
	private onConfirm: () => void;
	private title: string;
	private message: string;
	private confirmText: string;
	private cancelText: string;

	constructor(
		app: App,
		{
			title = '确认操作',
			message = '您确定要执行此操作吗？',
			confirmText = '确认',
			cancelText = '取消',
			onConfirm
		}: {
			title?: string;
			message?: string;
			confirmText?: string;
			cancelText?: string;
			onConfirm: () => void;
		}
	) {
		super(app);
		this.title = title;
		this.message = message;
		this.confirmText = confirmText;
		this.cancelText = cancelText;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl, modalEl } = this;

		// 设置对话框样式，使其居中显示
		modalEl.addClass('ai-confirm-modal');

		// 添加标题和消息
		contentEl.createEl('h2', { text: this.title });
		contentEl.createEl('p', { text: this.message, cls: 'confirm-message' });

		// 添加按钮
		new Setting(contentEl)
			.addButton(button => button
				.setButtonText(this.confirmText)
				.setCta()
				.onClick(() => {
					this.onConfirm();
					this.close();
				})
			)
			.addButton(button => button
				.setButtonText(this.cancelText)
				.onClick(() => {
					this.close();
				})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// 定义插件设置接口
interface AIAutoTagsSettings {
	apiKey: string;
	tagCount: number;
	aiModel: string;
	apiEndpoint: string;
	modelName: string;
	apiVersion: string;
	timeout: number;
	enableCache: boolean;
	cacheTTL: number;
	autoExecute: boolean;
	autoExecuteTrigger: string;
	autoTaggingPaused: boolean;
	savedConfigurations: SavedAPIConfig[];
	generateProperties: boolean; // 是否生成额外属性
}

// 保存的 API 配置接口
interface SavedAPIConfig {
	name: string;
	model: string;
	apiKey: string;
	apiEndpoint: string;
	modelName: string;
	apiVersion: string;
	timeout: number;
	generateProperties: boolean;
}

// 默认设置
const DEFAULT_SETTINGS: AIAutoTagsSettings = {
	apiKey: '',
	tagCount: 5,
	aiModel: 'openai',
	apiEndpoint: '',
	modelName: '',
	apiVersion: '',
	timeout: 30000,
	enableCache: true,
	cacheTTL: 3600000,
	autoExecute: false,
	autoExecuteTrigger: '保存时',
	autoTaggingPaused: false,
	savedConfigurations: [],
	generateProperties: false // 默认不生成额外属性
}

export default class AIAutoTagsPlugin extends Plugin {
	settings: AIAutoTagsSettings;
	private aiService: AIService;
	private frontmatterService: FrontmatterService;

	async onload() {
		await this.loadSettings();

		// 初始化服务
		this.aiService = new AIService({
			apiKey: this.settings.apiKey,
			model: this.settings.aiModel as AIServiceType,
			tagCount: this.settings.tagCount,
			apiEndpoint: this.settings.apiEndpoint,
			modelName: this.settings.modelName,
			apiVersion: this.settings.apiVersion,
			timeout: this.settings.timeout,
			enableCache: this.settings.enableCache,
			cacheTTL: this.settings.cacheTTL,
			generateProperties: this.settings.generateProperties
		});
		this.frontmatterService = new FrontmatterService(this.app.vault);

		// 注册右键菜单
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
				// 添加统一的 AI 自动添加属性选项
				menu.addItem((item) => {
					item
						.setTitle('AI 自动添加属性')
						.setIcon('document-properties')
						.onClick(() => {
							// 显示确认对话框
							const modal = new ConfirmModal(this.app, {
								title: '确认生成属性',
								message: '此操作将使用 AI 生成属性并添加到文档中。这可能会修改或覆盖已有的属性（如标签、标题等）。确定要继续吗？',
								onConfirm: async () => {
									// 临时启用生成属性
									const originalSetting = this.settings.generateProperties;
									this.settings.generateProperties = true;

									const selectedText = editor.getSelection();
									const file = view.file;

									if (file) {
										if (selectedText) {
											// 处理选中的文本
											await this.processTextAndUpdateFrontmatter(file, selectedText);
										} else {
											// 处理整个文档
											const content = await this.app.vault.read(file);
											await this.processTextAndUpdateFrontmatter(file, content);
										}
									}

									// 恢复原始设置
									this.settings.generateProperties = originalSetting;
								}
							});
							modal.open();
						});
				});
			})
		);

		// 注册命令面板命令 - 生成标签
		this.addCommand({
			id: 'ai-generate-tags',
			name: 'AI 自动生成笔记标签',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				// 显示确认对话框
				const modal = new ConfirmModal(this.app, {
					title: '确认生成标签',
					message: '此操作将使用 AI 分析笔记内容并生成相关标签。如果笔记已有5个或更多标签，将不会添加新标签。确定要继续吗？',
					onConfirm: async () => {
						const selectedText = editor.getSelection();
						const file = view.file;

						if (file) {
							if (selectedText) {
								// 处理选中的文本
								await this.processTextAndUpdateFrontmatter(file, selectedText);
							} else {
								// 处理整个文档
								const content = await this.app.vault.read(file);
								await this.processTextAndUpdateFrontmatter(file, content);
							}
						}
					}
				});
				modal.open();
			}
		});

		// 注册命令面板命令 - 强制生成标签
		this.addCommand({
			id: 'ai-force-generate-tags',
			name: 'AI 强制生成笔记标签（忽略已有标签数量）',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				// 显示确认对话框
				const modal = new ConfirmModal(this.app, {
					title: '确认强制生成标签',
					message: '此操作将忽略笔记已有标签数量限制，强制添加新标签。这可能会导致标签过多。确定要继续吗？',
					onConfirm: async () => {
						const selectedText = editor.getSelection();
						const file = view.file;

						if (file) {
							if (selectedText) {
								// 处理选中的文本，强制更新
								await this.processTextAndUpdateFrontmatter(file, selectedText, true);
							} else {
								// 处理整个文档，强制更新
								const content = await this.app.vault.read(file);
								await this.processTextAndUpdateFrontmatter(file, content, true);
							}
						}
					}
				});
				modal.open();
			}
		});

		// 注册命令面板命令 - 生成所有属性
		this.addCommand({
			id: 'ai-generate-all-properties',
			name: 'AI 自动生成笔记所有属性',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				// 显示确认对话框
				const modal = new ConfirmModal(this.app, {
					title: '确认生成所有属性',
					message: '此操作将使用 AI 分析笔记内容并生成多种属性（标签、标题、作者、日期等）。这可能会覆盖笔记中已有的属性。确定要继续吗？',
					onConfirm: async () => {
						// 临时启用生成属性
						const originalSetting = this.settings.generateProperties;
						this.settings.generateProperties = true;

						const selectedText = editor.getSelection();
						const file = view.file;

						if (file) {
							if (selectedText) {
								// 处理选中的文本
								await this.processTextAndUpdateFrontmatter(file, selectedText);
							} else {
								// 处理整个文档
								const content = await this.app.vault.read(file);
								await this.processTextAndUpdateFrontmatter(file, content);
							}
						}

						// 恢复原始设置
						this.settings.generateProperties = originalSetting;
					}
				});
				modal.open();
			}
		});

		// 注册命令面板命令 - 暂停/恢复自动处理
		this.addCommand({
			id: 'ai-toggle-auto-tagging',
			name: '暂停/恢复 AI 自动处理',
			callback: () => {
				this.toggleAutoTagging();
			}
		});

		// 如果启用了自动执行，注册事件监听器
		if (this.settings.autoExecute) {
			this.registerAutoExecution();
		}

		// 添加设置选项卡
		this.addSettingTab(new AIAutoTagsSettingTab(this.app, this));
	}

	onunload() {
		// 清理工作
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);

		// 更新 AI 服务配置
		this.aiService = new AIService({
			apiKey: this.settings.apiKey,
			model: this.settings.aiModel as AIServiceType,
			tagCount: this.settings.tagCount,
			apiEndpoint: this.settings.apiEndpoint,
			modelName: this.settings.modelName,
			apiVersion: this.settings.apiVersion,
			timeout: this.settings.timeout,
			enableCache: this.settings.enableCache,
			cacheTTL: this.settings.cacheTTL,
			generateProperties: this.settings.generateProperties
		});

		// 根据设置更新自动执行
		if (this.settings.autoExecute) {
			this.registerAutoExecution();
		}
	}

	/**
	 * 注册自动执行的事件监听器
	 * 注意：这是一个占位实现，需要根据实际需求调整
	 */
	registerAutoExecution() {
		// 清除现有的事件监听器
		// 注意：需要提供正确的处理函数作为第二个参数
		// this.app.workspace.off('file-menu', this.fileMenuHandler);
		// this.app.vault.off('modify', ...);
		// this.app.vault.off('create', ...);

		// 根据触发方式注册不同的事件监听器
		switch (this.settings.autoExecuteTrigger) {
			case '保存时':
				// 监听文件保存事件
				this.registerEvent(
					this.app.vault.on('modify', debounce(async (file: TFile) => {
						// 如果自动处理已暂停，则跳过
						if (this.settings.autoTaggingPaused) {
							return;
						}

						if (file.extension === 'md') {
							const content = await this.app.vault.read(file);
							await this.processTextAndUpdateFrontmatter(file, content);
						}
					}, 5000)) // 5秒防抖
				);
				break;

			case '创建时':
				// 监听文件创建事件
				this.registerEvent(
					this.app.vault.on('create', async (file: TFile) => {
						// 如果自动处理已暂停，则跳过
						if (this.settings.autoTaggingPaused) {
							return;
						}

						if (file.extension === 'md') {
							const content = await this.app.vault.read(file);
							await this.processTextAndUpdateFrontmatter(file, content);
						}
					})
				);
				break;

			case '修改后':
				// 监听文件修改事件，使用更长的防抖时间
				this.registerEvent(
					this.app.vault.on('modify', debounce(async (file: TFile) => {
						// 如果自动处理已暂停，则跳过
						if (this.settings.autoTaggingPaused) {
							return;
						}

						if (file.extension === 'md') {
							const content = await this.app.vault.read(file);
							await this.processTextAndUpdateFrontmatter(file, content);
						}
					}, 10000)) // 10秒防抖
				);
				break;
		}
	}

	/**
	 * 暂停自动处理
	 */
	pauseAutoTagging() {
		this.settings.autoTaggingPaused = true;
		this.saveSettings();
		new Notice('AI 自动处理已暂停');
	}

	/**
	 * 恢复自动处理
	 */
	resumeAutoTagging() {
		this.settings.autoTaggingPaused = false;
		this.saveSettings();
		new Notice('AI 自动处理已恢复');
	}

	/**
	 * 切换自动处理状态
	 */
	toggleAutoTagging() {
		if (this.settings.autoTaggingPaused) {
			this.resumeAutoTagging();
		} else {
			this.pauseAutoTagging();
		}
	}

	/**
	 * 测试 API 连接
	 * @returns 测试结果信息
	 */
	async testAPIConnection(): Promise<{ success: boolean; message: string }> {
		return this.aiService.testConnection();
	}

	/**
	 * 处理文本并更新 Frontmatter
	 * @param file 当前文件
	 * @param text 要处理的文本
	 * @param forceUpdate 是否强制更新（即使已有5个或更多标签）
	 */
	async processTextAndUpdateFrontmatter(file: TFile, text: string, forceUpdate: boolean = false) {
		try {
			const noticeText = this.settings.generateProperties ? '正在生成属性...' : '正在生成标签...';
			new Notice(noticeText);

			if (this.settings.generateProperties) {
				// 生成所有属性
				const properties = await this.aiService.fetchProperties(text);

				if (properties && properties.tags && properties.tags.length > 0) {
					// 更新 Frontmatter
					const result = await this.frontmatterService.updateFrontmatter(file, properties, forceUpdate);

					// 显示结果消息
					new Notice(result.message);

					return result.updated;
				} else {
					new Notice('未能生成属性');
					return false;
				}
			} else {
				// 只生成标签
				const tags = await this.aiService.fetchTags(text);

				if (tags && tags.length > 0) {
					// 更新 Frontmatter
					const result = await this.frontmatterService.updateTags(file, tags, forceUpdate);

					// 显示结果消息
					new Notice(result.message);

					return result.updated;
				} else {
					new Notice('未能生成标签');
					return false;
				}
			}
		} catch (error) {
			console.error('处理属性时出错:', error);
			new Notice('生成属性时出错: ' + (error as Error).message);
			return false;
		}
	}




}

/**
 * 插件设置选项卡
 */
class AIAutoTagsSettingTab extends PluginSettingTab {
	plugin: AIAutoTagsPlugin;

	constructor(app: App, plugin: AIAutoTagsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.addClass('ai-tags-settings');

		containerEl.createEl('h2', { text: 'AI 自动属性设置' });

		// API 密钥设置
		new Setting(containerEl)
			.setName('AI API 密钥')
			.setDesc('输入您的 AI 服务 API 密钥（请注意保护您的密钥安全）')
			.addText(text => text
				.setPlaceholder('输入 API 密钥')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				})
			);

		// 标签数量设置
		new Setting(containerEl)
			.setName('生成标签数量')
			.setDesc('设置每次生成的标签数量')
			.addSlider(slider => slider
				.setLimits(1, 10, 1)
				.setValue(this.plugin.settings.tagCount)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.tagCount = value;
					await this.plugin.saveSettings();
				})
			);

		// AI 模型选择
		new Setting(containerEl)
			.setName('AI 模型')
			.setDesc('选择要使用的 AI 模型')
			.addDropdown(dropdown => dropdown
				.addOption('openai', 'OpenAI')
				.addOption('anthropic', 'Anthropic Claude')
				.addOption('azure-openai', 'Azure OpenAI')
				.addOption('google-ai', 'Google AI (Gemini)')
				.addOption('baidu', '百度文心一言')
				.addOption('xunfei', '讯飞星火')
				.addOption('zhipu', '智谱 AI')
				.addOption('moonshot', 'Moonshot AI')
				.addOption('deepseek', 'Deepseek')
				.addOption('openrouter', 'OpenRouter')
				.addOption('tongyi', '阿里通义千问')
				.addOption('custom', '自定义')
				.setValue(this.plugin.settings.aiModel)
				.onChange(async (value) => {
					this.plugin.settings.aiModel = value;
					await this.plugin.saveSettings();

					// 刷新设置界面以显示/隐藏相关设置
					this.display();
				})
			);

		// API 端点设置
		new Setting(containerEl)
			.setName('API 端点')
			.setDesc('设置自定义 API 端点（可选，留空使用默认端点）')
			.addText(text => text
				.setPlaceholder('输入 API 端点 URL')
				.setValue(this.plugin.settings.apiEndpoint)
				.onChange(async (value) => {
					this.plugin.settings.apiEndpoint = value;
					await this.plugin.saveSettings();
				})
			);

		// 模型名称设置
		new Setting(containerEl)
			.setName('模型名称')
			.setDesc('设置具体的模型名称（可选，留空使用默认模型）')
			.addText(text => text
				.setPlaceholder('输入模型名称')
				.setValue(this.plugin.settings.modelName)
				.onChange(async (value) => {
					this.plugin.settings.modelName = value;
					await this.plugin.saveSettings();
				})
			);

		// API 版本设置
		new Setting(containerEl)
			.setName('API 版本')
			.setDesc('设置 API 版本（可选，留空使用默认版本）')
			.addText(text => text
				.setPlaceholder('输入 API 版本')
				.setValue(this.plugin.settings.apiVersion)
				.onChange(async (value) => {
					this.plugin.settings.apiVersion = value;
					await this.plugin.saveSettings();
				})
			);

		// 请求超时设置
		new Setting(containerEl)
			.setName('请求超时')
			.setDesc('设置 API 请求超时时间（毫秒）')
			.addSlider(slider => slider
				.setLimits(5000, 60000, 5000)
				.setValue(this.plugin.settings.timeout)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.timeout = value;
					await this.plugin.saveSettings();
				})
			);

		// 启用缓存设置
		new Setting(containerEl)
			.setName('启用缓存')
			.setDesc('启用后，将缓存 AI 生成的属性结果，减少重复请求')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableCache)
				.onChange(async (value) => {
					this.plugin.settings.enableCache = value;
					await this.plugin.saveSettings();
				})
			);

		// 缓存有效期设置
		new Setting(containerEl)
			.setName('缓存有效期')
			.setDesc('设置缓存的有效期（毫秒）')
			.addDropdown(dropdown => dropdown
				.addOption('900000', '15分钟')
				.addOption('1800000', '30分钟')
				.addOption('3600000', '1小时')
				.addOption('7200000', '2小时')
				.addOption('86400000', '1天')
				.setValue(this.plugin.settings.cacheTTL.toString())
				.onChange(async (value) => {
					this.plugin.settings.cacheTTL = parseInt(value);
					await this.plugin.saveSettings();
				})
			);

		// 生成额外属性设置
		new Setting(containerEl)
			.setName('生成额外属性')
			.setDesc('启用后，除了标签外，还会生成标题、作者、日期、来源、网址、别名和摘要等属性')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.generateProperties)
				.onChange(async (value) => {
					this.plugin.settings.generateProperties = value;
					await this.plugin.saveSettings();
				})
			);

		// API 连接测试和保存按钮
		const apiTestSetting = new Setting(containerEl)
			.setName('测试 API 连接')
			.setDesc('测试当前配置的 API 连接是否正常')
			.addButton(button => button
				.setButtonText('测试连接')
				.onClick(async () => {
					// 禁用按钮，显示加载状态
					button.setButtonText('测试中...');
					button.setDisabled(true);
					saveButton.setDisabled(true);

					try {
						// 测试连接
						const result = await this.plugin.testAPIConnection();

						// 显示结果
						if (result.success) {
							new Notice('✅ ' + result.message);
							// 启用保存按钮
							saveButton.setDisabled(false);
						} else {
							new Notice('❌ ' + result.message);
							saveButton.setDisabled(true);
						}
					} catch (error) {
						new Notice('❌ 测试连接时出错: ' + (error as Error).message);
						saveButton.setDisabled(true);
					} finally {
						// 恢复按钮状态
						button.setButtonText('测试连接');
						button.setDisabled(false);
					}
				})
			);

		// 添加保存配置按钮
		const saveButton = apiTestSetting.addButton(button => button
			.setButtonText('保存配置')
			.setDisabled(true)
			.onClick(async () => {
				// 弹出对话框，让用户输入配置名称
				const modal = new SaveConfigModal(this.app, (configName) => {
					if (configName) {
						// 创建新的配置
						const newConfig: SavedAPIConfig = {
							name: configName,
							model: this.plugin.settings.aiModel,
							apiKey: this.plugin.settings.apiKey,
							apiEndpoint: this.plugin.settings.apiEndpoint,
							modelName: this.plugin.settings.modelName,
							apiVersion: this.plugin.settings.apiVersion,
							timeout: this.plugin.settings.timeout,
							generateProperties: this.plugin.settings.generateProperties
						};

						// 添加到已保存配置列表
						this.plugin.settings.savedConfigurations.push(newConfig);
						this.plugin.saveSettings();

						// 刷新设置界面
						this.display();

						new Notice(`配置 "${configName}" 已保存`);
					}
				});
				modal.open();
			})
		);

		// 已保存的配置列表
		if (this.plugin.settings.savedConfigurations.length > 0) {
			containerEl.createEl('h3', { text: '已保存的配置' });

			// 为每个已保存的配置创建设置项
			for (const config of this.plugin.settings.savedConfigurations) {
				new Setting(containerEl)
					.setName(config.name)
					.setDesc(`模型: ${config.model}${config.modelName ? `, 具体模型: ${config.modelName}` : ''}`)
					.addButton(button => button
						.setButtonText('加载')
						.onClick(async () => {
							// 加载配置
							this.plugin.settings.aiModel = config.model;
							this.plugin.settings.apiKey = config.apiKey;
							this.plugin.settings.apiEndpoint = config.apiEndpoint;
							this.plugin.settings.modelName = config.modelName;
							this.plugin.settings.apiVersion = config.apiVersion;

							// 加载新增的配置参数
							if (config.timeout !== undefined) {
								this.plugin.settings.timeout = config.timeout;
							}
							if (config.generateProperties !== undefined) {
								this.plugin.settings.generateProperties = config.generateProperties;
							}

							await this.plugin.saveSettings();

							// 刷新设置界面
							this.display();

							new Notice(`配置 "${config.name}" 已加载`);
						})
					)
					.addButton(button => button
						.setButtonText('删除')
						.onClick(async () => {
							// 删除配置
							this.plugin.settings.savedConfigurations = this.plugin.settings.savedConfigurations.filter(c => c.name !== config.name);
							await this.plugin.saveSettings();

							// 刷新设置界面
							this.display();

							new Notice(`配置 "${config.name}" 已删除`);
						})
					);
			}
		}

		// 自动执行设置
		new Setting(containerEl)
			.setName('自动执行')
			.setDesc('启用后，插件将根据选择的触发方式自动生成属性（谨慎使用，可能影响性能）')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoExecute)
				.onChange(async (value) => {
					this.plugin.settings.autoExecute = value;
					await this.plugin.saveSettings();
				})
			);

		// 自动处理暂停/恢复控制
		if (this.plugin.settings.autoExecute) {
			new Setting(containerEl)
				.setName('自动处理控制')
				.setDesc('暂停或恢复自动处理功能')
				.addButton(button => {
					const buttonText = this.plugin.settings.autoTaggingPaused ? '恢复自动处理' : '暂停自动处理';
					button
						.setButtonText(buttonText)
						.onClick(async () => {
							this.plugin.toggleAutoTagging();
							// 更新按钮文本
							button.setButtonText(this.plugin.settings.autoTaggingPaused ? '恢复自动处理' : '暂停自动处理');
						});
				});
		}

		// 自动执行触发方式
		new Setting(containerEl)
			.setName('自动执行触发方式')
			.setDesc('选择何时自动生成属性')
			.addDropdown(dropdown => dropdown
				.addOption('保存时', '保存时')
				.addOption('创建时', '创建时')
				.addOption('修改后', '修改后')
				.setValue(this.plugin.settings.autoExecuteTrigger)
				.onChange(async (value) => {
					this.plugin.settings.autoExecuteTrigger = value;
					await this.plugin.saveSettings();
				})
			);

		// 添加说明
		containerEl.createEl('h3', { text: '使用说明' });

		const usageInfo = containerEl.createEl('div', { cls: 'setting-item-description' });
		usageInfo.innerHTML = `
			<p>本插件使用 AI 为您的笔记自动生成标签和其他属性。您可以通过以下方式使用：</p>
			<ol>
				<li>在编辑器中右键点击，选择"AI 自动添加属性"，然后在确认对话框中点击"确认"</li>
				<li>使用命令面板（Ctrl+P）并搜索以下命令之一：
					<ul>
						<li>"AI 自动生成笔记标签" - 仅生成标签</li>
						<li>"AI 强制生成笔记标签" - 忽略已有标签数量限制，强制生成标签</li>
						<li>"AI 自动生成笔记所有属性" - 生成标签、标题、作者、日期、来源、网址、别名和摘要等属性</li>
					</ul>
				</li>
				<li>如果启用了自动执行，插件将根据您选择的触发方式自动生成属性</li>
				<li>您可以保存多个 API 配置，方便切换不同的 AI 服务和模型</li>
				<li>您可以暂停/恢复自动处理功能，以便在需要时临时禁用自动处理</li>
			</ol>
			<p>注意：您需要提供有效的 AI API 密钥才能使用此功能。</p>
		`;
	}
}


