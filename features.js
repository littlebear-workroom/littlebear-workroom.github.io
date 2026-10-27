// 小熊工作室 feature list — the one place that names every feature and every AI task.
// The app (menu locks), the admin panel (plan checkboxes, AI point costs, pricing advice)
// and the server (which data each feature may write) all read from here.
// Adding a feature or an AI task = adding a line below (desc is what the AI plan advisor reads).
// Every front-end update also gets a note in BEAR_RELEASES (bottom): the admin panel turns new notes into announcements.
window.BEAR_FEATURES = [
  // key        name                    menu views                 data it saves
  { key: "tasks",       name: "待辦清單",           views: ["tasks"],               data: ["bear_tasks", "bear_stickies", "bear_home_layout", "bear_onboard"] , desc: "個人待辦清單，可分類、排優先、逾期自動移到今天；右下角＋可以手寫便利貼，再一鍵轉成待辦" },
  { key: "calendar",    name: "行事曆",             views: ["calendar"],            data: ["bear_cal_events", "bear_cal_plans"] , desc: "整學期/當月行事曆，AI 讀園所行事曆照片匯入，標出我負責的工作" },
  { key: "chores",      name: "例行公事",           views: ["chores"],              data: ["bear_chores"] , desc: "週誌、月報等定期要做的事的提醒" },
  { key: "schedule",    name: "我的上下班時間",     views: ["schedule"],            data: ["bear_schedules"] , desc: "我的上下班時間，首頁倒數下班；值班會從全園班表帶入" },
  { key: "leave",       name: "請假登記與代班交接", views: ["leave"],               data: ["bear_leaves"] , desc: "請假登記，自動產生每日代班交接單（作息、課程、要注意的孩子），通知同班老師" },
  { key: "leaveplan",   name: "請假攻略",           views: ["leaveplan"],           data: ["bear_leave_plan", "bear_leave_private"] , desc: "請假攻略：依辦公日曆算連假怎麼請最划算，請假行事曆，同步同班老師" },
  { key: "lessons",     name: "教案花園",           views: ["lessons"],             data: ["bear_lessons", "bear_lesson_themes"] , desc: "教案花園：完整教案欄位，AI 對話共寫教案、推薦學習指標，材料加到待辦" },
  { key: "motor",       name: "大肌肉活動",         views: ["motor"],               data: ["bear_motor_days", "bear_motor_plans"] , desc: "大肌肉活動：AI 讀月規劃表，自動排成每日課程" },
  { key: "indicators",  name: "幼兒學習指標",       views: ["files"],               data: [] , desc: "幼兒學習指標查詢（教育部課綱 438 條）" },
  { key: "routine",     name: "班級作息表",         views: ["routine"],             data: ["bear_routine"] , desc: "班級作息表，AI 讀作息表照片" },
  { key: "writer",      name: "AI 文字小幫手",      views: ["writer"],              data: [] , desc: "AI 文字小幫手：寫家長通知、週誌/月報草稿" },
  { key: "students",    name: "學生名冊",           views: ["students"],            data: ["bear_student_records", "bear_meds"] , desc: "學生名冊、孩子小檔案（一頁看完今日狀況、用藥、補給品、娃娃車、才藝）、用藥提醒與紀錄、學年升班，可匯出 Excel" },
  { key: "attendance",  name: "出缺勤點名",         views: ["attendance"],          data: ["bear_attendance"] , desc: "每日點名與出席統計" },
  { key: "supplies",    name: "寶貝補給品",         views: ["supplies"],            data: ["bear_supply_settings", "bear_toilet"] , desc: "寶貝補給品：每位幼兒衣物、尿布數量，老師自訂低於幾件提醒，如廁階段與戒尿布如廁紀錄，一鍵複製請家長補充的訊息" },
  { key: "forms",       name: "回條小幫手",         views: ["forms"],               data: ["bear_forms"] , desc: "回條小幫手：回條、繳費、同意書勾選統計" },
  { key: "messages",    name: "訊息小幫手",         views: ["msgs"],                data: ["bear_msg_templates"], desc: "給家長的訊息集中：補給品、回條催繳、如廁與用藥通知一鍵複製，常用範本" },
  { key: "afterschool", name: "課後才藝",           views: ["afterschool"],         data: ["bear_afterschool"] , desc: "課後才藝名單與上課準備提醒" },
  { key: "bus",         name: "娃娃車名單",         views: ["bus"],                 data: ["bear_bus_routes", "bear_bus_riders"] , desc: "娃娃車名單：車次、搭車順序、聯絡人，AI 讀名單" },
  { key: "funds",       name: "班級資金",           views: ["funds"],               data: ["bear_fund_records", "bear_fund_types"] , desc: "班級資金：分類記帳與餘額" },
  { key: "roster",      name: "全園班表與代班",     views: ["roster"],              data: ["bear_teacher_map", "bear_roster_rows", "bear_sub_records"] , desc: "全園班表與代班：AI 讀全園班表，請假找人代班紀錄" },
  { key: "training",    name: "研習任務",           views: ["training"],            data: ["bear_trainings", "bear_training_cycle"] , desc: "研習任務：兩年一期研習時數與報名紀錄" },
  { key: "logs",        name: "週誌月報",           views: [],                      data: ["bear_logs"] , desc: "週誌月報紀錄" },
  { key: "team",        name: "班級共享（多位老師）", views: ["team"],              data: [] , desc: "班級共享：邀請同班老師，名冊、點名、教案、交接單等班級資料即時同步（沒有這項就只能一個人用）" },
  { key: "ai",          name: "AI 小幫手（所有 AI 功能）", views: [],              data: [] , desc: "AI 總開關：關掉就不能使用任何 AI 功能" },
];
// Every AI task: which feature it belongs to, default points per use, and the measured average cost per use (NT$)
// used until there is enough real usage to replace it.
window.BEAR_AI_KINDS = [
  { kind: "routine",    name: "讀作息表照片",       points: 1, estNT: 0.9, share: 0.10 , feature: "routine" },
  { kind: "roster",     name: "讀全園班表",         points: 1, estNT: 1.0, share: 0.10 , feature: "roster" },
  { kind: "calendar",   name: "讀行事曆",           points: 2, estNT: 3.5, share: 0.08 , feature: "calendar" },
  { kind: "motor",      name: "讀大肌肉活動規劃",   points: 1, estNT: 1.0, share: 0.05 , feature: "motor" },
  { kind: "bus",        name: "讀娃娃車名單",       points: 1, estNT: 1.0, share: 0.04 , feature: "bus" },
  { kind: "lesson",     name: "推薦學習指標",       points: 1, estNT: 0.8, share: 0.13 , feature: "lessons" },
  { kind: "lessonChat", name: "AI 寫教案（每一輪）", points: 2, estNT: 2.1, share: 0.30 , feature: "lessons" },
  { kind: "notice",     name: "寫家長通知",         points: 1, estNT: 0.6, share: 0.12 , feature: "writer" },
  { kind: "journal",    name: "寫週誌／月報",       points: 3, estNT: 3.0, share: 0.08 , feature: "writer" },
  { kind: "sticky",     name: "手寫便利貼轉文字",   points: 1, estNT: 0.5, share: 0.03, feature: "tasks" },
];
// What changed for teachers, newest last. Each note becomes a 「新功能上線」 announcement the first time
// the admin panel opens after it ships, and the admin is asked whether to notify teachers.
// id: unique and never reused. features: the BEAR_FEATURES keys it covers (optional).
window.BEAR_RELEASES = [
  { id: "2026-10-26-leave-multi", features: ["leaveplan"], title: "新功能上線",
    body: "「請假攻略」升級了！\n・長按日期就能多選：按住不放再滑動，一次選好幾天；也可以一天一天點選\n・多選的日期會用同一種假別一起登記\n・需要代班交接單時，會列出每一天的交接事項，可以直接修改\n・還沒確定的日子可以先跳過，請假前一週會提醒你建立" },
  { id: "2026-10-26-ai-members", features: ["ai"], title: "新功能上線",
    body: "班級 AI 點數看得更清楚了！\n・同班有兩位以上老師時，「帳號管理」的方案卡片會顯示本月每位老師用了多少點\n・全班老師共用同一份點數，大家一起看用量，分配更安心" },
  { id: "2026-10-27-big-update", features: ["students", "messages", "supplies", "tasks"], title: "新功能上線",
    body: "小熊工作室大更新！\n・孩子小檔案：點孩子名字，一頁看完今日狀況、用藥、補給品、娃娃車、才藝、出缺勤\n・用藥提醒：登記藥品和時間，時間到同班老師都會收到通知，餵完按「已餵藥」留下紀錄\n・今天要特別注意的孩子：點名時在備註寫下今天的狀況（例如咳嗽、要吃藥）就會出現\n・寶貝補給品：首頁只列名字，點名字看要補多少並一鍵複製給家長；可自訂提醒件數；新增如廁階段（包尿布／戒尿布中／穿內褲）和如廁紀錄\n・訊息小幫手：補給品、回條催繳、用藥完成的訊息集中一鍵複製，還能存常用範本\n・右下角＋變成便利貼，用手指寫下來就好，也能用 AI 轉成文字加入待辦\n・首頁可以自己排順序、關掉用不到的區塊；字體可以調大\n・學年升班、班費匯出 Excel、邀請老師一起拿 AI 點數" },
  { id: "2026-10-27-body-status", features: ["students", "supplies"], title: "新功能上線",
    body: "孩子小檔案新增「如廁與身體狀況」：\n・每個孩子都能記💩正常、💧拉肚子、😣便秘、🤮嘔吐，每點一次就記下當下的時間\n・自動統計今天幾次、在什麼時間\n・拉肚子、嘔吐、便秘會自動出現在「今天要特別注意的孩子」\n・一鍵整理今天的狀況，修改後複製給家長" },
  { id: "2026-10-27-kid-day-msg", features: ["messages"], title: "新功能上線",
    body: "訊息小幫手更聰明了：同一個孩子今天的狀況、用藥、拉肚子等身體狀況、要補的備品，會自動整理成同一則訊息，按一下就能複製給家長，也可以先修改再傳。" },
  { id: "2026-10-27-dashboard", features: ["tasks", "attendance"], title: "新功能上線",
    body: "首頁大改版，打開就知道今天要做什麼：\n・「今天要注意」一排小卡：還沒點名、用藥時間、要注意的孩子、補備品、請假、回條…最急的排最前面，點一下看細節\n・「我的待辦」只列最急的 3 件\n・下午會提醒「放學前要傳給家長幾則訊息」\n・下方按鈕改成：首頁、點名、待辦、訊息、選單\n・點名可以一鍵「沒點的都設為出席」\n・選單可以搜尋功能，最常用的會排在最上面" },
];
