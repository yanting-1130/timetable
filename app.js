/* =========================================================
   课表逻辑
   数据来自 data.js（parse.py 生成）：
     window.META    = { term, week1, totalWeeks, periods }
     window.COURSES = [{ name, day, start, end, weeks, place, campus, online }]
   ========================================================= */
(function () {
  "use strict";

  const META = window.META;
  const COURSES = window.COURSES;

  const ROW_H = 56;                       // 与 style.css 的 --rowh 保持一致
  const TOTAL = META.totalWeeks;
  const MS_DAY = 86400000;

  /* 课程块配色：按课程名做哈希，同一门课永远同色 */
  const PALETTE = [
    "#5aa860", "#3f9a9a", "#4a7bc8", "#b8792f",
    "#cc6690", "#cf6666", "#b3902f", "#7e6fcb",
    "#4f8f7a", "#c07a4a",
  ];

  function colorOf(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  /* ---------- 日期 ---------- */
  function parseDate(str) {
    const [y, m, d] = str.split("-").map(Number);
    return new Date(y, m - 1, d);          // 本地时区，别用 new Date(str)
  }

  const WEEK1 = parseDate(META.week1);

  function mondayOf(week) {
    return new Date(WEEK1.getTime() + (week - 1) * 7 * MS_DAY);
  }

  function todayMidnight() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }

  function currentWeek() {
    const diff = Math.round((todayMidnight() - WEEK1) / MS_DAY);
    return Math.floor(diff / 7) + 1;
  }

  const THIS_WEEK = Math.min(Math.max(currentWeek(), 1), TOTAL);

  /* ---------- 状态 ---------- */
  let week = THIS_WEEK;

  // 支持 ?w=8 直接打开某一周（也方便调试）
  const qw = Number(new URLSearchParams(location.search).get("w"));
  if (qw >= 1 && qw <= TOTAL) week = qw;

  const shown = new Set();                 // 记录「提示」是否已经消失

  const $ = (id) => document.getElementById(id);
  const board = $("board");
  const sheet = $("sheet");
  const mask = $("mask");

  /* ---------- 渲染 ---------- */
  function render() {
    const monday = mondayOf(week);
    const sunday = new Date(monday.getTime() + 6 * MS_DAY);

    $("term").textContent = `${META.term.replace("-", "–")} 学期`;
    $("weeknum").textContent = `第 ${week} 周`;
    $("daterange").textContent = `${md(monday)} – ${md(sunday)}`;
    $("thisweek").hidden = week !== THIS_WEEK;
    $("backtoday").hidden = week === THIS_WEEK;
    $("progressbar").style.width = `${(week / TOTAL) * 100}%`;

    // 星期表头：日期 + 今天高亮
    const today = todayMidnight();
    document.querySelectorAll(".dayhead").forEach((el, i) => {
      const d = new Date(monday.getTime() + i * MS_DAY);
      el.querySelector("span").textContent = `${d.getMonth() + 1}/${d.getDate()}`;
      el.classList.toggle("is-today", week === THIS_WEEK && d.getTime() === today.getTime());
    });

    // 每一天的课
    document.querySelectorAll(".daycol").forEach((col, i) => {
      const day = i + 1;
      col.classList.toggle("is-weekend", day >= 6);
      col.innerHTML = "";
      const events = COURSES.filter((c) => c.day === day);
      for (const cluster of clusterize(events)) {
        placeCluster(col, cluster);
      }
    });
  }

  /** 把同一天里时间重叠的课归成一簇（1-4 节和 1-2 节就会落在同一簇） */
  function clusterize(events) {
    const sorted = [...events].sort((a, b) => a.start - b.start || a.end - b.end);
    const clusters = [];
    for (const e of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && e.start <= last.maxEnd) {
        last.items.push(e);
        last.maxEnd = Math.max(last.maxEnd, e.end);
      } else {
        clusters.push({ items: [e], maxEnd: e.end });
      }
    }
    return clusters;
  }

  /** 渲染一簇：本周的课并排显示；全是其他周的就显示一张灰色占位卡 */
  function placeCluster(col, cluster) {
    const active = cluster.items.filter((e) => e.weeks.includes(week));

    if (active.length === 0) {
      const ghost = cluster.items[0];
      col.appendChild(makeCard(ghost, { top: ghost.start, bottom: ghost.end, left: 0, width: 100, ghost: true }));
      return;
    }

    // 同一簇里并排：给每门课分一条“泳道”
    const lanes = [];                      // 每条泳道记录结束节次
    for (const e of active) {
      let lane = lanes.findIndex((end) => e.start > end);
      if (lane === -1) {
        lanes.push(e.end);
        lane = lanes.length - 1;
      } else {
        lanes[lane] = e.end;
      }
      e._lane = lane;
    }

    const n = lanes.length;
    for (const e of active) {
      col.appendChild(makeCard(e, {
        top: e.start,
        bottom: e.end,
        left: (e._lane / n) * 100,
        width: 100 / n,
        ghost: false,
      }));
    }
  }

  function makeCard(course, box) {
    const el = document.createElement("article");
    el.className = "card" + (box.ghost ? " ghost" : "");
    el.style.top = `${(box.top - 1) * ROW_H + 3}px`;
    el.style.height = `${(box.bottom - box.top + 1) * ROW_H - 6}px`;
    el.style.left = `calc(${box.left}% + 1.5px)`;
    el.style.width = `calc(${box.width}% - 3px)`;
    if (!box.ghost) el.style.background = colorOf(course.name);

    el.innerHTML = `
      ${box.ghost ? '<span class="ghost-tag">非本周</span>' : ""}
      <div class="card-name">${esc(course.name)}</div>
      <div class="card-meta">${box.ghost ? "" : "@"}${esc(course.place)}</div>`;

    el.addEventListener("click", () => {
      if (dragged) return;                 // 刚才是在滑动，不是点击
      openSheet(course);
    });
    return el;
  }

  /* ---------- 周切换 ---------- */
  function go(delta) {
    const next = week + delta;
    if (next < 1 || next > TOTAL) return;
    week = next;
    render();
    board.animate(
      [{ opacity: 0.35, transform: `translateX(${delta > 0 ? -14 : 14}px)` },
       { opacity: 1, transform: "none" }],
      { duration: 190, easing: "ease-out" }
    );
  }

  $("prev").addEventListener("click", () => go(-1));
  $("next").addEventListener("click", () => go(1));
  $("backtoday").addEventListener("click", () => {
    if (week !== THIS_WEEK) {
      week = THIS_WEEK;
      render();
    }
  });

  /* ---------- 手势 ---------- */
  let startX = 0, startY = 0, dx = 0, dragging = false, dragged = false;

  board.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    dragging = true;
    dragged = false;
  });

  board.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (!dragged && Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my)) dragged = true;
    if (dragged) {
      dx = mx;
      board.style.transform = `translateX(${dx * 0.28}px)`;
    }
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    board.style.transform = "";
    if (dragged && Math.abs(dx) > 48) {
      go(dx < 0 ? 1 : -1);
      hideHint();
    }
    // 注意：这里不重置 dragged，留给紧随其后的 click 判断；
    // 下一次 pointerdown 会把它清掉
  }
  board.addEventListener("pointerup", endDrag);
  board.addEventListener("pointercancel", endDrag);
  board.addEventListener("pointerleave", endDrag);

  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "ArrowRight") go(1);
  });

  function hideHint() {
    if (shown.has("hint")) return;
    shown.add("hint");
    $("hint").classList.add("hide");
  }

  /* ---------- 详情面板 ---------- */
  function openSheet(course) {
    const p = META.periods;
    const time = `${p[course.start - 1][0]} – ${p[course.end - 1][1]}`;
    const online = course.online ? "网络课" : "线下课";
    const lab = /实验$|实习$/.test(course.name) ? " · 实验/实践" : "";

    $("sheetbody").innerHTML = `
      <h2>${esc(course.name)}</h2>
      <p class="sub">${weekLabel(course.day)} · 第 ${course.start}–${course.end} 节 · ${time}</p>
      <dl>
        <dt>地点</dt><dd>${esc(course.place || "未安排")}</dd>
        <dt>校区</dt><dd>${esc(course.campus || "—")}</dd>
        <dt>类型</dt><dd>${online}${lab}</dd>
        <dt>周次</dt><dd class="weeks">${formatWeeks(course.weeks)}</dd>
      </dl>`;

    sheet.classList.add("open");
    mask.hidden = false;
    requestAnimationFrame(() => mask.classList.add("show"));
  }

  function closeSheet() {
    sheet.classList.remove("open");
    mask.classList.remove("show");
    setTimeout(() => { mask.hidden = true; }, 220);
  }

  mask.addEventListener("click", closeSheet);
  sheet.addEventListener("click", (e) => e.stopPropagation());

  /* ---------- 小工具 ---------- */
  function md(d) { return `${d.getMonth() + 1}/${d.getDate()}`; }

  function weekLabel(day) { return "周" + "一二三四五六日"[day - 1]; }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /** [1,2,3,5] → "1–3, 5"，并把当前周标红 */
  function formatWeeks(weeks) {
    const parts = [];
    let i = 0;
    while (i < weeks.length) {
      let j = i;
      while (j + 1 < weeks.length && weeks[j + 1] === weeks[j] + 1) j++;
      parts.push(i === j ? `${weeks[i]}` : `${weeks[i]}–${weeks[j]}`);
      i = j + 1;
    }
    return parts
      .map((t) => (weeks.includes(week) && t.split("–").some((n) => Number(n) === week)
        ? `<em>${t}</em>` : t))
      .join("、") + " 周";
  }

  /* ---------- 启动 ---------- */
  $("timecol").innerHTML = META.periods
    .map(([s, e], i) => `<div class="tlabel"><b>${i + 1}</b><i>${s}</i><i>${e}</i></div>`)
    .join("");

  render();

  // PWA：本地 file:// 打开时跳过（浏览器不允许）
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
