import { Container, matchesKey, type SettingItem, SettingsList, Spacer, Text } from "@oh-my-pi/pi-tui";
import { settings } from "../../../../config/settings";
import { getType, SETTINGS_SCHEMA, type SettingPath } from "../../../../config/settings-schema";
import { DynamicBorder } from "../../../../modes/components/dynamic-border";
import { getSettingsListTheme, theme } from "../../../../modes/theme/theme";

const PHASES = ["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"] as const;

type Scope = "session" | "global";

/** Settings suffixes and their value lists for each phase */
const PHASE_SETTINGS = [
	{ suffix: "enabled", label: "Enabled", values: ["true", "false"] },
	{ suffix: "approval", label: "Approval", values: ["none", "user", "agent", "both"] },
	{ suffix: "reviewAgent", label: "Review Agent", values: ["critic", "reviewer"] },
	{ suffix: "maxReviewRounds", label: "Max Review Rounds", values: ["1", "2", "3", "4", "5"] },
] as const;

function isSettingPath(id: string): id is SettingPath {
	return id in SETTINGS_SCHEMA;
}

/** Coerce string display value to the appropriate type for the setting */
function coerceValue(path: SettingPath, raw: string): boolean | string | number {
	const type = getType(path);
	if (type === "boolean") return raw === "true";
	if (type === "number") return Number(raw);
	return raw;
}

/** Extract the base label for a setting path, ignoring any override marker */
function baseLabelForPath(id: string): string {
	const parts = id.split(".");
	const suffix = parts[parts.length - 1];
	return PHASE_SETTINGS.find(d => d.suffix === suffix)?.label ?? suffix;
}

/**
 * Build the flat items list (7 phase headers + 28 setting items = 35 total).
 *
 * The override indicator (*) is placed in the label — NOT the currentValue — so
 * that SettingsList.#activateItem can find the current value in the `values`
 * array by exact match and cycle correctly.
 */
function buildItems(scope: Scope): SettingItem[] {
	const items: SettingItem[] = [];

	for (const phase of PHASES) {
		// Phase header — non-interactive separator
		items.push({
			id: `header.${phase}`,
			label: `▸ ${phase}`,
			currentValue: "",
		});

		for (const def of PHASE_SETTINGS) {
			const path = `workflow.phases.${phase}.${def.suffix}` as SettingPath;
			const rawValue = String(settings.get(path));
			const hasOverride = scope === "session" && settings.hasOverride(path);
			items.push({
				id: path,
				// Override marker in label keeps currentValue clean for cycling
				label: hasOverride ? `${def.label} *` : def.label,
				currentValue: rawValue,
				values: [...def.values],
			});
		}
	}

	return items;
}

class WorkflowConfigComponent extends Container {
	#list: SettingsList;
	#scope: Scope = "session";
	#items: SettingItem[];
	#selectedIndex = 0;
	#done: (result: undefined) => void;
	#headerText: Text;
	#hintText: Text;
	// Store child references so #rebuildItems can re-insert without direct array mutation
	#topBorder: DynamicBorder;
	#afterHeaderSpacer: Spacer;
	#afterListSpacer: Spacer;
	#bottomBorder: DynamicBorder;

