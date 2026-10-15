import { FileView, normalizePath, Notice, parseYaml, Platform, Plugin, stringifyYaml, TFile } from 'obsidian';
import {
	carryThumbnails, disable, enable, findThumbnailFormula, fitTableColumns, isEnabled, isOwnFormulaName, isRecord, moveThumbnailProperty, rememberThumbnails, setViewThumbnails, summarizeViews, updateView, viewAspect,
	type ViewSummary,
} from './src/baseConfig.ts';
import { resolveViewLook, writeViewLook, type ViewLook, type ViewLookChanges } from './src/viewLook.ts';
import { resolveBaseSettings, writeStoredSettings, type BaseDefaults, type BaseSettings, type StoredBaseSettings } from './src/baseSettings.ts';
import { addGroupValue, autoColors, groupNoteProperty, normalizeHex, readGroupColors, renameGroupValue, writeGroupColors, type GroupStyle } from './src/groups.ts';
import { base64ToBytes, detectImage, firstWebUrl, IMAGE_EXTENSIONS, isHostedOn, looksLikeImage, looksLikeWebLink, parseImageInput, youtubeId, youtubeWatchUrl } from './src/images.ts';
import { strings } from './src/i18n';
import { ThumbnailModal } from './src/modal';
import { GroupMenuExtension } from './src/groupMenu';
import { kanbanViewsNeedingGroup, pickGroupProperty, setViewGroupBy } from './src/kanban.ts';
import { readGroupFiles } from './src/native';
import { BasesOverlay } from './src/overlay';
import { readLocalFile, Remote, RemoteError, type EagleClient, type EagleItem, type ImageData } from './src/remote';
import { defaultSettings, ThumbnailSettingTab, type Storage, type ThumbnailSettings } from './src/settings';
import { linkValue, readThumbnail, saveImageToVault, writeThumbnail } from './src/storage';

export type ThumbnailSource =
	| { kind: 'file'; file: File }
	| { kind: 'url'; url: string }
	/** An image that is already in the vault. */
	| { kind: 'vault'; file: TFile }
	/** A file on this computer, outside the vault. Desktop only. */
	| { kind: 'local'; path: string }
	| { kind: 'data'; mime: string; base64: string }
	| { kind: 'eagle'; item: EagleItem; client: EagleClient };

/** What a typed or pasted thumbnail input turned out to be, for the hint under the address field. */
export interface InputCheck {
	source: ThumbnailSource | null;
	kind: 'empty' | 'web' | 'youtube' | 'hosted' | 'vault' | 'local' | 'data' | 'missing' | 'not-image' | 'desktop-only' | 'unknown';
	/** File path or name to show in the hint. */
	detail: string;
}

export interface BaseInfo {
	enabled: boolean;
	/** Name of the formula that renders thumbnails in tables and lists. */
	formula: string | null;
	/** Every view of the base, for the look panel. */
	views: ViewSummary[];
	/** The look of each view (by name): its own settings, else the base's, else the defaults. */
	looks: Record<string, ViewLook>;
	/** Height ÷ width of the thumbnails of each view (by name). */
	aspects: Record<string, number>;
	/** Group value → #RRGGBB, stored in the base file and shared by its views. */
	groupColors: Record<string, string>;
	/** The base's own settings, what it already uses, and the defaults. */
	settings: BaseSettings;
	/**
	 * True when this plugin set the base up (its property is stored in the base, or the table
	 * and list thumbnails use a formula the plugin named). Only then are those images tidied;
	 * a base the user set up alone keeps its own look.
	 */
	managed: boolean;
}

/** Where a thumbnail goes: the property, image folder and link property of the base it is added from. */
export interface ThumbnailContext {
	property: string;
	linkProperty: string;
	folder: string;
	/** Name of the base, or null when the defaults from the settings are used. */
	baseName: string | null;
	/** Where images go when nobody asks, whether the window asks, and the R2 vault copy. */
	defaultStorage: 'vault' | 'r2';
	askStorage: boolean;
	keepVaultCopy: boolean;
}

export default class AchmageBasesLookPlugin extends Plugin {
	override settings: ThumbnailSettings = defaultSettings();
	remote!: Remote;
	private overlay!: BasesOverlay;
	private groupMenu!: GroupMenuExtension;
	private readonly baseCache = new Map<string, { mtime: number; info: BaseInfo | null }>();
	private readonly baseLoading = new Set<string>();
	/** Kanban views this session already tried to group automatically (`path` + `view name`). */
	private readonly kanbanTried = new Set<string>();
	/** Base files created while the plugin runs: only their kanban views are grouped on first sight. */
	private readonly createdBases = new Set<string>();

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.remote = new Remote(this.app, () => this.settings);
		this.overlay = new BasesOverlay(this);
		this.groupMenu = new GroupMenuExtension(this);
		this.groupMenu.watch(document);
		this.addSettingTab(new ThumbnailSettingTab(this));

