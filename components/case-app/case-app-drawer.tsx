"use client";

// 案件 App · 半屏抽屉（方案 §十）
//
// 三条口径，改之前先读：
// 1. 抽屉 65% 高、盖在剧情室上、聊天室不关；点遮罩关闭。
// 2. 只读节选，不跟剧情实时同步；材料正文永远来自案件包，AI 不许改。
// 3. 求的草稿只回填到聊天室输入框，App 本身不对外发任何一条消息。

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
    ArrowLeft,
    ClipboardCheck,
    FileText,
    Lock,
    NotebookPen,
    Send,
    X,
} from "lucide-react";
import {
    accessOf,
    canRead,
    checkEvidence,
    computeTodos,
    createSession,
    findEvidence,
    markDraftSent,
    receiveEvidence,
    recordObservation,
    requestEvidence,
    submitCase,
    updateDraft,
} from "@/lib/case-engine/engine";
import { CASES, getCasePackage } from "@/lib/case-engine/cases";
import { syncStoryDeliveries } from "@/lib/case-engine/link";
import { loadCaseSession, saveCaseSession, isCaseEnabledFor, setBoundScript } from "@/lib/case-engine/storage";
import { loadEnsembleScripts } from "@/lib/ensemble-storage";
import type { CaseIdentity, CaseSession } from "@/lib/case-engine/types";

const IDENTITIES: { id: CaseIdentity; label: string }[] = [
    { id: "wolinyu", label: "岳霖玉" },
    { id: "pi", label: "皮韩宇" },
    { id: "kim", label: "金成帝" },
];

const ACCESS_LABEL: Record<string, string> = {
    granted: "已授权",
    pending: "待授权",
    obtained: "非常规获得",
    locked: "锁",
};

const FROM_LABEL: Record<string, string> = {
    wolinyu: "我",
    pi: "皮韩宇",
    kim: "金成帝",
    court: "法院",
};

export type CaseAppDrawerProps = {
    scriptId: string;
    scriptTitle?: string;
    onClose: () => void;
    /** 把求的草稿回填到聊天室输入框（由调用方实现，App 不直接发送） */
    onPrefillInput?: (text: string) => void;
};

