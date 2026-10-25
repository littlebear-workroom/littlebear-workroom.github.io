// Phone notifications for the home-screen app (Web Push).
// The database calls this when a class's shared data changes; we tell the other teachers in that class.
// A signed-in teacher can also call it with mode "test" to get one notification right away.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
webpush.setVapidDetails("mailto:noreply@littlebear-workroom.app", Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);

const QUIET_MINUTES = 10; // one notification per class + item within this window
const LABELS: Record<string, [string, string]> = {
  bear_roster_rows: ["全園班表", "roster"],
  bear_sub_records: ["代班紀錄", "roster"],
  bear_routine: ["班級作息表", "routine"],
  bear_student_records: ["學生名冊", "students"],
  bear_forms: ["回條小幫手", "forms"],
  bear_afterschool: ["課後才藝", "afterschool"],
  bear_bus_routes: ["娃娃車車次", "bus"],
  bear_bus_riders: ["娃娃車名單", "bus"],
  bear_attendance: ["出缺勤點名", "attendance"],
  bear_fund_records: ["班費紀錄", "funds"],
  bear_fund_types: ["班級資金分類", "funds"],
  bear_teacher_map: ["老師名單", "roster"],
  bear_motor_days: ["大肌肉活動", "motor"],
  bear_motor_plans: ["大肌肉活動", "motor"],
  bear_lessons: ["教案花園", "lessons"],
  bear_lesson_themes: ["教案主題", "lessons"],
};

async function sendTo(userIds: string[], payload: Record<string, unknown>) {
  if (!userIds.length) return 0;
  const { data: subs } = await admin.from("push_subs").select("endpoint, sub").in("user_id", userIds);
  let sent = 0;
  await Promise.all((subs || []).map(async (s: any) => {
    try { await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 86400 }); sent++; }
    catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await admin.from("push_subs").delete().eq("endpoint", s.endpoint); else console.log("push error", e?.statusCode, e?.body || e?.message); }
  }));
  return sent;
}

