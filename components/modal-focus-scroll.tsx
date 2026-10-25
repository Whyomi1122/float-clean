"use client";

/**
 * 弹层输入框滚动进可视区（方案 A）。
 *
 * 背景：底部弹层表单（modal-sheet）高度不随键盘收缩，键盘弹出后
 * 弹层下半部分的输入框（如「添加身份」的年龄/职业）会被键盘盖住。
 *
 * 做法：全局监听 focusin——当聚焦元素位于某个可滚动容器
 * （.modal-body 或其他 data-ui="modal-body"）内时，把它平滑滚动到
 * 容器可视区的中部。只滚内容，不动任何栏（顶栏/底栏/输入栏位置不变）。
 *
 * 注：键盘弹出动画期间浏览器不提供中间值，这里延迟一帧 + 650ms 各滚一次，
 * 兜底键盘完全弹出后的最终位置。
 */

import { useEffect } from "react";

export function ModalFocusScroll() {
    useEffect(() => {
        if (typeof window === "undefined" || typeof document === "undefined") return;

        let timer1 = 0;
        let timer2 = 0;

        const scrollIntoViewCenter = (el: HTMLElement) => {
            // 找最近的弹层内容区
            const body = el.closest<HTMLElement>('[data-ui="modal-body"], .modal-body');
            if (!body) return;
            const r = el.getBoundingClientRect();
            // 以「可视区」（排除键盘遮挡）为基准：把输入框滚到可视区偏上 40% 处。
            // 之前滚到「弹层中心」，但底部弹层下半截整个被键盘盖住时，
            // 弹层中心也在键盘后面，等于白滚。
            const vv = window.visualViewport;
            const visibleTop = vv ? vv.offsetTop : 0;
            const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
            const targetY = visibleTop + (visibleBottom - visibleTop) * 0.4;
            const delta = (r.top + r.height / 2) - targetY;
            if (Math.abs(delta) < 8) return;
            body.scrollBy({ top: delta, behavior: "smooth" });
        };

        const onFocusIn = (event: FocusEvent) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const tag = target.tagName;
            const editable =
                tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
            if (!editable) return;
            window.clearTimeout(timer1);
            window.clearTimeout(timer2);
            timer1 = window.setTimeout(() => scrollIntoViewCenter(target), 50);
            // 键盘动画结束后再校准一次（安卓键盘动画期间无中间值）
            timer2 = window.setTimeout(() => scrollIntoViewCenter(target), 650);
        };

        document.addEventListener("focusin", onFocusIn, true);
        return () => {
            document.removeEventListener("focusin", onFocusIn, true);
            window.clearTimeout(timer1);
            window.clearTimeout(timer2);
        };
    }, []);

    return null;
}
