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
];

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
}
