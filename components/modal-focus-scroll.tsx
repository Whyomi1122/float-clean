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
            const scroll = (node: HTMLElement) => {
                const r = el.getBoundingClientRect();
                const b = node.getBoundingClientRect();
                // 元素中心滚到容器中心
                node.scrollBy({
                    top: (r.top + r.height / 2) - (b.top + b.height / 2),
                    behavior: "smooth",
                });
            };
            scroll(body);
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
