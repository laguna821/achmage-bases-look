import { AbstractInputSuggest, type App } from 'obsidian';

/** One suggestion: the value to fill in, and a short note on why it is suggested. */
export interface Choice {
	value: string;
	note: string;
}

/** A searchable list under a text field: typing filters it, picking one fills the field. */
export class ChoiceSuggest extends AbstractInputSuggest<Choice> {
	private readonly choices: () => Choice[];

	constructor(app: App, input: HTMLInputElement, choices: () => Choice[], pick: (value: string) => void) {
		super(app, input);
		this.choices = choices;
		this.onSelect((choice) => {
			this.setValue(choice.value);
			this.close();
			pick(choice.value);
		});
	}

	protected override getSuggestions(query: string): Choice[] {
		const wanted = query.trim().toLowerCase();
		const all = this.choices();
		return wanted ? all.filter((choice) => choice.value.toLowerCase().includes(wanted)) : all;
	}

	override renderSuggestion(choice: Choice, el: HTMLElement): void {
		el.addClass('achmage-look-choice');
		el.createDiv({ cls: 'achmage-look-choice-name', text: choice.value });
		if (choice.note) el.createDiv({ cls: 'achmage-look-choice-note', text: choice.note });
	}
}
