#!/usr/bin/env node
// Summarizes next-prompt-debug.log per suggestion model: how long generation
// takes and how often suggestions get sent. Needs `debug: true` in the config.
//
//   node scripts/stats.mjs [--since YYYY-MM-DD] [--log PATH] [--json]
//
// Log lines written before timing was recorded carry no `ms`; their duration
// is estimated from the compute_go -> complete_done gap in the same process
// (which can include a consent dialog) and marked `~` in the table.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes("--help") || args.includes("-h")) {
	console.log("usage: node scripts/stats.mjs [--since YYYY-MM-DD] [--log PATH] [--json]");
	process.exit(0);
}
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const logPath = opt("--log") ?? join(agentDir, "next-prompt-debug.log");
const since = opt("--since");

const lines = [];
for (const path of [`${logPath}.1`, logPath]) {
	if (!existsSync(path)) continue;
	for (const raw of readFileSync(path, "utf-8").split("\n")) {
		if (!raw) continue;
		try {
			const line = JSON.parse(raw);
			if (!since || line.t >= since) lines.push(line);
		} catch {
			// A torn last line from a crash; skip it.
		}
	}
}
if (lines.length === 0) {
	console.error(`no log lines in ${logPath}${since ? ` since ${since}` : ""}`);
	process.exit(1);
}
lines.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));

const groups = new Map();
const group = (key) => {
	let g = groups.get(key);
	if (!g) {
		const [model, thinking, tier] = key.split("|");
		g = { model, thinking, tier, requests: 0, errors: 0, ms: [], estimated: 0, out: [], cost: 0, auto: 0, manual: 0, shown: 0, shownTracked: 0, accepted: 0, exact: 0, edited: 0 };
		groups.set(key, g);
	}
	return g;
};
const keyOf = (l, model) => `${l.model ?? model ?? "?"}|${l.thinking ?? "?"}|${l.tier ?? "-"}`;

// Per process: rid -> group key, plus the latest request for legacy lines.
const procs = new Map();
const proc = (pid) => {
	let p = procs.get(pid);
	if (!p) procs.set(pid, (p = { byRid: new Map(), go: undefined, current: undefined }));
	return p;
};
const keyFor = (p, l) => (l.rid !== undefined ? p.byRid.get(l.rid) : p.current);
let typed = 0;

for (const l of lines) {
	const p = proc(l.pid);
	switch (l.event) {
		case "manual_trigger":
		case "regenerate":
		case "redo":
			p.pendingManual = true;
			break;
		case "compute_go":
			p.go = { ...l, src: l.src ?? (p.pendingManual ? "manual" : "auto") };
			p.pendingManual = false;
			break;
		case "complete_done":
		case "complete_error": {
			if (l.event === "complete_error" && l.aborted) break;
			const key = keyOf(l, p.go?.model);
			const g = group(key);
			if (l.rid !== undefined) p.byRid.set(l.rid, key);
			p.current = key;
			g.requests += 1;
			const src = l.src ?? p.go?.src;
			if (src === "manual") g.manual += 1;
			else if (src === "auto") g.auto += 1;
			if (l.event === "complete_error" || l.err) g.errors += 1;
			if (typeof l.ms === "number") g.ms.push(l.ms);
			else if (p.go) {
				g.ms.push(Date.parse(l.t) - Date.parse(p.go.t));
				g.estimated += 1;
			}
			if (typeof l.out === "number") g.out.push(l.out);
			if (typeof l.cost === "number") g.cost += l.cost;
			break;
		}
		case "shown":
		case "accept": {
			const key = keyFor(p, l);
			if (!key) break;
			const g = group(key);
			if (l.event === "accept") g.accepted += 1;
			else {
				g.shown += 1;
				// Only suggestions shown since submits were logged can count as sent.
				if (l.rid !== undefined) g.shownTracked += 1;
			}
			break;
		}
		case "submit": {
			if (l.how === "typed") typed += 1;
			const key = keyFor(p, l);
			if (key && (l.how === "exact" || l.how === "edited")) group(key)[l.how] += 1;
			break;
		}
	}
}

const quantile = (xs, q) => {
	if (xs.length === 0) return undefined;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const rows = [...groups.values()]
	.sort((a, b) => b.requests - a.requests)
	.map((g) => ({
		model: g.model,
		thinking: g.thinking,
		tier: g.tier,
		requests: g.requests,
		auto: g.auto,
		manual: g.manual,
		errors: g.errors,
		medianMs: quantile(g.ms, 0.5),
		p90Ms: quantile(g.ms, 0.9),
		estimatedTimings: g.estimated,
		avgOutTokens: g.out.length ? Math.round(g.out.reduce((a, b) => a + b, 0) / g.out.length) : undefined,
		cost: Number(g.cost.toFixed(4)),
		shown: g.shown,
		accepted: g.accepted,
		sentExact: g.exact,
		sentEdited: g.edited,
		shownSinceSubmitLogging: g.shownTracked,
	}));

if (args.includes("--json")) {
	console.log(JSON.stringify({ from: lines[0].t, to: lines.at(-1).t, typedPrompts: typed, models: rows }, null, 2));
	process.exit(0);
}

const sec = (ms, est) => (ms === undefined ? "-" : `${est ? "~" : ""}${(ms / 1000).toFixed(1)}s`);
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "-");
const table = [
	["model", "think", "tier", "reqs", "auto/man", "err", "median", "p90", "out tok", "cost", "shown", "accepted", "sent", "edited", "sent/shown"],
	...rows.map((r) => {
		const est = r.estimatedTimings > 0;
		return [
			r.model, r.thinking, r.tier, r.requests, `${r.auto}/${r.manual}`, r.errors,
			sec(r.medianMs, est), sec(r.p90Ms, est), r.avgOutTokens ?? "-", `$${r.cost.toFixed(2)}`,
			r.shown, r.accepted, r.sentExact, r.sentEdited, pct(r.sentExact + r.sentEdited, r.shownSinceSubmitLogging),
		].map(String);
	}),
];
const widths = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
console.log(`next-prompt stats, ${lines[0].t.slice(0, 10)} to ${lines.at(-1).t.slice(0, 10)} (${logPath})\n`);
for (const row of table) console.log(row.map((c, i) => (i < 3 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  "));
console.log(`\nsent = submitted unchanged, edited = submitted after changing it. Submits are logged from`);
console.log("this version on, so sent/shown only counts suggestions shown since then (- when none).");
console.log(`Prompts typed without accepting a suggestion: ${typed}.`);
if (rows.some((r) => r.estimatedTimings > 0))
	console.log("~ = some timings estimated from older log lines (may include consent-dialog time).");
