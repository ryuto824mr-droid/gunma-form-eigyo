const clientId = "848048997236-4ch3lsqdmagf2fmacgan0tbe5nc800c3.apps.googleusercontent.com";
const redirectUri = "http://localhost";
const scopes = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent`;

console.log("以下のURLをブラウザで開いてください:\n");
console.log(authUrl);
