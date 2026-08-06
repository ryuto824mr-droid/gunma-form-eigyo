// project-context.js
//
// 全ページ共通のプロジェクト(LOCLE / 群馬お仕事図鑑)コンテキスト管理。
// 各HTMLの<head>で <script src="/project-context.js"></script> として読み込む。
//
// 現時点では「選択状態を覚えて表示する」土台のみで、companies一覧やCRM等の
// APIをproject別に絞り込む処理はまだ行わない(次のステップで対応する)。

var PROJECT_STORAGE_KEY = "locle_current_project";
var PROJECT_LABELS = { locle: "LOCLE", ozukanzukan: "群馬お仕事図鑑" };
var PROJECT_COLORS = { locle: "#44B13F", ozukanzukan: "#f97316" };

// アクセントカラーのフルパレット(既存の--green-*系CSS変数・Chart.js等のJS色指定を
// 一括でプロジェクトカラーに切り替えるための土台)。オレンジ側はTailwindのorangeスケール
// (50/100/200/300/400/500/700/900)に合わせ、既存の訴求ポイントpill等と色味を揃えている。
var PROJECT_THEME = {
  locle: {
    g900: "#1a5c17", g800: "#277025", g700: "#2F8A2A", g600: "#3da038", g500: "#44B13F", g400: "#5BC952",
    g300: "#86efac", g200: "#b7e4b0", g100: "#d8f0d8", g50: "#f0faf0",
    rgb900: "26,92,23", rgb500: "68,177,63", rgb700: "47,138,42",
  },
  ozukanzukan: {
    g900: "#7c2d12", g800: "#9a3412", g700: "#c2410c", g600: "#ea580c", g500: "#f97316", g400: "#fb923c",
    g300: "#fdba74", g200: "#fed7aa", g100: "#ffedd5", g50: "#fff7ed",
    rgb900: "124,45,18", rgb500: "249,115,22", rgb700: "194,65,12",
  },
};

function isValidProject(project) {
  return project === "locle" || project === "ozukanzukan";
}

// 優先順位: 1.URLパラメータ(?project=xxx) 2.localStorage 3.デフォルト'locle'
// URLパラメータがあればlocalStorageも更新し、次回以降(パラメータなしのアクセス)にも引き継がれるようにする
function getCurrentProject() {
  try {
    var urlParams = new URLSearchParams(window.location.search);
    var fromUrl = urlParams.get("project");
    if (isValidProject(fromUrl)) {
      setCurrentProject(fromUrl);
      return fromUrl;
    }
  } catch (e) {}

  try {
    var stored = localStorage.getItem(PROJECT_STORAGE_KEY);
    if (isValidProject(stored)) return stored;
  } catch (e) {}

  return "locle";
}

function setCurrentProject(project) {
  if (!isValidProject(project)) return;
  try {
    localStorage.setItem(PROJECT_STORAGE_KEY, project);
  } catch (e) {}
}

function getProjectLabel(project) {
  return PROJECT_LABELS[project] || PROJECT_LABELS.locle;
}

function getProjectColor(project) {
  return PROJECT_COLORS[project] || PROJECT_COLORS.locle;
}

// Chart.js等、CSS変数を直接解釈できないJS側の色指定で使う濃色バージョン(--green-700相当)
function getProjectColorDark(project) {
  var t = PROJECT_THEME[project] || PROJECT_THEME.locle;
  return t.g700;
}

// Chart.js等で塗りつぶし用の半透明色(--green-500相当)が必要な箇所で使うrgba文字列を返す
function getProjectColorRgba(project, alpha) {
  var t = PROJECT_THEME[project] || PROJECT_THEME.locle;
  return "rgba(" + t.rgb500 + "," + alpha + ")";
}

// ページ間リンク用: 指定URLにproject パラメータを付与して返す(パス+クエリ+ハッシュ)
function addProjectParamToUrl(url, project) {
  try {
    var u = new URL(url, window.location.origin);
    u.searchParams.set("project", project);
    return u.pathname + u.search + u.hash;
  } catch (e) {
    var sep = url.indexOf("?") >= 0 ? "&" : "?";
    return url + sep + "project=" + encodeURIComponent(project);
  }
}

// ページ全体のアクセントカラー(--green-50〜900とそのrgba用-rgbサフィックス版)を
// 現在のプロジェクトに合わせて上書きする。既存のCSS(ボタン・バッジ・ヘッダー
// グラデーション等)はこれらの変数を参照しているため、この関数を呼ぶだけで
// 一括して緑↔オレンジに切り替わる。
// <head>内でproject-context.js読み込み直後、できるだけ早いタイミング(<style>がまだ
// パースされる前)に同期的に呼び出すことで、ちらつき無く初回描画から正しい色にする。
function applyProjectTheme() {
  var project = getCurrentProject();
  var t = PROJECT_THEME[project] || PROJECT_THEME.locle;
  try {
    var s = document.documentElement.style;
    s.setProperty("--green-900", t.g900);
    s.setProperty("--green-800", t.g800);
    s.setProperty("--green-700", t.g700);
    s.setProperty("--green-600", t.g600);
    s.setProperty("--green-500", t.g500);
    s.setProperty("--green-400", t.g400);
    s.setProperty("--green-300", t.g300);
    s.setProperty("--green-200", t.g200);
    s.setProperty("--green-100", t.g100);
    s.setProperty("--green-50", t.g50);
    s.setProperty("--green-500-rgb", t.rgb500);
    s.setProperty("--green-700-rgb", t.rgb700);
    s.setProperty("--green-900-rgb", t.rgb900);
  } catch (e) {}
}

// 各ページ共通ヘッダーの id="projectBadge" 要素を現在のプロジェクトに合わせて表示する。
// あわせて --project-accent CSS変数にプロジェクトカラーを反映する(ページ全体の配色統合は今後の対応)。
// id="navHomeLink" のヘッダー「ホーム」リンクがあれば、現在のプロジェクトを引き継いだ
// home.htmlへのリンクに更新する(app.html自身の「ホーム」リンクは自己参照のため対象外)。
//
// app.html(プロジェクト未選択のニュートラルな選択画面)では実行しない: getCurrentProject()は
// URLの?project=パラメータを読むとlocalStorageへ自動保存してしまうため、app.htmlをこの関数の
// 対象にすると「URLにパラメータを付けて開いただけで選択状態が変わる」という、分割前の挙動が
// 意図せず残ってしまう。app.htmlにはbadge/home-link要素も置いていないため、実害なく丸ごとスキップできる。
function initProjectBadge() {
  try {
    if (window.location && /\/app\.html$/.test(window.location.pathname)) return;
  } catch (e) {}

  var project = getCurrentProject();

  try {
    document.documentElement.style.setProperty("--project-accent", getProjectColor(project));
  } catch (e) {}

  var homeLink = document.getElementById("navHomeLink");
  if (homeLink) {
    homeLink.href = addProjectParamToUrl("/home.html", project);
  }

  var badge = document.getElementById("projectBadge");
  if (!badge) return;
  badge.textContent = getProjectLabel(project);
  badge.style.background = getProjectColor(project);
  badge.onclick = function () {
    window.location.href = "/app.html#project-select";
  };
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", initProjectBadge);
}
