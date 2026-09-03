// Mutation testing: plant a real defect, run the suite that should catch it,
// record whether it did. A test that has never failed proves nothing; this is
// the only way to find out which of 2,235 assertions are load-bearing.
//
// ALWAYS restores the file, including on crash - product code is mutated in
// place and a harness that leaves a mutation behind is worse than no harness.
const fs = require("fs");
const { execSync } = require("child_process");

const MUTANTS = require("./mutants.json");

// Paths in mutants.json are repo-relative, and every suite command assumes the
// repo root as cwd, so the harness moves there rather than making each entry
// carry a prefix that would rot the moment a file moves.
process.chdir(require("path").join(__dirname, "..", ".."));

function runSuite(cmd) {
  try {
    const out = execSync(cmd, { encoding: "utf8", stdio: ["ignore","pipe","pipe"], timeout: 300000 });
    const m = out.match(/Result: (\d+) passed, (\d+) failed/);
    if (!m) return { ran: false, failed: 0, note: "no Result line" };
    return { ran: true, passed: +m[1], failed: +m[2] };
  } catch (e) {
    const out = ((e.stdout||"") + (e.stderr||"")).toString();
    const m = out.match(/Result: (\d+) passed, (\d+) failed/);
    if (m) return { ran: true, passed: +m[1], failed: +m[2] };
    return { ran: false, failed: 0, note: "suite crashed or timed out" };
  }
}

const results = [];
for (const mut of MUTANTS) {
  const original = fs.readFileSync(mut.file, "utf8");
  if (original.split(mut.find).length - 1 !== 1) {
    results.push({ label: mut.label, verdict: "ANCHOR-MISS", detail: "find string not unique/present" });
    continue;
  }
  let r;
  try {
    fs.writeFileSync(mut.file, original.split(mut.find).join(mut.replace), "utf8");
    r = runSuite(mut.suite);
  } finally {
    fs.writeFileSync(mut.file, original, "utf8");
  }
  const verdict = !r.ran ? "SUITE-BROKE" : (r.failed > 0 ? "KILLED" : "SURVIVED");
  results.push({ label: mut.label, verdict, failed: r.failed || 0, note: r.note || "" });
  console.log(String(verdict).padEnd(12) + mut.label + (r.failed ? "  (" + r.failed + " failed)" : ""));
}

const killed = results.filter(r => r.verdict === "KILLED").length;
const survived = results.filter(r => r.verdict === "SURVIVED");
const broke = results.filter(r => r.verdict === "SUITE-BROKE");
const missed = results.filter(r => r.verdict === "ANCHOR-MISS");
console.log("");
console.log("KILL RATE: " + killed + "/" + (results.length - missed.length) + " mutants caught");
if (survived.length) { console.log(""); console.log("SURVIVORS - a real defect no assertion noticed:"); survived.forEach(s => console.log("   " + s.label)); }
if (broke.length) { console.log(""); console.log("SUITE BROKE (crash, not an assertion failure - counts as weak):"); broke.forEach(s => console.log("   " + s.label + " - " + s.note)); }
if (missed.length) { console.log(""); console.log("ANCHOR MISS (harness bug, not a result):"); missed.forEach(s => console.log("   " + s.label)); }