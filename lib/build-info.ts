/**
 * 构建信息（版本号常驻显示）。
 *
 * - commit：优先取 Vercel 构建时注入的真实 commit（next.config.mjs env），
 *   本地构建回落到 "dev"，保证线上看到的和 Vercel 部署记录能对上。
 * - entries：最近几轮的用户可感知更新（新的在前），进入 float 的弹窗会展示。
 */

export type BuildEntry = {
    version: string;
    title: string;
    items: string[];
};

const VERCEL_COMMIT = (process.env.NEXT_PUBLIC_BUILD_COMMIT || "").trim();

export const BUILD_INFO = {
    /** 当前构建 commit（线上 = Vercel 注入的真实值；本地 = "dev"） */
    commit: VERCEL_COMMIT || "dev",
    /** 当前版本号（用于展示） */
    version: "2026.10.23-1",
    /** 历史更新记录（新的在前） */
    entries: [
        {
            version: "2026.10.23-1",
            title: "键盘修复定版 + 群像迁移",
            items: [
                "键盘问题根治：壳子高度收缩方案（顶栏不再被顶起、输入栏贴键盘上沿）",
                "群像 App 完整迁入：桌面第二页新增「群像」图标",
                "弹层表单输入框聚焦时自动滚进可视区（如添加身份的年龄/职业）",
                "版本号常驻显示：进入弹窗 + 全局设置页均可查看构建 commit",
            ],
        },
    ] as BuildEntry[],
};
