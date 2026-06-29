
'use strict';

const obsidian = require('obsidian');

/* === Pre-compiled patterns === */
const RE_DIACRITICS = /[\u0300-\u036f]/g;
const RE_WS = /\s+/;
const RE_EMBEDDED_BLOCK = /^```embedded-omnisearch(?:\s|$)/m;
const DEFAULT_SETTINGS = { pageSize: 10, highlightColor: "#cca300", highlightOpacity: 0.35 };
const HIDDEN_CLASS = "eo-hidden";

/* === Helpers === */
function norm(s) {
	return String(s == null ? "" : s).trim().normalize("NFD")
		.replace(RE_DIACRITICS, "").replace(/ß/g, "ss").toLowerCase();
}

function bname(p) { return String(p || "").replace(/^.*[\\/]/, ""); }

function getApi() {
	const a = globalThis.omnisearch;
	return a && typeof a.search === "function" ? a : null;
}

function clampPageSize(value) {
	const n = parseInt(value, 10);
	if (!isFinite(n) || isNaN(n)) return DEFAULT_SETTINGS.pageSize;
	if (n < 1) return 1;
	if (n > 100) return 100;
	return n;
}

function normalizeHexColor(value) {
	const color = String(value == null ? "" : value).trim();
	if (/^#[0-9a-fA-F]{6}$/.test(color)) return color.toLowerCase();
	if (/^#[0-9a-fA-F]{3}$/.test(color)) {
		return ("#" + color[1] + color[1] + color[2] + color[2] + color[3] + color[3]).toLowerCase();
	}
	return DEFAULT_SETTINGS.highlightColor;
}

function clampOpacity(value) {
	const n = parseFloat(value);
	if (!isFinite(n) || isNaN(n)) return DEFAULT_SETTINGS.highlightOpacity;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return Math.round(n * 100) / 100;
}

function hexToRgba(hex, alpha) {
	const color = normalizeHexColor(hex);
	const r = parseInt(color.slice(1, 3), 16);
	const g = parseInt(color.slice(3, 5), 16);
	const b = parseInt(color.slice(5, 7), 16);
	return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}

function extractPlainText(html) {
	const source = String(html != null ? html : "");
	if (typeof DOMParser !== "undefined") {
		const doc = new DOMParser().parseFromString(source, "text/html");
		return doc.body ? (doc.body.textContent || "") : "";
	}
	return source.replace(/<[^>]*>/g, " ");
}

function setElementHidden(el, hidden) {
	if (!el) return;
	el.classList.toggle(HIDDEN_CLASS, !!hidden);
}

/* === Accent-insensitive fold === */
function foldWithMap(str) {
	const src = String(str);
	const starts = [];
	const ends = [];
	let folded = "";
	let i = 0;
	for (const ch of src) {
		const start = i;
		const end = (i += ch.length);
		const n = ch.normalize("NFD");
		for (let j = 0; j < n.length; j++) {
			const code = n.charCodeAt(j);
			if (code >= 0x0300 && code <= 0x036f) continue;
			if (code === 0xDF) {
				folded += "ss"; starts.push(start, start); ends.push(end, end);
			} else {
				folded += n[j].toLowerCase(); starts.push(start); ends.push(end);
			}
		}
	}
	return { f: folded, s: starts, e: ends, o: src };
}

function appendHighlightedText(el, html, terms) {
	el.empty();
	const plain = extractPlainText(html);
	if (!plain) return;
	const m = foldWithMap(plain);
	const f = m.f;
	const s = m.s;
	const e = m.e;
	const o = m.o;
	if (!f || !terms.length) {
		el.appendChild(document.createTextNode(plain));
		return;
	}
	const ranges = [];
	for (const t of terms) {
		if (!t) continue;
		let pos = 0;
		let idx;
		while ((idx = f.indexOf(t, pos)) >= 0) {
			ranges.push([s[idx], e[idx + t.length - 1]]);
			pos = idx + t.length;
		}
	}
	if (!ranges.length) {
		el.appendChild(document.createTextNode(plain));
		return;
	}
	ranges.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
	const merged = [ranges[0]];
	for (let i = 1; i < ranges.length; i++) {
		const last = merged[merged.length - 1];
		const a = ranges[i][0];
		const b = ranges[i][1];
		if (a > last[1]) merged.push([a, b]);
		else last[1] = Math.max(last[1], b);
	}
	let cur = 0;
	for (const r of merged) {
		if (cur < r[0]) el.appendChild(document.createTextNode(o.slice(cur, r[0])));
		const mark = el.createEl("mark", { cls: "omnisearch-highlight" });
		mark.appendText(o.slice(r[0], r[1]));
		cur = r[1];
	}
	if (cur < o.length) el.appendChild(document.createTextNode(o.slice(cur)));
}

/* === Plugin === */
class EmbeddedOmnisearchPlugin extends obsidian.Plugin {
	async onload() {
		this.previewCheckToken = 0;
		this.views = new Set();
		await this.loadSettings();
		this.applyHighlightColor();
		this.addSettingTab(new EmbeddedOmnisearchSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
				this.enforceLeafPreview(leaf);
			}));
			this.enforceLeafPreview(this.getActiveMarkdownLeaf());
		});

		this.registerMarkdownCodeBlockProcessor("embedded-omnisearch", (source, el, ctx) => {
			ctx.addChild(new SearchView(this, el, this.parseConfig(source)));
		});
	}

	onunload() {
		if (typeof document !== "undefined" && document.documentElement) {
			document.documentElement.style.removeProperty("--eo-highlight-color");
		}
		if (this.views) this.views.clear();
	}

	async loadSettings() {
		let data = {};
		try {
			data = await this.loadData() || {};
		} catch (e) {}
		this.settings = {
			pageSize: clampPageSize(data.pageSize),
			highlightColor: normalizeHexColor(data.highlightColor),
			highlightOpacity: clampOpacity(data.highlightOpacity)
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.applyHighlightColor();
		this.refreshViews();
	}

	applyHighlightColor() {
		if (typeof document === "undefined" || !document.documentElement) return;
		document.documentElement.style.setProperty("--eo-highlight-color", hexToRgba(this.settings.highlightColor, this.settings.highlightOpacity));
	}

	refreshViews() {
		if (!this.views) return;
		for (const view of this.views) {
			if (view && typeof view.onSettingsChanged === "function") view.onSettingsChanged();
		}
	}

	getActiveMarkdownLeaf() {
		const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
		return view ? view.leaf : null;
	}

	registerSearchView(view) {
		this.views.add(view);
	}

	unregisterSearchView(view) {
		this.views.delete(view);
	}

	getLeafMarkdown(leaf) {
		if (!leaf || !leaf.view || leaf.view.getViewType() !== "markdown") return "";
		if (typeof leaf.view.getViewData === "function") {
			try {
				return String(leaf.view.getViewData() || "");
			} catch (e) {}
		}
		if (typeof leaf.view.data === "string") return leaf.view.data;
		return "";
	}

	noteContainsEmbeddedSearch(text) {
		return RE_EMBEDDED_BLOCK.test(String(text || ""));
	}

	setLeafPreview(leaf) {
		if (!leaf || !leaf.view || leaf.view.getViewType() !== "markdown") return false;
		const vs = leaf.getViewState ? leaf.getViewState() || {} : {};
		if (vs.state && vs.state.mode === "preview") return false;
		leaf.setViewState({
			type: vs.type || "markdown",
			state: Object.assign({}, vs.state || {}, { mode: "preview" })
		});
		return true;
	}

	async enforceLeafPreview(leaf) {
		if (!leaf || !leaf.view || leaf.view.getViewType() !== "markdown") return;
		const file = leaf.view.file;
		if (!file) return;

		const markdown = this.getLeafMarkdown(leaf);
		if (this.noteContainsEmbeddedSearch(markdown)) {
			this.setLeafPreview(leaf);
			return;
		}

		const token = ++this.previewCheckToken;
		let cached = "";
		try {
			cached = await this.app.vault.cachedRead(file);
		} catch (e) {
			return;
		}
		if (token !== this.previewCheckToken) return;
		if (!this.noteContainsEmbeddedSearch(cached)) return;
		this.setLeafPreview(leaf);
	}

	parseConfig(source) {
		const cfg = { pageSize: this.settings.pageSize, hasPageSizeOverride: false };
		for (const line of (source || "").split("\n")) {
			const m = line.match(/^\s*pageSize\s*:\s*(\d+)/);
			if (m) {
				cfg.pageSize = clampPageSize(m[1]);
				cfg.hasPageSizeOverride = true;
			}
		}
		return cfg;
	}
}

/* === Search View Component === */
class SearchView extends obsidian.Component {
	constructor(plugin, el, cfg) {
		super();
		this.plugin = plugin;
		this.app = plugin.app;
		this.rootEl = el;
		this.cfg = cfg;
		this.results = [];
		this.page = 0;
		this.pageSize = this.getPageSize();
		this.terms = [];
		this.timer = null;
		this.altHeld = false;
		this.hoverRow = null;
		this.mx = 0;
		this.my = 0;
	}

	onload() {
		this.plugin.registerSearchView(this);
		this.build();
		this.bind();
	}

	onunload() {
		clearTimeout(this.timer);
		if (this.popover && this.popover.parentNode) this.popover.remove();
		this.clearMinimalThemeResetMarker();
		this.plugin.unregisterSearchView(this);
	}

	markMinimalThemeResetContainer() {
		const root = this.rootEl;
		const container = root && root.parentElement;
		if (!container || !container.classList.contains("el-pre")) return;
		container.addClass("eo-minimal-reset");
		this.minimalThemeResetContainer = container;
	}

	clearMinimalThemeResetMarker() {
		if (!this.minimalThemeResetContainer) return;
		this.minimalThemeResetContainer.removeClass("eo-minimal-reset");
		this.minimalThemeResetContainer = null;
	}

	getPageSize() {
		if (this.cfg && this.cfg.hasPageSizeOverride) return clampPageSize(this.cfg.pageSize);
		return clampPageSize(this.plugin.settings.pageSize);
	}

	onSettingsChanged() {
		const nextPageSize = this.getPageSize();
		if (nextPageSize === this.pageSize) return;
		this.pageSize = nextPageSize;
		if (!this.results.length) return;
		const total = Math.ceil(this.results.length / this.pageSize);
		if (this.page > total - 1) this.page = Math.max(0, total - 1);
		this.renderPage();
	}

	/* --- Build UI --- */
	build() {
		const root = this.rootEl;
		root.empty();
		root.addClass("omnisearch-modal", "eo-wrap");
		this.markMinimalThemeResetContainer();

		/* Input */
		const inputWrap = root.createDiv({ cls: "omnisearch-input-container eo-input-wrap" });
		this.input = inputWrap.createEl("input", {
			cls: "omnisearch-input-field",
			attr: { type: "text", placeholder: "Find with Omnisearch...", spellcheck: "false", autocomplete: "off" }
		});

		this.clearBtn = inputWrap.createEl("button", {
			cls: "eo-clear",
			text: "\u2715",
			attr: { type: "button", "aria-label": "Clear search" }
		});

		/* Status */
		this.statusEl = root.createDiv({ cls: "eo-status" });

		/* Top pagination */
		this.topPageBar = this.createPaginationBar(root);

		/* Results list */
		this.resultsEl = root.createDiv({ cls: "eo-results" });
		this.buildResultsTable();

		/* Pagination */
		this.pageBar = this.createPaginationBar(root);
		this.paginationBars = [this.topPageBar, this.pageBar];
	}

	ensurePopover() {
		if (this.popover) return this.popover;
		this.popover = createEl("div", { cls: "eo-popover " + HIDDEN_CLASS });
		document.body.appendChild(this.popover);
		return this.popover;
	}

	buildResultsTable() {
		const tbl = this.resultsEl.createEl("table", { cls: "eo-results-table" });
		setElementHidden(tbl, true);
		const colgroup = tbl.createEl("colgroup");
		colgroup.createEl("col", { cls: "eo-col-file" });
		colgroup.createEl("col", { cls: "eo-col-score" });
		colgroup.createEl("col", { cls: "eo-col-preview" });

		const thead = tbl.createEl("thead", { cls: "eo-results-head" });
		const headRow = thead.createEl("tr", { cls: "eo-results-head-row" });
		headRow.createEl("th", { cls: "eo-results-head-cell eo-results-head-file", text: "File" });
		headRow.createEl("th", { cls: "eo-results-head-cell eo-results-head-score", text: "Score" });
		headRow.createEl("th", { cls: "eo-results-head-cell eo-results-head-preview", text: "Preview" });

		this.resultsTable = tbl;
		this.resultsBody = tbl.createEl("tbody", { cls: "eo-results-body" });
	}

	createPaginationBar(parent) {
		const bar = parent.createDiv({ cls: "eo-page-bar" });
		setElementHidden(bar, true);
		return {
			bar: bar,
			prevBtn: bar.createEl("button", { cls: "eo-page-btn", text: "<", attr: { type: "button" } }),
			pageInfo: bar.createEl("span", { cls: "eo-page-info" }),
			nextBtn: bar.createEl("button", { cls: "eo-page-btn", text: ">", attr: { type: "button" } })
		};
	}

	/* --- Bind events --- */
	bind() {
		/* Input */
		this.registerDomEvent(this.input, "input", () => {
			const v = this.input.value.trim();
			const has = !!v;
			this.setInputState(has);
			clearTimeout(this.timer);
			if (!has) {
				this.statusEl.textContent = "";
				this.resetResults();
				return;
			}
			this.timer = setTimeout(() => this.search(this.input.value), 350);
		});

		this.registerDomEvent(this.input, "keydown", (e) => {
			if (e.key === "Enter") this.search(this.input.value);
			if (e.key === "Escape") this.clearAll();
		});

		/* Clear */
		this.registerDomEvent(this.clearBtn, "click", (e) => {
			e.preventDefault();
			this.clearAll();
		});

		/* Pagination */
		for (const bar of this.paginationBars) {
			this.registerDomEvent(bar.prevBtn, "click", (e) => {
				e.preventDefault();
				this.changePage(-1);
			});
			this.registerDomEvent(bar.nextBtn, "click", (e) => {
				e.preventDefault();
				this.changePage(1);
			});
		}

		/* Result clicks — open in preview */
		this.registerDomEvent(this.resultsEl, "click", async (ev) => {
			const a = ev.target.closest("a.internal-link");
			if (!a) return;
			ev.preventDefault();
			const href = a.dataset.href || a.getAttribute("href");
			if (!href) return;
			const file = this.app.vault.getAbstractFileByPath(href);
			if (!file) return;
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file, { state: { mode: "preview" } });
		});

		/* Popover — mousemove / mouseleave on results */
		this.registerDomEvent(this.resultsEl, "mousemove", (ev) => {
			this.mx = ev.clientX;
			this.my = ev.clientY;
			this.hoverRow = ev.target.closest(".eo-results-row") || null;
			this.showPopover();
		});
		this.registerDomEvent(this.resultsEl, "mouseleave", () => {
			this.hoverRow = null;
			if (this.popover) setElementHidden(this.popover, true);
		});

		/* Alt key — global */
		this.registerDomEvent(document, "keydown", (e) => {
			if (e.key === "Alt") { this.altHeld = true; this.showPopover(); }
		});
		this.registerDomEvent(document, "keyup", (e) => {
			if (e.key === "Alt") {
				this.altHeld = false;
				if (this.popover) setElementHidden(this.popover, true);
			}
		});
	}

	/* --- Popover --- */
	showPopover() {
		const fp = this.hoverRow && this.hoverRow.dataset && this.hoverRow.dataset.filepath;
		if (!fp || !this.altHeld) {
			if (this.popover) setElementHidden(this.popover, true);
			return;
		}
		const popover = this.ensurePopover();
		popover.textContent = fp;
		setElementHidden(popover, false);
		popover.style.left = (this.mx + 14) + "px";
		popover.style.top = (this.my + 14) + "px";
	}

	/* --- Clear --- */
	clearAll() {
		this.input.value = "";
		this.statusEl.textContent = "";
		this.resetResults();
		this.setInputState(false);
		this.input.focus();
	}

	setInputState(hasValue) {
		this.clearBtn.classList.toggle("is-visible", hasValue);
		this.input.classList.toggle("has-value", hasValue);
	}

	resetResults() {
		if (this.resultsBody) this.resultsBody.empty();
		if (this.resultsTable) setElementHidden(this.resultsTable, true);
		this.results = [];
		this.page = 0;
		this.terms = [];
		this.setPaginationVisible(false);
	}

	setPaginationVisible(visible) {
		for (const bar of this.paginationBars) setElementHidden(bar.bar, !visible);
	}

	updatePaginationControls(total) {
		for (const bar of this.paginationBars) {
			setElementHidden(bar.bar, total <= 1);
			bar.prevBtn.disabled = this.page === 0;
			bar.nextBtn.disabled = this.page >= total - 1;
			bar.pageInfo.textContent = (this.page + 1) + " / " + total;
		}
	}

	changePage(delta) {
		const total = Math.ceil(this.results.length / this.pageSize);
		const nextPage = this.page + delta;
		if (nextPage < 0 || nextPage > total - 1 || nextPage === this.page) return;
		this.page = nextPage;
		this.renderPage();
		this.scrollToResultsTop();
	}

	scrollToResultsTop() {
		const anchor = this.rootEl;
		if (!anchor || typeof anchor.scrollIntoView !== "function") return;
		anchor.scrollIntoView({ behavior: "smooth", block: "start" });
	}

	/* --- Search --- */
	async search(raw) {
		const q = String(raw || "").trim();
		this.resetResults();
		if (!q) { this.statusEl.textContent = ""; return; }

		const api = getApi();
		if (!api) { this.statusEl.textContent = "\u274c Omnisearch API not available"; return; }

		this.statusEl.textContent = "Searching\u2026";
		const res = await api.search(q);
		if (!res || !res.length) { this.statusEl.textContent = 'No results for "' + q + '"'; return; }

		this.results = res;
		this.pageSize = this.getPageSize();
		this.terms = q.split(RE_WS).filter(Boolean).map(norm);
		this.page = 0;
		this.renderPage();
	}

	getResultTerms(result) {
		const terms = this.terms.slice();
		const foundWords = result.foundWords || [];
		for (let i = 0; i < foundWords.length; i++) {
			const word = norm(foundWords[i]);
			if (!word || terms.indexOf(word) >= 0) continue;
			terms.push(word);
		}
		return terms;
	}

	renderRow(result) {
		const path = String(result.path || "");
		const row = this.resultsBody.createEl("tr", { cls: "eo-results-row" });
		row.dataset.filepath = path;

		const fileCell = row.createEl("td", { cls: "eo-results-cell eo-results-file" });
		fileCell.createEl("a", {
			cls: "internal-link eo-results-link",
			text: bname(path),
			attr: { href: path, "data-href": path }
		});

		row.createEl("td", {
			cls: "eo-results-cell eo-results-score",
			text: String(Math.round(result.score || 0))
		});

		const previewCell = row.createEl("td", { cls: "eo-results-cell eo-results-preview" });
		appendHighlightedText(previewCell, result.excerpt, this.getResultTerms(result));
	}

	/* --- Render one page --- */
	renderPage() {
		const ps = this.pageSize;
		const total = Math.ceil(this.results.length / ps);
		const start = this.page * ps;
		const items = this.results.slice(start, start + ps);
		if (!items.length) return;

		this.statusEl.textContent = this.results.length + " results \u2014 page " + (this.page + 1) + " of " + total;
		this.resultsBody.empty();
		for (let i = 0; i < items.length; i++) this.renderRow(items[i]);
		setElementHidden(this.resultsTable, false);

		this.updatePaginationControls(total);
	}
}

class EmbeddedOmnisearchSettingTab extends obsidian.PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	async updateSetting(key, value) {
		if (this.plugin.settings[key] === value) return;
		this.plugin.settings[key] = value;
		await this.plugin.saveSettings();
	}

	addResetButton(setting, onReset) {
		setting.addButton((button) => {
			button.setButtonText("Reset");
			button.setTooltip("Reset to default");
			button.onClick(onReset);
		});
	}

	createPageSizeSetting(containerEl) {
		let textControl = null;
		const setting = new obsidian.Setting(containerEl)
			.setName("Results per page")
			.setDesc("Default pageSize value. A code block with pageSize: ... overrides this setting.");

		setting.addText((text) => {
			textControl = text;
			const commitPageSize = async () => {
				const normalized = clampPageSize(text.getValue());
				const normalizedText = String(normalized);
				if (text.getValue() !== normalizedText) text.setValue(normalizedText);
				await this.updateSetting("pageSize", normalized);
			};

			text.setPlaceholder(String(DEFAULT_SETTINGS.pageSize));
			text.setValue(String(this.plugin.settings.pageSize));
			text.inputEl.type = "number";
			text.inputEl.min = "1";
			text.inputEl.max = "100";
			text.inputEl.step = "1";
			text.inputEl.addEventListener("change", commitPageSize);
			text.inputEl.addEventListener("blur", commitPageSize);
		});

		this.addResetButton(setting, async () => {
			const defaultValue = DEFAULT_SETTINGS.pageSize;
			if (textControl) textControl.setValue(String(defaultValue));
			await this.updateSetting("pageSize", defaultValue);
		});
	}

	createHighlightColorSetting(containerEl) {
		let pickerControl = null;
		let textControl = null;
		const setting = new obsidian.Setting(containerEl)
			.setName("Highlight color")
			.setDesc("Color used to highlight matching terms.");

		if (typeof setting.addColorPicker === "function") {
			setting.addColorPicker((picker) => {
				pickerControl = picker;
				picker.setValue(this.plugin.settings.highlightColor);
				picker.onChange(async (value) => {
					const normalized = normalizeHexColor(value);
					if (normalized !== value) picker.setValue(normalized);
					await this.updateSetting("highlightColor", normalized);
				});
			});
		} else {
			setting.addText((text) => {
				textControl = text;
				text.setValue(this.plugin.settings.highlightColor);
				text.inputEl.type = "color";
				text.inputEl.addEventListener("change", async () => {
					const normalized = normalizeHexColor(text.getValue());
					text.setValue(normalized);
					await this.updateSetting("highlightColor", normalized);
				});
			});
		}

		this.addResetButton(setting, async () => {
			const defaultValue = DEFAULT_SETTINGS.highlightColor;
			if (pickerControl) pickerControl.setValue(defaultValue);
			if (textControl) textControl.setValue(defaultValue);
			await this.updateSetting("highlightColor", defaultValue);
		});
	}

	createHighlightOpacitySetting(containerEl) {
		let sliderControl = null;
		let textControl = null;
		const setting = new obsidian.Setting(containerEl)
			.setName("Highlight opacity")
			.setDesc("Opacity of the highlight background from 0% to 100%.");

		if (typeof setting.addSlider === "function") {
			setting.addSlider((slider) => {
				sliderControl = slider;
				slider.setLimits(0, 100, 5);
				slider.setValue(Math.round(this.plugin.settings.highlightOpacity * 100));
				if (typeof slider.setDynamicTooltip === "function") slider.setDynamicTooltip();
				slider.onChange(async (value) => {
					const normalized = clampOpacity(value / 100);
					await this.updateSetting("highlightOpacity", normalized);
				});
			});
		} else {
			setting.addText((text) => {
				textControl = text;
				const commitOpacity = async () => {
					const normalized = clampOpacity(parseFloat(text.getValue()) / 100);
					const displayValue = String(Math.round(normalized * 100));
					if (text.getValue() !== displayValue) text.setValue(displayValue);
					await this.updateSetting("highlightOpacity", normalized);
				};

				text.setPlaceholder(String(Math.round(DEFAULT_SETTINGS.highlightOpacity * 100)));
				text.setValue(String(Math.round(this.plugin.settings.highlightOpacity * 100)));
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.inputEl.max = "100";
				text.inputEl.step = "5";
				text.inputEl.addEventListener("change", commitOpacity);
				text.inputEl.addEventListener("blur", commitOpacity);
			});
		}

		this.addResetButton(setting, async () => {
			const defaultValue = DEFAULT_SETTINGS.highlightOpacity;
			const displayValue = Math.round(defaultValue * 100);
			if (sliderControl) sliderControl.setValue(displayValue);
			if (textControl) textControl.setValue(String(displayValue));
			await this.updateSetting("highlightOpacity", defaultValue);
		});
	}

	display() {
		const containerEl = this.containerEl;
		containerEl.empty();

		this.createPageSizeSetting(containerEl);
		this.createHighlightColorSetting(containerEl);
		this.createHighlightOpacitySetting(containerEl);
	}
}

module.exports = EmbeddedOmnisearchPlugin;
