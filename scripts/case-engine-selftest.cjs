// 案件引擎纯函数自测（不碰 kv / React）。跑法：
//   npx tsc lib/case-engine/engine.ts lib/case-engine/cases/exit9_invalid_nods.ts --outDir .tmp-case-test --module commonjs --target es2020 --moduleResolution node --skipLibCheck
//   node scripts/case-engine-selftest.cjs
// 结束后可删 .tmp-case-test。
const { EXIT9_INVALID_NODS: pkg } = require("../.tmp-case-test/cases/exit9_invalid_nods.js");
const E = require("../.tmp-case-test/engine.js");

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass += 1; console.log("PASS", name); }
    else { fail += 1; console.log("FAIL", name, extra === undefined ? "" : extra); }
}

let s = E.createSession(pkg, "script-x", "wolinyu", 1000);
ok("初始授权 granted", s.access["E-01"] === "granted" && s.access["E-05"] === "granted");
ok("初始授权 pending", s.access["E-03"] === "pending" && s.access["E-06"] === "pending");
ok("初始分钟 12", s.minutesLeft === 12, s.minutesLeft);

let r = E.checkEvidence(pkg, s, "E-03", 2000);
ok("未授权不能核", r.ok === false, r.reason);

r = E.checkEvidence(pkg, s, "E-01", 2000);
ok("核 E-01 成功", r.ok === true && r.value.includes("抓腕"));
ok("核 E-01 扣 3 分钟", r.session.minutesLeft === 9, r.session.minutesLeft);
ok("核过记入 checked", r.session.checkedIds.includes("E-01"));
s = r.session;

const again = E.checkEvidence(pkg, s, "E-01", 3000);
ok("重复核不重复扣分", again.session.minutesLeft === 9 && again.value === r.value);

r = E.receiveEvidence(s, "E-03", 4000);
ok("投递后 granted", r.session.access["E-03"] === "granted");
s = r.session;
r = E.checkEvidence(pkg, s, "E-03", 5000);
ok("E-03 核扣 4 分钟", r.session.minutesLeft === 5, r.session.minutesLeft);
s = r.session;

const d0 = E.requestEvidence(pkg, s, "E-06", 6000);
ok("求生成草稿", d0.ok === true && d0.session.drafts.length === 1);
ok("草稿默认未发送", d0.session.drafts[0].sent === false);
s = E.updateDraft(d0.session, "E-06", "金警官，记录给我一份。", 6500).session;
const sent = E.markDraftSent(s, "E-06", 7000);
ok("发送后记入通讯", sent.ok === true && sent.session.comms.length === 1 && sent.session.drafts[0].sent === true);
ok("发送后转为 pending", sent.session.access["E-06"] === "pending", sent.session.access["E-06"]);
s = sent.session;

const obs = E.recordObservation(s, "  抓腕帧在护箱之后   多出来的空白   ", "E-01", 1, 8000);
ok("观察压缩空白并截断", obs.value.length <= 60 && !obs.value.includes("\n"), obs.value);
s = obs.session;

const todos = E.computeTodos(pkg, s);
ok("待办四格", todos.length === 4 && todos.find((t) => t.id === "核").done === true && todos.find((t) => t.id === "记").done === true);

// 结局 A：只引用断链（red herring）、语义层没立起来 → rejected
let onlyRed = E.createSession(pkg, "script-x", "wolinyu", 9000);
onlyRed = E.recordObservation(onlyRed, "旧档案有一页，像是前科", "F-01", 0, 9100).session;
ok("只引用断链 → rejected", E.computeEnding(pkg, onlyRed) === "rejected", E.computeEnding(pkg, onlyRed));

// 结局 B：核过 E-03 + E-06 + 语义层两份 → filed
let full = E.receiveEvidence(s, "E-06", 10000).session;
full = E.checkEvidence(pkg, full, "E-06", 10100).session;
full = E.checkEvidence(pkg, full, "E-05", 10200).session;
ok("语义层覆盖 2 份", ["E-03", "E-05"].every((id) => full.checkedIds.includes(id)));
ok("完整走完 → filed", E.computeEnding(pkg, full) === "filed", E.computeEnding(pkg, full));

const sub = E.submitCase(pkg, full, 11000);
ok("结案写入 filed", sub.session.submitted === true && sub.session.status === "filed");
ok("结案返回判法文本", sub.value.text.length > 0);

// 结局 C：什么都没做 → rejected（不算惩罚，待办保留）
const fresh = E.createSession(pkg, "script-x", "wolinyu", 12000);
ok("空白开局 → rejected", E.computeEnding(pkg, fresh) === "rejected");

// 真相不进任何可读文本
const blob = JSON.stringify([todos, sub.value]);
ok("材料正文里没有真相原文", !JSON.stringify(pkg.evidence).includes("保安先动手") && !blob.includes("保安先动手"), "truth 泄漏");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);