"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock, Layers, UserRound } from "lucide-react";
import type { EnsembleScript } from "@/lib/ensemble-storage";
import { getStoryNow, isStoryClockActive, setStoryNow } from "@/lib/story-clock";

type Props = {
    script: EnsembleScript;
    /** 保存后就地更新（父组件负责 setCurrentScript + 落库 + 刷新列表） */
    onSaved: (updated: EnsembleScript) => void;
    onToast?: (message: string) => void;
};

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

/** Date → datetime-local 需要的字符串（本地时区，不带秒） */
function toLocalInput(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 番外剧本专属设置（2026-11-27）
 *
 * 1) 阵容人设：阵容是建剧本时的快照，就地改**只影响这一条番外**——
 *    if 线需要角色变形（改立场/改记忆/换身份）时靠这个，不会污染主线和其他剧本。
 * 2) 番外剧情时间：只拨这条番外的时间线，主线与其他剧本不动。
 *    全局设置页那条是「主线剧情时间」，番外不进那个列表。
 */
export function SideStorySettings({ script, onSaved, onToast }: Props) {
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [draftPersona, setDraftPersona] = useState<string>("");
    const [timeInput, setTimeInput] = useState("");

    const now = useMemo(() => getStoryNow(script.id), [script.id, script.updatedAt]);

    useEffect(() => {
        setTimeInput(toLocalInput(getStoryNow(script.id)));
    }, [script.id]);

    function startEdit(memberId: string, persona: string) {
        setExpandedId(memberId);
        setDraftPersona(persona ?? "");
    }

    function commitPersona(memberId: string) {
        const member = (script.cast ?? []).find(item => item.id === memberId);
        if (!member) return;
        if ((member.persona ?? "") === draftPersona) {
            setExpandedId(null);
            return;
        }
        const updated: EnsembleScript = {
            ...script,
            updatedAt: new Date().toISOString(),
            cast: (script.cast ?? []).map(item =>
                item.id === memberId ? { ...item, persona: draftPersona } : item,
            ),
        };
        onSaved(updated);
        setExpandedId(null);
        onToast?.("本幕阵容人设已更新（只影响这个番外）");
    }

    function commitTime() {
        const parsed = new Date(timeInput);
        if (Number.isNaN(parsed.getTime())) {
            onToast?.("时间格式不对");
            return;
        }
        setStoryNow(parsed, script.id);
        onToast?.(`番外剧情时间已设为 ${toLocalInput(parsed).replace("T", " ")}`);
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="rounded-2xl bg-white/70 border border-black/[0.05] px-4 py-3">
                <div className="flex items-center gap-2 text-[12px] font-medium text-[#1a1a1a]">
                    <Layers size={13} className="text-[#8a7550]" />
                    番外专属
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-black/45">
                    这条番外的剧情、归档、走向卡、时间线都和主线各管各的。杀青后归档只进「番外记忆库」，
                    需要你在记忆库里手动确认，才会注入角色记忆。
                </p>
            </div>

            {/* 1. 阵容人设（快照就地编辑） */}
            <div className="rounded-2xl bg-white/70 border border-black/[0.05] px-4 py-3">
                <div className="flex items-center gap-2 text-[12px] font-medium text-[#1a1a1a]">
                    <UserRound size={13} className="text-[#8a7550]" />
                    本番外阵容人设
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-black/45">
                    改这里只影响这条番外（if 线可以把人写歪、写疯、写成另一个人），主线和其他剧本不动。
                </p>
                <div className="mt-2 flex flex-col gap-1.5">
                    {(script.cast ?? []).map(member => {
                        const editing = expandedId === member.id;
                        return (
                            <div key={member.id} className="rounded-xl bg-white/80 px-3 py-2">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-[12px] text-[#1a1a1a] line-clamp-1">
                                        {member.name}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => (editing ? setExpandedId(null) : startEdit(member.id, member.persona ?? ""))}
                                        className="text-[11px]"
                                        style={{ color: "#5B8FB9" }}
                                    >
                                        {editing ? "收起" : "编辑人设"}
                                    </button>
                                </div>
                                {editing && (
                                    <div className="mt-1.5">
                                        <textarea
                                            value={draftPersona}
                                            onChange={event => setDraftPersona(event.target.value)}
                                            rows={10}
                                            className="w-full resize-y rounded-xl border border-black/[0.08] bg-white px-2.5 py-2 text-[12px] leading-relaxed outline-none"
                                        />
                                        <div className="mt-1.5 flex gap-2">
                                            <button
                                                type="button"
                                                onClick={() => commitPersona(member.id)}
                                                className="rounded-lg px-3 py-1 text-[11px] text-white"
                                                style={{ background: "#5B8FB9" }}
                                            >
                                                保存这一份
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setExpandedId(null)}
                                                className="rounded-lg bg-black/[0.06] px-3 py-1 text-[11px] text-black/60"
                                            >
                                                取消
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    {(script.cast ?? []).length === 0 && (
                        <p className="text-[11px] text-black/40">这个番外还没有阵容。</p>
                    )}
                </div>
            </div>

            {/* 2. 番外剧情时间 */}
            <div className="rounded-2xl bg-white/70 border border-black/[0.05] px-4 py-3">
                <div className="flex items-center gap-2 text-[12px] font-medium text-[#1a1a1a]">
                    <Clock size={13} className="text-[#8a7550]" />
                    番外剧情时间
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-black/45">
                    只拨这条番外的时间线。设置页里那条叫「主线剧情时间」，番外不参与，也不会把角色的
                    单聊日期带到这里。
                </p>
                <div className="mt-2 text-[12px] text-black/60">
                    现在：<strong>{toLocalInput(now).replace("T", " ")}</strong>
                    <span className="ml-2 text-[11px] text-black/40">
                        {isStoryClockActive(script.id) ? "已拨过（已冻结）" : "跟随现实时间"}
                    </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                        type="datetime-local"
                        value={timeInput}
                        onChange={event => setTimeInput(event.target.value)}
                        className="rounded-xl border border-black/[0.08] bg-white px-2 py-1 text-[12px]"
                    />
                    <button
                        type="button"
                        onClick={commitTime}
                        className="rounded-lg px-3 py-1 text-[11px] text-white"
                        style={{ background: "#5B8FB9" }}
                    >
                        设为这个时刻
                    </button>
                </div>
            </div>
        </div>
    );
}

export default SideStorySettings;