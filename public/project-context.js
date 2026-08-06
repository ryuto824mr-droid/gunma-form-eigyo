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

// 各ページ共通ヘッダーの id="projectBadge" 要素を現在のプロジェクトに合わせて表示する。
// あわせて --project-accent CSS変数にプロジェクトカラーを反映する(ページ全体の配色統合は今後の対応)。
function initProjectBadge() {
  var project = getCurrentProject();

  try {
    document.documentElement.style.setProperty("--project-accent", getProjectColor(project));
  } catch (e) {}

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
