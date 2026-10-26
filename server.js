// WorkHours — tiny time tracker server. Node built-in modules only (no npm deps).
// Storage: a single JSON file. Auth: open signup, PLAINTEXT passwords (as requested).
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const PORT = +(process.env.PORT || 8080);
const ADDRESS = process.env.ADDRESS || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || "./data";
// When set, signup requires a matching invite code (public-safe). When empty,
// signup is open — fine only behind a trusted network (LAN/VPN).
const SIGNUP_TOKEN = process.env.SIGNUP_TOKEN || "";
const DB = path.join(DATA_DIR, "db.json");
const PUBLIC = path.join(__dirname, "public");

fs.mkdirSync(DATA_DIR, { recursive: true });

// First-run seed. The DB is created from SEED_FILE (a full {users:{...}} document)
// if present, otherwise an empty user list (open signup). Keep real/personal seed
// data OUT of this repo — point SEED_FILE at a file in the state dir instead.
// See seed.example.json for the format.
const SEED_FILE = process.env.SEED_FILE || path.join(DATA_DIR, "seed.json");

function saveDB(db){ const tmp = DB + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, DB); }
function initialDB(){
  try { const s = JSON.parse(fs.readFileSync(SEED_FILE, "utf8")); if (s && s.users) return s; } catch(e){}
  return { users: {} };
}
function loadDB(){
  try { return JSON.parse(fs.readFileSync(DB, "utf8")); }
  catch(e){ const db = initialDB(); saveDB(db); return db; }
}
let db = loadDB();

const sessions = new Map(); // token -> username (in memory; users re-login after a restart)
const newToken = () => crypto.randomBytes(18).toString("hex");
function cookies(req){ const o={}; (req.headers.cookie||"").split(";").forEach(p=>{const i=p.indexOf("="); if(i>0)o[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim());}); return o; }
const userOf = req => sessions.get(cookies(req).sid);

