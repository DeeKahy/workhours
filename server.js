// WorkHours — tiny time tracker server. Node built-in modules only (no npm deps).
// Storage: a single JSON file. Auth: open signup, PLAINTEXT passwords (as requested).
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const PORT = +(process.env.PORT || 8080);
const ADDRESS = process.env.ADDRESS || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || "./data";
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
const authCookie = t => `sid=${t}; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000`;

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;

  if(p.startsWith("/api/")){
    if(p === "/api/signup" && req.method === "POST"){
      const b = await body(req); const un = (b.username||"").trim(), pw = b.password||"";
      if(!un || !pw) return send(res, 400, {error:"username and password required"});
      if(db.users[un]) return send(res, 409, {error:"username already taken"});
      db.users[un] = { password: pw, entries: [] }; saveDB(db);
      const t = newToken(); sessions.set(t, un);
      return send(res, 200, {username: un}, {"Set-Cookie": authCookie(t)});
    }
    if(p === "/api/login" && req.method === "POST"){
      const b = await body(req); const un = (b.username||"").trim(), pw = b.password||"";
      const u = db.users[un];
      if(!u || u.password !== pw) return send(res, 401, {error:"wrong username or password"});
      const t = newToken(); sessions.set(t, un);
      return send(res, 200, {username: un}, {"Set-Cookie": authCookie(t)});
    }
    if(p === "/api/logout" && req.method === "POST"){
      const sid = cookies(req).sid; if(sid) sessions.delete(sid);
      return send(res, 200, {ok:true}, {"Set-Cookie":"sid=; HttpOnly; Path=/; Max-Age=0"});
    }
    const un = userOf(req);
    if(!un) return send(res, 401, {error:"not logged in"});
    if(p === "/api/me") return send(res, 200, {username: un});
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
