/**
 * TR10 NUCLEAR - ONE FILE (FIXED)
 * discord.js v14 + sqlite3
 * Global slash commands
 */

const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder
} = require("discord.js");

const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

// ===================== ENV =====================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID || "910264482444480562";
const TZ = "Asia/Riyadh";

if (!TOKEN || !CLIENT_ID) {
  console.error("❌ Missing TOKEN or CLIENT_ID in env/secrets.");
  process.exit(1);
}

// ===================== CLIENT =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

// ===================== DB =====================
let db;

async function initDB() {
  db = await open({ filename: "./tr10.sqlite", driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      guild_id TEXT,
      user_id TEXT,
      text_total INTEGER DEFAULT 0,
      voice_total INTEGER DEFAULT 0,
      text_week INTEGER DEFAULT 0,
      voice_week INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      guild_id TEXT PRIMARY KEY,
      congrats_channel_id TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS level_roles (
      guild_id TEXT,
      level INTEGER,
      role_id TEXT,
      PRIMARY KEY (guild_id, level)
    );

    CREATE TABLE IF NOT EXISTS autoreplies (
      guild_id TEXT,
      trigger TEXT,
      reply TEXT,
      PRIMARY KEY (guild_id, trigger)
    );
  `);

  console.log("✅ Database Ready");
}

async function ensureUser(gid, uid) {
  let row = await db.get(
    `SELECT * FROM users WHERE guild_id = ? AND user_id = ?`,
    [gid, uid]
  );

  if (!row) {
    await db.run(`INSERT INTO users (guild_id, user_id) VALUES (?, ?)`, [
      gid,
      uid
    ]);
    row = await db.get(
      `SELECT * FROM users WHERE guild_id = ? AND user_id = ?`,
      [gid, uid]
    );
  }

  return row;
}

async function ensureSettings(gid) {
  let row = await db.get(`SELECT * FROM settings WHERE guild_id = ?`, [gid]);

  if (!row) {
    await db.run(`INSERT INTO settings (guild_id) VALUES (?)`, [gid]);
    row = await db.get(`SELECT * FROM settings WHERE guild_id = ?`, [gid]);
  }

  return row;
}

// ===================== LEVEL SYSTEM =====================
function requiredXP(level) {
  return level * 200;
}

async function maybeLevelUp(gid, uid) {
  const row = await ensureUser(gid, uid);
  const total = row.text_total + row.voice_total;

  let newLevel = row.level;
  let leveled = false;

  while (total >= requiredXP(newLevel)) {
    newLevel++;
    leveled = true;
  }

  if (!leveled) return;

  await db.run(
    `UPDATE users SET level = ? WHERE guild_id = ? AND user_id = ?`,
    [newLevel, gid, uid]
  );

  // Give roles for levels passed
  for (let lvl = row.level + 1; lvl <= newLevel; lvl++) {
    const lr = await db.get(
      `SELECT role_id FROM level_roles WHERE guild_id = ? AND level = ?`,
      [gid, lvl]
    );

    if (lr?.role_id) {
      try {
        const guild = await client.guilds.fetch(gid);
        const member = await guild.members.fetch(uid);
        await member.roles.add(lr.role_id).catch(() => {});
      } catch {}
    }
  }

  // Congrats channel
  try {
    const settings = await ensureSettings(gid);
    if (settings?.congrats_channel_id) {
      const ch = await client.channels.fetch(settings.congrats_channel_id).catch(() => null);
      if (ch && ch.isTextBased()) {
        ch.send(`🎉 <@${uid}> وصلت لفل **${newLevel}**!`).catch(() => {});
      }
    }
  } catch {}
}

// ===================== TEXT XP + AUTOREPLY =====================
client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild || msg.author.bot) return;

    const gid = msg.guild.id;
    const uid = msg.author.id;

    const content = (msg.content || "").trim();
    if (content) {
      const ar = await db.get(
        `SELECT reply FROM autoreplies WHERE guild_id = ? AND trigger = ?`,
        [gid, content.toLowerCase()]
      );
      if (ar?.reply) msg.reply(ar.reply).catch(() => {});
    }

    await ensureUser(gid, uid);

    await db.run(
      `UPDATE users
       SET text_total = text_total + 5,
           text_week = text_week + 5
       WHERE guild_id = ? AND user_id = ?`,
      [gid, uid]
    );

    await maybeLevelUp(gid, uid);
  } catch (e) {
    console.log("messageCreate error:", e?.message);
  }
});

// ===================== VOICE XP =====================
const voiceIntervals = new Map();

function vKey(gid, uid) {
  return `${gid}:${uid}`;
}

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const gid = member.guild.id;
    const uid = member.id;

    const wasIn = !!oldState.channelId;
    const isIn = !!newState.channelId;

    const key = vKey(gid, uid);

    if (!wasIn && isIn) {
      if (voiceIntervals.has(key)) return;

      const intervalId = setInterval(async () => {
        try {
          const guild = client.guilds.cache.get(gid);
          const m = guild?.members.cache.get(uid);
          const stillIn = m?.voice?.channelId;

          if (!stillIn) {
            clearInterval(intervalId);
            voiceIntervals.delete(key);
            return;
          }

          await ensureUser(gid, uid);

          await db.run(
            `UPDATE users
             SET voice_total = voice_total + 10,
                 voice_week = voice_week + 10
             WHERE guild_id = ? AND user_id = ?`,
            [gid, uid]
          );

          await maybeLevelUp(gid, uid);
        } catch {}
      }, 60_000);

      voiceIntervals.set(key, intervalId);
    }

    if (wasIn && !isIn) {
      const intervalId = voiceIntervals.get(key);
      if (intervalId) clearInterval(intervalId);
      voiceIntervals.delete(key);
    }
  } catch (e) {
    console.log("voiceStateUpdate error:", e?.message);
  }
});

// ===================== WEEKLY RESET =====================
let lastWeeklyResetKey = null;

setInterval(async () => {
  try {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));

    const day = now.getDay();
    const hh = now.getHours();
    const mm = now.getMinutes();
    const key = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

    if (day === 0 && hh === 0 && mm === 0 && lastWeeklyResetKey !== key) {
      await db.run(`UPDATE users SET text_week = 0, voice_week = 0`);
      lastWeeklyResetKey = key;
      console.log("🧹 Weekly Reset Done");
    }
  } catch {}
}, 60_000);

// ===================== SLASH COMMANDS =====================
const commandBuilders = [
  new SlashCommandBuilder().setName("help").setDescription("عرض جميع الأوامر"),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("عرض رانكك أو رانك عضو")
    .addUserOption((o) =>
      o.setName("user").setDescription("اختر العضو").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("top")
    .setDescription("عرض التوب")
    .addStringOption((o) =>
      o
        .setName("type")
        .setDescription("نوع التوب")
        .setRequired(true)
        .addChoices(
          { name: "كتابي", value: "text" },
          { name: "صوتي", value: "voice" },
          { name: "الإجمالي", value: "all" },
          { name: "كتابي-أسبوعي", value: "text_week" },
          { name: "صوتي-أسبوعي", value: "voice_week" }
        )
    ),

  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("قفل الروم الحالي")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("فتح الروم الحالي")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

  new SlashCommandBuilder()
    .setName("set-congrats")
    .setDescription("تحديد روم التهنئة عند رفع اللفل")
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("اختر الروم")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("set-level-role")
    .setDescription("ربط رتبة بلفل معين")
    .addIntegerOption((o) =>
      o.setName("level").setDescription("رقم اللفل").setRequired(true)
    )
    .addRoleOption((o) =>
      o.setName("role").setDescription("اختر الرتبة").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),

  new SlashCommandBuilder()
    .setName("autoreply-add")
    .setDescription("إضافة رد تلقائي")
    .addStringOption((o) =>
      o.setName("trigger").setDescription("الكلمة/الجملة").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("reply").setDescription("الرد").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("autoreply-remove")
    .setDescription("حذف رد تلقائي")
    .addStringOption((o) =>
      o.setName("trigger").setDescription("الكلمة/الجملة").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("autoreply-list")
    .setDescription("عرض الردود التلقائية")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("owner-reset-user")
    .setDescription("تصفير عضو كامل (أونر فقط)")
    .addUserOption((o) =>
      o.setName("user").setDescription("اختر العضو").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("owner-reset-guild")
    .setDescription("تصفير السيرفر كامل (أونر فقط)"),

  new SlashCommandBuilder()
    .setName("owner-sync")
    .setDescription("تحديث/مزامنة الأوامر (أونر فقط)")
];

const commandsJSON = commandBuilders.map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandsJSON });
  console.log("✅ Global Commands Synced");
}

// ===================== INTERACTIONS (FIXED REPLY LOGIC) =====================
client.on("interactionCreate", async (i) => {
  try {
    if (!i.isChatInputCommand()) return;

    // أهم سطر: نرد بسرعة حتى ما يطلع "The application did not respond"
    await i.deferReply({ ephemeral: false });

    const gid = i.guildId;
    const isOwner = i.user.id === OWNER_ID;

    if (i.commandName === "help") {
      const embed = new EmbedBuilder()
        .setTitle("🔥 TR10 NUCLEAR")
        .setDescription(
          [
            "**الأوامر العامة:**",
            "/rank",
            "/top",
            "",
            "**الإدارية:**",
            "/lock",
            "/unlock",
            "/set-congrats",
            "/set-level-role",
            "/autoreply-add",
            "/autoreply-remove",
            "/autoreply-list",
            "",
            "**أوامر الأونر:**",
            "/owner-reset-user",
            "/owner-reset-guild",
            "/owner-sync"
          ].join("\n")
        );

      return i.editReply({ embeds: [embed] });
    }

    if (i.commandName === "rank") {
      const user = i.options.getUser("user") || i.user;
      const row = await ensureUser(gid, user.id);

      const total = row.text_total + row.voice_total;
      const nextAt = requiredXP(row.level);

      return i.editReply({
        content:
`👑 TR10 RANK

👤 ${user}
📖 الكتابي: ${row.text_total} XP
🎙️ الصوتي: ${row.voice_total} XP
🏆 الإجمالي: ${total} XP
🎖️ اللفل: ${row.level}
⏭️ المستوى القادم عند: ${nextAt} XP`
      });
    }

    if (i.commandName === "top") {
      const type = i.options.getString("type");

      let select = "text_total";
      if (type === "voice") select = "voice_total";
      if (type === "all") select = "(text_total + voice_total)";
      if (type === "text_week") select = "text_week";
      if (type === "voice_week") select = "voice_week";

      const rows = await db.all(
        `SELECT user_id, ${select} AS xp
         FROM users
         WHERE guild_id = ?
         ORDER BY xp DESC
         LIMIT 10`,
        [gid]
      );

      const title =
        type === "text"
          ? "🏆 TOP كتابي"
          : type === "voice"
          ? "🏆 TOP صوتي"
          : type === "all"
          ? "🏆 TOP إجمالي"
          : type === "text_week"
          ? "🏆 TOP كتابي أسبوعي"
          : "🏆 TOP صوتي أسبوعي";

      let msg = `${title}\n\n`;
      rows.forEach((r, idx) => {
        msg += `${idx + 1}. <@${r.user_id}> — ${r.xp}\n`;
      });

      return i.editReply({ content: msg });
    }

    if (i.commandName === "lock" || i.commandName === "unlock") {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.ManageChannels)) {
        return i.editReply("❌ ما عندك صلاحية.");
      }

      const channel = i.channel;
      if (!channel) return i.editReply("❌ ما فيه روم.");

      const deny = i.commandName === "lock";
      await channel.permissionOverwrites.edit(i.guild.roles.everyone, {
        SendMessages: deny ? false : null
      });

      return i.editReply(deny ? "🔒 تم قفل الروم." : "🔓 تم فتح الروم.");
    }

    if (i.commandName === "set-congrats") {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        return i.editReply("❌ ما عندك صلاحية.");
      }

      const ch = i.options.getChannel("channel");
      await ensureSettings(gid);

      await db.run(
        `UPDATE settings SET congrats_channel_id = ? WHERE guild_id = ?`,
        [ch.id, gid]
      );

      return i.editReply(`✅ تم تعيين روم التهنئة: ${ch}`);
    }

    if (i.commandName === "set-level-role") {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.ManageRoles)) {
        return i.editReply("❌ ما عندك صلاحية.");
      }

      const level = i.options.getInteger("level");
      const role = i.options.getRole("role");

      if (level < 1) {
        return i.editReply("❌ اللفل لازم يكون 1 أو أكثر.");
      }

      await db.run(
        `INSERT INTO level_roles (guild_id, level, role_id)
         VALUES (?, ?, ?)
         ON CONFLICT(guild_id, level) DO UPDATE SET role_id = excluded.role_id`,
        [gid, level, role.id]
      );

      return i.editReply(`✅ تم ربط ${role} مع لفل **${level}**`);
    }

    if (i.commandName === "autoreply-add") {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        return i.editReply("❌ ما عندك صلاحية.");
      }

      const trigger = i.options.getString("trigger").trim().toLowerCase();
      const reply = i.options.getString("reply").trim();

      await db.run(
        `INSERT INTO autoreplies (guild_id, trigger, reply)
         VALUES (?, ?, ?)
         ON CONFLICT(guild_id, trigger) DO UPDATE SET reply = excluded.reply`,
        [gid, trigger, reply]
      );

      return i.editReply(`✅ تم حفظ الرد التلقائي لـ: **${trigger}**`);
    }

    if (i.commandName === "autoreply-remove") {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        return i.editReply("❌ ما عندك صلاحية.");
      }

      const trigger = i.options.getString("trigger").trim().toLowerCase();
      await db.run(`DELETE FROM autoreplies WHERE guild_id = ? AND trigger = ?`, [
        gid,
        trigger
      ]);

      return i.editReply(`🗑️ تم حذف الرد التلقائي لـ: **${trigger}**`);
    }

    if (i.commandName === "autoreply-list") {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        return i.editReply("❌ ما عندك صلاحية.");
      }

      const rows = await db.all(
        `SELECT trigger, reply FROM autoreplies WHERE guild_id = ? ORDER BY trigger`,
        [gid]
      );

      if (!rows.length) return i.editReply("📭 ما فيه ردود تلقائية.");

      let txt = "📌 Auto Replies:\n\n";
      rows.slice(0, 30).forEach((r) => {
        txt += `• **${r.trigger}** → ${r.reply}\n`;
      });

      return i.editReply(txt);
    }

    if (i.commandName === "owner-reset-user") {
      if (!isOwner) return i.editReply("❌ هذا للأونر فقط.");

      const user = i.options.getUser("user");
      await db.run(
        `UPDATE users
         SET text_total=0, voice_total=0, text_week=0, voice_week=0, level=1
         WHERE guild_id=? AND user_id=?`,
        [gid, user.id]
      );

      return i.editReply(`✅ تم تصفير ${user} بالكامل.`);
    }

    if (i.commandName === "owner-reset-guild") {
      if (!isOwner) return i.editReply("❌ هذا للأونر فقط.");

      await db.run(`DELETE FROM users WHERE guild_id = ?`, [gid]);
      await db.run(`DELETE FROM level_roles WHERE guild_id = ?`, [gid]);
      await db.run(`DELETE FROM autoreplies WHERE guild_id = ?`, [gid]);
      await db.run(`DELETE FROM settings WHERE guild_id = ?`, [gid]);

      return i.editReply("✅ تم تصفير السيرفر كامل (XP + إعدادات + ردود).");
    }

    if (i.commandName === "owner-sync") {
      if (!isOwner) return i.editReply("❌ هذا للأونر فقط.");
      await registerCommands();
      return i.editReply("♻️ تم تحديث/مزامنة الأوامر عالميًا.");
    }

    // إذا وصل هنا: أمر غير معروف
    return i.editReply("❌ أمر غير معروف.");
  } catch (e) {
    console.log("interaction error:", e);

    try {
      if (i.deferred || i.replied) {
        await i.editReply("❌ صار خطأ داخلي.");
      } else {
        await i.reply({ content: "❌ صار خطأ داخلي.", ephemeral: true });
      }
    } catch {}
  }
});

// ===================== READY + START =====================
client.once("ready", async () => {
  console.log(`🔥 Logged in as ${client.user.tag}`);
  await registerCommands();
});

(async () => {
  await initDB();
  await client.login(TOKEN);
})();
