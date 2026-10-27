// LINE notifications for 小熊工作室 (sent from the 熊班 official account).
// mode "cron": called every 5 minutes by pg_cron; sends each teacher's reminders at their chosen times.
// mode "test": called by a signed-in teacher; sends them one message right away.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// ---------- dates in Taiwan time ----------
const WD = ["日", "一", "二", "三", "四", "五", "六"];
function taipeiNow() {
  const d = new Date(Date.now() + 8 * 3600e3);
  const iso = d.toISOString().slice(0, 10);
  return { iso, minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), wd: d.getUTCDay() };
}
const dOf = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const isoOf = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => { const d = dOf(iso); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };
const diff = (a: string, b: string) => Math.round((dOf(b).getTime() - dOf(a).getTime()) / 864e5);
const md = (iso: string) => { const d = dOf(iso); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（週${WD[d.getUTCDay()]}）`; };
const hm = (t: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };

// ---------- 國定假日與補假（老師見紅就休）----------
const holCache: Record<string, Set<string>> = {};
async function isHoliday(iso: string) {
  const y = iso.slice(0, 4);
  if (!holCache[y]) {
    try {
      const r = await fetch(`https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${y}.json`);
      const list = r.ok ? await r.json() : [];
      holCache[y] = new Set(list.filter((x: any) => x.isHoliday).map((x: any) => `${x.date.slice(0, 4)}-${x.date.slice(4, 6)}-${x.date.slice(6, 8)}`));
    } catch { return false; }
  }
  return holCache[y].has(iso);
}

// ---------- 例行公事 (same rules as the web page) ----------
type Chore = { id: string; title: string; type: string; wd?: number; anchor?: string; day?: number; dates?: string[]; weekdaysOnly?: boolean; lead?: number; enabled?: boolean; created: string; done?: Record<string, string> };
const monday = (iso: string) => addDays(iso, -((dOf(iso).getUTCDay() + 6) % 7));
function isDue(it: Chore, iso: string) {
  const d = dOf(iso), wd = d.getUTCDay(), day = d.getUTCDate(), last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  switch (it.type) {
    case "daily": return !it.weekdaysOnly || (wd > 0 && wd < 6);
    case "weekly": return wd === +(it.wd ?? 4);
    case "biweekly": return wd === +(it.wd ?? 4) && ((diff(monday(it.anchor || it.created), monday(iso)) / 7) % 2 + 2) % 2 === 0;
    case "monthStart": return day === 1;
    case "monthMid": return day === 15;
    case "monthEnd": return day === last;
    case "monthDay": return day === Math.min(+(it.day || 1), last);
    case "dates": return (it.dates || []).includes(iso);
  }
  return false;
}
function activeChores(list: Chore[], T: string) {
  const out: { it: Chore; due: string }[] = [];
  for (const it of list || []) {
    if (!it.enabled) continue;
    const done = it.done || {};
    if (it.type === "daily") { if (isDue(it, T) && !done[T]) out.push({ it, due: T }); continue; }
    const lead = Math.max(0, +(it.lead || 0)), from = it.created > addDays(T, -62) ? it.created : addDays(T, -62);
    for (let x = from; x <= addDays(T, lead); x = addDays(x, 1)) if (isDue(it, x) && !done[x] && addDays(x, -lead) <= T) out.push({ it, due: x });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}

// ---------- message text ----------
type Data = { tasks?: any[]; chores?: Chore[]; cal?: any[]; prefs?: any; leaveSoon?: any[] };
function dailyText(d: Data, T: string, withTomorrow: boolean) {
  const tasks = (d.tasks || []).filter((t) => t.date === T && !t.done);
  const overdue = (d.tasks || []).filter((t) => !t.done && t.date && t.date < T && t.date >= addDays(T, -60)).sort((a, b) => a.date.localeCompare(b.date));
  const chores = activeChores(d.chores || [], T);
  const cal = (d.cal || []).filter((e) => e.mine && !e.monthOnly && (e.date === T || (e.end && e.date <= T && T <= e.end)));
  const tm = addDays(T, 1);
  const tTasks = withTomorrow ? (d.tasks || []).filter((t) => t.date === tm && !t.done) : [];
  const tCal = withTomorrow ? (d.cal || []).filter((e) => e.mine && !e.monthOnly && e.date === tm) : [];
  const soon = d.leaveSoon || [];
  if (!tasks.length && !overdue.length && !chores.length && !cal.length && !tTasks.length && !tCal.length && !soon.length) return "";
  const L: string[] = [`小熊工作提醒 ♡ ${md(T)}`];
  if (overdue.length) L.push("", `⚠ 逾期還沒完成（${overdue.length}），請盡快處理`, ...overdue.slice(0, 8).map((t) => `・${t.title}（原定 ${md(t.date)}，逾期 ${diff(t.date, T)} 天）`), ...(overdue.length > 8 ? [`…還有 ${overdue.length - 8} 件`] : []));
  if (tasks.length) L.push("", `今天還沒完成的待辦（${tasks.length}）`, ...tasks.slice(0, 8).map((t) => `・${t.title}${t.time ? `（${t.time}）` : ""}`), ...(tasks.length > 8 ? [`…還有 ${tasks.length - 8} 件`] : []));
  if (chores.length) L.push("", "例行公事", ...chores.map((o) => { const n = diff(T, o.due); return `・${o.it.title}（${n === 0 ? "今天截止" : n > 0 ? md(o.due) + "前" : `已逾期 ${-n} 天`}）`; }));
  if (cal.length) L.push("", "今天行事曆上你負責的", ...cal.map((e) => `・${e.title}${e.time ? ` ${e.time}` : ""}`));
  if (tTasks.length || tCal.length) L.push("", "明天要記得", ...tTasks.map((t) => `・${t.title}${t.time ? `（${t.time}）` : ""}`), ...tCal.map((e) => `・${e.title}（我負責）`));
  if (soon.length) L.push("", `📋 一週後你請假：${soon.map((x: any) => `${md(x.date)} ${x.type}`).join("、")}`, "還沒有代班交接單，需要的話打開小熊工作室建立（首頁就會提醒你）。");
  L.push("", "打開小熊工作室：https://liff.line.me/" + (Deno.env.get("LIFF_ID") || ""));
  return L.join("\n");
}
function summaryText(d: Data, T: string) {
  const today = (d.tasks || []).filter((t) => t.date === T);
  if (!today.length) return "";
  const done = today.filter((t) => t.done).length, left = today.length - done;
  return [`今日工作總結 ${md(T)}`, `完成 ${done} 件，還有 ${left} 件${left ? "，剩下的明天再慢慢來" : "，全部完成了，好棒"} ♡`, ...today.filter((t) => !t.done).slice(0, 5).map((t) => `・${t.title}`)].join("\n");
}
function weeklyText(d: Data, T: string) {
  const mon = monday(T), week = (d.tasks || []).filter((t) => t.date >= mon && t.date <= T);
  if (!week.length) return "";
  const done = week.filter((t) => t.done).length;
  return [`本週工作總結（${md(mon)}–${md(T)}）`, `這週安排了 ${week.length} 件，完成 ${done} 件。辛苦了，週末好好休息 ♡`].join("\n");
}

// ---------- LINE push ----------
async function push(to: string, text: string) {
  const token = Deno.env.get("LINE_MESSAGING_TOKEN");
  if (!token) return { ok: false, error: "伺服器還沒設定熊班的 Channel access token" };
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
  if (r.ok) return { ok: true };
  const body = await r.text();
  return { ok: false, status: r.status, error: body };
}

async function loadData(userId: string, today?: string): Promise<Data> {
  const { data } = await admin.from("personal_data").select("key,value").eq("user_id", userId).in("key", ["bear_tasks", "bear_chores", "bear_cal_events", "bear_notify_prefs", "bear_leave_private", "bear_leave_plan", "bear_leaves"]);
  const m = new Map((data || []).map((r: any) => [r.key, r.value]));
  // planned leave exactly 7 days from now that has no handover sheet yet
  let plan: any[] = [...(m.get("bear_leave_private") || []), ...(m.get("bear_leave_plan") || [])], sheets: any[] = [...(m.get("bear_leaves") || [])];
  const { data: ms } = await admin.from("workspace_members").select("workspace_id").eq("user_id", userId).eq("status", "active");
  const wsIds = (ms || []).map((x: any) => x.workspace_id);
  if (wsIds.length) {
    const { data: sd } = await admin.from("shared_data").select("key,value").in("workspace_id", wsIds).in("key", ["bear_leave_plan", "bear_leaves"]);
    for (const r of sd || []) (r.key === "bear_leave_plan" ? plan : sheets).push(...(Array.isArray(r.value) ? r.value : []));
  }
  const target = today ? addDays(today, 7) : "";
  const covered = (x: any) => x.handover === "yes" || sheets.some((l: any) => (l.id === x.leaveId || l.byId === userId) && (l.days || []).some((d: any) => d.date === x.date));
  const leaveSoon = target ? plan.filter((x: any) => x && x.byId === userId && x.date === target && !x.remindOff && !covered(x)) : [];
  return { tasks: m.get("bear_tasks") || [], chores: m.get("bear_chores") || [], cal: m.get("bear_cal_events") || [], prefs: m.get("bear_notify_prefs") || null, leaveSoon };
}
async function alreadySent(userId: string, kind: string, day: string) {
  const { data } = await admin.from("notify_log").select("kind").eq("user_id", userId).eq("kind", kind).eq("day", day).maybeSingle();
  return !!data;
}
async function markSent(userId: string, kind: string, day: string) { await admin.from("notify_log").upsert({ user_id: userId, kind, day }); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const now = taipeiNow();

    if (body.mode === "test") {
      const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u } = await admin.auth.getUser(jwt);
      if (!u?.user) return json({ error: "請先登入" }, 401);
      const { data: p } = await admin.from("profiles").select("line_user_id, display_name").eq("id", u.user.id).maybeSingle();
      if (!p?.line_user_id) return json({ error: "找不到你的 LINE 帳號，請重新用 LINE 登入" }, 400);
      const d = await loadData(u.user.id, now.iso);
      const text = dailyText(d, now.iso, true) || `小熊工作提醒 ♡ ${md(now.iso)}\n今天沒有要提醒的事情，輕鬆一下吧！`;
      const r = await push(p.line_user_id, "【測試通知】\n" + text);
      return json(r.ok ? { ok: true } : { error: r.status === 400 || r.status === 403 ? "傳送失敗：請先加「熊班」為 LINE 好友" : r.error }, r.ok ? 200 : 400);
    }

    if (body.mode === "cron") {
      if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return json({ error: "forbidden" }, 403);
      // medicine reminders go out as phone notifications from the web-push function
      try { await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/web-push", { method: "POST", headers: { "Content-Type": "application/json", "x-cron-secret": Deno.env.get("CRON_SECRET")! }, body: JSON.stringify({ mode: "med_due" }) }); } catch (e) { console.log("med_due", String(e)); }
      // once a day at 9:00 (Taipei): renewal reminders, deletion warnings, remove expired data
      let billing: unknown = null;
      if (now.minutes >= 9 * 60 && now.minutes < 10 * 60) {
        const { data: last } = await admin.from("app_settings").select("value").eq("key", "billing_job_day").maybeSingle();
        if (last?.value !== now.iso) {
          await admin.from("app_settings").upsert({ key: "billing_job_day", value: now.iso });
          const { data: rem } = await admin.rpc("billing_reminders");
          let sentR = 0;
          for (const r of (rem || []) as any[]) {
            const { data: pr } = await admin.from("profiles").select("line_user_id").eq("id", r.user_id).maybeSingle();
            if (!pr?.line_user_id) continue;
            const what = r.class ? `班級「${r.class}」的${r.plan}` : r.trial ? "小熊工作室的免費體驗" : `你的${r.plan}`;
            const text = r.kind === "renew"
              ? `⏰ ${what}還有 ${r.days} 天到期（${md(String(r.ends_at).slice(0, 10))}）。\n到期後會變成唯讀，可以查看、匯出，但不能新增或修改。\n續約請打開小熊工作室 →「登入」→「方案與付款」。`
              : `⚠️ ${what}已經到期，資料會在 ${r.days} 天後依規定刪除。\n需要保留的話，請先續約，或打開小熊工作室匯出資料。`;
            if ((await push(pr.line_user_id, text)).ok) sentR++;
          }
          const { data: purged } = await admin.rpc("purge_expired");
          billing = { reminders: sentR, purged };
        }
      }
      const { data: people } = await admin.from("profiles").select("id, line_user_id").not("line_user_id", "is", null);
      let sent = 0;
      for (const p of people || []) {
        const d = await loadData(p.id, now.iso), pr = d.prefs;
        if (!pr) continue; // teacher hasn't saved notification settings yet
        const weekend = now.wd === 0 || now.wd === 6 || (await isHoliday(now.iso));
        if (weekend && pr.weekendOff !== false) continue;
        const due = (t: string | undefined, def: string) => { const m = hm(t || def); return m !== null && now.minutes >= m && now.minutes < m + 60; };
        if (pr.incomplete !== false && due(pr.time, "17:30") && !(await alreadySent(p.id, "daily", now.iso))) {
          const text = dailyText(d, now.iso, pr.due !== false);
          await markSent(p.id, "daily", now.iso);
          if (text && (await push(p.line_user_id, text)).ok) sent++;
        }
        if (pr.summary && due(pr.summaryTime, "18:00") && !(await alreadySent(p.id, "summary", now.iso))) {
          const text = summaryText(d, now.iso);
          await markSent(p.id, "summary", now.iso);
          if (text && (await push(p.line_user_id, text)).ok) sent++;
        }
        if (pr.weekly && now.wd === 5 && due(pr.summaryTime, "18:00") && !(await alreadySent(p.id, "weekly", now.iso))) {
          const text = weeklyText(d, now.iso);
          await markSent(p.id, "weekly", now.iso);
          if (text && (await push(p.line_user_id, text)).ok) sent++;
        }
      }
      return json({ ok: true, sent, billing, at: now });
    }
    return json({ error: "unknown mode" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
