const clientId = "848048997236-4ch3lsqdmagf2fmacgan0tbe5nc800c3.apps.googleusercontent.com";
const redirectUri = "http://localhost";
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=https://www.googleapis.com/auth/gmail.send&access_type=offline&prompt=consent`;

console.log("以下のURLをブラウザで開いてください:\n");
console.log(authUrl);