	constructor(done: (result: undefined) => void) {
		super();
		this.#done = done;
		this.#items = buildItems(this.#scope);

		this.#headerText = new Text(this.#renderHeader(), 0, 1);
		this.#hintText = new Text(this.#renderHint(), 0, 1);
		this.#topBorder = new DynamicBorder();
		this.#afterHeaderSpacer = new Spacer(1);
		this.#afterListSpacer = new Spacer(1);
		this.#bottomBorder = new DynamicBorder();

		this.#list = this.#createList();

		this.addChild(this.#topBorder);
		this.addChild(this.#headerText);
		this.addChild(this.#afterHeaderSpacer);
		this.addChild(this.#list);
		this.addChild(this.#afterListSpacer);
		this.addChild(this.#hintText);
		this.addChild(this.#bottomBorder);
	}

	#renderHeader(): string {
		const scopeLabel = this.#scope === "session" ? theme.fg("accent", "[SESSION]") : theme.fg("accent", "[GLOBAL]");
		return `${theme.bold("Workflow Configuration")}  ${scopeLabel}`;
	}

	#renderHint(): string {
		const hints = [
			theme.fg("dim", "g") + theme.fg("muted", " toggle scope"),
			theme.fg("dim", "esc") + theme.fg("muted", " close"),
		];
		if (this.#scope === "session") {
			hints.splice(1, 0, theme.fg("dim", "r") + theme.fg("muted", " reset override"));
		}
		const hintLine = hints.join(theme.fg("muted", "  │  "));
		const overrideNote = this.#scope === "session" ? `\n${theme.fg("muted", "  * = overridden from global")}` : "";
		return hintLine + overrideNote;
	}

	#createList(): SettingsList {
		return new SettingsList(
			this.#items,
			28,
			getSettingsListTheme(),
			(id, newValue) => this.#onChange(id, newValue),
			() => this.#done(undefined),
		);
	}

	#onChange(id: string, newValue: string): void {
		if (!isSettingPath(id)) return;
		const coerced = coerceValue(id, newValue);
		if (this.#scope === "session") {
			settings.override(id, coerced as never);
		} else {
			settings.set(id, coerced as never);
		}
		this.#refreshItemDisplay(id);
	}

	#refreshItemDisplay(id: string): void {
		if (!isSettingPath(id)) return;
		const item = this.#items.find(i => i.id === id);
		if (!item) return;

		const rawValue = String(settings.get(id));
		const hasOverride = this.#scope === "session" && settings.hasOverride(id);
		const baseLabel = baseLabelForPath(id);

		// Update the item in-place — SettingsList holds the same array reference
		item.label = hasOverride ? `${baseLabel} *` : baseLabel;
		item.currentValue = rawValue;

		// Tell SettingsList to re-render the updated value
		this.#list.updateValue(id, rawValue);
		this.invalidate();
	}

	#rebuildItems(): void {
		this.#items = buildItems(this.#scope);

		// Update in-place text nodes
		this.#headerText.setText(this.#renderHeader());
		this.#hintText.setText(this.#renderHint());

		// Swap list: remove trailing children (in reverse order), recreate list, re-add
		this.removeChild(this.#bottomBorder);
		this.removeChild(this.#hintText);
		this.removeChild(this.#afterListSpacer);
		this.removeChild(this.#list);

		this.#list = this.#createList();

		this.addChild(this.#list);
		this.addChild(this.#afterListSpacer);
		this.addChild(this.#hintText);
		this.addChild(this.#bottomBorder);

		this.#selectedIndex = 0;
		this.invalidate();
	}

	handleInput(data: string): void {
		if (data === "r" && this.#scope === "session") {
			const selected = this.#items[this.#selectedIndex];
			if (selected && isSettingPath(selected.id)) {
				settings.clearOverride(selected.id);
				this.#refreshItemDisplay(selected.id);
			}
			return;
		}

		if (data === "g") {
			this.#scope = this.#scope === "session" ? "global" : "session";
			this.#rebuildItems();
			return;
		}

		// Mirror SettingsList's selection tracking so `r` key targets the right item
		if (matchesKey(data, "up")) {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#items.length - 1 : this.#selectedIndex - 1;
		} else if (matchesKey(data, "down")) {
			this.#selectedIndex = this.#selectedIndex === this.#items.length - 1 ? 0 : this.#selectedIndex + 1;
		}

		this.#list.handleInput(data);
	}
}

export function createWorkflowConfigComponent(done: (result: undefined) => void): WorkflowConfigComponent {
	return new WorkflowConfigComponent(done);
}
