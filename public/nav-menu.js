// nav-menu.js
//
// 全ページ共通のハンバーガーメニュー(ドロワー)。project-context.jsの後に読み込み、
// 各ページの本文末尾(headerの後、既存のinitScrollReveal()等と同じ場所)で
// initNavMenu("<ページキー>") を呼び出して使う。
//
// PC表示(600px以上): ホームのみ常時表示バーに残し、それ以外は☰クリックで開くドロワーにまとめる。
// スマホ表示(600px未満): 常時表示バーの「ホーム」リンクをCSSで隠し、ドロワー側に用意した
// 同じリンク(nav-mobile-only)を含めて全リンクをドロワーに表示する。

var NAV_PRIMARY_ITEMS = [
  { key: "home", href: "/home.html", label: "ホーム" },
];

var NAV_SECONDARY_ITEMS = [
  { key: "companies",       href: "/companies.html",       label: "企業リスト" },
  { key: "variants",        href: "/variants.html",        label: "メッセージ管理" },
  { key: "send",              href: "/send.html",              label: "送信管理" },
  { key: "later",             href: "/later.html",             label: "あとで送る" },
  { key: "crm",               href: "/crm.html",               label: "CRM" },
  { key: "analytics",        href: "/analytics.html",        label: "分析" },
  { key: "reports",           href: "/reports.html",          label: "レポート" },
  { key: "content-studio",  href: "/content-studio.html",  label: "コンテンツ制作", contentStudioOnly: true },
  { key: "production",       href: "/production.html",       label: "制作進行", contentStudioOnly: true },
  { key: "work-logs",        href: "/work-logs.html",        label: "稼働管理" },
  { key: "meeting-notes",   href: "/meeting-notes.html",   label: "議事録" },
  { key: "calendar",         href: "/calendar.html",         label: "カレンダー" },
  { key: "help",              href: "/help.html",              label: "ヘルプ" },
  { key: "demo",              href: "/index.html",             label: "デモ", external: true },
  // 初めて開いたときの案内(下の showOnboarding)をもう一度開く
  { key: "onboarding",        href: "#onboarding",             label: "はじめての案内" },
];

// ==================== 各ページの上部の説明 ====================
// initNavMenu("<ページキー>") のキーごとに、そのページでできること(1〜3行)と help.html の項目を書く。
// 「閉じる」を押すと、そのブラウザでは小さな「ℹ このページの説明」だけを出す(localStorage。使えなければ毎回出す)
var PAGE_INTROS = {
  home: {
    title: "ホーム",
    lines: ["プロジェクトを選び、今日のフォローアップと期限切れのタスクを確認します。", "送信の数・反応率などの全体の数字もここで見られます。"],
    help: "intro",
  },
  companies: {
    title: "企業リスト",
    lines: ["営業先の企業を登録・リサーチ・アーカイブします。", "リサーチで、問い合わせフォームの欄・宛名・住所の県を確かめます。県外の会社や送り先として不適切な企業は自動送信の対象になりません。"],
    help: "companies",
  },
  variants: {
    title: "メッセージ管理",
    lines: ["送る文面(バリアント)を作ります。{{company_name}} は宛名(企業名)に置き換わります。", "送信記録のある文面は編集・削除できません。直すときはコピーして新しく作ります。"],
    help: "variants",
  },
  send: {
    title: "送信管理",
    lines: ["送信待ちの行と、送った結果(送れた・送れたか不明・失敗)を確かめます。", "「送れたか不明」の企業には、もう一度送らないでください(二重送信になるおそれがあります)。"],
    help: "send",
  },
  later: {
    title: "あとで送る",
    lines: ["まだ送っていない企業と保留の行を「送れる・要確認・送れない」に分けて表示します。このページでは送信しません。", "「送れる」から選んで送信待ちに入れると、次の自動送信で送られます。"],
    help: "later",
  },
  crm: {
    title: "CRM",
    lines: ["返信があった企業の商談・担当者・タスクを管理します。", "送信者の情報(名前・会社名・連絡先)の設定もここにあります。"],
    help: "crm",
  },
  analytics: { title: "分析", lines: ["文面ごとの送信数・反応率を比べ、どの文面がよいかを確かめます。"], help: "analytics" },
  reports: { title: "レポート", lines: ["期間ごとの送信・反応の集計を見ます。"], help: "reports" },
  "content-studio": { title: "コンテンツ制作", lines: ["取材記事・SNS投稿などの下書きを作ります(群馬お仕事図鑑)。"], help: "content-studio" },
  production: { title: "制作進行", lines: ["取材・原稿・公開までの進み具合を管理します(群馬お仕事図鑑)。"], help: "content-studio" },
  "work-logs": { title: "稼働管理", lines: ["出勤・退勤と、その日の作業内容を記録します。", "1か月分の稼働報告書(A4・1枚)を開いて、印刷画面から PDF にできます。"], help: "work-logs" },
  "meeting-notes": { title: "議事録", lines: ["打ち合わせの記録を残し、要約を作ります。"], help: "meeting-notes" },
  calendar: { title: "カレンダー", lines: ["予定と、フォローアップ・タスクの期限を月ごとに見ます。"], help: "calendar" },
  help: { title: "ヘルプ", lines: ["使い方の説明です。上の「役割から探す」から、自分の役割の手順を見られます。"], help: "role-guide" },
};

