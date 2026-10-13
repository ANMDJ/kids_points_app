/* ==========================================================================
 * 积分小管家 · 微信小程序高保真原型 —— 交互逻辑
 * --------------------------------------------------------------------------
 * 本文件是 kids_points_mp（Taro 小程序）的**可交互替身**，三处刻意同源：
 *
 *   1. ICONS     ← src/components/Icon/icons.ts  （同一份 24×24 矢量路径）
 *   2. 派生函数   ← src/data/types.ts            （limitTextOf / doneTextOf /
 *                    ruleDetail / recordSubtitle / amountText / dayLabel …）
 *   3. 初始数据   ← src/data/seed.ts             （124 分 / 324 / 4 / 四条流水 / 四条规则）
 *
 * 目的：让评审者**不装微信开发者工具**就能点开看真实交互，
 * 同时保证原型里出现的每一句文案都来自仓库的派生函数，而不是人手拼的展示串
 * （那正是 design/03 里 E17 / E19 的病）。
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ 图标 */

  /**
   * 与 src/components/Icon/icons.ts 的 ICONS **逐字相同**。
   * `f: 1` 表示实心（fill），缺省为线性（stroke，线宽 1.9，圆头圆角）。
   */
  var ICONS = {
    home: ['M4.2 10.6 12 4.2l7.8 6.4V19a1.2 1.2 0 0 1-1.2 1.2h-3.6v-5.4H9v5.4H5.4A1.2 1.2 0 0 1 4.2 19z'],
    homeFill: { f: 1, d: ['M12 3.4 3.6 10.3V19.4A1.6 1.6 0 0 0 5.2 21h3.9v-5.7h5.8V21h3.9a1.6 1.6 0 0 0 1.6-1.6v-9.1z'] },
    heart: ['M12 20.4C10.3 19.2 4.2 15 4.2 10.5A4.4 4.4 0 0 1 12 7.3a4.4 4.4 0 0 1 7.8 3.2c0 4.5-6.1 8.7-7.8 9.9z'],
    heartFill: { f: 1, d: ['M12 21S3.4 15.9 3.4 10.4A4.9 4.9 0 0 1 12 7.1a4.9 4.9 0 0 1 8.6 3.3C20.6 15.9 12 21 12 21z'] },
    smile: [
      'M12 3.4a8.6 8.6 0 1 0 0 17.2 8.6 8.6 0 0 0 0-17.2z',
      'M8.9 10h.01',
      'M15.1 10h.01',
      'M8.4 14.1a4.6 4.6 0 0 0 7.2 0'
    ],
    book: [
      'M12 6.6C10.5 5.4 8.5 4.8 5.8 4.8H4.2v13.4h1.6c2.7 0 4.7.6 6.2 1.8',
      'M12 6.6c1.5-1.2 3.5-1.8 6.2-1.8h1.6v13.4h-1.6c-2.7 0-4.7.6-6.2 1.8',
      'M12 6.6v13.4'
    ],
    stories: [
      'M12 6.6C10.5 5.4 8.5 4.8 5.8 4.8H4.2v13.4h1.6c2.7 0 4.7.6 6.2 1.8',
      'M12 6.6c1.5-1.2 3.5-1.8 6.2-1.8h1.6v13.4h-1.6c-2.7 0-4.7.6-6.2 1.8',
      'M12 6.6v13.4',
      'M7 9.6h2.6',
      'M14.4 9.6H17'
    ],
    backpack: [
      'M6.6 9.8h10.8a1.6 1.6 0 0 1 1.6 1.6v7.4a1.6 1.6 0 0 1-1.6 1.6H6.6A1.6 1.6 0 0 1 5 18.8v-7.4a1.6 1.6 0 0 1 1.6-1.6z',
      'M9.2 9.8V7.4a2.8 2.8 0 0 1 5.6 0v2.4',
      'M9.4 14.6h5.2'
    ],
    clipboard: [
      'M9.2 4.6h5.6a1.2 1.2 0 0 1 1.2 1.2v1.4H8V5.8a1.2 1.2 0 0 1 1.2-1.2z',
      'M8 7.2H6.6A1.4 1.4 0 0 0 5.2 8.6v10.6a1.4 1.4 0 0 0 1.4 1.4h10.8a1.4 1.4 0 0 0 1.4-1.4V8.6a1.4 1.4 0 0 0-1.4-1.4H16',
      'M9 12.4h6',
      'M9 15.8h4'
    ],
    gift: [
      'M4.8 10.6h14.4v8.8a1.4 1.4 0 0 1-1.4 1.4H6.2a1.4 1.4 0 0 1-1.4-1.4z',
      'M3.6 7.4h16.8v3.2H3.6z',
      'M12 7.4v13.4',
      'M12 7.4C10.4 4.6 9.4 3.4 8.2 3.4a2 2 0 0 0 0 4h3.8z',
      'M12 7.4c1.6-2.8 2.6-4 3.8-4a2 2 0 0 1 0 4H12z'
    ],
    palette: [
      'M12 3.6a8.4 8.4 0 0 0 0 16.8c1.1 0 1.8-.7 1.8-1.6 0-1.6.9-2.3 2.1-2.3h1.5a2.9 2.9 0 0 0 2.9-2.9c0-5.5-3.8-10-8.3-10z',
      'M7.8 11.2h.01',
      'M11.2 8.6h.01',
      'M15.2 10.6h.01'
    ],
    music: [
      'M9.4 18.2a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0z',
      'M19.8 15.8a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0z',
      'M9.4 18.2V6.6l10.4-2.6v11.8'
    ],
    basketball: [
      'M12 3.4a8.6 8.6 0 1 0 0 17.2 8.6 8.6 0 0 0 0-17.2z',
      'M3.6 12h16.8',
      'M12 3.4c2.6 3 2.6 14.2 0 17.2',
      'M12 3.4c-2.6 3-2.6 14.2 0 17.2'
    ],
    spray: [
      'M9.8 8.6h5.6l1.4 11.8H8.4z',
      'M10.6 8.6V6.4h4v2.2',
      'M12.6 6.4V4.2',
      'M12.4 3.6h3.2v1.6h-3.2z',
      'M7.2 4.4h.01',
      'M5.4 6.6h.01'
    ],
    trophy: [
      'M7.6 4.6h8.8v4.2a4.4 4.4 0 0 1-8.8 0z',
      'M7.6 6h-2A1.4 1.4 0 0 0 4.2 7.4v.3a3.2 3.2 0 0 0 3.2 3.2',
      'M16.4 6h2a1.4 1.4 0 0 1 1.4 1.4v.3a3.2 3.2 0 0 1-3.2 3.2',
      'M12 13.2v3.4',
      'M9.8 16.6h4.4v3.6H9.8z',
      'M8.6 20.2h6.8'
    ],
    star: ['M12 4.4l2.3 4.7 5.2.8-3.8 3.6.9 5.1-4.6-2.5-4.6 2.5.9-5.1L4.5 9.9l5.2-.8z'],
    starFill: { f: 1, d: ['M12 4.4l2.3 4.7 5.2.8-3.8 3.6.9 5.1-4.6-2.5-4.6 2.5.9-5.1L4.5 9.9l5.2-.8z'] },

    plus: ['M12 5.6v12.8', 'M5.6 12h12.8'],
    minus: ['M5.6 12h12.8'],
    check: ['M5.2 12.6 9.7 17.1 18.8 7.9'],
    pencil: ['M4.8 19.2v-3.5L15.3 5.2a2.2 2.2 0 0 1 3.1 3.1L7.9 19.2z', 'M14.2 6.4l3.4 3.4'],
    editNote: [
      'M4.4 19.7v-3.4L14.1 6.3a2.1 2.1 0 0 1 3 3L7.4 19.4z',
      'M13.2 7.4l3 3',
      'M4 21.4h16'
    ],
    chevronLeft: ['M14.4 6.2 8.6 12l5.8 5.8'],
    chevronRight: ['M9.6 6.2 15.4 12l-5.8 5.8'],
    copy: [
      'M9.4 9.4h7.8a1.6 1.6 0 0 1 1.6 1.6v7.8a1.6 1.6 0 0 1-1.6 1.6H9.4a1.6 1.6 0 0 1-1.6-1.6V11a1.6 1.6 0 0 1 1.6-1.6z',
      'M5.2 15.4A1.6 1.6 0 0 1 3.6 13.8V6a1.6 1.6 0 0 1 1.6-1.6h7.8A1.6 1.6 0 0 1 14.6 6v.4'
    ],
    close: ['M6.2 6.2l11.6 11.6', 'M17.8 6.2 6.2 17.8'],
    listCheck: ['M4 6.6h9.2', 'M4 12h9.2', 'M4 17.4h5.6', 'M14.4 15.2l2.2 2.2 4-4.4'],
    trash: [
      'M5.4 7.4h13.2',
      'M9.6 7.4V5.6a1.2 1.2 0 0 1 1.2-1.2h2.4a1.2 1.2 0 0 1 1.2 1.2v1.8',
      'M7 7.4l.8 11.2a1.4 1.4 0 0 0 1.4 1.3h5.6a1.4 1.4 0 0 0 1.4-1.3L17 7.4',
      'M10.4 11v5.6',
      'M13.6 11v5.6'
    ],
    /* 兜底占位（白名单之外的名字画它）——与 icons.ts 的 FALLBACK_ICON_NAME 同名 */
    unknown: [
      'M12 3.4a8.6 8.6 0 1 0 0 17.2 8.6 8.6 0 0 0 0-17.2z',
      'M9.5 9.5a2.5 2.5 0 0 1 4.9.6c0 1.7-2.4 1.9-2.4 3.6',
      'M12.1 17.1h.01'
    ]
  };

  var FALLBACK_ICON_NAME = 'unknown';

  /**
   * 取图标定义（未登记的名字走兜底，不空白、不崩溃）——同 icons.ts 的 getIcon。
   *
   * 登记写法刻意分成两种，省掉每行都写 `d:`：
   *   · 线性图标（默认）→ 直接给路径数组：      plus: ['M12 5.6v12.8', 'M5.6 12h12.8']
   *   · 实心图标        → 给 `{ f: 1, d: [...] }`（f = fill）
   * [iconDefOf] 负责归一回 `{ fill, d }`，语义等价于 icons.ts 的 `IconDef`。
   */
  function getIcon(name) {
    if (!Object.prototype.hasOwnProperty.call(ICONS, name)) {
      return ICONS[FALLBACK_ICON_NAME];
    }
    return ICONS[name];
  }

  /** 归一成 `{ fill, d }`。 */
  function iconDefOf(name) {
    var def = getIcon(name);
    if (Object.prototype.hasOwnProperty.call(def, 'd')) {
      return { fill: def.f === 1, d: def.d };
    }
    return { fill: false, d: def };
  }

  /**
   * 画一个图标：把 SVG 编成 data URI 作为背景图，颜色运行时注入。
   * 与 components/Icon/index.tsx 同一做法（所以不需要任何图片资源）。
   */
  function iconSvg(name, size, color) {
    return (
      '<span class="kp-icon" style="width:' + size + 'px;height:' + size + 'px;' +
      'background-image:' + cssUrl(svgSource(name, color)) + '"></span>'
    );
  }

  /** 把 SVG 源码编成可放进 CSS url() 的 data URI（# 必须转义）。 */
  function cssUrl(svg) {
    var encoded = svg
      .replace(/#/g, '%23')
      .replace(/</g, '%3C')
      .replace(/>/g, '%3E')
      .replace(/"/g, "'");
    return "url(\"data:image/svg+xml," + encoded + "\")";
  }

  /** 首屏静态标记里的 <span data-icon>：按 data-* 渲染出来（含底部导航的选中态）。 */
  function paintStaticIcons() {
    document.querySelectorAll('[data-icon]').forEach(function (el) {
      el.style.width = el.dataset.size + 'px';
      el.style.height = el.dataset.size + 'px';
      el.style.backgroundImage = cssUrl(svgSource(el.dataset.icon, el.dataset.color));
    });
    paintNavIcons();
  }

  /** 底部导航：选中项 23px 主色、未选中 23px 灰色（AppBottomNav 的做法）。 */
  function paintNavIcons(activeIndex) {
    var items = document.querySelectorAll('#bottom-nav .kp-nav__item');
    items.forEach(function (item, index) {
      var active = index === activeIndex;
      var wrap = item.querySelector('[data-nav-icon]');
      var base = wrap.dataset.navIcon;
      var name = active ? base + 'Fill' : base;
      // “我的”用同一个笑脸图标表示选中（与 ITEMS 的 activeIcon: 'smile' 一致）
      if (base === 'smile') name = 'smile';
      wrap.style.width = '23px';
      wrap.style.height = '23px';
      wrap.style.backgroundImage = cssUrl(svgSource(name, active ? '#7fbf55' : '#b9c2b0'));
      item.classList.toggle('is-active', active);
    });
  }

  function svgSource(name, color) {
    var def = iconDefOf(name);
    var paths = def.d
      .map(function (d) {
        return (
          '<path d="' + d + '" fill="' + (def.fill ? color : 'none') +
          '" stroke="' + (def.fill ? 'none' : color) +
          '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'
        );
      })
      .join('');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' + paths + '</svg>';
  }

  /* ======================================================================
   * 文案派生 —— 与 src/data/types.ts 逐字一致
   * ----------------------------------------------------------------------
   * 原型里出现的每一句「每天 1 次 / 今日已完成 N 次 / 09:30 · 家长记录」
   * 都必须由这里算出来，页面不写死任何展示串（修 E15 / E17 / E19 的同一口径）。
   * ==================================================================== */

  var recordCategoryLabels = { praise: '表扬', exchange: '兑换', adjust: '调整' };

  var recordSourceLabels = {
    child_self: '自己完成',
    guardian: '家长记录',
    agent: '积分小助手',
    approval: '家长审批通过',
    system: '系统',
    correction: '撤销'
  };

  var dailyLimitMin = 1;
  var dailyLimitMax = 5;
  var trashRetentionDays = 90;
  var msPerDay = 86400000;

  /** 频次的展示串（types.ts limitTextOf）：1 次是「每天 1 次」，其余是「每天最多 N 次」。 */
  function limitTextOf(dailyLimit) {
    return dailyLimit === 1 ? '每天 1 次' : '每天最多 ' + dailyLimit + ' 次';
  }

  function doneTextOf(count) {
    return '今日已完成 ' + count + ' 次';
  }

  function amountText(points) {
    return points >= 0 ? '+' + points : String(points);
  }

  function ruleDetail(rule) {
    return rule.condition + ' · ' + limitTextOf(rule.dailyLimit);
  }

  function clockText(time) {
    var date = new Date(time);
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function isSameDay(a, b) {
    var x = new Date(a);
    var y = new Date(b);
    return (
      x.getFullYear() === y.getFullYear() &&
      x.getMonth() === y.getMonth() &&
      x.getDate() === y.getDate()
    );
  }

  function dayLabel(time) {
    var now = new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var date = new Date(time);
    var dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    var diff = Math.round((todayStart - dayStart) / msPerDay);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff === 2) return '前天';
    return date.getMonth() + 1 + ' 月 ' + date.getDate() + ' 日';
  }

  /**
   * 由结构字段派生流水副标题（types.ts recordSubtitle）。
   * 兑换类固定说「兑换奖励」，其余按**真实来源**取词 —— 禁止一律写「家长记录」(A4)。
   */
  function recordSubtitle(input) {
    var head =
      input.category === 'exchange' ? '兑换奖励' : recordSourceLabels[input.source];
    var parts = [clockText(input.time), head];
    var note = (input.note || '').trim();
    if (note !== '') parts.push(note);
    return parts.join(' · ');
  }

  function trashRetentionText(deletedAt, now) {
    var days = Math.floor(((now || Date.now()) - deletedAt) / msPerDay);
    var left = trashRetentionDays - days;
    return left <= 0 ? '已过保留期' : '还能恢复 ' + left + ' 天';
  }

  function trashKindLabelOf(kind) {
    if (kind === 'point_rule') return '规则';
    if (kind === 'wish') return '心愿';
    return '习惯';
  }

  /* ======================================================================
   * 初始数据 —— 与 src/data/seed.ts 同值
   * ----------------------------------------------------------------------
   * 124 分 / 324 好习惯 / 4 次奖励 / 三条今天的习惯 / 四条心愿 /
   * 四条流水（今天 19:30 与 18:50、昨天 20:00 与 19:10）/ 四条规则。
   * ⚠️ 与 seed.ts 一样，流水时间取的是**固定钟点**，所以不论你几点打开，
   *    「今天的流水」永远是 19:30 / 18:50 —— 这是演示数据的既有口径，不是 bug。
   * ==================================================================== */

  function at(dayOffset, hour, minute) {
    var now = new Date();
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + dayOffset,
      hour,
      minute
    ).getTime();
  }

  function buildSeed() {
    var today1930 = at(0, 19, 30);
    var today1850 = at(0, 18, 50);
    var yesterday2000 = at(-1, 20, 0);
    var yesterday1910 = at(-1, 19, 10);

    var habits = [
      {
        id: 'habit-pomodoro',
        title: '番茄钟写作业',
        points: 1,
        condition: '专注 25 分钟',
        dailyLimit: 2,
        icon: 'book',
        color: '#7fbf55',
        ruleId: 'rule-1'
      },
      {
        id: 'habit-backpack',
        title: '自己收书包',
        points: 2,
        condition: '睡前整理好',
        dailyLimit: 1,
        icon: 'backpack',
        color: '#f5a24b',
        ruleId: 'rule-2'
      },
      {
        id: 'habit-reading',
        title: '自主阅读',
        points: 2,
        condition: '阅读 20 分钟',
        dailyLimit: 1,
        icon: 'stories',
        color: '#7bb0e8',
        ruleId: 'rule-4'
      }
    ];

    var wishes = [
      { id: 'wish-1', title: '限定商品 30 元优惠券（满 300 减 100）', cost: 40, emoji: '🍖', coverStyle: 'A', redeemed: false },
      { id: 'wish-2', title: '汪汪零食大礼包 · 周末加餐', cost: 40, emoji: '🐶', coverStyle: 'B', redeemed: false },
      { id: 'wish-3', title: '一起去游乐园玩一整天（亲子票）', cost: 445, emoji: '🎡', coverStyle: 'C', redeemed: false },
      { id: 'wish-4', title: '新款积木套装（1000+ 颗粒）', cost: 445, emoji: '🧩', coverStyle: 'D', redeemed: false }
    ];

    var records = [
      {
        id: 'rec-1',
        title: '番茄钟写作业',
        points: 1,
        time: today1930,
        category: 'praise',
        icon: 'book',
        color: '#f6c64a',
        source: 'guardian',
        note: '',
        habitId: 'habit-pomodoro',
        ruleId: 'rule-1',
        ruleVersion: 1,
        wishId: null,
        reversesRecordId: null,
        balanceAfter: 123
      },
      {
        id: 'rec-2',
        title: '自己收书包',
        points: 2,
        time: today1850,
        category: 'praise',
        icon: 'backpack',
        color: '#e9834b',
        source: 'guardian',
        note: '',
        habitId: 'habit-backpack',
        ruleId: 'rule-2',
        ruleVersion: 1,
        wishId: null,
        reversesRecordId: null,
        balanceAfter: 125
      },
      {
        id: 'rec-3',
        title: '围棋课后作业',
        points: 5,
        time: yesterday2000,
        category: 'praise',
        icon: 'clipboard',
        color: '#7fbf55',
        source: 'guardian',
        note: '',
        habitId: null,
        ruleId: 'rule-3',
        ruleVersion: 1,
        wishId: null,
        reversesRecordId: null,
        balanceAfter: 121
      },
      {
        id: 'rec-4',
        title: '兑换：小饼干',
        points: -30,
        time: yesterday1910,
        category: 'exchange',
        icon: 'gift',
        color: '#f5a24b',
        source: 'guardian',
        /* 备注作为副标题的**附加段**（不替换来源）—— 修 E19 */
        note: '已兑换',
        habitId: null,
        ruleId: null,
        ruleVersion: null,
        wishId: null,
        reversesRecordId: null,
        balanceAfter: 116
      }
    ];

    var rules = [
      { id: 'rule-1', title: '番茄钟写作业', condition: '专注 25 分钟', dailyLimit: 2, points: 1, icon: 'book', color: '#f6c64a', currentVersion: 1 },
      { id: 'rule-2', title: '自己收书包', condition: '睡前整理好', dailyLimit: 1, points: 2, icon: 'backpack', color: '#e9834b', currentVersion: 1 },
      { id: 'rule-3', title: '围棋课后作业', condition: '完成并检查', dailyLimit: 1, points: 5, icon: 'clipboard', color: '#7fbf55', currentVersion: 1 },
      { id: 'rule-4', title: '自主阅读', condition: '阅读 20 分钟', dailyLimit: 1, points: 2, icon: 'stories', color: '#7fbf55', currentVersion: 1 }
    ];

    return {
      points: 124,
      profile: {
        name: '萌新铲屎官的小可爱',
        childId: '38038532',
        goodHabitCount: 324,
        rewardCount: 4
      },
      habits: habits,
      wishes: wishes,
      records: records,
      rules: rules,
      /** 回收站初始为空（seed.ts 的口径：回收站是「用出来的」，不预置） */
      trash: [],
      seq: 0
    };
  }

  /* ======================================================================
   * 状态中心 —— AppStore（src/data/store.ts）的精简替身
   * ----------------------------------------------------------------------
   * 保留的是**语义**而不是实现：每个动作返回 `null` 表示成功、返回字符串表示
   * 「必须把原因告诉用户」的失败（仓库里禁止静默失败）。
   * ==================================================================== */

  var state = buildSeed();
  var ui = { screen: 'home', filter: null, actionRule: null, editingRule: null };

  /** 配置项统一补上软删状态位（与后端 enum RecordStatus 一一对应）。 */
  function normalize(items) {
    items.forEach(function (item) {
      if (!item.status) item.status = 'active';
      if (item.deletedAt === undefined) item.deletedAt = null;
    });
  }

  function resetState() {
    state = buildSeed();
    normalize(state.habits);
    normalize(state.wishes);
    normalize(state.rules);
    ui.filter = null;
    ui.actionRule = null;
    ui.editingRule = null;
  }

  resetState();

  function activeOnly(items) {
    return items.filter(function (item) {
      return item.status === 'active';
    });
  }

  function trashOnly(items) {
    return items.filter(function (item) {
      return item.status === 'deleted';
    });
  }

  function newId(prefix) {
    state.seq += 1;
    return prefix + '-' + state.seq + '-' + Date.now();
  }

  // -------------------------------------------------------- 派生（types.ts）

  /** 今天某条习惯完成几次 —— 由当天流水数出（排除冲正记录与已被冲正的原记录）。 */
  function checkedCountToday(habitId) {
    var reversed = {};
    state.records.forEach(function (record) {
      if (record.reversesRecordId) reversed[record.reversesRecordId] = true;
    });
    return state.records.filter(function (record) {
      return (
        record.habitId === habitId &&
        record.category === 'praise' &&
        record.source !== 'correction' &&
        !reversed[record.id] &&
        isSameDay(record.time, Date.now())
      );
    }).length;
  }

  /** 今天某条规则已经产生几次表扬流水（改规则时的额度重算要用它）。 */
  function checkedCountTodayByRule(ruleId) {
    var reversed = {};
    state.records.forEach(function (record) {
      if (record.reversesRecordId) reversed[record.reversesRecordId] = true;
    });
    return state.records.filter(function (record) {
      return (
        record.ruleId === ruleId &&
        record.category === 'praise' &&
        record.source !== 'correction' &&
        !reversed[record.id] &&
        isSameDay(record.time, Date.now())
      );
    }).length;
  }

  /** 习惯的派生视图（types.ts habitView）：页面拿到的每个字段都是算出来的。 */
  function habitViews() {
    return activeOnly(state.habits).map(function (habit) {
      var count = checkedCountToday(habit.id);
      return Object.assign({}, habit, {
        checkedCountToday: count,
        limitText: limitTextOf(habit.dailyLimit),
        doneText: doneTextOf(count),
        checked: count >= habit.dailyLimit
      });
    });
  }

  /** 流水按时间倒序（记录页的分组依赖它）。 */
  function recordsSorted() {
    return state.records.slice().sort(function (a, b) {
      return b.time - a.time;
    });
  }

  function recordsOf(category) {
    var list = recordsSorted();
    if (!category) return list;
    return list.filter(function (record) {
      return record.category === category;
    });
  }

  function trashItems() {
    var items = [];
    function collect(kind, list) {
      trashOnly(list).forEach(function (item) {
        items.push({
          kind: kind,
          id: item.id,
          title: item.title,
          deletedAt: item.deletedAt,
          expired: Date.now() - item.deletedAt >= trashRetentionDays * msPerDay
        });
      });
    }
    collect('point_rule', state.rules);
    collect('wish', state.wishes);
    collect('habit', state.habits);
    return items.sort(function (a, b) {
      return b.deletedAt - a.deletedAt;
    });
  }

  function listOf(kind) {
    if (kind === 'point_rule') return state.rules;
    if (kind === 'wish') return state.wishes;
    return state.habits;
  }

  // ---------------------------------------------------------------- 动作

  /** 打卡（首页点习惯卡）。成功返回 null，失败返回给家长/孩子看的文案。 */
  function checkIn(habit) {
    var live = state.habits.filter(function (item) {
      return item.id === habit.id;
    })[0];
    if (!live) return '“' + habit.title + '”已经不在今天的习惯里了';
    var done = checkedCountToday(live.id);
    if (done >= live.dailyLimit) {
      return '“' + live.title + '”今天已经完成 ' + done + ' 次啦，明天继续加油～';
    }
    state.points += live.points;
    state.profile.goodHabitCount += 1;
    var time = Date.now();
    state.records.unshift({
      id: newId('rec'),
      title: live.title,
      points: live.points,
      time: time,
      category: 'praise',
      icon: live.icon,
      color: live.color,
      source: 'guardian',
      note: '',
      habitId: live.id,
      ruleId: live.ruleId,
      ruleVersion: 1,
      wishId: null,
      reversesRecordId: null,
      balanceAfter: state.points
    });
    return null;
  }

  /**
   * 撤销打卡（长按习惯卡）。**写入一条冲正流水、原记录保留** ——
   * 账本不可变，所以撤销后流水条数是 +1 而不是 −1。
   */
  function undoCheckIn(habit) {
    if (checkedCountToday(habit.id) === 0) {
      return '“' + habit.title + '”今天还没有打卡，不用撤销';
    }
    var reversed = {};
    state.records.forEach(function (record) {
      if (record.reversesRecordId) reversed[record.reversesRecordId] = true;
    });
    var target = state.records.filter(function (record) {
      return (
        record.habitId === habit.id &&
        record.category === 'praise' &&
        record.source !== 'correction' &&
        !reversed[record.id] &&
        isSameDay(record.time, Date.now())
      );
    })[0];
    if (!target) return '没有找到“' + habit.title + '”今天的打卡记录';
    if (target.points > state.points) {
      return (
        '积分不足，无法撤销（需扣回 ' + target.points + ' 分，当前只有 ' + state.points + ' 分）'
      );
    }
    state.points -= target.points;
    if (state.profile.goodHabitCount > 0) state.profile.goodHabitCount -= 1;
    state.records.unshift({
      id: newId('rec'),
      title: '撤销：' + target.title,
      points: -target.points,
      time: Date.now(),
      category: 'adjust',
      icon: 'minus',
      color: '#e9834b',
      source: 'correction',
      note: target.title,
      habitId: habit.id,
      ruleId: target.ruleId,
      ruleVersion: target.ruleVersion,
      wishId: null,
      reversesRecordId: target.id,
      balanceAfter: state.points
    });
    return null;
  }

  /** 记一笔（家长手动加减分）；超额扣分**拒绝**而不是静默截断（修 B6）。 */
  function addQuickNote(delta, reason, note) {
    if (delta === 0) return '调整金额不能为 0';
    if (delta < 0 && Math.abs(delta) > state.points) {
      return '积分不足，当前只有 ' + state.points + ' 分，最多可扣 ' + state.points + ' 分';
    }
    var gain = delta > 0;
    state.points += delta;
    state.records.unshift({
      id: newId('rec'),
      title: reason.trim() === '' ? (gain ? '额外奖励' : '扣除积分') : reason.trim(),
      points: delta,
      time: Date.now(),
      category: 'adjust',
      icon: gain ? 'plus' : 'minus',
      color: gain ? '#6fbf4b' : '#e9834b',
      source: 'guardian',
      note: (note || '').trim(),
      habitId: null,
      ruleId: null,
      ruleVersion: null,
      wishId: null,
      reversesRecordId: null,
      balanceAfter: state.points
    });
    return null;
  }

  function canRedeem(wish) {
    return !wish.redeemed && state.points >= wish.cost;
  }

  /** 兑换心愿：完整标题快照 + wishId 回指（修 B8）。 */
  function redeem(wish) {
    if (!canRedeem(wish)) return false;
    state.points -= wish.cost;
    wish.redeemed = true;
    state.profile.rewardCount += 1;
    state.records.unshift({
      id: newId('rec'),
      title: '兑换：' + wish.title,
      points: -wish.cost,
      time: Date.now(),
      category: 'exchange',
      icon: 'gift',
      color: '#f5a24b',
      source: 'guardian',
      note: '',
      habitId: null,
      ruleId: null,
      ruleVersion: null,
      wishId: wish.id,
      reversesRecordId: null,
      balanceAfter: state.points
    });
    return true;
  }

  /** 新增心愿；配色由「空档 + id 哈希」决定，与列表长度无关（修 E16）。 */
  function pickCoverStyle(taken, id) {
    var styles = ['A', 'B', 'C', 'D'];
    var free = styles.filter(function (style) {
      return taken.indexOf(style) < 0;
    })[0];
    if (free) return free;
    var hash = 0;
    for (var i = 0; i < id.length; i += 1) {
      hash = (hash * 31 + id.charCodeAt(i)) % 1000003;
    }
    return styles[hash % styles.length];
  }

  function addWish(title, cost, emoji) {
    var id = newId('wish');
    state.wishes.unshift({
      id: id,
      title: title.trim(),
      cost: cost,
      emoji: emoji,
      coverStyle: pickCoverStyle(
        state.wishes.map(function (item) {
          return item.coverStyle;
        }),
        id
      ),
      redeemed: false,
      status: 'active',
      deletedAt: null
    });
  }

  /**
   * 新增规则（修 E15 / A2 / D9）：
   * 收的是 condition ＋ dailyLimit 结构字段；越界**拒绝**而不是夹到边界。
   */
  function addRule(title, condition, dailyLimit, points, icon, color) {
    if (!(Number.isInteger(dailyLimit) && dailyLimit >= dailyLimitMin && dailyLimit <= dailyLimitMax)) {
      return '每天次数只能是 ' + dailyLimitMin + '–' + dailyLimitMax + ' 之间的整数';
    }
    if (!Object.prototype.hasOwnProperty.call(ICONS, icon)) {
      return '图标「' + icon + '」不在可选列表里';
    }
    var rule = {
      id: newId('rule'),
      title: title.trim(),
      condition: condition.trim() === '' ? '家长约定' : condition.trim(),
      dailyLimit: dailyLimit,
      points: points,
      icon: icon,
      color: color,
      currentVersion: 1,
      status: 'active',
      deletedAt: null
    };
    state.rules.unshift(rule);
    return null;
  }

  /**
   * 改规则对「今天已打卡」的影响提示（types.ts ruleChangeNotice）——
   * **验收标准，不是可选项**：改完孩子打不了卡却不知原因，必然产生投诉。
   */
  function ruleChangeNotice(childName, checkedCountTodayValue, newDailyLimit) {
    if (checkedCountTodayValue < newDailyLimit) return null;
    var name = childName.trim() === '' ? '孩子' : childName.trim();
    return (
      '改动后，' + name + '今天已完成 ' + checkedCountTodayValue + ' 次，按新规则「' +
      limitTextOf(newDailyLimit) + '」，今天不能再打卡了。'
    );
  }

  /** 编辑规则：id 不变、currentVersion 递增，并同步由它派生的首页习惯。 */
  function updateRule(rule, input) {
    var live = state.rules.filter(function (item) {
      return item.id === rule.id;
    })[0];
    if (!live) return '这条规则已经不在了';
    if (live.status === 'deleted') return '“' + live.title + '”在回收站里，先恢复再改';
    if (!(Number.isInteger(input.dailyLimit) && input.dailyLimit >= dailyLimitMin && input.dailyLimit <= dailyLimitMax)) {
      return '每天次数只能是 ' + dailyLimitMin + '–' + dailyLimitMax + ' 之间的整数';
    }
    var title = input.title.trim() === '' ? live.title : input.title.trim();
    var condition = input.condition.trim() === '' ? '家长约定' : input.condition.trim();
    if (
      title === live.title &&
      condition === live.condition &&
      input.dailyLimit === live.dailyLimit &&
      input.points === live.points
    ) {
      return '没有改动，规则保持原样';
    }
    live.title = title;
    live.condition = condition;
    live.dailyLimit = input.dailyLimit;
    live.points = input.points;
    live.currentVersion += 1;
    /* 派生同步：由这条规则生成的首页习惯跟着新规走（未来从新规） */
    state.habits.forEach(function (habit) {
      if (habit.ruleId !== live.id) return;
      habit.title = title;
      habit.condition = condition;
      habit.dailyLimit = input.dailyLimit;
      habit.points = input.points;
    });
    return null;
  }

  /** 按规则生成首页习惯；扣分规则**拒绝**（修 A1：原先 Math.abs 会把扣分变加分）。 */
  function addHabitFromRule(rule) {
    var exists = state.habits.some(function (habit) {
      return habit.title === rule.title && habit.status === 'active';
    });
    if (exists) return '“' + rule.title + '”已经在今天的习惯里了';
    if (rule.points < 0) return '“' + rule.title + '”是扣分规则，不能加入今天的习惯';
    state.habits.push({
      id: newId('habit'),
      title: rule.title,
      points: rule.points,
      condition: rule.condition,
      dailyLimit: rule.dailyLimit,
      icon: rule.icon,
      color: rule.color,
      ruleId: rule.id,
      status: 'active',
      deletedAt: null
    });
    return null;
  }

  // ------------------------------------------------- 软删除 / 回收站（C9）

  /** 软删：只改状态位，物理数据一律保留（90 天内可恢复）。 */
  function softDelete(item, kind) {
    if (item.status === 'deleted') return false;
    if (kind === 'wish') {
      var records = state.records.filter(function (record) {
        return record.wishId === item.id;
      });
      if (records.length > 0) {
        /* 已发生兑换的心愿也允许删 —— 流水靠 wishId 仍能解释这笔扣分 */
      }
    }
    item.status = 'deleted';
    item.deletedAt = Date.now();
    return true;
  }

  function removeWish(wish) {
    var live = state.wishes.filter(function (item) {
      return item.id === wish.id;
    })[0];
    if (live) softDelete(live, 'wish');
  }

  function removeRule(rule) {
    var live = state.rules.filter(function (item) {
      return item.id === rule.id;
    })[0];
    if (live) softDelete(live, 'point_rule');
  }

  function restoreTrash(kind, id) {
    var live = listOf(kind).filter(function (item) {
      return item.id === id;
    })[0];
    if (!live || live.status !== 'deleted') return false;
    live.status = 'active';
    live.deletedAt = null;
    return true;
  }

  function purgeTrash(kind, id) {
    var list = listOf(kind);
    var index = -1;
    list.forEach(function (item, i) {
      if (item.id === id && item.status === 'deleted') index = i;
    });
    if (index < 0) return false;
    list.splice(index, 1);
    return true;
  }

  /** 清理已过期的回收站条目（只在家长显式点击时执行）。 */
  function purgeExpiredTrash() {
    var purged = 0;
    trashItems().forEach(function (item) {
      if (!item.expired) return;
      if (purgeTrash(item.kind, item.id)) purged += 1;
    });
    return purged;
  }

  /* ======================================================================
   * 渲染
   * ==================================================================== */

  /** 心愿插画底色（WishCard 的 WISH_GRADIENTS，按**稳定枚举**取色）。 */
  var WISH_GRADIENTS = {
    A: ['#fff8e6', '#fbe7b8'],
    B: ['#fff6e9', '#f7dcc0'],
    C: ['#f3faea', '#dceebe'],
    D: ['#fff6f1', '#f8d9ce']
  };

  /** 心愿卡宽高比（Flutter GridView childAspectRatio）。 */
  var CARD_ASPECT = 0.62;
  var LIST_PADDING = 20;
  var GRID_GAP = 14;

  function esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** 把 #RRGGBB 加上透明度 —— 与 utils/color.ts 的 withAlpha 同一口径。 */
  function withAlpha(hex, alpha) {
    var value = hex.replace('#', '');
    var r = parseInt(value.slice(0, 2), 16);
    var g = parseInt(value.slice(2, 4), 16);
    var b = parseInt(value.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha.toFixed(3) + ')';
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function renderHome() {
    var views = habitViews();
    var doneCount = views.filter(function (view) {
      return view.checked;
    }).length;

    setText('home-points', state.points);
    setText('home-progress', '已完成 ' + doneCount + '/' + views.length);

    document.getElementById('home-habits').innerHTML = views
      .map(function (view) {
        /* 副标题由结构字段 ＋ 当天流水派生（修 A2 / A3 / E17）：
           「已达上限」显示今日完成次数，「未达上限」显示频次。 */
        var subtitle = view.checked
          ? view.condition + ' · ' + view.doneText
          : view.condition + ' · ' + view.limitText;
        return (
          '<button class="kp-card is-border kp-habit" data-habit="' + view.id + '">' +
          '<span class="kp-habit__row">' +
          '<span class="kp-habit__check' + (view.checked ? ' is-done' : '') + '">' +
          iconSvg('check', 17, view.checked ? '#ffffff' : '#cbd2c2') +
          '</span>' +
          '<span class="kp-habit__body">' +
          '<span class="kp-habit__title">' + esc(view.title) + '</span>' +
          '<span class="kp-habit__subtitle">' + esc(subtitle) + '</span>' +
          '</span>' +
          '<span class="kp-habit__amount">+' + view.points + '</span>' +
          '</span>' +
          '</button>'
        );
      })
      .join('');
  }

  function renderWishlist() {
    setText('wish-points', state.points);
    var width = (400 - LIST_PADDING * 2 - GRID_GAP) / 2;
    var height = width / CARD_ASPECT;

    document.getElementById('wish-grid').innerHTML = activeOnly(state.wishes)
      .map(function (wish) {
        var affordable = !wish.redeemed && state.points >= wish.cost;
        var gap = wish.cost - state.points > 0 ? wish.cost - state.points : 0;
        var colors = WISH_GRADIENTS[wish.coverStyle] || WISH_GRADIENTS.A;
        var pill = affordable
          ? '<span class="kp-pill is-filled" data-redeem="' + wish.id + '">' +
            '<span class="kp-pill__label">兑换</span></span>'
          : wish.redeemed
            ? '<span class="kp-pill"><span class="kp-pill__label">已兑换</span></span>'
            : '<span class="kp-pill"><span class="kp-pill__label">还差 ' + gap + '</span></span>';

        return (
          '<div class="kp-wishlist__cell" style="width:' + width + 'px;height:' + height + 'px">' +
          '<div class="kp-wish" data-wish="' + wish.id + '">' +
          '<div class="kp-wish__illustration" style="background-image:linear-gradient(135deg,' +
          colors[0] + ',' + colors[1] + ')">' +
          '<span class="kp-wish__emoji">' + wish.emoji + '</span>' +
          '<span class="kp-wish__sparkle">✨</span>' +
          (wish.redeemed
            ? '<span class="kp-wish__redeemed">' +
              '<span class="kp-wish__redeemed-label">已兑换</span></span>'
            : '') +
          '</div>' +
          '<span class="kp-wish__title">' + esc(wish.title) + '</span>' +
          '<div class="kp-wish__bottom">' +
          '<span class="kp-wish__cost">' +
          '<span class="kp-wish__cost-value">' + wish.cost + '</span>' +
          '<span class="kp-wish__cost-unit">积分</span></span>' +
          pill +
          '</div>' +
          '</div></div>'
        );
      })
      .join('');
  }

  function renderProfile() {
    setText('profile-name', state.profile.name);
    setText('profile-id', 'ID:' + state.profile.childId);
    setText('profile-habits', state.profile.goodHabitCount);
    setText('profile-rewards', state.profile.rewardCount);
    var count = trashItems().length;
    setText('trash-label', count > 0 ? '回收站（' + count + '）' : '回收站');
  }

  /** 一条流水（RecordTile）：图标底色 32/255，金额按正负取色。 */
  function recordTile(record) {
    var gain = record.points >= 0;
    return (
      '<div class="kp-card is-border kp-tile">' +
      '<div class="kp-tile__row">' +
      '<div class="kp-tile__icon" style="background-color:' +
      withAlpha(record.color, 32 / 255) + '">' +
      iconSvg(record.icon, 20, record.color) +
      '</div>' +
      '<div class="kp-tile__body">' +
      '<span class="kp-tile__title">' + esc(record.title) + '</span>' +
      '<span class="kp-tile__subtitle">' + esc(recordSubtitle(record)) + '</span>' +
      '</div>' +
      '<span class="kp-tile__amount" style="color:' + (gain ? '#6fbf4b' : '#e9834b') + '">' +
      amountText(record.points) + '</span>' +
      '</div></div>'
    );
  }

  function renderRecord() {
    var filters = [null, 'praise', 'exchange', 'adjust'];
    document.getElementById('record-chips').innerHTML = filters
      .map(function (item) {
        return (
          '<span class="kp-record__chip">' +
          '<button class="kp-chip' + (ui.filter === item ? ' is-selected' : '') +
          '" data-filter="' + (item || 'all') + '">' +
          '<span class="kp-chip__label">' +
          esc(item ? recordCategoryLabels[item] : '全部') +
          '</span></button></span>'
        );
      })
      .join('');

    var list = recordsOf(ui.filter);
    setText('record-count', '共 ' + list.length + ' 条');

    var host = document.getElementById('record-list');
    host.parentElement.classList.toggle('is-empty', list.length === 0);

    if (list.length === 0) {
      host.innerHTML =
        '<div class="kp-record__empty">' +
        '<span class="kp-record__empty-emoji">🍃</span>' +
        '<div style="height:10px"></div>' +
        '<span class="kp-record__empty-text">这里还没有记录</span>' +
        '</div>';
      return;
    }

    var html = '';
    var currentLabel = '';
    list.forEach(function (record) {
      var label = dayLabel(record.time);
      if (label !== currentLabel) {
        html +=
          '<div class="kp-record__day' + (currentLabel === '' ? ' is-first' : '') + '">' +
          '<span class="kp-record__day-label">' + label + '</span></div>';
        currentLabel = label;
      }
      html += recordTile(record);
    });
    host.innerHTML = html;
  }

  /** 一条规则（RuleTile）：细则由结构字段派生（修 E15），不是存下来的展示串。 */
  function ruleTile(rule) {
    var gain = rule.points >= 0;
    return (
      '<button class="kp-card is-border kp-tile is-rule" data-rule="' + rule.id + '">' +
      '<span class="kp-tile__row">' +
      '<span class="kp-tile__icon" style="background-color:' +
      withAlpha(rule.color, 34 / 255) + '">' +
      iconSvg(rule.icon, 20, rule.color) +
      '</span>' +
      '<span class="kp-tile__body">' +
      '<span class="kp-tile__title">' + esc(rule.title) + '</span>' +
      '<span class="kp-tile__subtitle">' + esc(ruleDetail(rule)) + '</span>' +
      '</span>' +
      '<span class="kp-tile__amount" style="color:' + (gain ? '#6fbf4b' : '#e9834b') + '">' +
      amountText(rule.points) + '</span>' +
      '</span></button>'
    );
  }

  function renderRule() {
    var rules = activeOnly(state.rules);
    var host = document.getElementById('rule-list');
    if (rules.length === 0) {
      host.innerHTML =
        '<div class="kp-rule__empty"><span class="kp-rule__empty-text">' +
        '还没有规则，点下方按钮新增吧</span></div>';
      return;
    }
    host.innerHTML = rules.map(ruleTile).join('');
  }

  /* ======================================================================
   * 页面切换 / 轻提示 / 二次确认
   * ==================================================================== */

  /** 三个 Tab 页在底部导航里的下标（AppBottomNav 的顺序：首页 / 心愿单 / 我的）。 */
  var TAB_INDEX = { home: 0, wishlist: 1, profile: 2 };

  function showScreen(key) {
    ui.screen = key;
    document.querySelectorAll('.kp-screen').forEach(function (el) {
      el.classList.toggle('is-active', el.dataset.screen === key);
    });

    var tabIndex = TAB_INDEX[key];
    var navVisible = tabIndex !== undefined;
    document.getElementById('bottom-nav').classList.toggle('is-hidden', !navVisible);
    if (navVisible) paintNavIcons(tabIndex);

    document.querySelectorAll('.proto-nav__item[data-goto]').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.goto === key);
    });

    renderAll();
    if (key === 'wishlist') syncWishFab();
  }

  /** 轻提示（utils/toast.ts 的 toast）——一次只显示一条，1.9 秒后收起。 */
  var toastTimer = null;

  function toast(message) {
    var el = document.getElementById('toast');
    el.textContent = message;
    el.classList.add('is-visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('is-visible');
    }, 1900);
  }

  /** 二次确认（utils/toast.ts 的 confirm）——返回 Promise<boolean>。 */
  var confirmResolve = null;

  function askConfirm(options) {
    return new Promise(function (resolve) {
      confirmResolve = resolve;
      setText('confirm-title', options.title);
      setText('confirm-text', options.text);
      document.getElementById('confirm-ok').textContent = options.okLabel;
      document.getElementById('confirm-cancel').textContent = options.cancelLabel;
      document.getElementById('confirm').classList.add('is-visible');
    });
  }

  function closeConfirm(result) {
    document.getElementById('confirm').classList.remove('is-visible');
    var resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(result);
  }

  /** 全部重绘：一次动作可能同时影响多个页面（积分 / 习惯 / 流水 / 回收站计数）。 */
  function renderAll() {
    renderHome();
    renderWishlist();
    renderProfile();
    renderRecord();
    renderRule();
  }

  /* ======================================================================
   * 底部弹窗（SheetFrame 的替身）
   * ==================================================================== */

  var sheetLayer = document.getElementById('sheet-layer');

  /** 弹窗外壳：遮罩 + 圆角白底 + 拖动条 + 标题 + 关闭按钮 +（可选）底部主按钮。 */
  function sheetShell(options) {
    return (
      '<div class="kp-sheet" data-sheet="' + options.key + '">' +
      '<div class="kp-sheet__mask" data-close-sheet="1"></div>' +
      '<div class="kp-sheet__panel">' +
      '<div class="kp-sheet__handle"></div>' +
      '<div class="kp-sheet__header">' +
      '<div class="kp-sheet__titles">' +
      '<span class="kp-sheet__title">' + esc(options.title) + '</span>' +
      (options.subtitle
        ? '<span class="kp-sheet__subtitle">' + esc(options.subtitle) + '</span>'
        : '') +
      '</div>' +
      '<button class="kp-sheet__close" data-close-sheet="1">' +
      iconSvg('close', 20, '#6e7568') +
      '</button>' +
      '</div>' +
      '<div class="kp-sheet__body"><div class="kp-sheet__scroll">' +
      '<div class="kp-sheet__content">' + options.body + '</div>' +
      '</div></div>' +
      (options.actionLabel
        ? '<button class="kp-sheet__action" data-sheet-action="1">' +
          (options.actionIcon ? iconSvg(options.actionIcon, 18, '#3f6b2e') : '') +
          '<span class="kp-sheet__action-label">' + esc(options.actionLabel) + '</span>' +
          '</button>'
        : '') +
      '</div></div>'
    );
  }

  /** 步进器（PointsStepper）：圆形加减 + 数值 +单位，到边界时按钮变灰。 */
  function stepperHtml(field, value, min, max, suffix) {
    return (
      '<div class="kp-stepper" data-stepper="' + field + '" data-min="' + min +
      '" data-max="' + max + '">' +
      '<button class="kp-stepper__button' + (value > min ? '' : ' is-disabled') +
      '" data-step="-1">' + iconSvg('minus', 22, value > min ? '#3f6b2e' : '#b6bdb0') +
      '</button>' +
      '<div class="kp-stepper__center">' +
      '<span class="kp-stepper__value">' + value + '</span>' +
      '<span class="kp-stepper__suffix">' + suffix + '</span>' +
      '</div>' +
      '<button class="kp-stepper__button' + (value < max ? '' : ' is-disabled') +
      '" data-step="1">' + iconSvg('plus', 22, value < max ? '#3f6b2e' : '#b6bdb0') +
      '</button>' +
      '</div>'
    );
  }

  /** 按当前值刷新步进器（不重绘 DOM，避免输入框失焦）。 */
  function syncStepper(container, value) {
    var min = Number(container.dataset.min);
    var max = Number(container.dataset.max);
    container.querySelector('.kp-stepper__value').textContent = value;
    var buttons = container.querySelectorAll('.kp-stepper__button');
    buttons[0].classList.toggle('is-disabled', value <= min);
    buttons[1].classList.toggle('is-disabled', value >= max);
    buttons[0].innerHTML = iconSvg('minus', 22, value > min ? '#3f6b2e' : '#b6bdb0');
    buttons[1].innerHTML = iconSvg('plus', 22, value < max ? '#3f6b2e' : '#b6bdb0');
  }

  /** 二选一分段（SegmentedToggle）：奖励加分 / 扣分提醒。 */
  function segmentHtml(gainSelected) {
    return (
      '<div class="kp-segment">' +
      '<button class="kp-segment__item' + (gainSelected ? ' is-selected' : '') +
      '" data-sign="1">' +
      '<span class="kp-segment__label kp-segment__label--gain">奖励加分</span></button>' +
      '<button class="kp-segment__item' + (gainSelected ? '' : ' is-selected') +
      '" data-sign="-1">' +
      '<span class="kp-segment__label kp-segment__label--spend">扣分提醒</span></button>' +
      '</div>'
    );
  }

  /** 快捷标签组（QuickTag）。`kind` 用来区分「额度」与「事由」两组标签。 */
  function tagsHtml(values, selected, withSuffix, kind) {
    return (
      '<div class="kp-sheet-tags">' +
      values
        .map(function (value) {
          var picked = value === selected;
          return (
            '<span class="kp-sheet-tags__item">' +
            '<button class="kp-tag' + (picked ? ' is-selected' : '') +
            '" data-tag="' + esc(value) + '" data-tag-kind="' + (kind || 'text') + '">' +
            '<span class="kp-tag__label">' + esc(value + (withSuffix || '')) +
            '</span></button></span>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function fieldLabel(text) {
    return '<span class="kp-field__label">' + esc(text) + '</span>';
  }

  /** 输入框（SoftTextField）：maxLines > 1 时用 textarea。 */
  function textField(id, value, hint, lines) {
    if (lines > 1) {
      return (
        '<textarea class="kp-field__input" id="' + id + '" rows="' + lines +
        '" placeholder="' + esc(hint) + '">' + esc(value) + '</textarea>'
      );
    }
    return (
      '<input class="kp-field__input" id="' + id + '" type="text" value="' +
      esc(value) + '" placeholder="' + esc(hint) + '" />'
    );
  }

  var currentSheet = null;

  /** rAF 兜底：老内核 / 无头环境（jsdom）里退化成 setTimeout，保证弹窗仍能挂载。 */
  function nextFrame(callback) {
    if (window.requestAnimationFrame) return window.requestAnimationFrame(callback);
    return setTimeout(callback, 16);
  }

  /** 挂载弹窗：先插入 DOM、下一帧再加 .is-visible，才会有「从底部滑上来」的过渡。 */
  function mountSheet(html, onReady) {
    sheetLayer.innerHTML = html;
    currentSheet = sheetLayer.querySelector('.kp-sheet');
    var sheet = currentSheet;
    nextFrame(function () {
      nextFrame(function () {
        sheet.classList.add('is-visible');
        if (onReady) onReady(sheet);
      });
    });
  }

  function closeSheet() {
    if (!currentSheet) return;
    var sheet = currentSheet;
    sheet.classList.remove('is-visible');
    currentSheet = null;
    setTimeout(function () {
      if (!currentSheet) sheetLayer.innerHTML = '';
    }, 240);
  }

  /* -------------------------------------------------------------- 记一笔 */

  /** 常见事由 / 快选额度（与 QuickNoteSheet 逐字一致）。 */
  var QUICK_REASONS = [
    '主动帮忙做家务',
    '自主阅读',
    '按时起床',
    '主动整理房间',
    '顶嘴 / 发脾气'
  ];
  var QUICK_AMOUNTS = [1, 2, 5, 10];

  function openQuickNoteSheet() {
    var draft = { gain: true, amount: 1, reason: '', note: '' };

    var body =
      segmentHtml(true) +
      '<div class="kp-sheet-gap-xxl"></div>' +
      stepperHtml('amount', draft.amount, 1, 999, '积分') +
      '<div class="kp-sheet-gap-xs"></div>' +
      '<div class="kp-sheet-tags kp-sheet-tags--center">' +
      QUICK_AMOUNTS.map(function (value) {
        return (
          '<span class="kp-sheet-tags__item">' +
          '<button class="kp-tag' + (value === draft.amount ? ' is-selected' : '') +
          '" data-tag="' + value + '" data-tag-kind="amount">' +
          '<span class="kp-tag__label">' + value + ' 分</span></button></span>'
        );
      }).join('') +
      '</div>' +
      '<div class="kp-sheet-gap-lg"></div>' +
      fieldLabel('常见事由') +
      tagsHtml(QUICK_REASONS, '', '', 'reason') +
      '<div class="kp-sheet-gap-lg"></div>' +
      fieldLabel('补充说明（可选）') +
      textField('qn-note', '', '例如：今天主动帮妈妈洗碗', 2);

    function actionLabel() {
      var delta = draft.gain ? draft.amount : -draft.amount;
      return '保存（' + (delta > 0 ? '+' : '') + delta + ' 积分）';
    }

    mountSheet(
      sheetShell({
        key: 'quick-note',
        title: '记一笔',
        subtitle: '家长手动加分或扣分，孩子立刻能看到',
        body: body,
        actionLabel: actionLabel(),
        actionIcon: 'check'
      }),
      function (sheet) {
        var stepper = sheet.querySelector('[data-stepper="amount"]');
        var note = sheet.querySelector('#qn-note');

        function refreshAction() {
          sheet.querySelector('.kp-sheet__action-label').textContent = actionLabel();
        }

        sheet.querySelector('.kp-segment').addEventListener('click', function (event) {
          var button = event.target.closest('[data-sign]');
          if (!button) return;
          draft.gain = button.dataset.sign === '1';
          sheet.querySelectorAll('[data-sign]').forEach(function (item) {
            item.classList.toggle('is-selected', item === button);
          });
          refreshAction();
        });

        stepper.addEventListener('click', function (event) {
          var button = event.target.closest('[data-step]');
          if (!button) return;
          var next = draft.amount + Number(button.dataset.step);
          draft.amount = Math.min(999, Math.max(1, next));
          syncStepper(stepper, draft.amount);
          sheet.querySelectorAll('[data-tag-kind="amount"]').forEach(function (tag) {
            tag.classList.toggle('is-selected', Number(tag.dataset.tag) === draft.amount);
          });
          refreshAction();
        });

        sheet.querySelectorAll('[data-tag]').forEach(function (tag) {
          tag.addEventListener('click', function () {
            if (tag.dataset.tagKind === 'amount') {
              draft.amount = Number(tag.dataset.tag);
              syncStepper(stepper, draft.amount);
              sheet.querySelectorAll('[data-tag-kind="amount"]').forEach(function (item) {
                item.classList.toggle('is-selected', Number(item.dataset.tag) === draft.amount);
              });
              refreshAction();
              return;
            }
            /* 再点一次取消选中（与 QuickNoteSheet 的 toggle 行为一致） */
            draft.reason = draft.reason === tag.dataset.tag ? '' : tag.dataset.tag;
            sheet.querySelectorAll('[data-tag-kind="reason"]').forEach(function (item) {
              item.classList.toggle('is-selected', item.dataset.tag === draft.reason);
            });
          });
        });

        note.addEventListener('input', function () {
          draft.note = note.value;
        });

        sheet.querySelector('[data-sheet-action]').addEventListener('click', function () {
          var delta = draft.gain ? draft.amount : -draft.amount;
          var typed = draft.note.trim();
          /* 事由拼装规则与 QuickNoteSheet 逐字一致：选中标签优先，手写内容作为补充 */
          var reason =
            draft.reason !== ''
              ? typed === '' ? draft.reason : draft.reason + '（' + typed + '）'
              : typed === '' ? '额外调整' : typed;
          var message = addQuickNote(delta, reason);
          if (message) {
            /* 修 B6：超额扣分会被拒绝，必须把原因告诉家长（禁止静默失败） */
            toast(message);
            return;
          }
          closeSheet();
          toast(
            delta > 0
              ? '已加 ' + delta + ' 积分：' + reason
              : '已扣 ' + Math.abs(delta) + ' 积分：' + reason
          );
          renderAll();
        });
      }
    );
  }

  /* ------------------------------------------------------------ 新增心愿 */

  /** 心愿 emoji 候选（与 FormFields.wishEmojis 逐字一致）。 */
  var WISH_EMOJIS = ['🎁', '🍖', '🐶', '🍦', '🧩', '🎡', '📚', '🚲', '🎮', '🍿', '⚽', '🎨'];

  /** 规则可选图标（与 FormFields.ruleIconOptions 逐字一致）。 */
  var RULE_ICON_OPTIONS = [
    { icon: 'book', color: '#f6c64a' },
    { icon: 'backpack', color: '#e9834b' },
    { icon: 'clipboard', color: '#7fbf55' },
    { icon: 'stories', color: '#7bb0e8' },
    { icon: 'palette', color: '#e58fb0' },
    { icon: 'music', color: '#9b8be8' },
    { icon: 'basketball', color: '#f5a24b' },
    { icon: 'spray', color: '#62c1b8' }
  ];

  function emojiPickerHtml(selected) {
    return (
      '<div class="kp-picker">' +
      WISH_EMOJIS.map(function (emoji) {
        return (
          '<button class="kp-picker__item kp-picker__item--emoji' +
          (emoji === selected ? ' is-selected-soft' : '') + '" data-emoji="' + emoji + '">' +
          '<span class="kp-picker__emoji">' + emoji + '</span></button>'
        );
      }).join('') +
      '</div>'
    );
  }

  function iconPickerHtml(selectedIndex) {
    return (
      '<div class="kp-picker">' +
      RULE_ICON_OPTIONS.map(function (option, index) {
        var picked = index === selectedIndex;
        return (
          '<button class="kp-picker__item' + (picked ? ' is-selected' : '') +
          '" data-icon-index="' + index + '" style="background-color:' +
          withAlpha(option.color, (picked ? 60 : 30) / 255) + ';border-color:' +
          (picked ? option.color : 'transparent') + '">' +
          iconSvg(option.icon, 21, option.color) +
          '</button>'
        );
      }).join('') +
      '</div>'
    );
  }

  function openAddWishSheet() {
    var draft = { title: '', cost: 40, emoji: '🎁' };

    function tipText() {
      return state.points >= draft.cost
        ? '现在就能兑换，点“兑换”立即生效'
        : '还差 ' + (draft.cost - state.points) + ' 积分，加油打卡就能达成';
    }

    var body =
      fieldLabel('心愿名称') +
      textField('aw-title', '', '例如：去游乐园玩一整天', 2) +
      '<div class="kp-sheet-gap-lg"></div>' +
      fieldLabel('需要多少积分') +
      stepperHtml('cost', draft.cost, 1, 9999, '积分') +
      '<div class="kp-sheet-gap-lg"></div>' +
      fieldLabel('选个图标') +
      emojiPickerHtml(draft.emoji) +
      '<div class="kp-sheet-gap-sm"></div>' +
      '<div class="kp-wish-tip"><span class="kp-wish-tip__text" id="aw-tip">' +
      tipText() + '</span></div>';

    mountSheet(
      sheetShell({
        key: 'add-wish',
        title: '新增心愿',
        subtitle: '当前可用积分 ' + state.points,
        body: body,
        actionLabel: '保存心愿',
        actionIcon: 'heartFill'
      }),
      function (sheet) {
        var title = sheet.querySelector('#aw-title');
        var stepper = sheet.querySelector('[data-stepper="cost"]');

        title.addEventListener('input', function () {
          draft.title = title.value;
        });

        stepper.addEventListener('click', function (event) {
          var button = event.target.closest('[data-step]');
          if (!button) return;
          draft.cost = Math.min(9999, Math.max(1, draft.cost + Number(button.dataset.step)));
          syncStepper(stepper, draft.cost);
          /* 提示条随积分实时变（还差 N → 现在就能兑换） */
          sheet.querySelector('#aw-tip').textContent = tipText();
        });

        sheet.querySelectorAll('[data-emoji]').forEach(function (button) {
          button.addEventListener('click', function () {
            draft.emoji = button.dataset.emoji;
            sheet.querySelectorAll('[data-emoji]').forEach(function (item) {
              item.classList.toggle('is-selected-soft', item === button);
            });
          });
        });

        sheet.querySelector('[data-sheet-action]').addEventListener('click', function () {
          var trimmed = draft.title.trim();
          if (trimmed === '') {
            toast('先给心愿起个名字吧～');
            return;
          }
          addWish(trimmed, draft.cost, draft.emoji);
          closeSheet();
          toast('已添加心愿：' + trimmed + '（' + draft.cost + ' 积分）');
          renderAll();
        });
      }
    );
  }

  /* ---------------------------------------------------- 新增 / 编辑规则 */

  /**
   * 同一张表单承担「新增」与「编辑」两个入口（修 C10）。
   *
   * ⚠️ 与仓库的**已知差异**（已在 prototype/README.md 标注）：
   * `AddRuleSheet` 的成功提示写的是 `rule.currentVersion + 1`，而 `updateRule`
   * 已经原地把 `currentVersion` 加了 1 —— 于是提示会**多报一版**。
   * 原型按语义显示正确的版本号（改动前的版本 + 1），不复制这处笔误。
   */
  function openRuleFormSheet(rule) {
    var editing = !!rule;
    var draft = {
      title: rule ? rule.title : '',
      condition: rule ? rule.condition : '',
      dailyLimit: rule ? rule.dailyLimit : 1,
      gain: rule ? rule.points >= 0 : true,
      amount: rule ? Math.abs(rule.points) : 2,
      iconIndex: 0
    };

    var body =
      fieldLabel('规则名称') +
      textField('ar-title', draft.title, '例如：每天练琴 30 分钟', 1) +
      '<div class="kp-sheet-gap-md"></div>' +
      fieldLabel('达成条件（会显示在名称下方）') +
      textField('ar-condition', draft.condition, '例如：认真练习不断开', 1) +
      '<div class="kp-sheet-gap-md"></div>' +
      fieldLabel('每天最多几次') +
      stepperHtml('limit', draft.dailyLimit, dailyLimitMin, dailyLimitMax, '次/天') +
      '<div class="kp-sheet-gap-lg"></div>' +
      fieldLabel('积分方向') +
      segmentHtml(draft.gain) +
      '<div class="kp-sheet-gap-md"></div>' +
      stepperHtml('points', draft.amount, 1, 999, '积分') +
      (editing
        ? ''
        : '<div class="kp-sheet-gap-md"></div>' +
          fieldLabel('选择图标') +
          iconPickerHtml(draft.iconIndex));

    mountSheet(
      sheetShell({
        key: editing ? 'rule-form-edit' : 'rule-form-new',
        title: editing ? '编辑规则' : '新增规则',
        subtitle: '规则会出现在积分规则页，也可以加入今天的习惯',
        body: body,
        actionLabel: '保存规则',
        actionIcon: 'check'
      }),
      function (sheet) {
        var title = sheet.querySelector('#ar-title');
        var condition = sheet.querySelector('#ar-condition');
        var limitStepper = sheet.querySelector('[data-stepper="limit"]');
        var pointStepper = sheet.querySelector('[data-stepper="points"]');

        title.addEventListener('input', function () {
          draft.title = title.value;
        });
        condition.addEventListener('input', function () {
          draft.condition = condition.value;
        });

        limitStepper.addEventListener('click', function (event) {
          var button = event.target.closest('[data-step]');
          if (!button) return;
          draft.dailyLimit = Math.min(
            dailyLimitMax,
            Math.max(dailyLimitMin, draft.dailyLimit + Number(button.dataset.step))
          );
          syncStepper(limitStepper, draft.dailyLimit);
        });

        pointStepper.addEventListener('click', function (event) {
          var button = event.target.closest('[data-step]');
          if (!button) return;
          draft.amount = Math.min(999, Math.max(1, draft.amount + Number(button.dataset.step)));
          syncStepper(pointStepper, draft.amount);
        });

        sheet.querySelector('.kp-segment').addEventListener('click', function (event) {
          var button = event.target.closest('[data-sign]');
          if (!button) return;
          draft.gain = button.dataset.sign === '1';
          sheet.querySelectorAll('[data-sign]').forEach(function (item) {
            item.classList.toggle('is-selected', item === button);
          });
        });

        sheet.querySelectorAll('[data-icon-index]').forEach(function (button) {
          button.addEventListener('click', function () {
            draft.iconIndex = Number(button.dataset.iconIndex);
            sheet.querySelectorAll('[data-icon-index]').forEach(function (item) {
              var index = Number(item.dataset.iconIndex);
              var option = RULE_ICON_OPTIONS[index];
              var picked = index === draft.iconIndex;
              item.classList.toggle('is-selected', picked);
              item.style.backgroundColor = withAlpha(option.color, (picked ? 60 : 30) / 255);
              item.style.borderColor = picked ? option.color : 'transparent';
            });
          });
        });

        sheet.querySelector('[data-sheet-action]').addEventListener('click', function () {
          var trimmed = draft.title.trim();
          if (trimmed === '') {
            toast('规则名称不能为空哦');
            return;
          }
          var points = draft.gain ? draft.amount : -draft.amount;

          if (editing) {
            /* 改动后若「今天已打卡数 ≥ 新上限」，必须告知家长今天不能再打卡 */
            var notice = ruleChangeNotice(
              state.profile.name,
              checkedCountTodayByRule(rule.id),
              draft.dailyLimit
            );
            var versionBefore = rule.currentVersion;
            var message = updateRule(rule, {
              title: trimmed,
              condition: draft.condition,
              dailyLimit: draft.dailyLimit,
              points: points
            });
            if (message) {
              toast(message);
              return;
            }
            closeSheet();
            toast(notice || '已更新规则：' + trimmed + '（第 ' + (versionBefore + 1) + ' 版）');
            renderAll();
            return;
          }

          var option = RULE_ICON_OPTIONS[draft.iconIndex];
          var result = addRule(
            trimmed,
            draft.condition,
            draft.dailyLimit,
            points,
            option.icon,
            option.color
          );
          if (result) {
            /* 修 A2：频次越界被拒绝时必须说明原因（禁止静默失败） */
            toast(result);
            return;
          }
          closeSheet();
          toast(
            '已新增规则：' + trimmed + '（每天 ' + draft.dailyLimit + ' 次 · ' +
            (draft.gain ? '+' : '-') + draft.amount + ' 积分）'
          );
          renderAll();
        });
      }
    );
  }

  /* ------------------------------------------------------ 规则操作菜单 */

  function openRuleActionsSheet(rule) {
    var body =
      '<button class="kp-sheet-row" data-rule-edit="1">' +
      iconSvg('pencil', 20, '#3f6b2e') +
      '<span class="kp-sheet-row__label">编辑这条规则（当前第 ' + rule.currentVersion +
      ' 版）</span></button>' +
      '<div class="kp-sheet-gap-10"></div>' +
      '<button class="kp-sheet-row" data-rule-habit="1">' +
      iconSvg('listCheck', 20, '#3f6b2e') +
      '<span class="kp-sheet-row__label">加入今天的习惯</span></button>' +
      '<div class="kp-sheet-gap-10"></div>' +
      '<button class="kp-sheet-row is-danger" data-rule-remove="1">' +
      iconSvg('trash', 20, '#e9834b') +
      '<span class="kp-sheet-row__label">移到回收站</span></button>';

    mountSheet(
      sheetShell({
        key: 'rule-actions',
        title: rule.title,
        subtitle: ruleDetail(rule),
        body: body
      }),
      function (sheet) {
        sheet.querySelector('[data-rule-edit]').addEventListener('click', function () {
          /* 先收起操作菜单，再打开编辑态表单（两个弹窗不叠在一起） */
          closeSheet();
          setTimeout(function () {
            openRuleFormSheet(rule);
          }, 240);
        });

        sheet.querySelector('[data-rule-habit]').addEventListener('click', function () {
          var message = addHabitFromRule(rule);
          if (message) {
            /* 修 A1：扣分规则不能生成可打卡习惯，必须把原因告诉家长 */
            toast(message);
            return;
          }
          closeSheet();
          toast('“' + rule.title + '”已加入首页习惯');
          renderAll();
        });

        sheet.querySelector('[data-rule-remove]').addEventListener('click', function () {
          removeRule(rule);
          closeSheet();
          toast('已移到回收站，90 天内可在「我的 · 回收站」恢复');
          renderAll();
        });
      }
    );
  }

  /* -------------------------------------------------------------- 回收站 */

  function openTrashSheet() {
    var items = trashItems();
    var expiredCount = items.filter(function (item) {
      return item.expired;
    }).length;

    var body =
      items.length === 0
        ? '<div class="kp-trash__empty"><span class="kp-trash__empty-text">' +
          '回收站是空的</span></div>'
        : '<div class="kp-trash__list">' +
          items
            .map(function (item) {
              return (
                '<div class="kp-trash__row">' +
                '<div class="kp-trash__head">' +
                '<span class="kp-trash__title">' + esc(item.title) + '</span>' +
                '<span class="kp-trash__meta">' + trashKindLabelOf(item.kind) + ' · ' +
                trashRetentionText(item.deletedAt) + '</span>' +
                '</div>' +
                '<div class="kp-trash__actions">' +
                '<button class="kp-trash__chip" data-restore="' + item.kind + '|' + item.id +
                '"><span class="kp-trash__chip-text">恢复</span></button>' +
                '<button class="kp-trash__chip is-danger" data-purge="' + item.kind + '|' +
                item.id + '"><span class="kp-trash__chip-text">彻底删除</span></button>' +
                '</div></div>'
              );
            })
            .join('') +
          '</div>';

    mountSheet(
      sheetShell({
        key: 'trash',
        title: '回收站',
        subtitle: '删除的规则 / 心愿 / 习惯在这里保留 ' + trashRetentionDays + ' 天',
        body: body,
        actionLabel: expiredCount > 0 ? '清理已过期（' + expiredCount + '）' : '',
        actionIcon: 'trash'
      }),
      function (sheet) {
        function refresh() {
          /* 恢复 / 彻底删除都会改变条目，重开一次让面板内容与数据一致 */
          closeSheet();
          setTimeout(openTrashSheet, 240);
        }

        sheet.querySelectorAll('[data-restore]').forEach(function (button) {
          button.addEventListener('click', function () {
            var parts = button.dataset.restore.split('|');
            var done = restoreTrash(parts[0], parts[1]);
            if (!done) {
              toast('这条内容已经不在了');
              return;
            }
            renderAll();
            toast('已恢复“' + button.closest('.kp-trash__row')
              .querySelector('.kp-trash__title').textContent + '”');
            refresh();
          });
        });

        sheet.querySelectorAll('[data-purge]').forEach(function (button) {
          button.addEventListener('click', function () {
            var parts = button.dataset.purge.split('|');
            var title = button.closest('.kp-trash__row')
              .querySelector('.kp-trash__title').textContent;
            askConfirm({
              title: '彻底删除',
              text: '彻底删除后无法恢复，确定删除“' + title + '”吗？',
              okLabel: '彻底删除',
              cancelLabel: '取消'
            }).then(function (ok) {
              if (!ok) return;
              var done = purgeTrash(parts[0], parts[1]);
              toast(done ? '已彻底删除' : '这条内容已经不在了');
              renderAll();
              refresh();
            });
          });
        });

        var action = sheet.querySelector('[data-sheet-action]');
        if (action) {
          action.addEventListener('click', function () {
            askConfirm({
              title: '清理已过期',
              text: '确定清理 ' + expiredCount + ' 条已过 ' + trashRetentionDays +
                ' 天保留期的内容吗？',
              okLabel: '清理',
              cancelLabel: '取消'
            }).then(function (ok) {
              if (!ok) return;
              var purged = purgeExpiredTrash();
              toast(purged > 0 ? '已清理 ' + purged + ' 条' : '没有可清理的内容');
              renderAll();
              refresh();
            });
          });
        }
      }
    );
  }

  /* ======================================================================
   * 事件绑定 / 启动
   * ==================================================================== */

  /** 按 key 打开某张弹窗（左侧原型导航与页面按钮共用）。 */
  function openSheetByKey(key) {
    if (key === 'quick-note') return openQuickNoteSheet();
    if (key === 'add-wish') return openAddWishSheet();
    if (key === 'rule-form-new') return openRuleFormSheet(null);
    if (key === 'rule-form-edit') return openRuleFormSheet(activeOnly(state.rules)[0]);
    if (key === 'rule-actions') return openRuleActionsSheet(activeOnly(state.rules)[0]);
    if (key === 'trash') return openTrashSheet();
    return undefined;
  }

  /**
   * 心愿单右下角的「新增心愿」：列表滚到底才展开成整行胶囊
   * （与 wishlist/index.tsx 的 expanded 逻辑同一口径，容差 24）。
   */
  function syncWishFab() {
    var scroll = document.getElementById('wish-scroll');
    var fab = document.getElementById('wish-fab');
    if (!scroll || !fab) return;
    var atBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 24;
    fab.classList.toggle('is-expanded', atBottom);
    var label = fab.querySelector('.kp-fab__label');
    var icon = fab.querySelector('.kp-icon');
    if (label) label.classList.toggle('is-visible', atBottom);
    if (icon) {
      icon.style.transition =
        'transform 340ms cubic-bezier(0.34, 1.56, 0.64, 1), ' +
        'margin 340ms cubic-bezier(0.215, 0.61, 0.355, 1)';
      icon.style.transform = atBottom ? 'scale(1)' : 'scale(1.16)';
      icon.style.marginRight = atBottom ? '8px' : '0';
    }
  }

  /** 长按判定：按下 550ms 触发一次；随后**同一个元素**上的那次 click 会被抑制。 */
  var longPressGuard = { el: null, until: 0 };

  function bindLongPress(container, selector, handler) {
    var timer = null;
    var held = null;
    function cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      held = null;
    }
    container.addEventListener('pointerdown', function (event) {
      var el = event.target.closest(selector);
      if (!el) return;
      held = el;
      timer = setTimeout(function () {
        timer = null;
        var target = held;
        held = null;
        if (!target) return;
        /* 只抑制「长按的那张卡」在 450ms 内的 click：
           长按与随后的 click 是同一只手的一次操作，别把旁边的按钮也一起吞掉 */
        longPressGuard = { el: target, until: Date.now() + 450 };
        handler(target);
      }, 550);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (type) {
      container.addEventListener(type, cancel);
    });
    container.addEventListener('contextmenu', function (event) {
      /* 右键 / 系统长按菜单会打断演示，在可长按的元素上直接吞掉 */
      if (event.target.closest(selector)) event.preventDefault();
    });
  }

  function bindTap(container, selector, handler) {
    container.addEventListener('click', function (event) {
      var el = event.target.closest(selector);
      if (!el) return;
      var guard = longPressGuard;
      if (guard.el && Date.now() < guard.until && guard.el.contains(el)) {
        longPressGuard = { el: null, until: 0 };
        return;
      }
      handler(el);
    });
  }

  function ruleById(id) {
    return state.rules.filter(function (item) {
      return item.id === id;
    })[0];
  }

  function wishById(id) {
    return state.wishes.filter(function (item) {
      return item.id === id;
    })[0];
  }

  function bindEvents() {
    var root = document.querySelector('.phone__screen');
    var protoNav = document.querySelector('.proto-nav');

    /* 页面跳转：底部导航 / 我的页入口 / 返回箭头 / 左侧原型导航共用 */
    bindTap(root, '[data-goto]', function (el) {
      showScreen(el.dataset.goto);
    });
    bindTap(protoNav, '[data-goto]', function (el) {
      showScreen(el.dataset.goto);
    });

    /* 打开 / 关闭弹窗 */
    bindTap(root, '[data-open-sheet]', function (el) {
      openSheetByKey(el.dataset.openSheet);
    });
    bindTap(protoNav, '[data-goto-sheet]', function (el) {
      openSheetByKey(el.dataset.gotoSheet);
    });
    root.addEventListener('click', function (event) {
      if (event.target.closest('[data-close-sheet]')) closeSheet();
    });

    /* 二次确认 */
    document.getElementById('confirm-ok').addEventListener('click', function () {
      closeConfirm(true);
    });
    document.getElementById('confirm-cancel').addEventListener('click', function () {
      closeConfirm(false);
    });
    document.getElementById('confirm-mask').addEventListener('click', function () {
      closeConfirm(false);
    });

    /* 首页：点卡打卡、长按撤销 */
    var home = document.getElementById('screen-home');
    bindTap(home, '[data-habit]', function (el) {
      var habit = state.habits.filter(function (item) {
        return item.id === el.dataset.habit;
      })[0];
      if (!habit) return;
      var message = checkIn(habit);
      if (message) {
        toast(message);
        return;
      }
      toast('太棒了！“' + habit.title + '”+' + habit.points + ' 积分');
      renderAll();
    });
    bindLongPress(home, '[data-habit]', function (el) {
      var habit = state.habits.filter(function (item) {
        return item.id === el.dataset.habit;
      })[0];
      if (!habit) return;
      var message = undoCheckIn(habit);
      toast(message || '已撤销“' + habit.title + '”的打卡');
      renderAll();
    });

    /* 心愿单：点“兑换”扣分；长按卡片删到回收站 */
    var wishlist = document.getElementById('screen-wishlist');
    bindTap(wishlist, '[data-redeem]', function (el) {
      var wish = wishById(el.dataset.redeem);
      if (!wish) return;
      var ok = redeem(wish);
      toast(ok ? '兑换成功：' + wish.title : '积分还不够，继续加油打卡吧！');
      renderAll();
    });
    bindLongPress(wishlist, '[data-wish]', function (el) {
      var wish = wishById(el.dataset.wish);
      if (!wish) return;
      askConfirm({
        title: '删除心愿',
        text: '确定要把“' + wish.title + '”移到回收站吗？90 天内可恢复。',
        okLabel: '移到回收站',
        cancelLabel: '取消'
      }).then(function (ok) {
        if (!ok) return;
        removeWish(wish);
        toast('已移到回收站，90 天内可在「我的 · 回收站」恢复');
        renderAll();
      });
    });

    /* 记录页：全部 / 表扬 / 兑换 / 调整 */
    bindTap(document.getElementById('screen-record'), '[data-filter]', function (el) {
      ui.filter = el.dataset.filter === 'all' ? null : el.dataset.filter;
      renderRecord();
    });

    /* 规则页：点 / 长按都打开操作菜单 */
    var ruleScreen = document.getElementById('screen-rule');
    var openActions = function (el) {
      var target = ruleById(el.dataset.rule);
      if (target) openRuleActionsSheet(target);
    };
    bindTap(ruleScreen, '[data-rule]', openActions);
    bindLongPress(ruleScreen, '[data-rule]', openActions);

    /* 我的：点头像改名（最长 16 字）、点 ID 复制、恢复演示数据 */
    document.getElementById('profile-avatar').addEventListener('click', function () {
      var input = window.prompt('修改昵称', state.profile.name);
      if (input === null) return;
      var trimmed = input.trim();
      if (trimmed === '') return;
      state.profile.name = trimmed.slice(0, 16);
      renderAll();
    });
    document.getElementById('profile-id-row').addEventListener('click', function () {
      toast('已复制孩子 ID');
    });
    document.getElementById('demo-reset').addEventListener('click', function () {
      resetState();
      showScreen(ui.screen);
      toast('已恢复演示数据');
    });

    /* 心愿单滚动 → 悬浮按钮收起 / 展开 */
    document.getElementById('wish-scroll').addEventListener('scroll', syncWishFab);

    /* 左侧原型导航的显示开关与重置 */
    document.getElementById('toggle-capsule').addEventListener('change', function (event) {
      document.body.classList.toggle('no-capsule', !event.target.checked);
    });
    document.getElementById('toggle-leaves').addEventListener('change', function (event) {
      document.body.classList.toggle('no-leaves', !event.target.checked);
    });
    document.getElementById('reset-state').addEventListener('click', function () {
      resetState();
      closeSheet();
      showScreen('home');
      toast('原型状态已重置');
    });

    /* Esc 收起弹窗（键盘演示更顺手） */
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (confirmResolve) {
        closeConfirm(false);
        return;
      }
      closeSheet();
    });
  }

  function boot() {
    paintStaticIcons();
    bindEvents();
    showScreen('home');
    syncWishFab();
  }

  boot();
})();