export function CaseAppDrawer({ scriptId, scriptTitle, onClose, onPrefillInput }: CaseAppDrawerProps) {
    const defaultCaseId = CASES[0]?.id ?? "";
    const [identity, setIdentity] = useState<CaseIdentity>("wolinyu");
    const [session, setSession] = useState<CaseSession | null>(null);
    const [openEvidenceId, setOpenEvidenceId] = useState<string | null>(null);
    const [obsText, setObsText] = useState("");
    const [notice, setNotice] = useState("");
    const [ending, setEnding] = useState<{ title: string; text: string } | null>(null);
    // 绑定＝白名单：这个剧本绑了才真的开案、才注入；没绑就先在这里绑
    const [bound, setBound] = useState(() => isCaseEnabledFor(scriptId));

    useEffect(() => {
        setBound(isCaseEnabledFor(scriptId));
        const saved = loadCaseSession(scriptId, defaultCaseId, identity);
        setOpenEvidenceId(null);
        setEnding(null);
        if (!saved) {
            setSession(null);
            setNotice("");
            return;
        }
        // 剧情 → App：打开 App 时把「求过、剧情里真的递到手上」的材料解锁
        const p = getCasePackage(saved.caseId);
        const script = loadEnsembleScripts().find((s) => s.id === scriptId);
        const synced = p && script ? syncStoryDeliveries(p, saved, script.turns) : null;
        if (synced && synced.deliveries.length > 0) {
            saveCaseSession(synced.session);
            setSession(synced.session);
            setNotice(`剧情把${synced.deliveries.map((d) => d.name).join("、")}递到你手上了。`);
            return;
        }
        setSession(saved);
        setNotice("");
    }, [scriptId, defaultCaseId, identity]);

    const pkg = useMemo(
        () => getCasePackage(session?.caseId ?? defaultCaseId),
        [session?.caseId, defaultCaseId],
    );

    const persist = useCallback((next: CaseSession) => {
        setSession(next);
        saveCaseSession(next);
    }, []);

    const start = useCallback(() => {
        if (!pkg) return;
        persist(createSession(pkg, scriptId, identity));
        setNotice(pkg.protocol.open);
    }, [pkg, persist, scriptId, identity]);

    const currentEvidence = openEvidenceId ? findEvidence(pkg!, openEvidenceId) : undefined;
    const draft = currentEvidence
        ? session?.drafts.find((d) => d.evidenceId === currentEvidence.id && !d.sent)
        : undefined;

    const handleClose = () => {
        if (typeof document !== "undefined") document.body.style.overflow = "";
        onClose();
    };

    useEffect(() => {
        if (typeof document === "undefined") return;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = "";
        };
    }, []);

    if (typeof document === "undefined") return null;

    return createPortal(
        <div className="fixed inset-0 z-[70] flex flex-col justify-end" role="dialog" aria-modal="true">
            <div className="absolute inset-0 bg-black/35" onClick={handleClose} />
            <div
                className="relative flex h-[65vh] flex-col overflow-hidden rounded-t-3xl bg-[#F7F5F1] shadow-[0_-8px_32px_rgba(0,0,0,0.18)]"
                style={{ animation: "modalSoftRise 0.24s cubic-bezier(0.16, 1, 0.3, 1)" }}
            >
                {/* 抽屉把手 */}
                <div className="flex shrink-0 items-center gap-3 px-4 pt-3 pb-2">
                    <div className="h-1 w-10 rounded-full bg-black/15" />
                    <div className="ml-auto flex items-center gap-3">
                        <span className="text-[11px] text-black/35">{scriptTitle || "案件"}</span>
                        <button
                            type="button"
                            onClick={handleClose}
                            className="flex h-7 w-7 items-center justify-center rounded-full bg-black/[0.06] text-black/50"
                            aria-label="收起"
                        >
                            <X size={14} />
                        </button>
                    </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
                    {!bound ? (
                        <BindScreen
                            scriptTitle={scriptTitle}
                            onBind={() => {
                                setBoundScript({ id: scriptId, title: scriptTitle || "" });
                                setBound(true);
                            }}
                        />
                    ) : !session ? (
                        <StartScreen
                            caseTitle={pkg?.title ?? ""}
                            caseNo={pkg?.caseNo ?? ""}
                            date={pkg?.meta.date ?? ""}
                            place={pkg?.meta.place ?? ""}
                            deliveredBy={pkg?.meta.deliveredBy ?? ""}
                            deliveredLine={pkg?.meta.deliveredLine ?? ""}
                            todos={pkg?.openingTodos ?? []}
                            onStart={start}
                        />
                    ) : currentEvidence ? (
                        <EvidenceDetail
                            session={session}
                            evidenceId={currentEvidence.id}
                            onBack={() => setOpenEvidenceId(null)}
                            notice={notice}
                            setNotice={setNotice}
                            draftText={draft?.text ?? ""}
                            onPersist={persist}
                            onPrefill={onPrefillInput}
                            pkgCaseId={session.caseId}
                        />
                    ) : (
                        <Overview
                            session={session}
                            identity={identity}
                            onIdentity={setIdentity}
                            onOpenEvidence={setOpenEvidenceId}
                            obsText={obsText}
                            setObsText={setObsText}
                            onPersist={persist}
                            ending={ending}
                            onSubmit={() => {
                                if (!pkg) return;
                                const res = submitCase(pkg, session);
                                persist(res.session);
                                const id = res.value?.endingId ?? "";
                                const hit = pkg.endings.find((e) => e.id === id);
                                setEnding({ title: hit?.title ?? "", text: res.value?.text ?? "" });
                            }}
                            notice={notice}
                        />
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}

function BindScreen(props: { scriptTitle?: string; onBind: () => void }) {
    return (
        <div className="pt-2">
            <div className="rounded-2xl bg-white px-4 py-3.5 shadow-sm">
                <div className="text-[11px] tracking-wide text-black/35">案件 App</div>
                <div className="mt-0.5 text-[16px] font-semibold text-black/80">本剧本还没开案</div>
                <div className="mt-2 text-[12px] leading-relaxed text-black/55">
                    一个剧本只认一个绑定。绑上之后，剧情那边才会知道有你手上这桩案子 ——
                    每轮多读一段案件状态（≤600 字），案结了就自动不再读。
                </div>
                <div className="mt-2 text-[11.5px] leading-relaxed text-black/35">
                    绑的是「{props.scriptTitle || "当前剧本"}」。换剧本要重新绑。
                </div>
            </div>
            <button
                type="button"
                onClick={props.onBind}
                className="mt-4 w-full rounded-xl bg-[#5B8FB9] py-2.5 text-[13px] font-medium text-white"
            >
                就绑这个剧本
            </button>
        </div>
    );
}

function StartScreen(props: {
    caseTitle: string;
    caseNo: string;
    date: string;
    place: string;
    deliveredBy: string;
    deliveredLine: string;
    todos: string[];
    onStart: () => void;
}) {
    return (
        <div className="pt-2">
            <div className="rounded-2xl bg-white px-4 py-3.5 shadow-sm">
                <div className="text-[11px] tracking-wide text-black/35">{props.caseNo}</div>
                <div className="mt-0.5 text-[16px] font-semibold text-black/80">{props.caseTitle}</div>
                <div className="mt-2 text-[12px] leading-relaxed text-black/50">
                    {props.date}｜{props.place}
                </div>
                <div className="mt-2 border-t border-black/[0.06] pt-2 text-[12px] leading-relaxed text-black/60">
                    {props.deliveredBy}：「{props.deliveredLine}」
                </div>
            </div>

            <div className="mt-3 rounded-2xl bg-white px-4 py-3 shadow-sm">
                <div className="text-[11px] text-black/35">开庭前要做的</div>
                <ol className="mt-1.5 space-y-1">
                    {props.todos.map((t, i) => (
                        <li key={t} className="text-[12.5px] text-black/65">
                            {i + 1}. {t}
                        </li>
                    ))}
                </ol>
            </div>

            <button
                type="button"
                onClick={props.onStart}
                className="mt-4 w-full rounded-xl bg-[#5B8FB9] py-2.5 text-[13px] font-medium text-white"
            >
                开案
            </button>
        </div>
    );
}

function Overview(props: {
    session: CaseSession;
    identity: CaseIdentity;
    onIdentity: (next: CaseIdentity) => void;
    onOpenEvidence: (id: string) => void;
    obsText: string;
    setObsText: (v: string) => void;
    onPersist: (s: CaseSession) => void;
    onSubmit: () => void;
    ending: { title: string; text: string } | null;
    notice: string;
}) {
    const { session } = props;
    const pkg = getCasePackage(session.caseId);
    if (!pkg) return <div className="py-8 text-center text-[12px] text-black/40">案件包缺失</div>;

    const todos = computeTodos(pkg, session);
    const act = pkg.acts.find((a) => a.id === session.actId);

    return (
        <div className="pt-1">
            {/* 身份视图 */}
            <div className="flex items-center gap-1.5">
                {IDENTITIES.map((it) => {
                    const playable = !!pkg.acts.some((a) => a.playableIdentities.includes(it.id));
                    const active = props.identity === it.id;
                    return (
                        <button
                            key={it.id}
                            type="button"
                            onClick={() => playable && props.onIdentity(it.id)}
                            className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] ${
                                active
                                    ? "bg-[#5B8FB9] text-white"
                                    : playable
                                      ? "bg-white text-black/60"
                                      : "bg-black/[0.04] text-black/25"
                            }`}
                            disabled={!playable}
                        >
                            {!playable && <Lock size={10} />}
                            {it.label}
                        </button>
                    );
                })}
                <span className="ml-auto text-[11px] text-black/35">
                    {session.minutesLeft === null ? "本幕不计时" : `剩 ${session.minutesLeft} 分钟`}
                </span>
            </div>

            {/* 抬头 */}
            <div className="mt-3 rounded-2xl bg-white px-4 py-3 shadow-sm">
                <div className="text-[11px] text-black/35">
                    {pkg.caseNo}｜{act?.title ?? "庭审幕"}
                </div>
                <div className="mt-0.5 text-[15px] font-semibold text-black/80">{pkg.title}</div>

                {/* 待办四格 */}
                <div className="mt-3 grid grid-cols-4 gap-1.5">
                    {todos.map((t, i) => (
                        <div
                            key={t.id}
                            className={`rounded-xl px-2 py-1.5 text-center ${
                                t.done ? "bg-[#5B8FB9]/10 text-[#3F6E92]" : "bg-black/[0.03] text-black/40"
                            }`}
                        >
                            <div className="text-[10px] opacity-70">{i + 1}</div>
                            <div className="text-[12px] font-medium">{t.label}</div>
                            <div className="text-[10px] opacity-70">{t.done ? "✓" : "—"}</div>
                        </div>
                    ))}
                </div>
            </div>

            {/* 材料 */}
            <div className="mt-3 overflow-hidden rounded-2xl bg-white shadow-sm">
                {pkg.evidence.map((e, i) => {
                    const access = accessOf(session, e.id);
                    const readable = canRead(access);
                    const checked = session.checkedIds.includes(e.id);
                    return (
                        <button
                            key={e.id}
                            type="button"
                            onClick={() => readable && props.onOpenEvidence(e.id)}
                            className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-left ${
                                i > 0 ? "border-t border-black/[0.05]" : ""
                            } ${readable ? "" : "opacity-45"}`}
                        >
                            <FileText size={14} className="shrink-0 text-black/30" />
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-[13px] text-black/75">{e.name}</div>
                                <div className="mt-0.5 truncate text-[10.5px] text-black/35">
                                    {e.sectionMark ?? "节选"}
                                </div>
                            </div>
                            {checked && <ClipboardCheck size={13} className="text-[#3F6E92]" />}
                            <span className="shrink-0 rounded-full bg-black/[0.04] px-2 py-0.5 text-[10px] text-black/45">
                                {ACCESS_LABEL[access] ?? access}
                            </span>
                        </button>
                    );
                })}
            </div>

            {/* 记一条 */}
            <div className="mt-3 rounded-2xl bg-white px-3 py-2.5 shadow-sm">
                <div className="flex items-center gap-2">
                    <NotebookPen size={13} className="shrink-0 text-black/30" />
                    <input
                        value={props.obsText}
                        onChange={(ev) => props.setObsText(ev.target.value)}
                        placeholder="记一条（60 字以内）"
                        maxLength={60}
                        className="min-w-0 flex-1 bg-transparent text-[12.5px] text-black/75 outline-none placeholder:text-black/25"
                    />
                    <button
                        type="button"
                        onClick={() => {
                            const r = recordObservation(session, props.obsText);
                            if (!r.ok) return;
                            props.onPersist(r.session);
                            props.setObsText("");
                        }}
                        className="shrink-0 rounded-lg bg-[#5B8FB9] px-2.5 py-1 text-[11.5px] text-white"
                    >
                        记
                    </button>
                </div>
                {session.observations.length > 0 && (
                    <ul className="mt-2 space-y-1 border-t border-black/[0.05] pt-2">
                        {session.observations.slice(-4).map((o, i) => (
                            <li key={`${o.at}-${i}`} className="text-[11.5px] leading-relaxed text-black/55">
                                · {o.text}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* 通讯（只读）：剧情里对他说的话自动摘进来 */}
            {session.comms.length > 0 && (
                <div className="mt-3 rounded-2xl bg-white px-4 py-3 shadow-sm">
                    <div className="text-[11px] text-black/35">通讯 · 只读</div>
                    <ul className="mt-1.5 space-y-1.5">
                        {session.comms.slice(-6).map((c, i) => (
                            <li key={`${c.at}-${i}`} className="text-[11.5px] leading-relaxed text-black/60">
                                <span className="text-black/30">{FROM_LABEL[c.from] ?? "剧情"}：</span>
                                {c.text}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {props.notice && (
                <div className="mt-3 rounded-xl bg-[#5B8FB9]/8 px-3 py-2 text-[11.5px] text-[#3F6E92]">
                    {props.notice}
                </div>
            )}

            {/* 结算 */}
            {props.ending ? (
                <div className="mt-3 rounded-2xl border border-[#5B8FB9]/25 bg-white px-4 py-3">
                    <div className="text-[11px] text-black/35">材料已交</div>
                    <div className="mt-0.5 text-[14px] font-semibold text-black/75">{props.ending.title}</div>
                    <div className="mt-1 text-[12px] leading-relaxed text-black/55">{props.ending.text}</div>
                </div>
            ) : (
                <button
                    type="button"
                    onClick={props.onSubmit}
                    className="mt-3 w-full rounded-xl border border-[#5B8FB9]/40 bg-white py-2.5 text-[13px] font-medium text-[#3F6E92]"
                >
                    交材料
                </button>
            )}

            {session.traces.length > 0 && (
                <div className="mt-3 rounded-2xl bg-white px-4 py-3 shadow-sm">
                    <div className="text-[11px] text-black/35">痕迹（越界次数 {session.traces.length}）</div>
                    <ul className="mt-1 space-y-0.5">
                        {session.traces.slice(-3).map((t, i) => (
                            <li key={`${t.at}-${i}`} className="text-[11.5px] text-black/50">
                                · {t.text}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

function EvidenceDetail(props: {
    session: CaseSession;
    evidenceId: string;
    onBack: () => void;
    notice: string;
    setNotice: (v: string) => void;
    draftText: string;
    onPersist: (s: CaseSession) => void;
    onPrefill?: (text: string) => void;
    pkgCaseId: string;
}) {
    const pkg = getCasePackage(props.pkgCaseId);
    const ev = pkg ? findEvidence(pkg, props.evidenceId) : undefined;
    if (!pkg || !ev) return null;

    const access = accessOf(props.session, ev.id);
    const checked = props.session.checkedIds.includes(ev.id);
    const draft = props.session.drafts.find((d) => d.evidenceId === ev.id && !d.sent);

    return (
        <div className="pt-1">
            <button
                type="button"
                onClick={props.onBack}
                className="mb-2 flex items-center gap-1 text-[11.5px] text-black/40"
            >
                <ArrowLeft size={12} /> 材料
            </button>

            <div className="rounded-2xl bg-white px-4 py-3.5 shadow-sm">
                <div className="text-[10.5px] text-black/35">{ev.sectionMark ?? "节选"}</div>
                <div className="mt-0.5 text-[15px] font-semibold text-black/80">{ev.name}</div>
                <div className="mt-2 whitespace-pre-wrap text-[12.5px] leading-[1.75] text-black/65">
                    {ev.desc}
                </div>
                <div className="mt-3 flex items-center gap-2 text-[10.5px] text-black/35">
                    <span className="rounded-full bg-black/[0.04] px-2 py-0.5">{ACCESS_LABEL[access]}</span>
                    {ev.redHerring && <span>这条可能把人带偏</span>}
                </div>
            </div>

            {ev.check && canRead(access) && (
                <div className="mt-3 rounded-2xl bg-white px-4 py-3 shadow-sm">
                    <button
                        type="button"
                        onClick={() => {
                            const r = checkEvidence(pkg, props.session, ev.id);
                            if (!r.ok) {
                                props.setNotice(r.reason ?? "");
                                return;
                            }
                            props.onPersist(r.session);
                            props.setNotice(r.value ?? "");
                        }}
                        className="rounded-lg bg-[#5B8FB9] px-3 py-1.5 text-[12px] text-white"
                    >
                        {checked ? `${ev.check.label}（已核）` : ev.check.label}
                    </button>
                    {checked && <div className="mt-2 text-[12px] leading-relaxed text-black/60">{ev.check.result}</div>}
                    {ev.check.minutes ? (
                        <div className="mt-1 text-[10.5px] text-black/30">核一次 {ev.check.minutes} 分钟</div>
                    ) : null}
                </div>
            )}

            {ev.ask && !canRead(access) && (
                <div className="mt-3 rounded-2xl bg-white px-4 py-3 shadow-sm">
                    <div className="text-[11px] text-black/35">求</div>
                    {draft ? (
                        <>
                            <textarea
                                value={props.draftText}
                                onChange={(e) => {
                                    const r = updateDraft(props.session, ev.id, e.target.value);
                                    if (r.ok) props.onPersist(r.session);
                                }}
                                rows={3}
                                className="mt-1.5 w-full resize-none rounded-xl bg-black/[0.03] px-3 py-2 text-[12.5px] leading-relaxed text-black/75 outline-none"
                            />
                            <div className="mt-2 flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        const r = markDraftSent(props.session, ev.id);
                                        if (!r.ok) {
                                            props.setNotice(r.reason ?? "");
                                            return;
                                        }
                                        props.onPersist(r.session);
                                        props.onPrefill?.(r.value ?? "");
                                        props.setNotice("已填进输入框，你自己按发送。");
                                    }}
                                    className="flex items-center gap-1 rounded-lg bg-[#5B8FB9] px-3 py-1.5 text-[12px] text-white"
                                >
                                    <Send size={11} /> 填进输入框
                                </button>
                                <button
                                    type="button"
                                    onClick={() => props.onPrefill?.(props.draftText)}
                                    className="rounded-lg bg-black/[0.05] px-3 py-1.5 text-[12px] text-black/55"
                                >
                                    只复制
                                </button>
                            </div>
                        </>
                    ) : (
                        <button
                            type="button"
                            onClick={() => {
                                const r = requestEvidence(pkg, props.session, ev.id);
                                if (!r.ok) {
                                    props.setNotice(r.reason ?? "");
                                    return;
                                }
                                props.onPersist(r.session);
                            }}
                            className="mt-1.5 rounded-lg bg-black/[0.06] px-3 py-1.5 text-[12px] text-black/60"
                        >
                            起草
                        </button>
                    )}
                </div>
            )}

            {!canRead(access) && (
                <div className="mt-3 rounded-2xl bg-white px-4 py-3 shadow-sm">
                    <div className="text-[11px] text-black/35">还拿不到</div>
                    <div className="mt-1 text-[12px] leading-relaxed text-black/55">
                        这份要等剧情里递到你手上。递到了会自动解锁。
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            const r = receiveEvidence(props.session, ev.id);
                            props.onPersist(r.session);
                            props.setNotice("已到手。");
                        }}
                        className="mt-2 rounded-lg bg-black/[0.05] px-3 py-1.5 text-[11.5px] text-black/45"
                    >
                        剧情已递来
                    </button>
                </div>
            )}

            {props.notice && (
                <div className="mt-3 rounded-xl bg-[#5B8FB9]/8 px-3 py-2 text-[11.5px] leading-relaxed text-[#3F6E92]">
                    {props.notice}
                </div>
            )}
        </div>
    );
}