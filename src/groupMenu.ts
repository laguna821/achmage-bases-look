import { FileView, TFile } from 'obsidian';
import { strings } from './i18n';
import { renderGroupControls } from './groupUi';
import type AchmageBasesLookPlugin from '../main';
import type { BaseInfo } from '../main';

const SECTION = 'achmage-look-menu-section';

/**
 * Adds a “Group look” section under “Group by” in the native Bases Group menu.
 * The menu is created on demand and attached to the document body, so each window's body
 * is watched for it. If the menu's structure changes in a future Obsidian, the section is
 * simply not added; the same controls stay available in the toolbar panel.
 */
export class GroupMenuExtension {
	private readonly plugin: AchmageBasesLookPlugin;
	private readonly observers: MutationObserver[] = [];
	private readonly live = new Set<() => void>();

	constructor(plugin: AchmageBasesLookPlugin) {
		this.plugin = plugin;
	}

	watch(doc: Document): void {
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				for (const node of Array.from(record.addedNodes)) {
					if (node.instanceOf(HTMLElement) && node.hasClass('bases-toolbar-group-menu')) this.extend(node);
				}
			}
		});
		observer.observe(doc.body, { childList: true });
		this.observers.push(observer);
	}

	/** Redraw open sections, e.g. after “Group by” changed and the groups are different. */
	refresh(): void {
		for (const redraw of this.live) redraw();
	}

	destroy(): void {
		this.live.clear();
		for (const observer of this.observers) observer.disconnect();
		this.observers.length = 0;
		activeDocument.body.findAll(`.${SECTION}`).forEach((el) => el.detach());
	}

	/** The open base whose Group button opened this menu. */
	private owner(): { base: TFile; root: HTMLElement } | null {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('bases')) {
			const view = leaf.view;
			if (!(view instanceof FileView) || !(view.file instanceof TFile)) continue;
			if (view.containerEl.find('.bases-toolbar-group-menu .has-active-menu')) return { base: view.file, root: view.containerEl };
		}
		return null;
	}

	private extend(menu: HTMLElement): void {
		const owner = this.owner();
		const page = menu.find('.bases-group-page') ?? menu.find('.menu-scroll');
		if (!owner || !page) return;
		const t = strings();
		const section = page.createDiv({ cls: ['bases-toolbar-section', SECTION] });
		section.createDiv({ cls: 'bases-toolbar-section-header', text: t.groupLook });
		const content = section.createDiv({ cls: ['bases-toolbar-section-content', 'achmage-look-menu-content'] });

		let busy = Promise.resolve();
		const render = (info: BaseInfo | null) => {
			content.empty();
			renderGroupControls(this.plugin, content, owner.base, owner.root, info ?? this.plugin.emptyBaseInfo(), queue);
		};
		const queue = (job: () => Promise<BaseInfo | null>) => {
			busy = busy.then(async () => {
				const info = await job();
				if (info && content.isConnected) render(info);
			});
		};
		render(this.plugin.baseInfo(owner.base));

		// Changing “Group by” rebuilds the menu page and the groups; redraw after Bases settles.
		const redraw = () => {
			if (!menu.isConnected) {
				this.live.delete(redraw);
				return;
			}
			window.setTimeout(() => {
				const target = menu.find('.bases-group-page') ?? menu.find('.menu-scroll');
				if (target && !section.isConnected) target.appendChild(section);
				render(this.plugin.baseInfo(owner.base));
			}, 350);
		};
		this.live.add(redraw);
	}
}
