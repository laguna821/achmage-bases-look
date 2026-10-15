import { getLanguage, Notice, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { listPixelsFor, type RatioPreset } from './baseConfig.ts';
import { strings } from './i18n';
import type AchmageBasesLookPlugin from '../main';

export type Storage = 'vault' | 'r2' | 'link';

export interface ThumbnailSettings {
	property: string;
	folder: string;
	defaultStorage: 'vault' | 'r2';
	askStorage: boolean;
	keepVaultCopy: boolean;
	r2WorkerUrl: string;
	/** Id of the API key in Obsidian's secret storage, not the key itself. */
	r2ApiKeySecret: string;
	r2PublicUrl: string;
	eagleEnabled: boolean;
	eagleUrl: string;
	showPlaceholders: boolean;
	showToolbarButton: boolean;
	tidyImages: boolean;
	/** List thumbnail size on the 0–100 scale shared with the toolbar panel. */
	listSize: number;
	defaultRatio: RatioPreset;
	groupBackground: boolean;
	/** Background shade strength in percent. */
	groupTint: number;
	groupBorder: boolean;
	groupHeading: boolean;
	hoverLift: boolean;
	hoverRows: boolean;
	hoverUseAccent: boolean;
	hoverColor: string;
	/** Sections of the look panel the user folded away. */
	panelCollapsed: string[];
	/** Group kanban views that have no group property, so their notes show at once. */
	autoKanbanGroup: boolean;
	/** Group property for such views when the notes have no status-like property. */
	kanbanGroupProperty: string;
}

export function defaultSettings(): ThumbnailSettings {
	const korean = getLanguage().toLowerCase().startsWith('ko');
	return {
		property: korean ? '썸네일' : 'thumbnail',
		folder: korean ? '썸네일' : 'Thumbnails',
		defaultStorage: 'vault',
		askStorage: true,
		keepVaultCopy: false,
		r2WorkerUrl: '',
		r2ApiKeySecret: '',
		r2PublicUrl: '',
		eagleEnabled: true,
		eagleUrl: 'http://localhost:41595',
		showPlaceholders: true,
		showToolbarButton: true,
		tidyImages: true,
		listSize: 45,
		defaultRatio: 'landscape',
		groupBackground: true,
		groupTint: 10,
		groupBorder: true,
		groupHeading: true,
		hoverLift: true,
		hoverRows: true,
		hoverUseAccent: true,
		hoverColor: '#0090FF',
		panelCollapsed: [],
		autoKanbanGroup: true,
		kanbanGroupProperty: korean ? '상태' : 'status',
	};
}

const SETTING_KEYS = new Set<string>(Object.keys(defaultSettings()));

export function isSettingKey(key: string): key is keyof ThumbnailSettings {
	return SETTING_KEYS.has(key);
}

/**
 * The API Key field is a plain text field, as in CMDS Eagle, but the value goes to Obsidian's
 * secret storage instead of the plugin settings file.
 */
export const R2_API_KEY_FIELD = 'r2ApiKey';

export class ThumbnailSettingTab extends PluginSettingTab {
	private readonly owner: AchmageBasesLookPlugin;

	constructor(plugin: AchmageBasesLookPlugin) {
		super(plugin.app, plugin);
		this.owner = plugin;
		this.icon = 'image';
	}

	override getControlValue(key: string): unknown {
		if (key === R2_API_KEY_FIELD) return this.owner.getR2ApiKey();
		return isSettingKey(key) ? this.owner.settings[key] : undefined;
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === R2_API_KEY_FIELD) {
			await this.owner.setR2ApiKey(typeof value === 'string' ? value : '');
			return;
		}
		if (!isSettingKey(key)) return;
		await this.owner.updateSetting(key, value);
		this.update();
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		const t = strings();
		const r2Visible = () => this.owner.settings.defaultStorage === 'r2' || this.owner.settings.askStorage;
		return [
			{
				type: 'group',
				heading: t.headingProperty,
				items: [
					{
						name: t.propertyName,
						desc: t.propertyDesc,
						control: { type: 'text', key: 'property', validate: (value: string) => (value.trim() ? undefined : t.propertyInvalid) },
					},
					{
						name: t.folderName,
						desc: t.folderDesc,
						control: { type: 'folder', key: 'folder', includeRoot: true },
					},
				],
			},
			{
				type: 'group',
				heading: t.headingSaving,
				items: [
					{
						name: t.defaultStorageName,
						desc: t.defaultStorageDesc,
						control: { type: 'dropdown', key: 'defaultStorage', options: { vault: t.storeVault, r2: t.storeR2 } },
					},
					{ name: t.askName, desc: t.askDesc, control: { type: 'toggle', key: 'askStorage' } },
					{ name: t.keepCopyName, desc: t.keepCopyDesc, control: { type: 'toggle', key: 'keepVaultCopy' }, visible: r2Visible },
				],
			},
			{
				type: 'group',
				heading: t.headingR2,
				visible: r2Visible,
				items: [
					{
						name: t.importCmds,
						desc: t.importCmdsDesc,
						visible: () => this.owner.cmdsEagleFound,
						action: () => {
							void this.owner.importCmdsEagle().then((ok) => {
								new Notice(ok ? t.importedCmds : t.importCmdsMissing);
								this.update();
							});
						},
					},
					{ name: t.r2SetupName, desc: t.r2SetupDesc },
					{ name: t.workerName, desc: t.workerDesc, control: { type: 'text', key: 'r2WorkerUrl', placeholder: 'https://eagle-uploader.xxx.workers.dev' } },
					{ name: t.keyName, desc: t.keyDesc, control: { type: 'text', key: R2_API_KEY_FIELD, placeholder: 'your-api-key-here' } },
					{ name: t.publicName, desc: t.publicDesc, control: { type: 'text', key: 'r2PublicUrl', placeholder: 'https://pub-xxx.r2.dev' } },
					{
						name: t.testR2,
						action: () => {
							void this.owner.remote.testR2().then((ok) => new Notice(ok ? t.r2Ok : t.r2Bad));
						},
					},
				],
			},
			{
				type: 'group',
				heading: t.headingEagle,
				items: [
					{ name: t.eagleEnabledName, desc: t.eagleEnabledDesc, control: { type: 'toggle', key: 'eagleEnabled' } },
					{
						name: t.eagleUrlName,
						desc: t.eagleUrlDesc,
						visible: () => this.owner.settings.eagleEnabled,
						control: { type: 'text', key: 'eagleUrl', placeholder: 'http://localhost:41595' },
					},
					{
						name: t.testEagle,
						visible: () => this.owner.settings.eagleEnabled,
						action: () => {
							void this.owner.remote.eagle().ping().then((ok) => new Notice(ok ? t.eagleOk : t.eagleOffline));
						},
					},
				],
			},
			{
				type: 'group',
				heading: t.headingGroups,
				items: [
					{ name: t.groupBackgroundName, desc: `${t.groupIntro} ${t.groupBackgroundDesc}`, control: { type: 'toggle', key: 'groupBackground' } },
					{
						name: t.groupTintName,
						desc: t.groupTintDesc,
						visible: () => this.owner.settings.groupBackground,
						control: { type: 'slider', key: 'groupTint', min: 4, max: 30, step: 1, displayFormat: (value: number) => `${value}%` },
					},
					{ name: t.groupBorderName, desc: t.groupBorderDesc, control: { type: 'toggle', key: 'groupBorder' } },
					{ name: t.groupHeadingName, desc: t.groupHeadingDesc, control: { type: 'toggle', key: 'groupHeading' } },
					{ name: t.autoKanbanName, desc: t.autoKanbanDesc, control: { type: 'toggle', key: 'autoKanbanGroup' } },
					{
						name: t.kanbanPropertyName,
						desc: t.kanbanPropertyDesc,
						control: { type: 'text', key: 'kanbanGroupProperty', validate: (value: string) => (value.trim() ? undefined : t.propertyInvalid) },
					},
				],
			},
			{
				type: 'group',
				heading: t.headingHover,
				items: [
					{ name: t.hoverLiftName, desc: t.hoverLiftDesc, control: { type: 'toggle', key: 'hoverLift' } },
					{ name: t.hoverRowsName, desc: t.hoverRowsDesc, control: { type: 'toggle', key: 'hoverRows' } },
					{ name: t.hoverAccentName, desc: t.hoverAccentDesc, control: { type: 'toggle', key: 'hoverUseAccent' } },
					{
						name: t.hoverColorName,
						desc: t.hoverColorDesc,
						visible: () => !this.owner.settings.hoverUseAccent,
						control: { type: 'color', key: 'hoverColor' },
					},
				],
			},
			{
				type: 'group',
				heading: t.headingDisplay,
				items: [
					{ name: t.placeholdersName, desc: t.placeholdersDesc, control: { type: 'toggle', key: 'showPlaceholders' } },
					{ name: t.toolbarName, desc: t.toolbarDesc, control: { type: 'toggle', key: 'showToolbarButton' } },
					{ name: t.tidyName, desc: t.tidyDesc, control: { type: 'toggle', key: 'tidyImages' } },
					{
						name: t.listSizeName,
						desc: t.listSizeDesc,
						control: { type: 'slider', key: 'listSize', min: 0, max: 100, step: 5, displayFormat: (value: number) => `${listPixelsFor(value)}px` },
					},
					{
						name: t.defaultShapeName,
						desc: t.defaultShapeDesc,
						control: {
							type: 'dropdown',
							key: 'defaultRatio',
							options: {
								square: t.ratioSquare,
								landscape: t.ratioLandscape,
								wide: t.ratioWide,
								portrait: t.ratioPortrait,
								poster: t.ratioPoster,
							},
						},
					},
				],
			},
		];
	}
}
