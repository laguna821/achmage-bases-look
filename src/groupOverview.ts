import { allGroupsFolded, canFoldGroups, foldAllGroups, readViewGroups } from './native';

/** The count next to a group's value in its heading. */
const COUNT = 'achmage-look-group-count';
/** Group headings Bases lets you fold (cards, list, table; kanban columns have counts of their own). */
const HEADING = '.bases-group-heading.mod-collapsible';

/** A heading shows its group folded as Bases marks it: the heading and its arrow. */
function markFolded(heading: HTMLElement, fold: boolean): void {
	heading.toggleClass('is-collapsed', fold);
	heading.find('.collapse-icon')?.toggleClass('is-collapsed', fold);
}

/**
 * An overview of a grouped view: every group heading shows how many notes it holds, and Alt +
 * click on a heading folds every group at once (or unfolds them all when all are folded), so the
 * groups of a long view fit on one screen. Folds stay Obsidian's own, kept on this device.
 */
export class GroupOverview {
	/** Show (or, with `on` false, remove) the counts of a view's group headings. */
	decorate(owner: unknown, root: HTMLElement, on: boolean): void {
		const done = new Set<HTMLElement>();
		if (on) {
			const byValue = new Map<string, number>();
			for (const group of readViewGroups(owner)) {
				byValue.set(group.value, (byValue.get(group.value) ?? 0) + group.count);
				if (group.heading) {
					this.setCount(group.heading, group.count);
					done.add(group.heading);
				}
			}
			// Headings drawn a second time (a sticky heading while its group scrolls) by their value.
			for (const heading of root.findAll(HEADING)) {
				if (done.has(heading)) continue;
				const value = heading.find('.bases-group-value')?.textContent?.trim();
				const count = value === undefined ? undefined : byValue.get(value);
				if (count === undefined) continue;
				this.setCount(heading, count);
				done.add(heading);
			}
		}
		for (const el of root.findAll(`.${COUNT}`)) {
			if (!el.parentElement || !done.has(el.parentElement)) el.detach();
		}
	}

	clear(root: HTMLElement): void {
		root.findAll(`.${COUNT}`).forEach((el) => el.detach());
	}

	/**
	 * Alt + click on a group heading: fold every group, or unfold them all when all are folded.
	 * Returns true when it handled the click (Bases' own click, which folds one group, is skipped).
	 */
	onClick(event: MouseEvent, root: HTMLElement, owner: unknown): boolean {
		if (!event.altKey || event.button !== 0 || !(event.target instanceof Element)) return false;
		const heading = event.target.closest(HEADING);
		if (!heading || !root.contains(heading) || !canFoldGroups(owner)) return false;
		// Bases' own heading click checks this and leaves the group alone.
		event.preventDefault();
		this.foldAll(owner, root, !allGroupsFolded(owner));
		return true;
	}

	/** Fold or unfold every group of a view (also from the command palette). False when Bases cannot. */
	foldAll(owner: unknown, root: HTMLElement, fold: boolean): boolean {
		if (!foldAllGroups(owner, fold)) return false;
		// Headings drawn now, and those Bases keeps for groups out of sight, show the new state.
		for (const heading of root.findAll(HEADING)) markFolded(heading, fold);
		for (const group of readViewGroups(owner)) if (group.heading) markFolded(group.heading, fold);
		return true;
	}

	private setCount(heading: HTMLElement, count: number): void {
		const text = String(count);
		let el = heading.find(`:scope > .${COUNT}`);
		if (el?.textContent === text) return;
		if (!el) {
			el = createSpan({ cls: COUNT });
			const value = heading.find(':scope > .bases-group-value');
			if (value) value.after(el);
			else heading.appendChild(el);
		}
		el.setText(text);
	}
}
