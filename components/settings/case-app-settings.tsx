"use client";

// 案件 App 设置（全局设置页里的一个二级页）
// 只做三件事：绑定剧本 / 注入总开关 / 清空本案存档。
// 为什么绑定放在这里而不是案件面板里：面板要绑定后才出现，放面板里会死锁。

import { useCallback, useEffect, useState } from "react";
import { Toggle } from "@/components/ui/form";
import { loadEnsembleScripts } from "@/lib/ensemble-storage";
import {
    clearBoundScript,
    clearCaseSession,
    clearOrphanSessions,
    getBoundScript,
    listCaseSessionsForScript,
    setBoundScript,
} from "@/lib/case-engine/storage";
import { isInjectEnabled, setInjectEnabled } from "@/lib/case-engine/inject";

type ScriptRow = { id: string; title: string; sideStory: boolean };

export function CaseAppSettings() {
    const [scripts, setScripts] = useState<ScriptRow[]>([]);
    const [bound, setBound] = useState<{ id: string; title: string } | null>(null);
    const [inject, setInject] = useState(true);
    const [cleared, setCleared] = useState(0);

    const refresh = useCallback(() => {
        const list = loadEnsembleScripts().map((s) => ({
            id: s.id,
            title: s.title || "（未命名剧本）",
            sideStory: s.sideStory === true,
        }));
        setScripts(list);
        setBound(getBoundScript());
        setInject(isInjectEnabled());
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const boundExists = !!bound && scripts.some((s) => s.id === bound.id);

    return (
        <div className="prefs-block">
            <span className="prefs-block-label">Case App</span>

            <div className="prefs-row">
                <span className="flex-1 text-left ts-14 font-semibold text-[var(--c-text-title)]">本案剧本</span>
                <span className="ts-13 text-[var(--c-text)] opacity-70">
                    {!bound ? "未绑定" : boundExists ? bound.title || bound.id : "剧本已删除"}
                </span>
            </div>

            <button type="button" className="prefs-row" onClick={() => { clearBoundScript(); setBound(null); }}>
                <span className="flex-1 text-left ts-14 font-semibold text-[var(--c-text-title)]">不用案件 App</span>
                {!bound && <span className="ts-13 text-[var(--c-text)] opacity-70">当前</span>}
            </button>

            {scripts.map((s) => (
                <button
                    key={s.id}
                    type="button"
                    className="prefs-row"
                    onClick={() => {
                        setBoundScript({ id: s.id, title: s.title });
                        setBound({ id: s.id, title: s.title });
                    }}
                >
                    <span className="flex-1 truncate text-left ts-14 font-semibold text-[var(--c-text-title)]">
                        {s.title}
                        {s.sideStory ? "（番外）" : ""}
                    </span>
                    {bound?.id === s.id && <span className="ts-13 text-[var(--c-text)] opacity-70">当前</span>}
                </button>
            ))}

            <div className="prefs-row">
                <span className="flex-1 text-left ts-14 font-semibold text-[var(--c-text-title)]">
                    往剧情里注入案件背景
                </span>
                <Toggle
                    checked={inject}
                    onChange={(next) => {
                        setInjectEnabled(next);
                        setInject(next);
                    }}
                />
            </div>

            <button
                type="button"
                className="prefs-row"
                onClick={() => {
                    if (!bound) return;
                    const sessions = listCaseSessionsForScript(bound.id);
                    for (const s of sessions) {
                        clearCaseSession(s.ensembleScriptId, s.caseId, s.identity);
                    }
                    const orphans = clearOrphanSessions(scripts.map((s) => s.id));
                    setCleared(sessions.length + orphans);
                }}
            >
                <span className="flex-1 text-left ts-14 font-semibold text-[var(--c-text-title)]">清空本案存档</span>
                <span className="ts-13 text-[var(--c-text)] opacity-70">{cleared > 0 ? `已清 ${cleared}` : "—"}</span>
            </button>

            <div className="pb-3">
                <p className="m-0 ts-11 leading-relaxed text-[var(--c-text)] opacity-70">
                    只有绑定的剧本会出现案件入口、才会往剧情里注入案件背景；默认不绑，全站都没有案件 App。
                    绑定的是剧本 id，剧本删了重建会失配，重选一次即可。注入每轮一段 ≤600 字，嫌贵可以关掉，面板照用。
                </p>
            </div>
        </div>
    );
}