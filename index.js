// ==========================
// ✅ TR10 PRO XP (Text + Voice) + Daily/Weekly/Total + Congrats Channel
// - Prefix commands: xp / xp day / xp week / xp all
// - Voice split: xp v day|week|all
// - Text split:  xp t day|week|all
// - Voice counts even if mic muted (and يسجل دقائق مفتوح/مقفل)
// - Level roles rewards
// - Set congrats channel + custom congrats message
// - Admin tools: addxp, setlevel, resetxp, lock/unlock, setlevelrole
// - KeepAlive Web server for hosting
// ==========================

const fs = require("fs");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
} = require("discord.js");

// ====== KEEPALIVE WEB ======
const app = express();
app.get("/", (req, res) => res.status(200).send("Bot alive ✅"));
app.get("/health", (req, res) => res.json({ ok: true, time: Date.now() }));
app.listen(process.env.PORT || 3000, () =>
  console.log("🌐 Web server running on", process.env.PORT || 3000)
);

// ====== ENV ======
const TOKEN = process.env.TOKEN;
const OWNER_ID = process.env.OWNER_ID || ""; // اختياري (إذا حطيته يصير الأوامر الحساسة للمالك فقط)

if (!TOKEN) {
  console.log("❌ ضع TOKEN في Environment Variables / Secrets");
  process.exit(1);
}

// ====== FILES ======
const DB_FILE = "levels.json";
const CFG_FILE = "config.json";

if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "{}");
if (!fs.existsSync(CFG_FILE)) fs.writeFileSync(CFG_FILE, "{}");

function loadJSON(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
function saveJSON(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2));
}

let db = loadJSON(DB_FILE);
let cfg = loadJSON(CFG_FILE);

// ====== HELPERS ======
const keyOf = (gid, uid) => `${gid}:${uid}`;

