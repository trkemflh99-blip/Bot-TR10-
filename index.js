const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  SlashCommandBuilder,
  Routes,
  REST
} = require("discord.js");

const express = require("express");
const fs = require("fs");

//////////////////////
// KEEP ALIVE
//////////////////////
const app = express();
app.get("/", (req, res) => res.send("TR10 BOT ONLINE"));
app.listen(3000);

//////////////////////
// CLIENT
//////////////////////
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

//////////////////////
// DATABASE
//////////////////////
let db = {};
if (fs.existsSync("data.json")) {
  db = JSON.parse(fs.readFileSync("data.json"));
}

function save() {
  fs.writeFileSync("data.json", JSON.stringify(db, null, 2));
}

function getUser(guild, user) {
  if (!db[guild]) db[guild] = {};
  if (!db[guild][user])
    db[guild][user] = {
      text: 0,
      voice: 0,
      daily: 0,
      weekly: 0,
      level: 0
    };
  return db[guild][user];
}

//////////////////////
// LEVEL SYSTEM
//////////////////////
function checkLevel(guildId, userId, member) {
  const data = getUser(guildId, userId);
  const needed = (data.level + 1) * 500;

  if (data.text + data.voice >= needed) {
    data.level++;
    member.send(`🔥 مبروك وصلت لفل ${data.level}`);
    save();
  }
}

//////////////////////
// TEXT XP
//////////////////////
client.on("messageCreate", msg => {
  if (msg.author.bot || !msg.guild) return;

  const data = getUser(msg.guild.id, msg.author.id);

  data.text += 5;
  data.daily += 5;
  data.weekly += 5;

  checkLevel(msg.guild.id, msg.author.id, msg.member);
  save();

  if (msg.content === "!help") {
    msg.reply("📜 استخدم /help لعرض الأوامر");
  }
});

//////////////////////
// VOICE XP
//////////////////////
setInterval(() => {
  client.guilds.cache.forEach(guild => {
    guild.channels.cache
      .filter(c => c.isVoiceBased())
      .forEach(channel => {
        channel.members.forEach(member => {
          if (!member.user.bot) {
            const data = getUser(guild.id, member.id);
            data.voice += 10;
            data.daily += 10;
            data.weekly += 10;
            checkLevel(guild.id, member.id, member);
          }
        });
      });
  });
  save();
}, 60000);

//////////////////////
// SLASH COMMANDS
//////////////////////
const commands = [
  new SlashCommandBuilder()
    .setName("xp")
    .setDescription("عرض الاكس بي"),

  new SlashCommandBuilder()
    .setName("top")
    .setDescription("توب 10"),

  new SlashCommandBuilder()
    .setName("topweek")
    .setDescription("توب أسبوعي"),

  new SlashCommandBuilder()
    .setName("قفل")
    .setDescription("قفل الروم")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

  new SlashCommandBuilder()
    .setName("فتح")
    .setDescription("فتح الروم")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("عرض جميع الأوامر"),

  new SlashCommandBuilder()
    .setName("owner-addxp")
    .setDescription("إضافة اكس بي")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("المستخدم")
        .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("amount")
        .setDescription("الكمية")
        .setRequired(true)
    )
].map(c => c.toJSON());

//////////////////////
// REGISTER COMMANDS
//////////////////////
client.once("ready", async () => {
  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: commands }
  );

  console.log("🔥 TR10 READY");
});

//////////////////////
// INTERACTIONS
//////////////////////
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild.id;
  const user = interaction.user.id;
  const data = getUser(guild, user);

  if (interaction.commandName === "xp") {
    return interaction.reply({
      content:
        `📊 XP الكلي: ${data.text + data.voice}\n` +
        `💬 دردشة: ${data.text}\n` +
        `🎤 صوتي: ${data.voice}\n` +
        `📅 يومي: ${data.daily}\n` +
        `📆 أسبوعي: ${data.weekly}\n` +
        `⭐ لفل: ${data.level}`,
      ephemeral: true
    });
  }

  if (interaction.commandName === "top") {
    const users = Object.entries(db[guild] || {})
      .sort((a, b) =>
        (b[1].text + b[1].voice) - (a[1].text + a[1].voice)
      )
      .slice(0, 10);

    let text = "🏆 توب 10:\n";
    users.forEach((u, i) => {
      text += `${i + 1}- <@${u[0]}> | ${u[1].text + u[1].voice}\n`;
    });

    return interaction.reply({ content: text });
  }

  if (interaction.commandName === "topweek") {
    const users = Object.entries(db[guild] || {})
      .sort((a, b) => b[1].weekly - a[1].weekly)
      .slice(0, 10);

    let text = "📆 توب أسبوعي:\n";
    users.forEach((u, i) => {
      text += `${i + 1}- <@${u[0]}> | ${u[1].weekly}\n`;
    });

    return interaction.reply({ content: text });
  }

  if (interaction.commandName === "قفل") {
    await interaction.channel.permissionOverwrites.edit(
      interaction.guild.roles.everyone,
      { SendMessages: false }
    );
    return interaction.reply("🔒 تم قفل الروم");
  }

  if (interaction.commandName === "فتح") {
    await interaction.channel.permissionOverwrites.edit(
      interaction.guild.roles.everyone,
      { SendMessages: true }
    );
    return interaction.reply("🔓 تم فتح الروم");
  }

  if (interaction.commandName === "help") {
    return interaction.reply({
      content:
        "📜 الأوامر:\n" +
        "/xp\n/top\n/topweek\n/قفل\n/فتح\n/owner-addxp",
      ephemeral: true
    });
  }

  if (interaction.commandName === "owner-addxp") {
    if (interaction.user.id !== "910264482444480562")
      return interaction.reply({ content: "❌ ليس لك", ephemeral: true });

    const target = interaction.options.getUser("user");
    const amount = interaction.options.getInteger("amount");

    const targetData = getUser(guild, target.id);
    targetData.text += amount;
    save();

    return interaction.reply("✅ تم إضافة XP");
  }
});

//////////////////////
// LOGIN
//////////////////////
client.login(process.env.TOKEN);
