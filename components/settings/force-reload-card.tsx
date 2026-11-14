"use client";

import { useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";

/**
 * 强制刷新到最新版本（2026-11-14 用户要求）
 *
 * 痛点：手机上常常刷不到最新部署的版本，非得把 cookie / 站点数据全删了再导入备份才行。
 * 真正拦着的是这几层：
 *   1. Service Worker 里旧部署的壳（public/sw.js 的预缓存 "/"）
 *   2. Cache Storage 里的 static / runtime 缓存
 *   3. 浏览器 HTTP 缓存里那份 HTML（同 URL 可能还在有效期）
 * 所以这里按顺序清 1、2，再用带随机参数的 URL 重导航（等价于一个从没访问过的地址，
 * 浏览器和 CDN 都没有它的旧快照），就绕过了第 3 层。
 * 不动 localStorage / IndexedDB / cookie —— 用户的聊天、人设、API 配置一条都不会丢。
 */
export function ForceReloadCard() {
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState("");

  const forceReload = async () => {
    if (busy) return;
    setBusy(true);
    setDetail("正在注销离线缓存…");

    // 1) 注销所有 Service Worker（不注销的话它会在下一次导航时继续拦截文档请求）
    let removedSw = 0;
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        const results = await Promise.all(regs.map(reg => reg.unregister().catch(() => false)));
        removedSw = results.filter(Boolean).length;
      }
    } catch {
      // 无 SW 环境，忽略
    }

    // 2) 清空 Cache Storage（sw.js 的 static / runtime 两个桶都在这）
    let removedCache = 0;
    let removedEntries = 0;
    try {
      if (typeof caches !== "undefined") {
        const keys = await caches.keys();
        const results = await Promise.all(keys.map(async key => {
          try {
            const cache = await caches.open(key);
            const size = (await cache.keys()).length;
            const ok = await caches.delete(key);
            if (ok) removedEntries += size;
            return ok;
          } catch {
            return false;
          }
        }));
        removedCache = results.filter(Boolean).length;
      }
    } catch {
      // 隐私模式可能禁用 Cache Storage
    }

    setDetail(
      removedSw + removedCache > 0
        ? `已注销 ${removedSw} 个离线线程、清掉 ${removedCache} 份缓存（${removedEntries} 个文件），正在重新加载…`
        : "本机没有离线缓存残留，正在重新加载…",
    );

    // 3) 带随机参数重导航：新 URL 没有旧快照，一定会回到服务器拿最新部署
    const target = `${window.location.origin}${window.location.pathname}?_fresh=${Date.now()}`;
    window.setTimeout(() => {
      try {
        window.location.replace(target);
      } catch {
        window.location.href = target;
      }
    }, 350);

    // 兜底：万一重导航被拦（PWA 全屏 / 手势缓存），2 秒后硬跳一次
    window.setTimeout(() => {
      try {
        window.location.href = target;
      } catch {
        // 放弃
      }
    }, 2000);
  };

  return (
    <div className="g-card flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <RefreshCw size={18} className={busy ? "shrink-0 animate-spin text-[#5B8FB9]" : "shrink-0 text-[#5B8FB9]"} />
        <span className="menu-label flex-1">强制刷新到最新版本</span>
      </div>
      <span className="menu-desc !mt-0 ts-13">
        注销离线缓存 + 清空站点缓存，再用新地址重新打开。适用于「明明推送了新版本，手机还是旧界面」。
      </span>
      <span className="menu-desc !mt-0 ts-13 flex items-center gap-1.5">
        <ShieldCheck size={13} className="shrink-0 text-[var(--c-icon-active)]" />
        聊天记录、人设、API 配置保存在本地存储里，不会被清掉。
      </span>

      <button
        type="button"
        onClick={() => void forceReload()}
        disabled={busy}
        className="mt-1 flex items-center justify-center gap-1.5 rounded-[10px] bg-black/[0.05] py-2 text-[13px] active:bg-black/[0.09] disabled:opacity-60"
      >
        <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
        {busy ? "正在刷新…" : "强制刷新"}
      </button>

      {detail && <span className="menu-desc !mt-0 ts-13">{detail}</span>}
    </div>
  );
}