function pad2(n) {
  return String(n).padStart(2, "0");
}
function dayKeyNow() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function weekKeyNow() {
  // ISO-like week key: YYYY-W##
  const d = new Date();
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad2(weekNo)}`;
}

function ensureUser(gid, uid) {
  const k = keyOf(gid, uid);
  if (!db[k]) {
    db[k] = {
      level: 1,

      // totals
      textTotal: 0,
      voiceTotal: 0,

      // daily
      textDay: 0,
      voiceDay: 0,

      // weekly
      textWeek: 0,
      voiceWeek: 0,

      // progress XP for leveling (we level by total XP gained, but keep "carry" as curXP)
      curXP: 0,

      // cooldown
      lastMsgAt: 0,

      // voice minutes
      voiceMinsTotal: 0,
      voiceMinsMuted: 0,
      voiceMinsOpen: 0,

      // keys
      dayKey: dayKeyNow(),
      weekKey: weekKeyNow(),
    };
  }

  // reset day/week counters if date changed
  const u = db[k];
  const dk = dayKeyNow();
  const wk = weekKeyNow();

  if (u.dayKey !== dk) {
    u.dayKey = dk;
    u.textDay = 0;
    u.voiceDay = 0;
  }
  if (u.weekKey !== wk) {
    u.weekKey = wk;
    u.textWeek = 0;
    u.voiceWeek = 0;
  }

  return u;
}

function xpToNext(level) {
  // بسيطة وواضحة
  return 120 + (level - 1) * 40;
}

function isOwnerOrAdmin(member) {
  if (!member) return false;
  if (OWNER_ID && member.id === OWNER_ID) return true;
  return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

function getGuildConfig(gid) {
  if (!cfg[gid]) {
    cfg[gid] = {
      prefix: "xp",
      congratsChannelId: "",
      congratsMessage: "🎉 {user} وصل مستوى **{level}**! 🔥",
      levelRoles: {}, // { "5": "ROLE_ID" }
    };
  }
  return cfg[gid];
}

function formatCongrats(tpl, userMention, level) {
  return String(tpl)
    .replaceAll("{user}", userMention)
    .replaceAll("{level}", String(level));
}

function totalXP(u) {
  return (u.textTotal || 0) + (u.voiceTotal || 0);
}

function modeXP(u, mode) {
  // mode: all | t | v
  if (mode === "t") return u.textTotal || 0;
  if (mode === "v") return u.voiceTotal || 0;
  return totalXP(u);
}
function modeXPDay(u, mode) {
  if (mode === "t") return u.textDay || 0;
  if (mode === "v") return u.voiceDay || 0;
  return (u.textDay || 0) + (u.voiceDay || 0);
}
function modeXPWeek(u, mode) {
  if (mode === "t") return u.textWeek || 0;
  if (mode === "v") return u.voiceWeek || 0;
  return (u.textWeek || 0) + (u.voiceWeek || 0);
}

async function handleLevelUp(client, guild, member, newLevel) {
  const gcfg = getGuildConfig(guild.id);

  // level role reward
  const roleId = gcfg.levelRoles?.[String(newLevel)];
  if (roleId) {
    const role = guild.roles.cache.get(roleId);
    if (role && member) {
      member.roles.add(role).catch(() => {});
    }
  }

  // congrats channel
  const msg = formatCongrats(gcfg.congratsMessage, `<@${member.id}>`, newLevel);

  const chId = gcfg.congratsChannelId;
  if (chId) {
    const ch = guild.channels.cache.get(chId);
    if (ch && ch.isTextBased()) {
      ch.send(msg).catch(() => {});
      return;
    }
  }

  // fallback
  const sys = guild.systemChannel;
  if (sys && sys.isTextBased()) sys.send(msg).catch(() => {});
}

// ====== CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,      // لازم تفعلها من البوت!
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

// ====== XP SETTINGS ======
const CHAT_MIN = 8;
const CHAT_MAX = 16;
const CHAT_COOLDOWN_SEC = 35;

const VOICE_XP_PER_MIN = 6; // يعطي XP حتى لو مقفل المايك

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ====== CHAT XP + PREFIX COMMANDS ======
client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild || msg.author.bot) return;

    const gcfg = getGuildConfig(msg.guild.id);
    const prefix = (gcfg.prefix || "xp").toLowerCase();

    const content = msg.content.trim();

    // ====== PREFIX COMMANDS (xp ...) ======
    // Examples:
    // xp
    // xp day
    // xp week
    // xp all
    // xp v day
    // xp t week
    // لفلي  (alias)
    const lower = content.toLowerCase();

    const isAliasLevel =
      lower === "لفلي" ||
      lower === "رتبتي" ||
      lower === "rank" ||
      lower === "xp";

    const startsWithPrefix = lower.startsWith(prefix + " ") || lower === prefix;

    if (startsWithPrefix || isAliasLevel) {
      // Parse tokens
      const tokens = startsWithPrefix
        ? lower.split(/\s+/) // starts with prefix
        : ["xp"]; // alias acts like xp

      // tokens[0] is prefix
      // possible patterns:
      // xp
      // xp day|week|all
      // xp v|t day|week|all
      // admin: xp addxp @user 50
      // admin: xp setlevel @user 10
      // admin: xp resetxp all OR xp resetxp @user
      // admin: xp setcongrats #channel
      // admin: xp setcongratsmsg ....
      // admin: xp lock / xp unlock
      // admin: xp setlevelrole 5 @role
      // admin: xp removelevelrole 5
      // admin: xp listlevelroles
      // admin: xp setprefix newprefix

      const sub1 = tokens[1] || "";

      // ====== ADMIN COMMANDS ======
      const member = msg.member;

      // xp setprefix new
      if (sub1 === "setprefix") {
        if (!isOwnerOrAdmin(member)) return msg.reply("⛔ هذا الأمر للإدارة/الاونر فقط.");
        const newP = tokens[2];
        if (!newP) return msg.reply("اكتب: `xp setprefix <كلمة>`");
        gcfg.prefix = newP;
        cfg[msg.guild.id] = gcfg;
        saveJSON(CFG_FILE, cfg);
        return msg.reply(`✅ تم تغيير البريفكس إلى: **${newP}**`);
      }

      // xp setcongrats #channel
      if (sub1 === "setcongrats") {
        if (!isOwnerOrAdmin(member)) return msg.reply("⛔ هذا الأمر للإدارة/الاونر فقط.");
        const ch = msg.mentions.channels.first();
        if (!ch) return msg.reply("اكتب: `xp setcongrats #channel`");
        gcfg.congratsChannelId = ch.id;
        cfg[msg.guild.id] = gcfg;
        saveJSON(CFG_FILE, cfg);
        return msg.reply(`✅ تم تحديد روم التبريكات: ${ch}`);
      }

      // xp setcongratsmsg ....
      if (sub1 === "setcongratsmsg") {
        if (!isOwnerOrAdmin(member)) return msg.reply("⛔ هذا الأمر للإدارة/الاونر فقط.");
        const raw = content.split(/\s+/).slice(2).join(" ").trim();
        if (!raw) {
          return msg.reply(
            "اكتب: `xp setcongratsmsg <الجملة>`\nمثال: `xp setcongratsmsg 🎉 {user} وصل مستوى {level}!`"
          );
        }
        gcfg.congratsMessage = raw;
        cfg[msg.guild.id] = gcfg;
        saveJSON(CFG_FILE, cfg);
        return msg.reply("✅ تم حفظ جملة التبريكات.");
      }

      // xp lock / xp unlock (يقفل/يفتح الروم الحالي للكل)
      if (sub1 === "lock" || sub1 === "unlock") {
        if (!isOwnerOrAdmin(member)) return msg.reply("⛔ هذا الأمر للإدارة/الاونر فقط.");
        const ch = msg.channel;
        if (!ch || !ch.isTextBased()) return;
        const deny = sub1 === "lock";
        await ch.permissionOverwrites.edit(msg.guild.roles.everyone, {
          SendMessages: deny ? false : null,
        }).catch(() => {});
        return msg.reply(deny ? "🔒 تم قفل الروم." : "🔓 تم فتح الروم.");
      }

      // xp setlevelrole 5 @role
      if (sub1 === "setlevelrole") {
        if (!isOwnerOrAdmin(member)) return msg.reply("⛔ هذا الأمر للإدارة/الاونر فقط.");
        const lvl = parseInt(tokens[2], 10);
        const role = msg.mentions.roles.first();
        if (!lvl || lvl < 1 || !role) return msg.reply("اكتب: `xp setlevelrole <level> @role`");
        gcfg.levelRoles[String(lvl)] = role.id;
        cfg[msg.guild.id] = gcfg;
        saveJSON(CFG_FILE, cfg);
        return msg.reply(`✅ عند مستوى **${lvl}** ياخذ رتبة: ${role}`);
      }

      // xp removelevelrole 5
      if (sub1 === "removelevelrole") {
        if (!isOwnerOrAdmin(member)) return msg.reply("⛔ هذا الأمر للإدارة/الاونر فقط.");
        const lvl = parseInt(tokens[2], 10);
        if (!lvl || lvl < 1) return msg.reply("اكتب: `xp removelevelrole <level>`");
        delete gcfg.levelRoles[String(lvl)];
        cfg[msg.guild.id] = gcfg;
        saveJSON(CFG_FILE, cfg);
        return msg.reply(`✅ تم حذف رتبة مستوى **${lvl}**`);
      }

      // xp listlevelroles
      if (sub1 === "listlevelroles") {
        const map = gcfg.levelRoles || {};
        const entries = Object.entries(map).sort((a, b) => Number(a[0]) - Number(b[0]));
        if (!entries.length) return msg.reply("ما فيه رتب مربوطة بالمستويات.");
        const lines = entries.map(([lvl, rid]) => `Lv ${lvl} → <@&${rid}>`);
        return msg.reply("📌 رتب المستويات:\n" + lines.join("\n"));
      }

      // xp addxp @user 50 [t|v|all]
      if (sub1 === "addxp") {
        if (!isOwnerOrAdmin(member)) return msg.reply("⛔ هذا الأمر للإدارة/الاونر فقط.");
        const user = msg.mentions.users.first();
        const amount = parseInt(tokens[3], 10);
        const mode = (tokens[4] || "all").toLowerCase(); // t/v/all
        if (!user || !amount) return msg.reply("اكتب: `xp addxp @user <amount> [t|v|all]`");

        const u = ensureUser(msg.guild.id, user.id);
        if (mode === "t") {
          u.textTotal += amount; u.textDay += amount; u.textWeek += amount;
        } else if (mode === "v") {
          u.voiceTotal += amount; u.voiceDay += amount; u.voiceWeek += amount;
        } else {
          // all -> split to curXP only, but keep totals as total bucket
          u.textTotal += amount; u.textDay += amount; u.textWeek += amount;
        }

        u.curXP += amount;

        while (u.curXP >= xpToNext(u.level)) {
          u.curXP -= xpToNext(u.level);
          u.level += 1;
          const m = await msg.guild.members.fetch(user.id).catch(() => null);
          if (m) await handleLevelUp(client, msg.guild, m, u.level);
        }

        saveJSON(DB_FILE, db);
        return msg.reply(`✅ تمت إضافة **${amount} XP** لـ ${user} (Lv ${u.level})`);
      }

      // xp setlevel @user 10
      if (sub1 === "setlevel") {
        if (!isOwnerOrAdmin(member)) return msg.reply("⛔ هذا الأمر للإدارة/الاونر فقط.");
        const user = msg.mentions.users.first();
        const lvl = parseInt(tokens[3], 10);
        if (!user || !lvl || lvl < 1) return msg.reply("اكتب: `xp setlevel @user <level>`");
        const u = ensureUser(msg.guild.id, user.id);
        u.level = lvl;
        u.curXP = 0;
        saveJSON(DB_FILE, db);
        return msg.reply(`🔥 تم تحديد مستوى ${user} إلى **${lvl}**`);
      }

      // xp resetxp all OR xp resetxp @user
      if (sub1 === "resetxp") {
        if (!isOwnerOrAdmin(member)) return msg.reply("⛔ هذا الأمر للإدارة/الاونر فقط.");
        const targetAll = tokens[2] === "all" || tokens[2] === "server";
        const targetUser = msg.mentions.users.first();

        if (!targetAll && !targetUser) {
          return msg.reply("اكتب: `xp resetxp all` أو `xp resetxp @user`");
        }

        if (targetAll) {
          const gid = msg.guild.id;
          for (const k of Object.keys(db)) {
            if (k.startsWith(gid + ":")) delete db[k];
          }
          saveJSON(DB_FILE, db);
          return msg.reply("🧹 تم تصفير XP للسيرفر بالكامل.");
        } else {
          const k = keyOf(msg.guild.id, targetUser.id);
          delete db[k];
          saveJSON(DB_FILE, db);
          return msg.reply(`🧹 تم تصفير XP لـ ${targetUser}`);
        }
      }

      // ====== USER COMMANDS ======
      // parse mode/time
      // xp -> total
      // xp day/week/all
      // xp v day/week/all
      // xp t day/week/all

      let mode = "all"; // all | v | t
      let time = "now"; // now | day | week | all

      if (sub1 === "v" || sub1 === "t") {
        mode = sub1;
        time = (tokens[2] || "now").toLowerCase();
      } else if (sub1) {
        time = sub1;
      }

      const u = ensureUser(msg.guild.id, msg.author.id);
      const next = xpToNext(u.level);

      const vOpen = u.voiceMinsOpen || 0;
      const vMuted = u.voiceMinsMuted || 0;
      const vTotalMins = u.voiceMinsTotal || 0;

      function xpValue() {
        if (time === "day") return modeXPDay(u, mode);
        if (time === "week") return modeXPWeek(u, mode);
        if (time === "all") return modeXP(u, mode);
        // default: show level progress by curXP + totals
        return modeXP(u, mode);
      }

      // Show cards
      if (time === "day" || time === "week" || time === "all") {
        const titleMode = mode === "v" ? "🎧 صوتي" : mode === "t" ? "💬 دردشة" : "✨ الكل";
        const titleTime = time === "day" ? "اليومي" : time === "week" ? "الأسبوعي" : "الكلي";
        return msg.reply(
          `📊 **XP ${titleMode} — ${titleTime}**\n` +
          `• **${xpValue()} XP**\n` +
          (mode === "v"
            ? `• 🎙️ دقائق صوتي: **${vTotalMins}** (مفتوح: **${vOpen}** / مقفل: **${vMuted}**)`
            : "")
        );
      }

      // default: full rank view
      const totalAll = totalXP(u);
      return msg.reply(
        `🏅 **${msg.author.username}**\n` +
        `• المستوى: **${u.level}**\n` +
        `• التقدم: **${u.curXP}/${next} XP**\n` +
        `• الكلي: **${totalAll} XP** (💬 ${u.textTotal || 0} / 🎧 ${u.voiceTotal || 0})\n` +
        `• 🎙️ دقائق صوتي: **${vTotalMins}** (مفتوح: **${vOpen}** / مقفل: **${vMuted}**)`
      );
    }

    // ====== NORMAL CHAT XP ======
    const u = ensureUser(msg.guild.id, msg.author.id);
    const now = Date.now();
    if (now - (u.lastMsgAt || 0) < CHAT_COOLDOWN_SEC * 1000) return;
    u.lastMsgAt = now;

    const add = rand(CHAT_MIN, CHAT_MAX);

    u.textTotal += add;
    u.textDay += add;
    u.textWeek += add;

    u.curXP += add;

    let leveled = false;
    while (u.curXP >= xpToNext(u.level)) {
      u.curXP -= xpToNext(u.level);
      u.level += 1;
      leveled = true;
    }

    saveJSON(DB_FILE, db);

    if (leveled) {
      const m = await msg.guild.members.fetch(msg.author.id).catch(() => null);
      if (m) await handleLevelUp(client, msg.guild, m, u.level);
    }
  } catch (e) {
    // ignore
  }
});

