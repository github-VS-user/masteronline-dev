import { GameConstants, TeamMode } from "@common/constants";
import { Badges } from "@common/definitions/badges";
import { Skins } from "@common/definitions/items/skins";
import { CustomTeamMessage, PunishmentMessage } from "@common/typings";
import Cluster from "node:cluster";
import { URLSearchParams } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { version } from "../../package.json";
import { GameManager } from "./gameManager";
import { CustomTeam, CustomTeamPlayer, CustomTeamPlayerContainer } from "./team";
import { Config } from "./utils/config";
import { cleanUsername } from "./utils/misc";
import { corsHeaders, getIP, getPunishment, getSearchParams, parseRole, RateLimiter, serverError, serverLog } from "./utils/serverHelpers";

let customTeams: Map<string, CustomTeam> | undefined;
let teamsCreated: RateLimiter | undefined;

export function resetTeams(): void {
    if (!customTeams) return;

    for (const team of customTeams.values()) {
        for (const player of team.players) player.socket?.close();
    }
    customTeams.clear();
    teamsCreated?.reset();
}

declare global {
    var initialSetupComplete: boolean | undefined
}

if (Cluster.isPrimary && require.main === module) {
    //                   ^^^^^^^^^^^^^^^^^^^^^^^ only starts server if called directly from command line (not imported)

    // Cleans up workers from previous runs if the process is hot reloaded
    for (const worker of Object.values(Cluster.workers ?? {})) {
        worker?.kill();
    }

    const gameManager = new GameManager();

    // Stats store for dashboard
    const statsStore = {
        playerCounts: [] as { time: number; count: number }[],
        startTime: Date.now()
    };

    // Load persisted stats on startup
    try {
        const saved = JSON.parse(readFileSync("/opt/suroi/server/stats.json", "utf-8"));
        if (Array.isArray(saved)) {
            statsStore.playerCounts = saved.filter(
                (p: { time: number; count: number }) => p.time > Date.now() - 604800000
            );
            serverLog(`Loaded ${statsStore.playerCounts.length} stats entries from disk`);
        }
    } catch { /* no saved stats — start fresh */ }

    // Collect player counts every 60s
    setInterval(() => {
        statsStore.playerCounts.push({ time: Date.now(), count: gameManager.playerCount });
        if (statsStore.playerCounts.length > 10080) {
            statsStore.playerCounts = statsStore.playerCounts.slice(-10080);
        }
    }, 60000);

    // Persist stats every 5 minutes
    setInterval(() => {
        try {
            writeFileSync("/opt/suroi/server/stats.json", JSON.stringify(statsStore.playerCounts));
        } catch (e) {
            serverLog(`Failed to write stats.json: ${e}`);
        }
    }, 300000);

    // Prevents multiple loops from piling up if the process is hot reloaded
    if (!globalThis.initialSetupComplete) {
        let exiting = false;
        const exit = (): void => {
            if (exiting) return;
            exiting = true;
            serverLog("Shutting down...");
            for (const game of gameManager.games) {
                game?.worker.kill();
            }
            process.exit();
        };
        process.on("exit", exit);
        process.on("SIGINT", exit);
        process.on("SIGTERM", exit);
        process.on("SIGUSR2", exit);

        process.on("uncaughtException", e => {
            serverError("An unhandled error occurred. Details:", e);
            for (const game of gameManager.games) {
                game?.worker.kill();
            }
            process.exit(1);
        });

        setInterval(() => {
            const memoryUsage = process.memoryUsage().rss;

            let perfString = `RAM usage: ${Math.round(memoryUsage / 1024 / 1024 * 100) / 100} MB`;

            // windows L
            if (os.platform() !== "win32") {
                const load = os.loadavg().join("%, ");
                perfString += ` | CPU usage (1m, 5m, 15m): ${load}%`;
            }

            serverLog(perfString);

            gameManager.updateMapScaleRange();
        }, 60000);
    }
    globalThis.initialSetupComplete = true;

    customTeams = new Map<string, CustomTeam>();

    teamsCreated = Config.maxCustomTeams
        ? new RateLimiter(Config.maxCustomTeams)
        : undefined;

    const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Suroi Server Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;padding:2rem}
