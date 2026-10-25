// 小熊工作室 feature list — the one place that names every feature and every AI task.
// The app (menu locks), the admin panel (plan checkboxes, AI point costs, pricing advice)
// and the server (which data each feature may write) all read from here.
// Adding a feature or an AI task = adding a line below.
// Every front-end update also gets a note in BEAR_RELEASES (bottom): the admin panel turns new notes into announcements.
window.BEAR_FEATURES = [
  // key        name                    menu views                 data it saves
  { key: "tasks",       name: "待辦清單",           views: ["tasks"],               data: ["bear_tasks"] },
  { key: "calendar",    name: "行事曆",             views: ["calendar"],            data: ["bear_cal_events", "bear_cal_plans"] },
  { key: "chores",      name: "例行公事",           views: ["chores"],              data: ["bear_chores"] },
  { key: "schedule",    name: "我的上下班時間",     views: ["schedule"],            data: ["bear_schedules"] },
  { key: "leave",       name: "請假登記與代班交接", views: ["leave"],               data: ["bear_leaves"] },
  { key: "leaveplan",   name: "請假攻略",           views: ["leaveplan"],           data: ["bear_leave_plan", "bear_leave_private"] },
  { key: "lessons",     name: "教案花園",           views: ["lessons"],             data: ["bear_lessons", "bear_lesson_themes"] },
  { key: "motor",       name: "大肌肉活動",         views: ["motor"],               data: ["bear_motor_days", "bear_motor_plans"] },
  { key: "indicators",  name: "幼兒學習指標",       views: ["files"],               data: [] },
  { key: "routine",     name: "班級作息表",         views: ["routine"],             data: ["bear_routine"] },
  { key: "writer",      name: "AI 文字小幫手",      views: ["writer"],              data: [] },
  { key: "students",    name: "學生名冊",           views: ["students"],            data: ["bear_student_records"] },
  { key: "attendance",  name: "出缺勤點名",         views: ["attendance"],          data: ["bear_attendance"] },
  { key: "supplies",    name: "寶貝補給品",         views: ["supplies"],            data: [] },
  { key: "forms",       name: "回條小幫手",         views: ["forms"],               data: ["bear_forms"] },
  { key: "afterschool", name: "課後才藝",           views: ["afterschool"],         data: ["bear_afterschool"] },
  { key: "bus",         name: "娃娃車名單",         views: ["bus"],                 data: ["bear_bus_routes", "bear_bus_riders"] },
  { key: "funds",       name: "班級資金",           views: ["funds"],               data: ["bear_fund_records", "bear_fund_types"] },
  { key: "roster",      name: "全園班表與代班",     views: ["roster"],              data: ["bear_teacher_map", "bear_roster_rows", "bear_sub_records"] },
  { key: "training",    name: "研習任務",           views: ["training"],            data: ["bear_trainings", "bear_training_cycle"] },
  { key: "logs",        name: "週誌月報",           views: [],                      data: ["bear_logs"] },
  { key: "team",        name: "班級共享（多位老師）", views: ["team"],              data: [] },
  { key: "ai",          name: "AI 小幫手（所有 AI 功能）", views: [],              data: [] },
];
// Every AI task: default points per use, and the measured average cost per use (NT$)
// used until there is enough real usage to replace it.
window.BEAR_AI_KINDS = [
  { kind: "routine",    name: "讀作息表照片",       points: 1, estNT: 0.9, share: 0.10 },
  { kind: "roster",     name: "讀全園班表",         points: 1, estNT: 1.0, share: 0.10 },
  { kind: "calendar",   name: "讀行事曆",           points: 2, estNT: 3.5, share: 0.08 },
  { kind: "motor",      name: "讀大肌肉活動規劃",   points: 1, estNT: 1.0, share: 0.05 },
  { kind: "bus",        name: "讀娃娃車名單",       points: 1, estNT: 1.0, share: 0.04 },
  { kind: "lesson",     name: "推薦學習指標",       points: 1, estNT: 0.8, share: 0.13 },
  { kind: "lessonChat", name: "AI 寫教案（每一輪）", points: 2, estNT: 2.1, share: 0.30 },
  { kind: "notice",     name: "寫家長通知",         points: 1, estNT: 0.6, share: 0.12 },
  { kind: "journal",    name: "寫週誌／月報",       points: 3, estNT: 3.0, share: 0.08 },
];
// What changed for teachers, newest last. Each note becomes a 「新功能上線」 announcement the first time
// the admin panel opens after it ships, and the admin is asked whether to notify teachers.
// id: unique and never reused. features: the BEAR_FEATURES keys it covers (optional).
window.BEAR_RELEASES = [
  { id: "2026-10-26-leave-multi", features: ["leaveplan"], title: "新功能上線",
    body: "「請假攻略」升級了！\n・長按日期就能多選：按住不放再滑動，一次選好幾天；也可以一天一天點選\n・多選的日期會用同一種假別一起登記\n・需要代班交接單時，會列出每一天的交接事項，可以直接修改\n・還沒確定的日子可以先跳過，請假前一週會提醒你建立" },
];