// ====== VOICE TRACKING ======
const voiceSetByGuild = new Map(); // gid -> Set(uid)
function getVoiceSet(gid) {
  if (!voiceSetByGuild.has(gid)) voiceSetByGuild.set(gid, new Set());
  return voiceSetByGuild.get(gid);
}

client.on("voiceStateUpdate", (oldS, newS) => {
  const gid = newS.guild.id;
  const set = getVoiceSet(gid);

  const userId = newS.id;
  if (newS.member?.user?.bot) return;

  const nowInVoice = !!newS.channelId;
  const beforeInVoice = !!oldS.channelId;

  if (!beforeInVoice && nowInVoice) set.add(userId);
  if (beforeInVoice && !nowInVoice) set.delete(userId);
});

// كل دقيقة نعطي XP للي بالصوتي (حتى لو المايك مقفل)
setInterval(async () => {
  try {
    for (const [gid, set] of voiceSetByGuild.entries()) {
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;

      for (const userId of set) {
        const u = ensureUser(gid, userId);

        // حاول نجيب العضو
        let member = guild.members.cache.get(userId);
        if (!member) member = await guild.members.fetch(userId).catch(() => null);
        if (!member) continue;

        // إذا ما عاد في روم صوتي فعلياً، شيله
        if (!member.voice?.channelId) continue;

        // سجل دقائق صوتي مفتوح/مقفل (selfMute)
        u.voiceMinsTotal = (u.voiceMinsTotal || 0) + 1;
        if (member.voice.selfMute) u.voiceMinsMuted = (u.voiceMinsMuted || 0) + 1;
        else u.voiceMinsOpen = (u.voiceMinsOpen || 0) + 1;

        // XP صوتي
        u.voiceTotal += VOICE_XP_PER_MIN;
        u.voiceDay += VOICE_XP_PER_MIN;
        u.voiceWeek += VOICE_XP_PER_MIN;

        u.curXP += VOICE_XP_PER_MIN;

        let leveled = false;
        while (u.curXP >= xpToNext(u.level)) {
          u.curXP -= xpToNext(u.level);
          u.level += 1;
          leveled = true;
        }

        if (leveled) {
          await handleLevelUp(client, guild, member, u.level);
        }
      }
    }
    saveJSON(DB_FILE, db);
  } catch (e) {
    // ignore
  }
}, 60 * 1000);

// ====== READY ======
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log("✅ Prefix default: xp (تقدر تغيره: xp setprefix <كلمة>)");
});

client.login(TOKEN);