function _safeStorage(fn, fallback) {
  try { return fn(window.localStorage); } catch (e) { return fallback; }
}

function _escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function renderPageIntro(activePage) {
  var intro = PAGE_INTROS[activePage];
  if (!intro || document.getElementById("pageIntro")) return;
  var header = document.querySelector(".page-nav") && document.querySelector(".page-nav").closest("header");
  if (!header) return;
  var hiddenKey = "gfe_intro_hidden_" + activePage;
  var box = document.createElement("div");
  box.id = "pageIntro";
  box.className = "page-intro";
  box.setAttribute("role", "note");
  var helpLink = activePage === "help" ? "" :
    ' <a class="page-intro-help" href="/help.html#' + intro.help + '">くわしく</a>';
  box.innerHTML =
    '<div class="page-intro-body">' +
      '<strong class="page-intro-title">このページでできること（' + _escapeHtml(intro.title) + "）</strong>" +
      intro.lines.map(function (l) { return "<p>" + _escapeHtml(l) + "</p>"; }).join("") +
      helpLink +
    "</div>" +
    '<button type="button" class="page-intro-close" aria-label="説明を閉じる">閉じる</button>';
  var mini = document.createElement("button");
  mini.type = "button";
  mini.className = "page-intro-mini";
  mini.textContent = "ℹ このページの説明";
  header.parentNode.insertBefore(box, header.nextSibling);
  header.parentNode.insertBefore(mini, box.nextSibling);
  function show(visible) {
    box.hidden = !visible;
    mini.hidden = visible;
  }
  show(_safeStorage(function (s) { return s.getItem(hiddenKey) !== "1"; }, true));
  box.querySelector(".page-intro-close").addEventListener("click", function () {
    _safeStorage(function (s) { s.setItem(hiddenKey, "1"); });
    show(false);
  });
  mini.addEventListener("click", function () {
    _safeStorage(function (s) { s.removeItem(hiddenKey); });
    show(true);
  });
}

// ==================== 初めて開いたときの案内 ====================
// ログインも人ごとのアカウントも無い。見たかどうかと選んだ役割は、そのブラウザに覚えさせる。
// メニューの「はじめての案内」でいつでも開き直せる
var ONBOARDING_KEY = "gfe_onboarding_v1";
var ROLE_KEY = "gfe_role";
var ROLE_GUIDES = {
  admin: {
    label: "管理者",
    summary: "設定・自動化・データの直しを受け持ちます。",
    today: [
      "「あとで送る」で、警告と★候補を確かめる",
      "「送信管理」で、失敗と「送れたか不明」を確かめる",
      "1日の送信の上限・自動化の入/切は、管理者だけが変える",
    ],
    help: "role-admin",
  },
  sales: {
    label: "営業担当",
    summary: "送る企業を選び、返信に対応します。",
    today: [
      "「あとで送る」の「送れる」から選んで、送信待ちに入れる",
      "「要確認」の企業は、理由を見て直すか、見送る",
      "返信があった企業は「CRM」で対応する",
    ],
    help: "role-sales",
  },
  everyone: {
    label: "全員",
    summary: "日々の記録をつけます。",
    today: [
      "「稼働管理」で出勤・退勤と作業内容を記録する",
      "打ち合わせは「議事録」、予定は「カレンダー」に残す",
      "わからないときは「ヘルプ」の「役割から探す」を見る",
    ],
    help: "role-everyone",
  },
};
var ONBOARDING_DONTS = [
  "「送れたか不明」「送信記録あり」の企業には、もう一度送らない(二重送信になるおそれがあります)",
  "営業お断り・人からの反応がある企業には送らない",
  "このツールの URL を社外の人に教えない(ログインが無いため、URL を知っていれば誰でも開けます)",
];