function send(res, code, obj, headers){ const b = JSON.stringify(obj); res.writeHead(code, Object.assign({"Content-Type":"application/json"}, headers||{})); res.end(b); }
function body(req){ return new Promise(r=>{ let d=""; req.on("data",c=>{ d+=c; if(d.length>1e6) req.destroy(); }); req.on("end",()=>{ try{ r(d?JSON.parse(d):{});}catch(e){ r({}); } }); }); }
// Add Secure to the cookie when the request reached us over HTTPS (Caddy/Cloudflare
// terminate TLS and pass X-Forwarded-Proto; plain-HTTP LAN access omits it so login
// keeps working there).
const isHttps = req => (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
const authCookie = (t, secure) => `sid=${t}; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000${secure ? "; Secure" : ""}`;

// Passwords are stored scrypt-hashed as `scrypt$<saltHex>$<hashHex>`. Legacy
// plaintext entries (older DBs/seed) still verify, and are upgraded to a hash on
// the next successful login.
function hashPassword(pw){
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function verifyPassword(pw, stored){
  if(typeof stored !== "string") return false;
  if(stored.startsWith("scrypt$")){
    const [, saltHex, hashHex] = stored.split("$");
    const expected = Buffer.from(hashHex || "", "hex");
    let actual; try { actual = crypto.scryptSync(pw, Buffer.from(saltHex || "", "hex"), expected.length); } catch(e){ return false; }
    return expected.length > 0 && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  return stored === pw; // legacy plaintext
}
const isHashed = s => typeof s === "string" && s.startsWith("scrypt$");

// Per-username login throttle: lock out for a window after too many failures,
// to blunt brute-forcing once this is reachable from the internet.
const LOGIN_MAX = 10, LOGIN_WINDOW_MS = 15*60*1000;
const loginAttempts = new Map(); // username -> { fails, until }
const loginBlocked = un => { const e = loginAttempts.get(un); return !!(e && e.until > Date.now()); };
function loginFail(un){ const e = loginAttempts.get(un) || {fails:0, until:0}; if(++e.fails >= LOGIN_MAX){ e.until = Date.now()+LOGIN_WINDOW_MS; e.fails = 0; } loginAttempts.set(un, e); }
const loginReset = un => loginAttempts.delete(un);

// Clock token: lets an iPhone Shortcuts automation ("when I arrive at work") clock
// in/out without a browser session. Only its sha256 is stored; the raw token is
// shown once when generated. POST /api/clock/in|out with "Authorization: Bearer <token>".
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
function userOfToken(req){
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || ""); if(!m) return null;
  const h = sha256(m[1]);
  return Object.keys(db.users).find(un => db.users[un].clockTokenHash === h) || null;
}
const pad2 = n => String(n).padStart(2, "0");
// Server-local date/time (the service runs in the host's timezone), same format as the UI.
function nowLocal(){ const d = new Date(); return { date: d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()), time: pad2(d.getHours())+":"+pad2(d.getMinutes()) }; }
function clock(un, dir){
  const u = db.users[un]; u.entries = u.entries || [];
  const { date, time } = nowLocal();
  const open = u.entries.find(e => e.date === date && e.in && !e.out);
  if(dir === "in"){
    // Geofences can fire more than once; an already-open entry makes this a no-op.
    if(open) return { ok:true, status:"already", message:"Already clocked in since "+open.in };
    const first = !u.entries.some(e => e.date === date); // only the day's first stint gets the default break
    u.entries.push({ id: Date.now().toString(36)+crypto.randomBytes(2).toString("hex"), date, in: time, out: null, break: first ? 30 : 0, note: "" });
    saveDB(db); return { ok:true, status:"in", message:"Clocked in at "+time };
  }
  if(!open) return { ok:true, status:"already", message:"Not clocked in" };
  open.out = time; saveDB(db); return { ok:true, status:"out", message:"Clocked out at "+time };
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;

  if(p.startsWith("/api/")){
    if(p === "/api/signup" && req.method === "POST"){
      const b = await body(req); const un = (b.username||"").trim(), pw = b.password||"";
      if(!un || !pw) return send(res, 400, {error:"username and password required"});
      if(SIGNUP_TOKEN && (b.inviteCode||"") !== SIGNUP_TOKEN) return send(res, 403, {error:"invalid or missing invite code"});
      if(db.users[un]) return send(res, 409, {error:"username already taken"});
      db.users[un] = { password: hashPassword(pw), entries: [] }; saveDB(db);
      const t = newToken(); sessions.set(t, un);
      return send(res, 200, {username: un}, {"Set-Cookie": authCookie(t, isHttps(req))});
    }
    if(p === "/api/login" && req.method === "POST"){
      const b = await body(req); const un = (b.username||"").trim(), pw = b.password||"";
      if(loginBlocked(un)) return send(res, 429, {error:"too many attempts, try again later"});
      const u = db.users[un];
      if(!u || !verifyPassword(pw, u.password)){ loginFail(un); return send(res, 401, {error:"wrong username or password"}); }
      loginReset(un);
      if(!isHashed(u.password)){ u.password = hashPassword(pw); saveDB(db); } // upgrade legacy plaintext
      const t = newToken(); sessions.set(t, un);
      return send(res, 200, {username: un}, {"Set-Cookie": authCookie(t, isHttps(req))});
    }
    if(p === "/api/logout" && req.method === "POST"){
      const sid = cookies(req).sid; if(sid) sessions.delete(sid);
      return send(res, 200, {ok:true}, {"Set-Cookie":"sid=; HttpOnly; Path=/; Max-Age=0"});
    }
    if((p === "/api/clock/in" || p === "/api/clock/out") && req.method === "POST"){
      const tu = userOfToken(req);
      if(!tu) return send(res, 401, {error:"invalid or missing clock token"});
      return send(res, 200, clock(tu, p.endsWith("/in") ? "in" : "out"));
    }
    const un = userOf(req);
    if(!un) return send(res, 401, {error:"not logged in"});
    if(p === "/api/me") return send(res, 200, {username: un, clockToken: !!db.users[un].clockTokenHash});
    if(p === "/api/clock/token" && req.method === "POST"){
      const t = crypto.randomBytes(24).toString("hex");
      db.users[un].clockTokenHash = sha256(t); saveDB(db);
      return send(res, 200, {token: t});
    }
    if(p === "/api/clock/token" && req.method === "DELETE"){
      delete db.users[un].clockTokenHash; saveDB(db);
      return send(res, 200, {ok:true});
    }
    if(p === "/api/entries" && req.method === "GET") return send(res, 200, {entries: db.users[un].entries || []});
    if(p === "/api/entries" && req.method === "PUT"){
      const b = await body(req);
      if(!Array.isArray(b.entries)) return send(res, 400, {error:"entries must be an array"});
      db.users[un].entries = b.entries; saveDB(db);
      return send(res, 200, {ok:true});
    }
    if(p === "/api/settings" && req.method === "GET") return send(res, 200, {settings: db.users[un].settings || {}});
    if(p === "/api/settings" && req.method === "PUT"){
      const b = await body(req);
      if(typeof b.settings !== "object" || b.settings === null) return send(res, 400, {error:"settings must be an object"});
      db.users[un].settings = Object.assign(db.users[un].settings || {}, b.settings); saveDB(db);
      return send(res, 200, {ok:true});
    }
    return send(res, 404, {error:"not found"});
  }

  // static files from ./public, with index.html fallback
  const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
  const fp = path.join(PUBLIC, rel);
  if(!fp.startsWith(PUBLIC)){ res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(fp, (err, data) => {
    if(err){
      return fs.readFile(path.join(PUBLIC, "index.html"), (e2, idx) => {
        if(e2){ res.writeHead(404); res.end("not found"); }
        else { res.writeHead(200, {"Content-Type":"text/html"}); res.end(idx); }
      });
    }
    const types = {".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml",".ico":"image/x-icon",".json":"application/json",".webmanifest":"application/manifest+json"};
    res.writeHead(200, {"Content-Type": types[path.extname(fp)] || "application/octet-stream"});
    res.end(data);
  });
});

server.listen(PORT, ADDRESS, () => console.log(`WorkHours on http://${ADDRESS}:${PORT}  (data: ${DB})`));