.banner{padding:.9rem 1.2rem;border-radius:8px;margin-bottom:1.5rem;font-weight:600;font-size:.95rem;display:flex;align-items:center;gap:.5rem}
.banner.healthy{background:rgba(35,134,54,.15);border:1px solid #238636;color:#3fb950}
.banner.warning{background:rgba(158,106,3,.15);border:1px solid #9e6a03;color:#d29922}
.banner.overloaded{background:rgba(248,81,73,.15);border:1px solid #f85149;color:#f85149}
h1{font-size:1.5rem;margin-bottom:1.5rem;color:#f0883e}
h1 span{color:#58a6ff;font-size:.9rem;font-weight:400}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:1.5rem}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.2rem;text-align:center}
.card .label{font-size:.8rem;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:.5rem}
.card .value{font-size:1.8rem;font-weight:700;color:#f0883e}
.card .value.blue{color:#58a6ff}
.card .status{font-size:.72rem;margin-top:.4rem;font-weight:600;display:inline-block;padding:2px 10px;border-radius:12px}
.status-ok{background:rgba(35,134,54,.2);color:#3fb950}
.status-warn{background:rgba(158,106,3,.2);color:#d29922}
.status-crit{background:rgba(248,81,73,.2);color:#f85149}
.capacity{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.2rem;margin-bottom:1.5rem}
.capacity h2{font-size:.85rem;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:.8rem}
.capacity .bar{height:8px;background:#21262d;border-radius:4px;overflow:hidden;margin-bottom:.5rem}
.capacity .bar-fill{height:100%;border-radius:4px;transition:width .5s}
.capacity .bar-fill.good{background:#238636}
.capacity .bar-fill.warn{background:#9e6a03}
.capacity .bar-fill.crit{background:#f85149}
.capacity .stats{display:flex;justify-content:space-between;font-size:.82rem}
.capacity .stats .pct{color:#f0883e;font-weight:700}
.summary{text-align:center;padding:.7rem;border-radius:6px;font-size:.82rem;margin-bottom:1.5rem}
.summary.ok{background:rgba(35,134,54,.1);border:1px solid #238636;color:#3fb950}
.summary.warn{background:rgba(158,106,3,.1);border:1px solid #9e6a03;color:#d29922}
.summary.crit{background:rgba(248,81,73,.1);border:1px solid #f85149;color:#f85149}
.stats-row{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:1.5rem;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.8rem}
.stats-row .stat-item{text-align:center}
.stats-row .stat-item .label{font-size:.72rem;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:.2rem}
.stats-row .stat-item .number{font-size:1.4rem;font-weight:700;color:#f0883e}
.stats-row .stat-item .number.blue{color:#58a6ff}
.footer{text-align:center;margin-top:1.5rem;font-size:.75rem;color:#484f58}
<\/style>
</head>
<body>
<div class="banner" id="banner">🟢 Checking...</div>
<h1>🎮 Suroi <span>@ online.master3d.net</span></h1>
<div class="cards">
<div class="card"><div class="label">Players Online</div><div class="value" id="players">-</div><div class="status" id="players-status"></div></div>
<div class="card"><div class="label">RAM Used</div><div class="value blue" id="ram">-</div><div class="status" id="ram-status"></div></div>
<div class="card"><div class="label">CPU Load</div><div class="value" id="cpu">-</div><div class="status" id="cpu-status"></div></div>
<div class="card"><div class="label">Uptime</div><div class="value blue" id="uptime">-</div></div>
</div>
<div class="capacity">
<h2>📊 Server Capacity</h2>
<div class="bar"><div class="bar-fill" id="cap-bar" style="width:0%"></div></div>
<div class="stats">
<span>Max recommended: <strong>~50</strong> players</span>
<span>Current: <strong id="cap-players">-</strong> (<span class="pct" id="cap-pct">-</span>%)</span>
<span id="cap-slots"></span>
</div>
</div>
<div class="summary" id="summary"></div>
<div class="stats-row">
<div class="stat-item"><div class="label">Peak (24h)</div><div class="number blue" id="peak24">-</div></div>
<div class="stat-item"><div class="label">Peak (7d)</div><div class="number" id="peak7d">-</div></div>
<div class="stat-item"><div class="label">Avg (24h)</div><div class="number blue" id="avg24">-</div></div>
</div>
<div class="footer" id="footer">Auto-refreshes every <span id="poll-interval">5</span>s <span id="poll-state"></span></div>
<script>
let pollTimer=null
const POLL_MS=5000
const MAX=50
function fmtUptime(s){const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d>0?d+'d '+h+'h '+m+'m':h>0?h+'h '+m+'m':m+'m '+s%60+'s'}
function fmtMB(b){return (b/1048576).toFixed(0)}
function fmtTime(t){return new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
function level(v,t){return v<t[0]?'ok':v<t[1]?'warn':'crit'}
function label(l,cls){return cls==='ok'?'\ud83d\udfe2 '+l:cls==='warn'?'\ud83d\udfe1 '+l:'\ud83d\udd34 '+l}
async function refresh(){
try{const r=await fetch('/server/api/stats');const d=await r.json()
const p=d.current.players,cpu=d.current.cpu,ramPct=d.current.memUsed/d.current.memTotal*100
const pc=Math.min(p/MAX*100,100)
const pLvl=level(p,[30,40]),cpuLvl=level(cpu,[50,80]),ramLvl=level(ramPct,[70,90])
const worst=[{l:pLvl},{l:cpuLvl},{l:ramLvl}];worst.sort((a,b)=>(a.l==='ok'?0:a.l==='warn'?1:2)-(b.l==='ok'?0:b.l==='warn'?1:2))
const wlvl=worst[2].l
const bn=document.getElementById('banner')
bn.className='banner '+wlvl
bn.innerHTML=wlvl==='ok'?'\ud83d\udfe2 Server Healthy — all systems normal':wlvl==='warn'?'\ud83d\udfe1 Server Under Load — monitor closely':'\ud83d\udd34 Server Overloaded — reduce load or restart'
document.getElementById('players').textContent=p
document.getElementById('players-status').textContent=label(pLvl==='ok'?'Light load':pLvl==='warn'?'Moderate load':'Heavy load',pLvl)
document.getElementById('players-status').className='status status-'+pLvl
document.getElementById('ram').textContent=fmtMB(d.current.memUsed)+' / '+fmtMB(d.current.memTotal)+' MB'
document.getElementById('ram-status').textContent=label(ramPct.toFixed(0)+'% used',ramLvl)
document.getElementById('ram-status').className='status status-'+ramLvl
document.getElementById('cpu').textContent=cpu.toFixed(1)+'%'
document.getElementById('cpu-status').textContent=label(cpuLvl==='ok'?'Low load':cpuLvl==='warn'?'Moderate load':'High load',cpuLvl)
document.getElementById('cpu-status').className='status status-'+cpuLvl
document.getElementById('uptime').textContent=fmtUptime(d.current.uptime)
const cb=document.getElementById('cap-bar');cb.style.width=pc+'%';cb.className='bar-fill '+(pc<60?'good':pc<80?'warn':'crit')
document.getElementById('cap-players').textContent=p
document.getElementById('cap-pct').textContent=pc.toFixed(0)
document.getElementById('cap-slots').textContent=p>=MAX?'Server at capacity':(MAX-p)+' slot'+(MAX-p!==1?'s':'')+' available'
const sm=document.getElementById('summary')
sm.className='summary '+wlvl
sm.innerHTML=wlvl==='ok'?'\u2705 Server is running smoothly \u2014 '+p+'/'+MAX+' players, CPU '+cpu.toFixed(0)+'%, RAM '+ramPct.toFixed(0)+'%'
:wlvl==='warn'?'\u26a0\ufe0f Server under load \u2014 '+p+'/'+MAX+' players, CPU '+cpu.toFixed(0)+'%, RAM '+ramPct.toFixed(0)+'%. Consider reducing graphics settings on clients.'
:'\ud83d\udd34 Server at capacity \u2014 '+p+'/'+MAX+' players, CPU '+cpu.toFixed(0)+'%, RAM '+ramPct.toFixed(0)+'%. New connections may be affected.'
const peak24=Math.max(...d.history24.map(p=>p.count),0)
const peak7d=Math.max(...d.history7d.map(p=>p.count),0)
const avg24=d.history24.length?Math.round(d.history24.reduce((s,p)=>s+p.count,0)/d.history24.length):0
document.getElementById('peak24').textContent=peak24
document.getElementById('peak7d').textContent=peak7d
document.getElementById('avg24').textContent=avg24
}catch(e){console.error(e)}}
function setPollState(v){const s=document.getElementById("poll-state");s.textContent=v?"\u25cf live":"(paused)";s.style.color=v?"#3fb950":"#8b949e"}
function startPoll(){if(pollTimer)clearInterval(pollTimer);pollTimer=setInterval(refresh,5000);setPollState(true)}
function stopPoll(){if(pollTimer){clearInterval(pollTimer);pollTimer=null}setPollState(false)}
refresh();startPoll()
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"){refresh();startPoll()}else{stopPoll()}})
<\/script>
</body>
</html>`;

    Bun.serve({
        hostname: Config.hostname,
        port: Config.port,
        routes: {
            "/server": () => new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html" } }),
            "/server/api/stats": () => {
                const now = Date.now();
                const hours24 = statsStore.playerCounts.filter(p => p.time > now - 86400000);
                const hours168 = statsStore.playerCounts.filter(p => p.time > now - 604800000);
                const downsample24 = hours24.filter((_, i) => i % 60 === 0 || i === hours24.length - 1);
                const downsample7d = hours168.filter((_, i) => i % 360 === 0 || i === hours168.length - 1);
                return Response.json({
                    current: {
                        players: gameManager.playerCount,
                        memUsed: process.memoryUsage().rss,
                        memTotal: os.totalmem(),
                        cpu: os.loadavg()[0],
                        uptime: Math.floor((now - statsStore.startTime) / 1000)
                    },
                    history24: downsample24,
                    history7d: downsample7d
                });
            },
            "/api/serverInfo": async(req, res) => {
                let punishment: PunishmentMessage | undefined;
                if (new URLSearchParams(req.url.slice(req.url.indexOf("?"))).get("checkPunishments") === "true") {
                    punishment = await getPunishment(getIP(req, res));
                }

                const { playerCount, teamMode, map, mode, nextMode } = gameManager;

                return Response.json({
                    protocolVersion: GameConstants.protocolVersion,
                    playerCount,
                    teamMode: teamMode.current,
                    nextTeamMode: teamMode.next,
                    teamModeSwitchTime: teamMode.nextSwitch ? teamMode.nextSwitch - Date.now() : undefined,
                    mode,
                    nextMode,
                    modeSwitchTime: map.nextSwitch ? map.nextSwitch - Date.now() : undefined,
                    punishment
                }, corsHeaders);
            },
            "/api/getGame": async req => {
                serverLog(`[/api/getGame] Request received from ${req.url}`);
                let gameID: number | undefined;
                const teamID = gameManager.teamMode.current !== TeamMode.Solo && getSearchParams(req).get("teamID");
                if (teamID) {
                    gameID = customTeams?.get(teamID)?.gameID;
                    serverLog(`[/api/getGame] teamID=${teamID} resolved to gameID=${gameID}`);
                } else {
                    gameID = await gameManager.findGame();
                    serverLog(`[/api/getGame] findGame returned gameID=${gameID}`);
                }

                if (gameID === undefined) {
                    serverLog(`[/api/getGame] FAILED: no game available (playerCount=${gameManager.playerCount})`);
                } else {
                    serverLog(`[/api/getGame] SUCCESS: returning gameID=${gameID} mode=${gameManager.mode}`);
                }

                return Response.json(
                    gameID !== undefined
                        ? { success: true, gameID, mode: gameManager.mode }
                        : { success: false },
                    corsHeaders
                );
            },
            "/team": async(req, res) => {
                const ip = getIP(req, res);
                const searchParams = getSearchParams(req);
                let punishmentMessage: string | undefined;

                // Prevent connection if team is full or punishments active
                if (
                    teamsCreated?.isLimited(ip)
                    || (punishmentMessage = (await getPunishment(ip))?.message) && punishmentMessage !== "noname"
                ) {
                    return new Response("403 Forbidden");
                }

                // Get team
                const teamID = searchParams.get("teamID");
                let team: CustomTeam;
                if (teamID !== null) {
                    const givenTeam = customTeams?.get(teamID);
                    if (!givenTeam || givenTeam.locked || givenTeam.players.length >= 4) {
                        return new Response("403 Forbidden"); // TODO "Team is locked" and "Team is full" messages
                    }
                    team = givenTeam;
                } else {
                    team = new CustomTeam(gameManager);
                    customTeams?.set(team.id, team);
                }

                // Get name, skin, badge, & role
                const name = punishmentMessage === "noname" ? GameConstants.player.defaultName : cleanUsername(searchParams.get("name"));
                let skin = searchParams.get("skin") ?? GameConstants.player.defaultSkin;
                let badge = searchParams.get("badge") ?? undefined;
                const { role = "", nameColor } = parseRole(searchParams);

                // Validate skin
                const skinDefinition = Skins.fromStringSafe(skin);
                const rolesRequired = skinDefinition?.rolesRequired;
                if (!skinDefinition || (rolesRequired && !rolesRequired.includes(role))) {
                    skin = GameConstants.player.defaultSkin;
                }

                // Validate badge
                const badgeDefinition = badge ? Badges.fromStringSafe(badge) : undefined;
                if (!badgeDefinition || (badgeDefinition.roles && !badgeDefinition.roles.includes(role))) {
                    badge = undefined;
                }

                // Upgrade the connection
                res.upgrade(req, {
                    data: { player: new CustomTeamPlayer(ip, team, name, skin, badge, nameColor) }
                });
            }
        },
        websocket: {
            idleTimeout: 960,
            open(socket: Bun.ServerWebSocket<CustomTeamPlayerContainer>) {
                const { player } = socket.data;
                player.socket = socket;
                player.team.addPlayer(player);
            },

            message(socket: Bun.ServerWebSocket<CustomTeamPlayerContainer>, message: Buffer) {
                try {
                    const { player } = socket.data;
                    void player.team.onMessage(player, JSON.parse(String(message)) as CustomTeamMessage);
                } catch (e) {
                    serverError("Error parsing team socket message. Details:", e);
                }
            },

            close(socket: Bun.ServerWebSocket<CustomTeamPlayerContainer>) {
                const { player } = socket.data;
                const team = player.team;
                team.removePlayer(player);
                if (!team.players.length) {
                    customTeams?.delete(team.id);
                }
                teamsCreated?.decrement(player.ip);
            }
        }
    });

    process.stdout.write("\x1Bc"); // clears screen
    serverLog(`Suroi Server v${version}`);
    serverLog(`Listening on ${Config.hostname}:${Config.port}`);
    serverLog("Press Ctrl+C to exit.");

    void gameManager.newGame(0);
}