function showOnboarding(roleKey) {
  var old = document.getElementById("onboarding");
  if (old) old.remove();
  var wrap = document.createElement("div");
  wrap.id = "onboarding";
  wrap.className = "onboarding-overlay";
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-modal", "true");
  wrap.setAttribute("aria-label", "はじめての案内");
  var role = ROLE_GUIDES[roleKey];
  var body;
  if (!role) {
    body =
      "<h2>ようこそ</h2>" +
      "<p>このツールは「企業を探す → リサーチ → 送る企業を選ぶ → 自動で送信 → 返信に対応」を行います。</p>" +
      "<p><strong>あなたの役割を選んでください</strong>（あとで、メニューの「はじめての案内」から変えられます）</p>" +
      '<div class="onboarding-roles">' +
        Object.keys(ROLE_GUIDES).map(function (k) {
          return '<button type="button" class="onboarding-role" data-role="' + k + '"><strong>' +
            _escapeHtml(ROLE_GUIDES[k].label) + "</strong><span>" + _escapeHtml(ROLE_GUIDES[k].summary) + "</span></button>";
        }).join("") +
      "</div>";
  } else {
    body =
      "<h2>" + _escapeHtml(role.label) + "の方へ</h2>" +
      "<p>" + _escapeHtml(role.summary) + "</p>" +
      "<h3>まずやること</h3><ol>" + role.today.map(function (t) { return "<li>" + _escapeHtml(t) + "</li>"; }).join("") + "</ol>" +
      "<h3>してはいけないこと</h3><ul>" + ONBOARDING_DONTS.map(function (t) { return "<li>" + _escapeHtml(t) + "</li>"; }).join("") + "</ul>" +
      '<p><a href="/help.html#' + role.help + '">' + _escapeHtml(role.label) + "の手順をヘルプで見る</a></p>" +
      '<div class="onboarding-actions">' +
        '<button type="button" class="onboarding-back">役割を選び直す</button>' +
        '<button type="button" class="onboarding-done">はじめる</button>' +
      "</div>";
  }
  wrap.innerHTML = '<div class="onboarding-card">' + body + "</div>";
  document.body.appendChild(wrap);
  wrap.querySelectorAll(".onboarding-role").forEach(function (b) {
    b.addEventListener("click", function () {
      var k = b.getAttribute("data-role");
      _safeStorage(function (s) { s.setItem(ROLE_KEY, k); });
      showOnboarding(k);
    });
  });
  var back = wrap.querySelector(".onboarding-back");
  if (back) back.addEventListener("click", function () { showOnboarding(null); });
  var done = wrap.querySelector(".onboarding-done");
  if (done) {
    done.addEventListener("click", function () {
      _safeStorage(function (s) { s.setItem(ONBOARDING_KEY, "1"); });
      wrap.remove();
    });
    done.focus();
  }
}

function maybeShowOnboarding() {
  var seen = _safeStorage(function (s) { return s.getItem(ONBOARDING_KEY) === "1"; }, true);
  if (!seen) showOnboarding(_safeStorage(function (s) { return s.getItem(ROLE_KEY); }, null));
}

function _navLinkHtml(item, extraClass) {
  var classes = ["nav-drawer-link"];
  if (extraClass) classes.push(extraClass);
  if (item.contentStudioOnly) classes.push("content-studio-only");
  var hiddenAttr = item.contentStudioOnly ? " hidden" : "";
  var targetAttr = item.external ? ' target="_blank"' : "";
  return '<a href="' + item.href + '" class="' + classes.join(" ") + '" data-page="' + item.key + '"' + hiddenAttr + targetAttr + ">" + item.label + "</a>";
}

