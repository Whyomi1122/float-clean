// lib/case-engine/cases/exit9_invalid_nods.ts
// 测试案《九号出口 · 无效点头》（借鉴真实案件类型的虚构案，细节全虚构、不指向真人）。
// 只锁四根桩：真相 / 关键材料（含节选正文）/ 三层争点 / 结局判法。
// 其余（谁怎么递、庭上怎么争、说什么话）由剧情 AI 现场写 —— AI 不许新增证据、不许改正文。

import type { CasePackage } from "../types";

export const EXIT9_INVALID_NODS: CasePackage = {
    id: "exit9_invalid_nods",
    title: "九号出口 · 无效点头",
    caseNo: "2027고합0147",
    meta: {
        date: "2027-04-01 21:03",
        place: "首尔 · 鹰岩站 9 号出口",
        deliveredBy: "崔永进",
        deliveredLine: "明天这个庭，翻译这边你先看一眼。",
    },
    truth: "保安车东勋先动手抓住被告左腕往外拖；被告三次点头是「我正在听」的回应信号，不是「同意先动手」。",

    acts: [
        { id: "investigate", title: "侦查幕（本版不开放）", playableIdentities: [] },
        { id: "prosecute", title: "起诉幕（本版不开放）", playableIdentities: [] },
        {
            id: "trial",
            title: "庭审幕",
            playableIdentities: ["wolinyu"],
            // 12 分钟只是这个案子的设定值；真实时长以案件包/剧情为准，不给＝本幕不计时
            timeBudgetMin: 12,
        },
    ],

    evidence: [
        {
            id: "E-01",
            name: "CCTV 节选帧 23:41:12",
            sectionMark: "节选 · 2027고합0147 · 附件 3",
            desc: "三帧定格：23:41:12 保安右手扣住被告左腕；23:41:15 往回一带；23:41:19 被告单膝着地、货箱脱手。帧号从 22:58 直接跳到 23:39——中间四十多分钟没有记录。",
            pointsTo: ["scene"],
            initialAccess: { wolinyu: "granted" },
            check: {
                label: "对帧",
                minutes: 3,
                result: "抓腕那一帧在被告抬手护住货箱之后。不是他先伸手，是他先被抓住才挣开。",
            },
        },
        {
            id: "E-02",
            name: "西大门署现场笔录（节选）",
            sectionMark: "节选 · 页码自 2/5 起",
            desc: "记录写：「问：是你先动手的吗。嫌疑人点头。记录：嫌疑人点头承认先动手。」页眉标 2/5，缺第 1、4 页。签名栏有办案警员与被告指印，翻译栏是空的。",
            pointsTo: ["procedure"],
            initialAccess: { wolinyu: "granted" },
            check: {
                label: "抠措辞",
                minutes: 2,
                result: "问句是封闭式的，被告的动作只有「点头」两个字，记录却把它写成「承认」。中间跳了一步。",
            },
        },
        {
            id: "E-03",
            name: "第一次讯问录像",
            sectionMark: "节选 · 前 22 分钟",
            desc: "画面二十二分四十一秒。第 8 分 03 秒，警员说「点头就是不反对吧」，被告点头；第 9 分 12 秒同一句又问一次，被告又点头。全程没有手语翻译入镜，桌面上没有写字板。",
            pointsTo: ["procedure", "semantics"],
            initialAccess: { wolinyu: "pending", pi: "granted", kim: "granted" },
            ask: {
                to: "pi",
                draft: "皮检察官，第一次讯问的完整录像能不能调一份给我？我只需要看翻译是否在场、点头出现在哪一句之后。",
            },
            check: {
                label: "过录像",
                minutes: 4,
                result: "两次点头都跟在「点头就是不反对吧」这句之后。第 9 分 12 秒那次之后，被告低头在写字板上写了字，镜头没拍到内容。",
            },
        },
        {
            id: "E-04",
            name: "车东勋诊断书",
            sectionMark: "节选 · 急诊记录",
            desc: "急诊记录：左腕舟骨骨裂，未移位，石膏固定四到六周。备注栏写着：腕部皮肤有环状淤痕，符合被握住后挣脱，不符合推倒时用手撑地。",
            pointsTo: ["scene"],
            initialAccess: { wolinyu: "granted" },
            check: {
                label: "看伤",
                minutes: 1,
                result: "环状淤痕加骨裂方向：被握住挣脱，不是被推倒撑地。伤在腕，不在掌。",
            },
        },
        {
            id: "E-05",
            name: "吴世理写字板照片",
            sectionMark: "节选 · 拍摄于 00:07",
            desc: "巴掌大的写字板，当夜 00:07 拍下：一行歪扭的字——「我点头只是在说我听到了。请更正笔录。」下面还压着半行没拍全的字。",
            pointsTo: ["semantics"],
            initialAccess: { wolinyu: "granted" },
            check: {
                label: "认字",
                minutes: 1,
                result: "照片时间是 00:07，笔录制作时间是 00:41。异议写在笔录之前，不是事后翻供。",
            },
        },
        {
            id: "E-06",
            name: "讯问在场人员记录",
            sectionMark: "节选 · 值班表",
            desc: "在场人员一栏：办案警员两名、值班组长一名。翻译一栏空白。备注写着「嫌疑人可以正常沟通」，没有注明依据，也没有写用什么方式沟通。",
            pointsTo: ["procedure"],
            initialAccess: { wolinyu: "pending", pi: "granted" },
            ask: {
                to: "kim",
                draft: "金警官，讯问当日的在场人员记录能给我一份吗？我需要看翻译那一栏是怎么填的。",
            },
            check: {
                label: "核对在场",
                minutes: 2,
                result: "所有在场人员记录里都没有翻译。备注「可以正常沟通」没有依据、没有方式——这句话本身就是问题。",
            },
        },
        {
            id: "F-01",
            name: "2024 年商铺纠纷记录",
            sectionMark: "节选 · 旧档",
            desc: "报警人一栏写的是被告本人。那一次他是替店主找被偷的货箱，不是被报警的人。卷宗里只留了这一页，前后都没有。",
            pointsTo: [],
            initialAccess: { wolinyu: "granted" },
            redHerring: true,
            check: {
                label: "翻旧档",
                minutes: 1,
                result: "他是报警的那个人。这一页如果被当成「前科」递上去，会被打回。",
            },
        },
        {
            id: "F-02",
            name: "30 米外目击者陈述",
            sectionMark: "节选 · 112 记录",
            desc: "匿名 112 记录：一名三十米外的目击者称「那个聋子推的」。询问时天已经黑了，通道照明故障；目击者自述没戴眼镜。",
            pointsTo: [],
            initialAccess: { wolinyu: "granted" },
            redHerring: true,
            check: {
                label: "核条件",
                minutes: 1,
                result: "天黑、灯坏、没戴眼镜、三十米。这个人看见的多半是轮廓。",
            },
        },
    ],

    disputes: [
        { layer: "scene", text: "伤是摔出来的，不是被推出去的。" },
        { layer: "procedure", text: "没有翻译、没有同步录音的讯问笔录，效力站不住。" },
        { layer: "semantics", text: "聋人的点头是「我在听」的回应信号，不是同意。" },
    ],

    endings: [
        {
            id: "filed",
            title: "已采纳",
            text: "交出语义层材料，并核过 E-03 / E-06 —— 法院不采信「点头承认」。",
        },
        {
            id: "noted",
            title: "记下不动",
            text: "只交了观察 —— 法院把意见记下，本案继续走。",
        },
        {
            id: "rejected",
            title: "打回",
            text: "引用了断链（前科、目击证言之类）—— 驳回，理由：超出翻译职责范围。不惩罚，待办保留。",
        },
    ],

    openingTodos: ["看", "求", "核", "记"],
    protocol: {
        open: "崔永进转来庭审参考卷（节选）。",
        settle: "岳霖玉提交语义层材料，法院对「点头承认」不予采信。",
    },
};