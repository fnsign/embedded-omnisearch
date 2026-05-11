'use strict';

var obsidian = require('obsidian');

/* === Pre-compiled patterns === */
var RE_HTML = /[&<>"']/g;
var HTML_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
var RE_DIACRITICS = /[\u0300-\u036f]/g;
var RE_WS = /\s+/;
var RE_EMBEDDED_BLOCK = /^```embedded-omnisearch(?:\s|$)/m;
var DEFAULT_SETTINGS = { pageSize: 10, highlightColor: "#cca300", highlightOpacity: 0.35 };

/* === Helpers === */
function escHtml(s) { return String(s).replace(RE_HTML, function (c) { return HTML_MAP[c]; }); }

function norm(s) {
	return String(s == null ? "" : s).trim().normalize("NFD")
		.replace(RE_DIACRITICS, "").replace(/ß/g, "ss").toLowerCase();
}

function bname(p) { return String(p || "").replace(/^.*[\\/]/, ""); }

function getApi() {
	var a = globalThis.omnisearch;
	return a && typeof a.search === "function" ? a : null;
}

function clampPageSize(value) {
	var n = parseInt(value, 10);
	if (!isFinite(n) || isNaN(n)) return DEFAULT_SETTINGS.pageSize;
	if (n < 1) return 1;
	if (n > 100) return 100;
	return n;
}

function normalizeHexColor(value) {
	var color = String(value == null ? "" : value).trim();
	if (/^#[0-9a-fA-F]{6}$/.test(color)) return color.toLowerCase();
	if (/^#[0-9a-fA-F]{3}$/.test(color)) {
		return ("#" + color[1] + color[1] + color[2] + color[2] + color[3] + color[3]).toLowerCase();
	}
	return DEFAULT_SETTINGS.highlightColor;
}

function clampOpacity(value) {
	var n = parseFloat(value);
	if (!isFinite(n) || isNaN(n)) return DEFAULT_SETTINGS.highlightOpacity;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return Math.round(n * 100) / 100;
}

function hexToRgba(hex, alpha) {
	var color = normalizeHexColor(hex);
	var r = parseInt(color.slice(1, 3), 16);
	var g = parseInt(color.slice(3, 5), 16);
	var b = parseInt(color.slice(5, 7), 16);
	return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}

/* === Accent-insensitive fold === */
function foldWithMap(str) {
	var src = String(str), starts = [], ends = [], folded = "", i = 0;
	for (var ch of src) {
		var start = i, end = (i += ch.length);
		var n = ch.normalize("NFD");
		for (var j = 0; j < n.length; j++) {
			var code = n.charCodeAt(j);
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

var stripEl = document.createElement("span");

function highlight(html, terms) {
	stripEl.innerHTML = String(html != null ? html : "");
	var plain = stripEl.textContent || "";
	if (!plain) return "";
	var m = foldWithMap(plain), f = m.f, s = m.s, e = m.e, o = m.o;
	if (!f || !terms.length) return plain;
	var ranges = [];
	for (var t of terms) {
		if (!t) continue;
		var pos = 0, idx;
		while ((idx = f.indexOf(t, pos)) >= 0) {
			ranges.push([s[idx], e[idx + t.length - 1]]);
			pos = idx + t.length;
		}
	}
	if (!ranges.length) return plain;
	ranges.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
	var merged = [ranges[0]];
	for (var i = 1; i < ranges.length; i++) {
		var last = merged[merged.length - 1], a = ranges[i][0], b = ranges[i][1];
		if (a > last[1]) merged.push([a, b]);
		else last[1] = Math.max(last[1], b);
	}
	var out = "", cur = 0;
	for (var r of merged) {
		out += escHtml(o.slice(cur, r[0]));
		out += '<mark class="omnisearch-highlight" style="background-color:var(--eo-highlight-color, rgba(204,163,0,0.35));color:var(--text-normal);padding:0 .15em;border-radius:3px">'
			+ escHtml(o.slice(r[0], r[1])) + '</mark>';
		cur = r[1];
	}
	var span = document.createElement("span");
	span.innerHTML = out + escHtml(o.slice(cur));
	return span;
}

/* === Plugin === */
class EmbeddedOmnisearchPlugin extends obsidian.Plugin {
	async onload() {
		this.previewCheckToken = 0;
		this.views = new Set();
		await this.loadSettings();
		this.applyHighlightColor();
		this.addSettingTab(new EmbeddedOmnisearchSettingTab(this.app, this));
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
			this.enforceLeafPreview(leaf);
		}));
		this.app.workspace.onLayoutReady(() => {
			this.enforceLeafPreview(this.app.workspace.activeLeaf);
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
		var data = {};
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
		for (var view of this.views) {
			if (view && typeof view.onSettingsChanged === "function") view.onSettingsChanged();
		}
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
		var vs = leaf.getViewState ? leaf.getViewState() || {} : {};
		if (vs.state && vs.state.mode === "preview") return false;
		leaf.setViewState({
			type: vs.type || "markdown",
			state: Object.assign({}, vs.state || {}, { mode: "preview" })
		});
		return true;
	}

	async enforceLeafPreview(leaf) {
		if (!leaf || !leaf.view || leaf.view.getViewType() !== "markdown") return;
		var file = leaf.view.file;
		if (!file) return;

		var markdown = this.getLeafMarkdown(leaf);
		if (this.noteContainsEmbeddedSearch(markdown)) {
			this.setLeafPreview(leaf);
			return;
		}

		var token = ++this.previewCheckToken;
		var cached = "";
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
		var cfg = { pageSize: this.settings.pageSize, hasPageSizeOverride: false };
		for (var line of (source || "").split("\n")) {
			var m = line.match(/^\s*pageSize\s*:\s*(\d+)/);
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
		this.plugin.unregisterSearchView(this);
	}

	getPageSize() {
		if (this.cfg && this.cfg.hasPageSizeOverride) return clampPageSize(this.cfg.pageSize);
		return clampPageSize(this.plugin.settings.pageSize);
	}

	onSettingsChanged() {
		var nextPageSize = this.getPageSize();
		if (nextPageSize === this.pageSize) return;
		this.pageSize = nextPageSize;
		if (!this.results.length) return;
		var total = Math.ceil(this.results.length / this.pageSize);
		if (this.page > total - 1) this.page = Math.max(0, total - 1);
		this.renderPage();
	}

	/* --- Build UI --- */
	build() {
		var root = this.rootEl;
		root.empty();
		root.addClass("omnisearch-modal", "eo-wrap");

		/* Input */
		var inputWrap = root.createDiv({ cls: "omnisearch-input-container eo-input-wrap" });
		this.input = inputWrap.createEl("input", {
			cls: "omnisearch-input-field",
			attr: { type: "text", placeholder: "Find with Omnisearch...", spellcheck: "false", autocomplete: "off" }
		});
		this.input.style.fontStyle = "italic";

		this.clearBtn = inputWrap.createEl("button", {
			cls: "eo-clear",
			text: "\u2715",
			attr: { type: "button", "aria-label": "clear" }
		});
		this.clearBtn.style.opacity = "0";
		this.clearBtn.style.pointerEvents = "none";

		/* Status */
		this.statusEl = root.createDiv({ cls: "eo-status" });

		/* Top pagination */
		this.topPageBar = this.createPaginationBar(root);

		/* Results list */
		this.resultsEl = root.createDiv({ cls: "eo-results" });

		/* Pagination */
		this.pageBar = this.createPaginationBar(root);

		/* Popover */
		this.popover = createEl("div", { cls: "eo-popover" });
		this.popover.style.display = "none";
		document.body.appendChild(this.popover);
	}

	createPaginationBar(parent) {
		var bar = parent.createDiv({ cls: "eo-page-bar" });
		bar.style.display = "none";
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
			var v = this.input.value.trim();
			var has = !!v;
			this.clearBtn.style.opacity = has ? "1" : "0";
			this.clearBtn.style.pointerEvents = has ? "auto" : "none";
			this.input.classList.toggle("has-value", has);
			this.input.style.fontStyle = has ? "normal" : "italic";
			clearTimeout(this.timer);
			if (!has) {
				this.statusEl.textContent = "";
				this.resultsEl.empty();
				this.results = [];
				this.page = 0;
				this.setPaginationDisplay("none");
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
		this.registerDomEvent(this.topPageBar.prevBtn, "click", (e) => {
			e.preventDefault();
			if (this.page > 0) { this.page--; this.renderPage(); }
		});
		this.registerDomEvent(this.topPageBar.nextBtn, "click", (e) => {
			e.preventDefault();
			var total = Math.ceil(this.results.length / this.pageSize);
			if (this.page < total - 1) { this.page++; this.renderPage(); }
		});
		this.registerDomEvent(this.pageBar.prevBtn, "click", (e) => {
			e.preventDefault();
			if (this.page > 0) { this.page--; this.renderPage(); }
		});
		this.registerDomEvent(this.pageBar.nextBtn, "click", (e) => {
			e.preventDefault();
			var total = Math.ceil(this.results.length / this.pageSize);
			if (this.page < total - 1) { this.page++; this.renderPage(); }
		});

		/* Result clicks — open in preview */
		this.registerDomEvent(this.resultsEl, "click", async (ev) => {
			var a = ev.target.closest("a.internal-link");
			if (!a) return;
			ev.preventDefault();
			var href = a.dataset.href || a.getAttribute("href");
			if (!href) return;
			var file = this.app.vault.getAbstractFileByPath(href);
			if (!file) return;
			var leaf = this.app.workspace.getLeaf(false);
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
			this.popover.style.display = "none";
		});

		/* Alt key — global */
		this.registerDomEvent(document, "keydown", (e) => {
			if (e.key === "Alt") { this.altHeld = true; this.showPopover(); }
		});
		this.registerDomEvent(document, "keyup", (e) => {
			if (e.key === "Alt") { this.altHeld = false; this.popover.style.display = "none"; }
		});
	}

	/* --- Popover --- */
	showPopover() {
		var fp = this.hoverRow && this.hoverRow.dataset && this.hoverRow.dataset.filepath;
		if (!fp || !this.altHeld) { this.popover.style.display = "none"; return; }
		this.popover.textContent = fp;
		this.popover.style.display = "block";
		this.popover.style.left = (this.mx + 14) + "px";
		this.popover.style.top = (this.my + 14) + "px";
	}

	/* --- Clear --- */
	clearAll() {
		this.input.value = "";
		this.statusEl.textContent = "";
		this.resultsEl.empty();
		this.results = [];
		this.page = 0;
		this.terms = [];
		this.setPaginationDisplay("none");
		this.clearBtn.style.opacity = "0";
		this.clearBtn.style.pointerEvents = "none";
		this.input.classList.remove("has-value");
		this.input.style.fontStyle = "italic";
		this.input.focus();
	}

	setPaginationDisplay(display) {
		this.topPageBar.bar.style.display = display;
		this.pageBar.bar.style.display = display;
	}

	updatePaginationControls(total) {
		var bars = [this.topPageBar, this.pageBar];
		for (var bar of bars) {
			bar.bar.style.display = total > 1 ? "flex" : "none";
			bar.prevBtn.disabled = this.page === 0;
			bar.prevBtn.style.opacity = this.page === 0 ? "0.35" : "1";
			bar.nextBtn.disabled = this.page >= total - 1;
			bar.nextBtn.style.opacity = this.page >= total - 1 ? "0.35" : "1";
			bar.pageInfo.textContent = (this.page + 1) + " / " + total;
		}
	}

	/* --- Search --- */
	async search(raw) {
		var q = String(raw || "").trim();
		this.resultsEl.empty();
		this.setPaginationDisplay("none");
		this.results = [];
		this.page = 0;
		this.terms = [];
		if (!q) { this.statusEl.textContent = ""; return; }

		var api = getApi();
		if (!api) { this.statusEl.textContent = "\u274c Omnisearch API not available"; return; }

		this.statusEl.textContent = "Searching\u2026";
		var res = await api.search(q);
		if (!res || !res.length) { this.statusEl.textContent = 'No results for "' + q + '"'; return; }

		this.results = res;
		this.pageSize = this.getPageSize();
		this.terms = q.split(RE_WS).filter(Boolean).map(norm);
		this.page = 0;
		this.renderPage();
	}

	/* --- Render one page --- */
	renderPage() {
		this.resultsEl.empty();
		var ps = this.pageSize;
		var total = Math.ceil(this.results.length / ps);
		var start = this.page * ps;
		var items = this.results.slice(start, start + ps);
		if (!items.length) return;

		this.statusEl.textContent = this.results.length + " results \u2014 page " + (this.page + 1) + " of " + total;

		var tbl = this.resultsEl.createEl("table", { cls: "eo-results-table" });
		var colgroup = tbl.createEl("colgroup");
		colgroup.createEl("col", { cls: "eo-col-file" });
		colgroup.createEl("col", { cls: "eo-col-score" });
		colgroup.createEl("col", { cls: "eo-col-preview" });

		var thead = tbl.createEl("thead", { cls: "eo-results-head" });
		var headRow = thead.createEl("tr", { cls: "eo-results-head-row" });
		headRow.createEl("th", { cls: "eo-results-head-cell eo-results-head-file", text: "File" });
		headRow.createEl("th", { cls: "eo-results-head-cell eo-results-head-score", text: "Score" });
		headRow.createEl("th", { cls: "eo-results-head-cell eo-results-head-preview", text: "Preview" });

		var tbody = tbl.createEl("tbody", { cls: "eo-results-body" });

		for (var r of items) {
			var tr = tbody.createEl("tr", { cls: "eo-results-row" });
			tr.dataset.filepath = r.path || "";

			var tdFile = tr.createEl("td", { cls: "eo-results-cell eo-results-file" });
			tdFile.createEl("a", {
				cls: "internal-link eo-results-link",
				text: bname(r.path),
				attr: { "data-href": r.path, href: r.path }
			});

			tr.createEl("td", {
				cls: "eo-results-cell eo-results-score",
				text: String(Math.round(r.score || 0))
			});

			var tdBody = tr.createEl("td", { cls: "eo-results-cell eo-results-preview" });
			var uniq = Array.from(new Set(
				this.terms.concat((r.foundWords || []).map(norm)).filter(Boolean)
			)).sort(function (a, b) { return b.length - a.length; });

			var hl = highlight(r.excerpt, uniq);
			if (typeof hl === "string") tdBody.textContent = hl;
			else tdBody.appendChild(hl);
		}

		this.updatePaginationControls(total);
	}
}

class EmbeddedOmnisearchSettingTab extends obsidian.PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		var containerEl = this.containerEl;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Embedded-Omnisearch Settings" });

		new obsidian.Setting(containerEl)
			.setName("Results per page")
			.setDesc("Default pageSize value. A code block with pageSize: ... overrides this setting.")
			.addText((text) => {
				var commitPageSize = async () => {
					var normalized = clampPageSize(text.getValue());
					if (text.getValue() !== String(normalized)) text.setValue(String(normalized));
					if (this.plugin.settings.pageSize === normalized) return;
					this.plugin.settings.pageSize = normalized;
					await this.plugin.saveSettings();
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

		var colorSetting = new obsidian.Setting(containerEl)
			.setName("Highlight color")
			.setDesc("Color used to highlight matching terms.");

		if (typeof colorSetting.addColorPicker === "function") {
			colorSetting.addColorPicker((picker) => {
				picker.setValue(this.plugin.settings.highlightColor);
				picker.onChange(async (value) => {
					var normalized = normalizeHexColor(value);
					if (normalized !== value) picker.setValue(normalized);
					if (this.plugin.settings.highlightColor === normalized) return;
					this.plugin.settings.highlightColor = normalized;
					await this.plugin.saveSettings();
				});
			});
		} else {
			colorSetting.addText((text) => {
				text.setValue(this.plugin.settings.highlightColor);
				text.inputEl.type = "color";
				text.inputEl.addEventListener("change", async () => {
					var normalized = normalizeHexColor(text.getValue());
					text.setValue(normalized);
					if (this.plugin.settings.highlightColor === normalized) return;
					this.plugin.settings.highlightColor = normalized;
					await this.plugin.saveSettings();
				});
			});
		}

		var opacitySetting = new obsidian.Setting(containerEl)
			.setName("Highlight opacity")
			.setDesc("Opacity of the highlight background from 0% to 100%.");

		if (typeof opacitySetting.addSlider === "function") {
			opacitySetting.addSlider((slider) => {
				slider.setLimits(0, 100, 5);
				slider.setValue(Math.round(this.plugin.settings.highlightOpacity * 100));
				if (typeof slider.setDynamicTooltip === "function") slider.setDynamicTooltip();
				slider.onChange(async (value) => {
					var normalized = clampOpacity(value / 100);
					if (this.plugin.settings.highlightOpacity === normalized) return;
					this.plugin.settings.highlightOpacity = normalized;
					await this.plugin.saveSettings();
				});
			});
		} else {
			opacitySetting.addText((text) => {
				var commitOpacity = async () => {
					var normalized = clampOpacity(parseFloat(text.getValue()) / 100);
					var displayValue = String(Math.round(normalized * 100));
					if (text.getValue() !== displayValue) text.setValue(displayValue);
					if (this.plugin.settings.highlightOpacity === normalized) return;
					this.plugin.settings.highlightOpacity = normalized;
					await this.plugin.saveSettings();
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
	}
}

module.exports = EmbeddedOmnisearchPlugin;