function initNavMenu(activePage) {
  var nav = document.querySelector(".page-nav");
  if (!nav) return;

  // app.html自身は「ホーム」がプロジェクトダッシュボード(home.html)ではなく
  // 自分自身(プロジェクト選択画面)への自己参照リンクであるべきなので、ここだけ特別扱いする
  var isAppPage = /\/app\.html$/.test(window.location.pathname);
  var homeHref = isAppPage ? "/app.html" : "/home.html";

  var themeToggle = document.getElementById("themeToggleBtn");

  var primaryHtml = NAV_PRIMARY_ITEMS.map(function (item) {
    var href = item.key === "home" ? homeHref : item.href;
    return '<a href="' + href + '" class="nav-primary" data-page="' + item.key + '">' + item.label + "</a>";
  }).join("");
  var hamburgerHtml = '<button type="button" class="nav-hamburger-btn" id="navHamburgerBtn" aria-label="メニュー" aria-expanded="false" aria-haspopup="true">&#9776;</button>';

  var barFrag = document.createElement("div");
  barFrag.innerHTML = primaryHtml + hamburgerHtml;
  var barNodes = Array.prototype.slice.call(barFrag.childNodes);
  barNodes.forEach(function (node) {
    if (themeToggle) nav.insertBefore(node, themeToggle);
    else nav.appendChild(node);
  });

  var mobilePrimaryHtml = NAV_PRIMARY_ITEMS.map(function (item) {
    var item2 = item.key === "home" ? { key: "home", href: homeHref, label: item.label } : item;
    return _navLinkHtml(item2, "nav-mobile-only");
  }).join("") + '<div class="nav-drawer-divider nav-mobile-only"></div>';

  var secondaryHtml = NAV_SECONDARY_ITEMS.map(function (item) {
    return _navLinkHtml(item);
  }).join("");

  var drawerFrag = document.createElement("div");
  drawerFrag.innerHTML =
    '<div class="nav-drawer-overlay" id="navDrawerOverlay"></div>' +
    '<div class="nav-drawer" id="navDrawer" role="dialog" aria-modal="true" aria-label="メニュー">' +
      '<div class="nav-drawer-header">' +
        '<span class="nav-drawer-title">メニュー</span>' +
        '<button type="button" class="nav-drawer-close" id="navDrawerClose" aria-label="閉じる">&#x2715;</button>' +
      "</div>" +
      '<div class="nav-drawer-links">' + mobilePrimaryHtml + secondaryHtml + "</div>" +
    "</div>";
  document.body.appendChild(drawerFrag);

  if (activePage) {
    var activeEls = document.querySelectorAll('[data-page="' + activePage + '"]');
    for (var i = 0; i < activeEls.length; i++) activeEls[i].classList.add("active");
  }

  var hamburgerBtn = document.getElementById("navHamburgerBtn");
  var overlay = document.getElementById("navDrawerOverlay");
  var drawer = document.getElementById("navDrawer");
  var closeBtn = document.getElementById("navDrawerClose");

  function openDrawer() {
    overlay.classList.add("open");
    drawer.classList.add("open");
    hamburgerBtn.setAttribute("aria-expanded", "true");
  }
  function closeDrawer() {
    overlay.classList.remove("open");
    drawer.classList.remove("open");
    hamburgerBtn.setAttribute("aria-expanded", "false");
  }

  hamburgerBtn.addEventListener("click", function () {
    if (drawer.classList.contains("open")) closeDrawer();
    else openDrawer();
  });
  closeBtn.addEventListener("click", closeDrawer);
  overlay.addEventListener("click", closeDrawer); // ドロワー外(オーバーレイ)クリックで閉じる
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && drawer.classList.contains("open")) closeDrawer();
  });

  // メニューの「はじめての案内」: 役割の選択から開き直す
  var onboardingLink = drawer.querySelector('[data-page="onboarding"]');
  if (onboardingLink) {
    onboardingLink.addEventListener("click", function (e) {
      e.preventDefault();
      closeDrawer();
      showOnboarding(null);
    });
  }

  renderPageIntro(activePage);
  maybeShowOnboarding();
}

// テスト(node)から中身を確かめられるようにする(ブラウザでは使わない)
if (typeof module === "object" && module.exports) {
  module.exports = { PAGE_INTROS: PAGE_INTROS, ROLE_GUIDES: ROLE_GUIDES, NAV_SECONDARY_ITEMS: NAV_SECONDARY_ITEMS };
}