async function linePush(to: string, text: string) {
  const token = Deno.env.get("LINE_MESSAGING_TOKEN");
  if (!token || !to) return false;
  const r = await fetch("https://api.line.me/v2/bot/message/push", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }) });
  return r.ok;
}
async function paymentNotice(id: number, mode: string) {
  const { data: p } = await admin.from("payments").select("*").eq("id", id).maybeSingle();
  if (!p) return { ok: false };
  const [{ data: payer }, { data: plan }, { data: ws }] = await Promise.all([
    admin.from("profiles").select("display_name, line_user_id").eq("id", p.paid_by).maybeSingle(),
    p.plan_id ? admin.from("plans").select("name").eq("id", p.plan_id).maybeSingle() : Promise.resolve({ data: null }),
    p.subject_type === "workspace" ? admin.from("workspaces").select("name").eq("id", p.subject_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const what = [plan?.name ? `${plan.name}（${p.months === 12 ? "年繳" : p.months + " 個月"}）` : "", p.extra_seats ? `加 ${p.extra_seats} 位老師` : "", p.topup_points ? `加購 ${p.topup_points} 點` : ""].filter(Boolean).join("、");
  if (mode === "pay_notice") {
    const { data: admins } = await admin.from("admins").select("user_id");
    const ids = (admins || []).map((a: any) => a.user_id);
    const { data: profs } = ids.length ? await admin.from("profiles").select("line_user_id").in("id", ids) : { data: [] };
    const text = `💰 新的付款通知\n老師：${payer?.display_name || ""}${ws?.name ? `\n班級：${ws.name}` : ""}\n內容：${what}\n金額：NT$${p.amount}\n轉出銀行代碼：${p.from_bank}\n帳號末五碼：${p.from_last5}\n轉帳日期：${p.transfer_date || ""}${p.note ? `\n備註：${p.note}` : ""}\n\n請到後台「付款紀錄」確認收款。`;
    for (const pr of profs || []) if (pr.line_user_id) await linePush(pr.line_user_id, text);
    await sendTo(ids, { title: "新的付款通知", body: `${payer?.display_name || "老師"}・NT$${p.amount}・末五碼 ${p.from_last5}`, view: "home", tag: "pay-" + id });
  } else {
    const ok = p.status === "paid";
    const text = ok ? `🎉 小熊工作室已確認收款，${what}已經開通了！\n重新打開小熊工作室就能使用，謝謝你 ♡` : `小熊工作室付款通知被退回：${p.note || "款項核對不符"}\n如果有疑問，請直接聯絡我們。`;
    if (payer?.line_user_id) await linePush(payer.line_user_id, text);
    await sendTo([p.paid_by], { title: ok ? "方案已開通 ♡" : "付款通知被退回", body: ok ? `${what}已經開通，重新打開 App 就能使用` : p.note || "款項核對不符", view: "login", tag: "payres-" + id });
  }
  return { ok: true };
}

const FB_CAT: Record<string, string> = { question: "使用問題", bug: "回報錯誤", idea: "許願／建議", billing: "付款與方案", other: "其他" };
async function feedbackNotice(id: number, mode: string) {
  const { data: f } = await admin.from("feedback").select("*").eq("id", id).maybeSingle();
  if (!f) return { ok: false };
  const { data: who } = await admin.from("profiles").select("display_name, line_user_id").eq("id", f.user_id).maybeSingle();
  if (mode === "fb_new") {
    const { data: admins } = await admin.from("admins").select("user_id");
    const ids = (admins || []).map((a: any) => a.user_id);
    const { data: profs } = ids.length ? await admin.from("profiles").select("line_user_id").in("id", ids) : { data: [] };
    const text = `📮 新的意見回饋（${FB_CAT[f.category] || f.category}）\n老師：${who?.display_name || ""}\n\n${String(f.message).slice(0, 800)}\n\n到後台「意見回饋」回覆。`;
    for (const pr of profs || []) if (pr.line_user_id) await linePush(pr.line_user_id, text);
    await sendTo(ids, { title: "新的意見回饋", body: `${who?.display_name || "老師"}：${String(f.message).slice(0, 60)}`, view: "home", tag: "fb-" + id });
  } else {
    const text = `💌 小熊工作室回覆了你的意見：\n\n「${String(f.message).slice(0, 120)}」\n\n回覆：${f.reply}`;
    if (who?.line_user_id) await linePush(who.line_user_id, text);
    await sendTo([f.user_id], { title: "小熊工作室回覆了你", body: String(f.reply).slice(0, 80), view: "login", tag: "fbr-" + id });
  }
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    if (body.mode === "test") {
      const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u } = await admin.auth.getUser(jwt);
      if (!u?.user) return json({ error: "請先登入" }, 401);
      const n = await sendTo([u.user.id], { title: "小熊工作室", body: "手機通知開好了！班級有新資料時會通知你 ♡", view: "home" });
      return n ? json({ ok: true, sent: n }) : json({ error: "這支手機還沒開啟通知" }, 400);
    }
    if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return json({ error: "forbidden" }, 403);
    if (body.mode === "pay_notice" || body.mode === "pay_result") return json(await paymentNotice(Number(body.payment), body.mode));
    if (body.mode === "fb_new" || body.mode === "fb_reply") return json(await feedbackNotice(Number(body.feedback), body.mode));
    const { ws, key, by } = body;
    let label = LABELS[key], logKey = key;
    if (!ws || !label) return json({ ok: true, skipped: "not notified" });
    // 寶貝補給品 lives inside the student list: tell the two apart by what changed.
    if (key === "bear_student_records" && Array.isArray(body.old) && Array.isArray(body.new)) {
      const strip = (list: any[]) => JSON.stringify(list.map((r) => Object.fromEntries(Object.entries(r || {}).filter(([k]) => !/suppl|diaper/i.test(k)))));
      if (strip(body.old) === strip(body.new)) {
        if (JSON.stringify(body.old) === JSON.stringify(body.new)) return json({ ok: true, skipped: "no change" });
        label = ["寶貝補給品", "supplies"]; logKey = key + "#supplies";
      }
    }
    const { data: last } = await admin.from("push_log").select("sent_at").eq("workspace_id", ws).eq("key", logKey).maybeSingle();
    if (last && Date.now() - new Date(last.sent_at).getTime() < QUIET_MINUTES * 60e3) return json({ ok: true, skipped: "quiet" });
    await admin.from("push_log").upsert({ workspace_id: ws, key: logKey, sent_at: new Date().toISOString() });
    const [{ data: members }, { data: w }, { data: who }] = await Promise.all([
      admin.from("workspace_members").select("user_id").eq("workspace_id", ws).eq("status", "active"),
      admin.from("workspaces").select("name").eq("id", ws).maybeSingle(),
      by ? admin.from("profiles").select("display_name").eq("id", by).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const to = (members || []).map((m: any) => m.user_id).filter((id: string) => id !== by);
    const name = (who as any)?.display_name || "同班老師";
    const sent = await sendTo(to, { title: `${w?.name || "班級"}有新資料`, body: `${name} 更新了「${label[0]}」，點開看看`, view: label[1], tag: `${ws}:${logKey}` });
    return json({ ok: true, sent });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
