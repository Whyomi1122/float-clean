"use client";

import { Info, ShieldAlert, ChevronRight } from "lucide-react";

import { BUILD_INFO } from "@/lib/build-info";
import { StartupProbeCard } from "@/components/settings/startup-probe-card";
import { ForceReloadCard } from "@/components/settings/force-reload-card";

export function AboutDeclaration() {
    return (
        <div className="flex flex-col gap-6 h-full">
            <div className="prefs-block">
                <span className="prefs-block-label">版本信息</span>
                <div className="prefs-row">
                    <span className="flex-1 text-left ts-14 font-semibold text-[var(--c-text-title)]">版本</span>
                    <span className="ts-13 text-[var(--c-text)] opacity-70">{BUILD_INFO.version}</span>
                </div>
                <div className="prefs-row">
                    <span className="flex-1 text-left ts-14 font-semibold text-[var(--c-text-title)]">构建 commit</span>
                    <span className="ts-13 text-[var(--c-text)] opacity-70" style={{ fontFamily: "ui-monospace, monospace" }}>
                        {BUILD_INFO.commit}
                    </span>
                </div>
            </div>

            <span className="prefs-block-label px-1">性能自检</span>

            <StartupProbeCard />

            <ForceReloadCard />

            <div className="prefs-block">
                <span className="prefs-block-label">免责声明</span>
                <div className="prefs-row items-start">
                    <span className="shrink-0 mt-0.5 text-[var(--c-warning)]"><ShieldAlert size={18} strokeWidth={1.8} /></span>
                    <div className="flex flex-col gap-1 min-w-0 text-left">
                        <span className="ts-14 font-semibold text-[var(--c-text-title)]">AI 生成内容声明</span>
                        <span className="ts-11 leading-relaxed text-[var(--c-text)] opacity-70">
                            本应用内的所有角色对话、动态内容均为人工智能模型自动生成。生成内容不代表本平台的立场与观点，亦不对应任何现实中的人物、事件。用户应当自行辨别并承担使用风险。
                        </span>
                    </div>
                </div>
                <div className="prefs-row items-start">
                    <span className="shrink-0 mt-0.5 text-[var(--c-icon-active)]"><Info size={18} strokeWidth={1.8} /></span>
                    <div className="flex flex-col gap-1 min-w-0 text-left">
                        <span className="ts-14 font-semibold text-[var(--c-text-title)]">隐私与数据安全</span>
                        <span className="ts-11 leading-relaxed text-[var(--c-text)] opacity-70">
                            您的日记、聊天记录及身份预设等敏感数据默认保存在本地浏览器中（LocalStorage/IndexedDB）。清理浏览器缓存可能会导致数据丢失，请注意妥善备份。
                        </span>
                    </div>
                </div>
            </div>

            <div className="prefs-block">
                <span className="prefs-block-label">相关信息</span>
                <button type="button" className="prefs-row">
                    <span className="flex-1 text-left ts-14 font-semibold text-[var(--c-text-title)]">支持开发者</span>
                    <span className="ts-13 text-[var(--c-text)] opacity-70">请我喝杯咖啡</span>
                    <ChevronRight size={16} className="text-[var(--c-icon)] opacity-50 shrink-0" />
                </button>
            </div>
        </div>
    );
}
