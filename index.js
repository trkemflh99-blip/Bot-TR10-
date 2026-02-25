const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionsBitField
} = require("discord.js");

const express = require("express");
const sqlite3 = require("sqlite3").verbose();

// ================= ENV =================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;

// ================= DATABASE =================
const db = new sqlite3.Database("./data.db");

db.run(`
CREATE TABLE IF NOT EXISTS users (
  guild TEXT,
  user TEXT,
  xp INTEGER DEFAULT 0,
  level INTEGER DEFAULT 0,
  PRIMARY KEY (guild,user)
)`);

db.run(`
CREATE TABLE IF NOT EXISTS settings (
  guild TEXT PRIMARY KEY,
  congrats TEXT
)`);

db.run(`
CREATE TABLE IF NOT EXISTS levelroles (
  guild TEXT,
  level INTEGER,
  role TEXT
)`);

// ================= CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// ================= XP SYSTEM =================
client.on("messageCreate", async (msg) => {
  if (!msg.guild || msg.author.bot) return;

  const gid = msg.guild.id;
  const uid = msg.author.id;

  db.get(
    `SELECT * FROM users WHERE guild=? AND user=?`,
    [gid, uid],
    (err, row) => {
      if (!row) {
        db.run(`INSERT INTO users (guild,user,xp,level) VALUES (?,?,?,?)`,
          [gid, uid, 10, 0]);
      } else {
        let xp = row.xp + 10;
        let level = row.level;
        let needed = (level + 1) * 100;

        if (xp >= needed) {
          level++;
          xp = 0;

          db.all(
            `SELECT role FROM levelroles WHERE guild=? AND level=?`,
            [gid, level],
            async (err, roles) => {
              if (roles) {
                for (const r of roles) {
                  const role = msg.guild.roles.cache.get(r.role);
                  if (role) {
                    await msg.member.roles.add(role).catch(()=>{});
                  }
                }
              }
            }
          );

          db.get(
            `SELECT congrats FROM settings WHERE guild=?`,
            [gid],
            async (err, row2) => {
              if (row2 && row2.congrats) {
                const ch = msg.guild.channels.cache.get(row2.congrats);
                if (ch) ch.send(`🎉 ${msg.author} وصل لفل ${level}`);
              }
            }
          );
        }

        db.run(`UPDATE users SET xp=?, level=? WHERE guild=? AND user=?`,
          [xp, level, gid, uid]);
      }
    }
  );
});

// ================= SLASH COMMANDS =================
function buildCommands() {
  return [

    new SlashCommandBuilder()
      .setName("rank")
      .setDescription("عرض لفلك"),

    new SlashCommandBuilder()
      .setName("top")
      .setDescription("عرض التوب"),

    new SlashCommandBuilder()
      .setName("lock")
      .setDescription("قفل روم")
      .addChannelOption(o =>
        o.setName("room").setDescription("اختر روم").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("unlock")
      .setDescription("فتح روم")
      .addChannelOption(o =>
        o.setName("room").setDescription("اختر روم").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("set-congrats")
      .setDescription("تحديد روم التبريك")
      .addChannelOption(o =>
        o.setName("room").setDescription("اختر روم").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("set-level-role")
      .setDescription("ربط رتبة بمستوى")
      .addIntegerOption(o =>
        o.setName("level").setDescription("المستوى").setRequired(true)
      )
      .addRoleOption(o =>
        o.setName("role").setDescription("الرتبة").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("owner-sync")
      .setDescription("تحديث الأوامر (اونر فقط)")

  ].map(c => c.toJSON());
}

// ================= REGISTER =================
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationCommands(CLIENT_ID),
    { body: buildCommands() }
  );

  console.log("✅ Commands Registered");
}

// ================= INTERACTIONS =================
client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;

  const gid = i.guild.id;

  if (i.commandName === "rank") {
    db.get(
      `SELECT * FROM users WHERE guild=? AND user=?`,
      [gid, i.user.id],
      (err, row) => {
        if (!row) return i.reply("ما عندك بيانات");
        i.reply(`لفلك: ${row.level} | XP: ${row.xp}`);
      }
    );
  }

  if (i.commandName === "top") {
    db.all(
      `SELECT * FROM users WHERE guild=? ORDER BY level DESC LIMIT 5`,
      [gid],
      (err, rows) => {
        if (!rows) return i.reply("لا يوجد بيانات");
        let txt = "";
        rows.forEach((r, x) => {
          txt += `${x+1}- <@${r.user}> | Lv ${r.level}\n`;
        });
        i.reply(txt);
      }
    );
  }

  if (i.commandName === "lock") {
    const ch = i.options.getChannel("room");
    await ch.permissionOverwrites.edit(i.guild.roles.everyone, {
      SendMessages: false
    });
    i.reply("🔒 تم القفل");
  }

  if (i.commandName === "unlock") {
    const ch = i.options.getChannel("room");
    await ch.permissionOverwrites.edit(i.guild.roles.everyone, {
      SendMessages: true
    });
    i.reply("🔓 تم الفتح");
  }

  if (i.commandName === "set-congrats") {
    const ch = i.options.getChannel("room");
    db.run(`INSERT OR REPLACE INTO settings (guild,congrats) VALUES (?,?)`,
      [gid, ch.id]);
    i.reply("تم تحديد روم التبريك");
  }

  if (i.commandName === "set-level-role") {
    const level = i.options.getInteger("level");
    const role = i.options.getRole("role");

    db.run(`INSERT INTO levelroles (guild,level,role) VALUES (?,?,?)`,
      [gid, level, role.id]);

    i.reply("تم الربط");
  }

  if (i.commandName === "owner-sync") {
    if (i.user.id !== OWNER_ID)
      return i.reply("❌ ليس لك");

    await registerCommands();
    i.reply("تم التحديث");
  }
});

// ================= START =================
client.once("ready", () => {
  console.log("🔥 BOT READY");
});

client.login(TOKEN);
registerCommands();
