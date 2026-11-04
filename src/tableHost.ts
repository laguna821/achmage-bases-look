import { TFile, type FileView } from 'obsidian';
import { readNativeTable, type NativeTable } from './native';
import { emptyFormat, type FormatChange, type FormatTarget, type RowPreset, type TableFormat } from './tableFormat.ts';
import type AchmageBasesLookPlugin from '../main';
import type { BaseInfo } from '../main';

/**
 * A table view on screen and the place its changes go: a Bases leaf, whose base file is changed,
 * or a base embedded in a note, which Bases saves itself (in the base file, or in the code block).
 */
export interface TableHost {
	/** The element the table's events and formats belong to: the leaf's view, or the embed. */
	readonly root: HTMLElement;
	/** The base file shown, or null for a base written in a code block. */
	readonly base: TFile | null;
	/** True for a base embedded in a note, a code block, a hover preview or a canvas card. */
	readonly embedded: boolean;
	/** Still the table it was found as. */
	alive(): boolean;
	/** The table as it is drawn now, or null. */
	table(): NativeTable | null;
	/** Facts about the base (its thumbnail column), read when needed. */
	info(): BaseInfo | null;
	/** The format of a view, as shown now. */
	format(viewName: string): TableFormat;
	setFormat(viewName: string, target: FormatTarget, change: FormatChange): Promise<void>;
	/** Clear the format of a target, or (null) every format of the view. */
	clearFormat(viewName: string, target: FormatTarget | null): Promise<void>;
	/** Column widths (null: back to Obsidian's automatic width); `fitThumbnails` refits the thumbnail column. */
	setColumnWidths(viewName: string, widths: Record<string, number | null>, fitThumbnails: boolean): Promise<void>;
	setRowHeight(viewName: string, preset: RowPreset): Promise<void>;
}

/** A table view in a Bases leaf: changes go to its base file, as they always did. */
export class LeafTable implements TableHost {
	readonly embedded = false;
	private readonly plugin: AchmageBasesLookPlugin;
	private readonly view: FileView;
	readonly base: TFile;

	constructor(plugin: AchmageBasesLookPlugin, view: FileView, base: TFile) {
		this.plugin = plugin;
		this.view = view;
		this.base = base;
	}

	get root(): HTMLElement {
		return this.view.containerEl;
	}

	alive(): boolean {
		return this.view.file === this.base && this.root.isConnected;
	}

	table(): NativeTable | null {
		return readNativeTable(this.view);
	}

	info(): BaseInfo | null {
		return this.plugin.baseInfo(this.base);
	}

	format(viewName: string): TableFormat {
		return this.info()?.formats[viewName] ?? emptyFormat();
	}

	async setFormat(viewName: string, target: FormatTarget, change: FormatChange): Promise<void> {
		await this.plugin.setTableFormat(this.base, viewName, target, change);
	}

	async clearFormat(viewName: string, target: FormatTarget | null): Promise<void> {
		await this.plugin.clearTableFormat(this.base, viewName, target);
	}

	async setColumnWidths(viewName: string, widths: Record<string, number | null>, fitThumbnails: boolean): Promise<void> {
		await this.plugin.setColumnWidths(this.base, viewName, widths, fitThumbnails);
	}

	async setRowHeight(viewName: string, preset: RowPreset): Promise<void> {
		await this.plugin.setViewOptions(this.base, viewName, { rowHeight: preset });
	}
}

/** The Bases leaf showing a view container, as a table host. */
export function leafTable(plugin: AchmageBasesLookPlugin, view: FileView | null): LeafTable | null {
	return view && view.file instanceof TFile && view.file.extension === 'base' ? new LeafTable(plugin, view, view.file) : null;
}