		const t = strings();
		this.addCommand({
			id: 'add-thumbnail',
			name: t.cmdAdd,
			icon: 'image-plus',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				if (!checking) this.openThumbnailModal(file);
				return true;
			},
		});
		this.addCommand({
			id: 'open-look-panel',
			name: t.cmdPanel,
			icon: 'sliders-horizontal',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(FileView);
				if (!view || !(view.file instanceof TFile) || view.file.extension !== 'base') return false;
				if (!checking) this.overlay.openPanel(view);
				return true;
			},
		});
		this.addCommand({
			id: 'toggle-base-thumbnails',
			name: t.cmdToggle,
			icon: 'image',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'base') return false;
				if (!checking) void this.toggleBase(file);
				return true;
			},
		});

		this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
			if (!(file instanceof TFile)) return;
			if (file.extension === 'md') {
				menu.addItem((item) => item.setTitle(t.fileMenuAdd).setIcon('image-plus').setSection('action')
					.onClick(() => this.openThumbnailModal(file)));
			} else if (file.extension === 'base') {
				const enabled = this.baseInfo(file)?.enabled ?? false;
				menu.addItem((item) => item.setTitle(enabled ? t.fileMenuHide : t.fileMenuShow).setIcon('image').setSection('action')
					.onClick(() => void this.toggleBase(file)));
			}
		}));

		this.registerEvent(this.app.workspace.on('layout-change', () => this.overlay.attachAll()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.overlay.attachAll()));
		this.registerEvent(this.app.workspace.on('window-open', (win) => this.groupMenu.watch(win.doc)));
		this.registerEvent(this.app.metadataCache.on('changed', () => this.overlay.refreshAll()));
		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file instanceof TFile && file.extension === 'base') {
				void this.followLayoutChanges(file);
				this.overlay.refreshAll();
				this.groupMenu.refresh();
			}
		}));
		this.app.workspace.onLayoutReady(() => {
			this.overlay.attachAll();
			void this.checkCmdsEagle();
			// Registered after loading: Obsidian reports every existing file as created while it loads.
			this.registerEvent(this.app.vault.on('create', (file) => {
				if (file instanceof TFile && file.extension === 'base') this.createdBases.add(file.path);
			}));
			this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && this.createdBases.delete(oldPath)) this.createdBases.add(file.path);
			}));
		});
	}

	override onunload(): void {
		this.overlay.destroy();
		this.groupMenu.destroy();
	}

	private async loadSettings(): Promise<void> {
		const stored: unknown = await this.loadData();
		const defaults = defaultSettings();
		const merged: Record<string, unknown> = { ...defaults };
		if (isRecord(stored)) {
			for (const [key, value] of Object.entries(stored)) {
				if (key in defaults && typeof value === typeof defaults[key as keyof ThumbnailSettings]) merged[key] = value;
			}
		}
		this.settings = merged as unknown as ThumbnailSettings;
	}

	async updateSetting(key: keyof ThumbnailSettings, value: unknown): Promise<void> {
		const defaults = defaultSettings();
		if (typeof value !== typeof defaults[key]) return;
		let clean = typeof value === 'string' ? value.trim() : value;
		// Same clean-up as the CMDS Eagle plugin: the Worker URL gets https:// and no trailing slash.
		if (key === 'r2WorkerUrl' && typeof clean === 'string' && clean) clean = (clean.startsWith('http') ? clean : `https://${clean}`).replace(/\/$/, '');
		if (key === 'r2PublicUrl' && typeof clean === 'string') clean = clean.replace(/\/$/, '');
		const next: Record<string, unknown> = { ...this.settings, [key]: clean };
		if (key === 'property' && !String(next.property)) return;
		if (key === 'kanbanGroupProperty' && !String(next.kanbanGroupProperty)) return;
		this.settings = next as unknown as ThumbnailSettings;
		await this.saveData(this.settings);
		if (key === 'property') this.baseCache.clear();
		this.overlay.refreshAll();
	}

	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
		setting?.open?.();
		setting?.openTabById?.(this.manifest.id);
	}

	/** Open the thumbnail window for a note, with the settings of the base it was opened from. */
	openThumbnailModal(note: TFile, base: TFile | null = null): void {
		new ThumbnailModal(this, note, this.contextFor(base)).open();
	}

	hasThumbnail(note: TFile, property: string = this.settings.property): boolean {
		return readThumbnail(this.app, note, property) !== null;
	}

	/**
	 * What a base without settings of its own uses. The settings tab no longer shows these: they
	 * are the built-in defaults, or the values someone set in an earlier version, kept so that
	 * nothing changes for them.
	 */
	baseDefaults(): BaseDefaults {
		const s = this.settings;
		return {
			property: s.property, linkProperty: s.linkProperty, folder: s.folder, autoKanbanGroup: s.autoKanbanGroup,
			kanbanGroupProperty: s.kanbanGroupProperty, defaultStorage: s.defaultStorage, askStorage: s.askStorage, keepVaultCopy: s.keepVaultCopy,
		};
	}

	/** What a view without look settings of its own uses (see baseDefaults). */
	viewLookDefaults(): ViewLook {
		const s = this.settings;
		return {
			listSize: s.listSize,
			shape: null,
			fit: 'cover',
			placeholders: s.showPlaceholders,
			tidy: s.tidyImages,
			hoverLift: s.hoverLift,
			hoverRows: s.hoverRows,
			hoverColor: s.hoverUseAccent ? null : normalizeHex(s.hoverColor),
			groupStyle: { background: s.groupBackground, tint: s.groupTint, border: s.groupBorder, heading: s.groupHeading },
		};
	}

	/** Where thumbnails added from this base go. Without a base, the defaults. */
	contextFor(base: TFile | null): ThumbnailContext {
		const settings = base ? this.baseInfo(base)?.settings ?? null : null;
		const resolved = settings ?? resolveBaseSettings({}, this.baseDefaults());
		return {
			property: resolved.thumbnailProperty,
			linkProperty: resolved.linkProperty.trim(),
			folder: resolved.imageFolder,
			baseName: settings && base ? base.basename : null,
			defaultStorage: resolved.defaultStorage,
			askStorage: resolved.askStorage,
			keepVaultCopy: resolved.keepVaultCopy,
		};
	}

	/** The note property a parsed base shows as thumbnails. */
	private propertyOf(base: Record<string, unknown>): string {
		return resolveBaseSettings(base, this.baseDefaults()).thumbnailProperty;
	}

	// ---- .base files -------------------------------------------------------------------

	private parseBase(text: string): Record<string, unknown> | null {
		try {
			const parsed: unknown = text.trim() ? parseYaml(text) : {};
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	private describe(base: Record<string, unknown>): BaseInfo {
		const settings = resolveBaseSettings(base, this.baseDefaults());
		const property = settings.thumbnailProperty;
		const formula = findThumbnailFormula(base, property);
		const views = summarizeViews(base, property);
		const looks: Record<string, ViewLook> = {};
		const aspects: Record<string, number> = {};
		const defaults = this.viewLookDefaults();
		const rawViews = Array.isArray(base.views) ? base.views.filter(isRecord) : [];
		for (const view of rawViews) {
			if (typeof view.name !== 'string') continue;
			looks[view.name] = resolveViewLook(base, view.name, defaults);
			aspects[view.name] = viewAspect(base, view, property);
		}
		return {
			settings,
			managed: settings.thumbnailSource === 'base' || (formula !== null && isOwnFormulaName(formula, property)),
			enabled: isEnabled(base, property),
			formula,
			views,
			looks,
			aspects,
			groupColors: readGroupColors(base),
		};
	}

	/**
	 * Cached facts about a base file. Returns the last known answer at once and refreshes
	 * in the background when the file changed; `onReady` runs after a refresh.
	 */
	baseInfo(file: TFile, onReady?: () => void): BaseInfo | null {
		const cached = this.baseCache.get(file.path);
		if (cached && cached.mtime === file.stat.mtime) return cached.info;
		if (!this.baseLoading.has(file.path)) {
			this.baseLoading.add(file.path);
			void this.app.vault.cachedRead(file).then((text) => {
				const base = this.parseBase(text);
				const info = base ? this.describe(base) : null;
				this.baseCache.set(file.path, { mtime: file.stat.mtime, info });
				if (info) void this.autoGroupKanban(file, cached?.info ?? null, info);
			}).finally(() => {
				this.baseLoading.delete(file.path);
				onReady?.();
			});
		}
		return cached?.info ?? null;
	}

	private async editBase(file: TFile, change: (base: Record<string, unknown>) => void): Promise<BaseInfo | null> {
		let info: BaseInfo | null = null;
		await this.app.vault.process(file, (text) => {
			const base = this.parseBase(text);
			if (!base) throw new Error('unreadable base');
			change(base);
			info = this.describe(base);
			return stringifyYaml(base);
		});
		// Keep the new facts cached so the toolbar does not flicker to “off” while Bases reloads the file.
		this.baseCache.set(file.path, { mtime: file.stat.mtime, info });
		this.overlay.refreshAll();
		return info;
	}

	/** Turn thumbnails on or off in every view of the base (command, file menu, panel). */
	async toggleBase(file: TFile): Promise<void> {
		try {
			const base = this.parseBase(await this.app.vault.read(file));
			if (!base) throw new Error('unreadable base');
			await this.setAllViews(file, !isEnabled(base, this.propertyOf(base)));
		} catch {
			new Notice(strings().baseUnreadable);
		}
	}

	/** Turn thumbnails on (in every view that has no image yet) or off in the whole base. */
	async setAllViews(file: TFile, on: boolean): Promise<BaseInfo | null> {
		const t = strings();
		try {
			const info = await this.editBase(file, (draft) => {
				const property = this.propertyOf(draft);
				if (on) enable(draft, property, this.settings.defaultRatio);
				else disable(draft, property);
			});
			if (on && !info?.enabled) new Notice(t.baseNoViews);
			else new Notice(on ? t.baseShown(file.basename) : t.baseHidden(file.basename));
			return info;
		} catch {
			new Notice(t.baseUnreadable);
			return null;
		}
	}

	/** Turn thumbnails on or off in one view only: the one whose toolbar button was clicked. */
	async toggleView(file: TFile, viewName: string): Promise<void> {
		const t = strings();
		try {
			let on = false;
			let found = false;
			await this.editBase(file, (draft) => {
				const property = this.propertyOf(draft);
				const view = summarizeViews(draft, property).find((each) => each.name === viewName);
				if (!view) return;
				found = true;
				on = !view.thumbnails;
				setViewThumbnails(draft, viewName, property, on);
				if (on) rememberThumbnails(draft, viewName, property, this.settings.defaultRatio);
				fitTableColumns(draft, property);
			});
			if (found) new Notice(on ? t.viewShown(viewName) : t.viewHidden(viewName));
		} catch {
			new Notice(t.baseUnreadable);
		}
	}

	/** Change the look of one view only (list size, shape, fit, frames, tidying, hover, group look). */
	async setViewLook(file: TFile, viewName: string, changes: ViewLookChanges): Promise<BaseInfo | null> {
		try {
			return await this.editBase(file, (draft) => {
				writeViewLook(draft, viewName, changes);
				if ('shape' in changes) fitTableColumns(draft, this.propertyOf(draft));
			});
		} catch {
			new Notice(strings().baseUnreadable);
			return null;
		}
	}

	emptyBaseInfo(): BaseInfo {
		return {
			enabled: false, formula: null, views: [], looks: {}, aspects: {}, groupColors: {},
			settings: resolveBaseSettings({}, this.baseDefaults()),
			managed: false,
		};
	}

	/** The look of one view of a base, or the defaults. */
	viewLookOf(info: BaseInfo | null, viewName: string | null): ViewLook {
		return (viewName && info?.looks[viewName]) || this.viewLookDefaults();
	}

	/**
	 * Change this base's own settings (thumbnail property, link property, image folder, kanban
	 * grouping, list size); null returns one to the default. Thumbnails that are on follow a new
	 * thumbnail property; the notes keep their values.
	 */
	async setBaseSettings(file: TFile, changes: { [K in keyof StoredBaseSettings]?: StoredBaseSettings[K] | null }): Promise<BaseInfo | null> {
		try {
			return await this.editBase(file, (draft) => {
				const before = this.propertyOf(draft);
				const shown = isEnabled(draft, before);
				writeStoredSettings(draft, changes);
				const after = this.propertyOf(draft);
				if (shown && after !== before) {
					moveThumbnailProperty(draft, before, after);
					fitTableColumns(draft, after);
				}
			});
		} catch {
			new Notice(strings().baseUnreadable);
			return null;
		}
	}

	/** Group look of one view (background, tint, border, heading). Group colors stay per base. */
	async setGroupStyle(file: TFile, viewName: string, changes: Partial<GroupStyle>): Promise<BaseInfo | null> {
		return this.setViewLook(file, viewName, { groupStyle: changes });
	}

	/** Change settings of one view (layout, column width, card size, row height, image fit or ratio). */
	async setViewOptions(file: TFile, viewName: string, changes: Record<string, unknown>): Promise<BaseInfo | null> {
		try {
			return await this.editBase(file, (draft) => {
				const property = this.propertyOf(draft);
				const before = summarizeViews(draft, property).find((view) => view.name === viewName);
				updateView(draft, viewName, changes);
				// A new layout keeps the thumbnails the view had.
				if (before?.thumbnails && typeof changes.type === 'string' && changes.type !== before.type) carryThumbnails(draft, property, [viewName]);
				fitTableColumns(draft, property);
			});
		} catch {
			new Notice(strings().baseUnreadable);
			return null;
		}
	}

	/**
	 * After the base file changed, move thumbnails along with any view whose layout was changed
	 * in Obsidian's own view settings. Compares with the last known state of the file, so views
	 * whose thumbnails were turned off stay off.
	 */
	private async followLayoutChanges(file: TFile): Promise<void> {
		const known = this.baseCache.get(file.path)?.info;
		if (!known?.enabled) return;
		const property = known.settings.thumbnailProperty;
		try {
			const base = this.parseBase(await this.app.vault.read(file));
			if (!base) return;
			const types = new Map(known.views.filter((view) => view.thumbnails).map((view) => [view.name, view.type]));
			const moved = summarizeViews(base, property)
				.filter((view) => types.has(view.name) && types.get(view.name) !== view.type && !view.thumbnails)
				.map((view) => view.name);
			if (moved.length === 0 || !carryThumbnails(base, property, moved)) return;
			await this.editBase(file, (draft) => {
				carryThumbnails(draft, property, moved);
				fitTableColumns(draft, property);
			});
		} catch {
			// The view still works; only the thumbnails stay where Obsidian left them.
		}
	}

	/**
	 * A kanban view without a group property shows only Obsidian's “Choose a property”. Group it
	 * so its notes show at once (under “None” while they have no value). Skipped when the user
	 * has just removed the grouping, or turned this off in the settings.
	 */
	private async autoGroupKanban(file: TFile, previous: BaseInfo | null, info: BaseInfo): Promise<void> {
		if (!info.settings.autoKanbanGroup) return;
		const views = kanbanViewsNeedingGroup(info.views, previous?.views ?? null, this.createdBases.has(file.path))
			.filter((name) => !this.kanbanTried.has(`${file.path}\n${name}`));
		if (views.length === 0) return;
		for (const name of views) this.kanbanTried.add(`${file.path}\n${name}`);
		const property = this.kanbanGroupPropertyFor(file);
		try {
			await this.editBase(file, (draft) => {
				for (const name of views) setViewGroupBy(draft, name, property);
			});
			new Notice(strings().kanbanGrouped(property));
		} catch {
			// The view keeps Obsidian's own “Choose a property”.
		}
	}

	/** Group a kanban view by hand, from the button next to Obsidian's “Choose a property”. */
	async groupKanbanView(file: TFile, viewName: string): Promise<BaseInfo | null> {
		const property = this.kanbanGroupPropertyFor(file);
		try {
			const info = await this.editBase(file, (draft) => setViewGroupBy(draft, viewName, property));
			new Notice(strings().kanbanGrouped(property));
			return info;
		} catch {
			new Notice(strings().baseUnreadable);
			return null;
		}
	}

	/** Group property for a kanban view of this base: a status property the notes use, else the setting. */
	kanbanGroupPropertyFor(file: TFile): string {
		const notes = new Set<TFile>();
		for (const leaf of this.app.workspace.getLeavesOfType('bases')) {
			if (!(leaf.view instanceof FileView) || leaf.view.file !== file) continue;
			for (const group of readGroupFiles(leaf.view)?.values() ?? []) group.forEach((note) => notes.add(note));
		}
		const frontmatters = [...notes].map((note) => this.app.metadataCache.getFileCache(note)?.frontmatter);
		return pickGroupProperty(frontmatters, this.baseInfo(file)?.settings.kanbanGroupProperty ?? this.settings.kanbanGroupProperty);
	}

	async setViewThumbnails(file: TFile, viewName: string, on: boolean): Promise<BaseInfo | null> {
		try {
			return await this.editBase(file, (draft) => {
				const property = this.propertyOf(draft);
				setViewThumbnails(draft, viewName, property, on);
				if (on) rememberThumbnails(draft, viewName, property, this.settings.defaultRatio);
				fitTableColumns(draft, property);
			});
		} catch {
			new Notice(strings().baseUnreadable);
			return null;
		}
	}

	/** Set or clear (null) group colors in the base file. */
	async setGroupColors(file: TFile, changes: Record<string, string | null>): Promise<BaseInfo | null> {
		try {
			return await this.editBase(file, (draft) => writeGroupColors(draft, changes));
		} catch {
			new Notice(strings().baseUnreadable);
			return null;
		}
	}

	// ---- group values ----------------------------------------------------------------------

	/**
	 * How the notes shown in this base use each property: how many have it, and how many hold an
	 * image or a web address. Feeds the property suggestions in the look panel.
	 */
	basePropertyStats(root: HTMLElement): Map<string, { notes: number; images: number; links: number }> {
		const stats = new Map<string, { notes: number; images: number; links: number }>();
		const notes = new Set<TFile>();
		for (const group of this.groupFiles(root)?.values() ?? []) group.forEach((note) => notes.add(note));
		for (const note of notes) {
			const frontmatter = this.app.metadataCache.getFileCache(note)?.frontmatter;
			if (!frontmatter) continue;
			for (const [name, value] of Object.entries(frontmatter)) {
				const entry = stats.get(name) ?? { notes: 0, images: 0, links: 0 };
				entry.notes++;
				if (looksLikeImage(value)) entry.images++;
				if (looksLikeWebLink(value)) entry.links++;
				stats.set(name, entry);
			}
		}
		return stats;
	}

	/** Notes per group (value as text, '' for no value) of the base view shown in this container. */
	groupFiles(root: HTMLElement): Map<string, TFile[]> | null {
		const leaf = this.app.workspace.getLeavesOfType('bases').find((each) => each.view.containerEl === root);
		return leaf ? readGroupFiles(leaf.view) : null;
	}

	/**
	 * Rename a group: every note in it gets the new value, and the base keeps the group's color
	 * and its place in views that order groups by hand. Values that are not text are left alone.
	 */
	async renameGroup(base: TFile, root: HTMLElement, property: string, from: string, to: string): Promise<BaseInfo | null> {
		const t = strings();
		const name = groupNoteProperty(property);
		const files = this.groupFiles(root)?.get(from) ?? null;
		if (!name || files === null) {
			new Notice(t.groupRenameUnsupported);
			return null;
		}
		let changed = 0;
		for (const file of files) {
			await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				const value = frontmatter[name];
				if (typeof value === 'string' && value.trim() === from) {
					frontmatter[name] = to;
					changed++;
				} else if (Array.isArray(value) && value.includes(from)) {
					frontmatter[name] = value.map((item: unknown) => (item === from ? to : item)).filter((item, i, all) => all.indexOf(item) === i);
					changed++;
				}
			});
		}
		if (files.length > 0 && changed === 0) {
			new Notice(t.groupRenameNone);
			return null;
		}
		try {
			const info = await this.editBase(base, (draft) => renameGroupValue(draft, property, from, to));
			new Notice(t.groupRenameDone(from, to, changed));
			return info;
		} catch {
			new Notice(strings().baseUnreadable);
			return null;
		}
	}

	/** Add an empty group to a view (the view then orders its groups by hand). */
	async addGroup(base: TFile, root: HTMLElement, viewName: string, value: string): Promise<BaseInfo | null> {
		const t = strings();
		const groups = this.groupFiles(root);
		if (!groups) {
			new Notice(t.groupRenameUnsupported);
			return null;
		}
		if (groups.has(value)) {
			new Notice(t.groupAddExists(value));
			return null;
		}
		let added = false;
		try {
			const info = await this.editBase(base, (draft) => {
				added = addGroupValue(draft, viewName, value, [...groups.keys()]);
				// In a base that uses group colors, the new group gets the next free one.
				const colors = readGroupColors(draft);
				if (added && Object.keys(colors).length > 0 && !colors[value]) {
					writeGroupColors(draft, { [value]: autoColors([value], colors)[value] ?? null });
				}
			});
			new Notice(added ? t.groupAddDone(value) : t.groupAddExists(value));
			return info;
		} catch {
			new Notice(t.baseUnreadable);
			return null;
		}
	}

	// ---- adding images -------------------------------------------------------------------

	/**
	 * Work out what typed or pasted text points at: a web address (bare or inside Markdown or
	 * HTML), an image in the vault, a file on this computer, or embedded image data.
	 */
	checkInput(text: string, note: TFile | null): InputCheck {
		const parsed = parseImageInput(text);
		if (!parsed) return { source: null, kind: text.trim() ? 'unknown' : 'empty', detail: '' };
		if (parsed.kind === 'url') {
			if (youtubeId(parsed.url)) return { source: parsed, kind: 'youtube', detail: parsed.url };
			return { source: parsed, kind: isHostedOn(parsed.url, this.settings.r2PublicUrl) ? 'hosted' : 'web', detail: parsed.url };
		}
		if (parsed.kind === 'data') return { source: parsed, kind: 'data', detail: '' };
		if (parsed.kind === 'local') {
			return Platform.isDesktop
				? { source: parsed, kind: 'local', detail: parsed.path }
				: { source: null, kind: 'desktop-only', detail: parsed.path };
		}
		const linkpath = parsed.linkpath.trim();
		const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, note?.path ?? '')
			?? this.app.vault.getFileByPath(normalizePath(linkpath))
			// [[picture]] without its extension: look for an image of that name.
			?? this.app.vault.getFiles().find((each) => IMAGE_EXTENSIONS.includes(each.extension.toLowerCase())
				&& (each.basename === linkpath || each.path.slice(0, -each.extension.length - 1) === linkpath))
			?? null;
		const extension = /\.([a-z0-9]+)$/i.exec(linkpath)?.[1]?.toLowerCase() ?? '';
		if (!file) return { source: null, kind: IMAGE_EXTENSIONS.includes(extension) ? 'missing' : 'unknown', detail: linkpath };
		if (!IMAGE_EXTENSIONS.includes(file.extension.toLowerCase())) return { source: null, kind: 'not-image', detail: file.path };
		return { source: { kind: 'vault', file }, kind: 'vault', detail: file.path };
	}

	/** Turn something dropped or pasted into a thumbnail source, or null if it holds no image. */
	sourceFromTransfer(transfer: DataTransfer, note: TFile | null = null): ThumbnailSource | null {
		const file = Array.from(transfer.files).find((each) => each.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(each.name));
		if (file) return { kind: 'file', file };
		const url = firstWebUrl(transfer.getData('text/uri-list'));
		if (url) return { kind: 'url', url };
		for (const text of [transfer.getData('text/plain'), transfer.getData('text/html')]) {
			const source = text ? this.checkInput(text, note).source : null;
			if (source) return source;
		}
		return null;
	}

	/** Dropped straight onto a card: use the default destination without asking. */
	async addFromDataTransfer(note: TFile, transfer: DataTransfer, base: TFile | null = null): Promise<void> {
		const source = this.sourceFromTransfer(transfer, note);
		if (!source) {
			new Notice(strings().notImage);
			return;
		}
		const context = this.contextFor(base);
		const storage = context.defaultStorage === 'r2' && this.remote.r2Config() ? 'r2' : 'vault';
		await this.addThumbnail(note, source, storage, context);
	}

	private async readSource(source: ThumbnailSource): Promise<ImageData> {
		if (source.kind === 'url') return this.remote.download(source.url);
		if (source.kind === 'eagle') return source.client.read(source.item);
		let data: ArrayBuffer;
		let mime: string | undefined;
		let name: string;
		if (source.kind === 'vault') {
			data = await this.app.vault.readBinary(source.file);
			name = source.file.name;
		} else if (source.kind === 'local') {
			try {
				data = await readLocalFile(source.path);
			} catch {
				throw new RemoteError('local-file');
			}
			name = source.path.split(/[\\/]/).pop() || 'image';
		} else if (source.kind === 'data') {
			data = base64ToBytes(source.base64).slice().buffer;
			mime = source.mime;
			name = 'image';
		} else {
			data = await source.file.arrayBuffer();
			mime = source.file.type;
			name = source.file.name;
		}
		const type = detectImage(new Uint8Array(data), mime, name);
		if (!type) throw new RemoteError('not-image');
		return { ...type, data, name };
	}

	/** Store the image and write the note property. Returns false (after a notice) on failure. */
	async addThumbnail(note: TFile, source: ThumbnailSource, storage: Storage, context: ThumbnailContext = this.contextFor(null)): Promise<boolean> {
		const t = strings();
		try {
			let value: string;
			const video = source.kind === 'url' ? youtubeId(source.url) : null;
			if (source.kind === 'url' && video) {
				// A YouTube video: its preview image is the thumbnail.
				const preview = await this.remote.youtubeThumbnail(video);
				value = storage === 'link' ? preview.url : await this.storeImage(note, preview.image, storage, null, context);
			} else if (source.kind === 'url' && (storage === 'link' || isHostedOn(source.url, this.settings.r2PublicUrl))) {
				// Link only, or an image already on Cloudflare R2: nothing to store again.
				value = source.url;
			} else if (source.kind === 'vault' && storage !== 'r2') {
				value = linkValue(this.app, source.file, note);
			} else {
				const image = await this.readSource(source);
				value = await this.storeImage(note, image, storage, source.kind === 'vault' ? source.file : null, context);
			}
			await writeThumbnail(this.app, note, context.property, value);
			new Notice(t.added(note.basename));
			if (source.kind === 'url' && video && !(await this.writeVideoLink(note, youtubeWatchUrl(source.url, video), context.linkProperty))) {
				new Notice(t.linkKept(context.linkProperty));
			}
			return true;
		} catch (error) {
			const message = error instanceof RemoteError
				? error.message === 'not-image' ? t.notImage
					: error.message === 'download' ? t.downloadFailed(error.status)
						: error.message === 'r2-missing' ? t.r2Missing
							: error.message === 'local-file' ? t.localFailed
								: error.message.startsWith('eagle') ? t.eagleOffline
									: t.r2Failed(error.message)
				: error instanceof Error ? error.message : String(error);
			new Notice(message);
			return false;
		}
	}

	/**
	 * Save image data as the thumbnail: in the vault, or uploaded to Cloudflare R2 (with a vault
	 * copy when the settings ask for one, unless the image already is a vault file).
	 */
	private async storeImage(note: TFile, image: ImageData, storage: Storage, vaultFile: TFile | null, context: ThumbnailContext): Promise<string> {
		if (storage !== 'r2') return linkValue(this.app, await saveImageToVault(this.app, context.folder, note, image), note);
		const saved = context.keepVaultCopy && !vaultFile ? await saveImageToVault(this.app, context.folder, note, image) : null;
		return this.remote.uploadToR2(image, saved?.name ?? vaultFile?.name ?? `${note.basename}.${image.ext}`);
	}

	/**
	 * Keep the video address in the link property, so the ▶ button on the thumbnail opens it.
	 * Another address already there is left alone. Returns false in that case.
	 */
	private async writeVideoLink(note: TFile, url: string, linkProperty: string): Promise<boolean> {
		const property = linkProperty.trim();
		if (!property) return true;
		let written = true;
		await this.app.fileManager.processFrontMatter(note, (frontmatter: Record<string, unknown>) => {
			const current: unknown = frontmatter[property];
			const text = typeof current === 'string' ? current.trim() : '';
			const parsed = text ? parseImageInput(text) : null;
			// Empty, or another YouTube video: replace. Anything else belongs to the user.
			const replaceable = current === undefined || current === null || (typeof current === 'string' && (!text || (parsed?.kind === 'url' && youtubeId(parsed.url) !== null)));
			if (replaceable) frontmatter[property] = url;
			else written = false;
		});
		return written;
	}

	/** True when this vault has CMDS Eagle settings that hold a Cloudflare R2 worker. Set on load. */
	cmdsEagleFound = false;

	private cmdsEaglePath(): string {
		return `${this.app.vault.configDir}/plugins/cmds-eagle/data.json`;
	}

	private async readCmdsEagleR2(): Promise<{ workerUrl: string; apiKey: string; publicUrl: string } | null> {
		try {
			const data: unknown = JSON.parse(await this.app.vault.adapter.read(this.cmdsEaglePath()));
			const providers = isRecord(data) && isRecord(data.cloudProviders) ? data.cloudProviders : null;
			const r2 = providers && isRecord(providers.r2) ? providers.r2 : null;
			const pick = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
			const found = {
				workerUrl: pick(r2?.workerUrl) || (isRecord(data) ? pick(data.r2WorkerUrl) : ''),
				apiKey: pick(r2?.apiKey) || (isRecord(data) ? pick(data.r2ApiKey) : ''),
				publicUrl: pick(r2?.publicUrl) || (isRecord(data) ? pick(data.r2PublicUrl) : ''),
			};
			return found.workerUrl && found.apiKey ? found : null;
		} catch {
			return null;
		}
	}

	async checkCmdsEagle(): Promise<void> {
		this.cmdsEagleFound = (await this.readCmdsEagleR2()) !== null;
	}

	getR2ApiKey(): string {
		const id = this.settings.r2ApiKeySecret;
		return id ? (this.app.secretStorage.getSecret(id) ?? '') : '';
	}

	/** Keep the API key in Obsidian's secret storage; the settings file only holds its id. */
	async setR2ApiKey(value: string): Promise<void> {
		const id = this.settings.r2ApiKeySecret || 'achmage-bases-look-r2-api-key';
		this.app.secretStorage.setSecret(id, value.trim());
		if (this.settings.r2ApiKeySecret !== id) {
			this.settings = { ...this.settings, r2ApiKeySecret: id };
			await this.saveData(this.settings);
		}
	}

	/** Copy the Cloudflare R2 worker settings from the CMDS Eagle plugin. The key goes to secret storage. */
	async importCmdsEagle(): Promise<boolean> {
		const found = await this.readCmdsEagleR2();
		if (!found) return false;
		const secretId = this.settings.r2ApiKeySecret || 'achmage-bases-look-r2-api-key';
		this.app.secretStorage.setSecret(secretId, found.apiKey);
		this.settings = { ...this.settings, r2WorkerUrl: found.workerUrl, r2PublicUrl: found.publicUrl, r2ApiKeySecret: secretId };
		await this.saveData(this.settings);
		return true;
	}

	async removeThumbnail(note: TFile, context: ThumbnailContext = this.contextFor(null)): Promise<void> {
		await writeThumbnail(this.app, note, context.property, null);
		new Notice(strings().removed(note.basename));
	}
}
