/**
 * Minimal single-file dashboard.
 *
 * Deliberately dependency-free and inline: it is served straight from memory
 * with no build step, and degrades to a plain-text view if scripting is off.
 */
export const renderDashboard = (
	pollIntervalMs: number,
	title = "Steam Hour Booster",
): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
	:root {
		color-scheme: light dark;
		--bg: #0f1115; --panel: #171a21; --fg: #e6e6e6; --muted: #9aa4b2;
		--border: #262b35; --ok: #3fb950; --warn: #d29922; --err: #f85149; --idle: #8b949e;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0; padding: 2rem 1.25rem; background: var(--bg); color: var(--fg);
		font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	}
	main { max-width: 70rem; margin: 0 auto; }
	header { display: flex; align-items: baseline; gap: .75rem; flex-wrap: wrap; margin-bottom: .35rem; }
	h1 { font-size: 1.25rem; margin: 0; font-weight: 600; letter-spacing: -.01em; }
	.meta { color: var(--muted); font-size: .8125rem; }
	#error { display: none; margin: 1rem 0; padding: .75rem 1rem; border: 1px solid var(--err);
		border-radius: .5rem; color: var(--err); background: rgba(248,81,73,.08); }
	table { width: 100%; border-collapse: collapse; margin-top: 1.25rem; background: var(--panel);
		border: 1px solid var(--border); border-radius: .5rem; overflow: hidden; }
	th, td { padding: .625rem .875rem; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
	th { font-size: .6875rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 600; }
	tr:last-child td { border-bottom: none; }
	td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
	.status { display: inline-flex; align-items: center; gap: .4rem; font-weight: 500; }
	.status::before { content: ""; width: .5rem; height: .5rem; border-radius: 50%; background: var(--idle); }
	.status.Playing::before { background: var(--ok); }
	.status.Blocked::before { background: var(--warn); }
	.status.Error::before, .status.Offline::before { background: var(--err); }
	.games { color: var(--muted); }
	.tag { display: inline-block; padding: .0625rem .375rem; margin: 0 .25rem .25rem 0;
		border: 1px solid var(--border); border-radius: .25rem; font-size: .75rem; }
	.empty { padding: 2rem; text-align: center; color: var(--muted); }
</style>
</head>
<body>
<main>
	<header>
		<h1>${title}</h1>
		<span class="meta" id="totals"></span>
	</header>
	<div class="meta" id="updated">Loading&hellip;</div>
	<div id="error"></div>
	<div id="content"><div class="empty">Loading&hellip;</div></div>
</main>
<script>
const el = (id) => document.getElementById(id);
const clock = (seconds) => {
	if (seconds === null || seconds === undefined) return "\\u2014";
	const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
	return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
};
const human = (ms) => {
	const total = Math.floor(ms / 1000);
	const d = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60);
	return (d ? d + "d " : "") + (h || d ? h + "h " : "") + m + "m";
};
const text = (value) => {
	const div = document.createElement("div");
	div.textContent = value ?? "";
	return div.innerHTML;
};

async function load() {
	try {
		const response = await fetch("/api/status", { cache: "no-store" });
		if (!response.ok) throw new Error("HTTP " + response.status);
		const payload = await response.json();
		const bots = Array.isArray(payload) ? payload : payload.bots;
		if (!Array.isArray(bots)) throw new Error("Malformed response");

		el("error").style.display = "none";

		const totalMs = bots.reduce((sum, b) => sum + (b.totalPlayedMs || 0), 0);
		el("totals").textContent = bots.length + " account(s) \\u00b7 " + human(totalMs) + " farmed in total";

		if (bots.length === 0) {
			el("content").innerHTML = '<div class="empty">No accounts configured.</div>';
			return;
		}

		const rows = bots.map((b) => {
			const games = (b.games || []).map((g) =>
				'<span class="tag" title="' + text(g.appid) + '">' + text(g.name) + "</span>").join("");
			const note = b.lastError ? '<div class="meta">' + text(b.lastError) + "</div>" : "";
			return "<tr>" +
				"<td><strong>" + text(b.username) + "</strong>" + (b.online ? " <span class=\\"tag\\">online</span>" : "") + note + "</td>" +
				'<td><span class="status ' + text(b.status) + '">' + text(b.status) + "</span></td>" +
				'<td class="num">' + clock(b.uptimeSeconds) + "</td>" +
				'<td class="num">' + human(b.totalPlayedMs || 0) + "</td>" +
				'<td class="num">' + (b.games || []).length + "</td>" +
				'<td class="games">' + (games || '<span class="meta">\\u2014</span>') + "</td>" +
				"</tr>";
		}).join("");

		el("content").innerHTML =
			"<table><thead><tr><th>Account</th><th>Status</th><th>Session</th><th>Total</th><th>Games</th><th>Playing</th></tr></thead><tbody>" +
			rows + "</tbody></table>";

		el("updated").textContent = "Updated " + new Date().toLocaleTimeString();
	} catch (error) {
		el("error").style.display = "block";
		el("error").textContent = "Could not load status: " + error.message;
	}
}

load();
setInterval(load, ${pollIntervalMs});
</script>
</body>
</html>
`;
