const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const config = require('./config');
const { RentalDB, ListDB } = require('./database');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegPath);

// konversi waktu ke WIB (UTC+7) - pakai UTC getter supaya tidak terpengaruh timezone server
const WIB_OFFSET = 7 * 60 * 60 * 1000;
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

const toWIB = (timestamp) => {
  const ms = timestamp ? new Date(timestamp).getTime() : Date.now();
  return new Date(ms + WIB_OFFSET);
};

const formatTanggal = (wibDate) => {
  const hari = HARI[wibDate.getUTCDay()];
  const tgl = wibDate.getUTCDate();
  const bulan = BULAN[wibDate.getUTCMonth()];
  const tahun = wibDate.getUTCFullYear();
  return `${hari}, ${tgl} ${bulan} ${tahun}`;
};

const formatWaktu = (wibDate) => {
  const h = String(wibDate.getUTCHours()).padStart(2, '0');
  const m = String(wibDate.getUTCMinutes()).padStart(2, '0');
  const s = String(wibDate.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s} WIB`;
};

// format tanggal lengkap (untuk sewa dll)
const formatDate = (timestamp) => {
  const wib = toWIB(timestamp);
  return `${formatTanggal(wib)}, ${formatWaktu(wib)}`;
};

const getRemainingDays = (expiry) => {
  const remaining = expiry - Date.now();
  return Math.ceil(remaining / (24 * 60 * 60 * 1000));
};

// pencekan sender owner
const isOwner = (sender) => {
  if (!sender) return false;
  if (!Array.isArray(config.ownerNumber)) return false;

  const senderNumber = sender.split('@')[0].split(':')[0];
  return config.ownerNumber.some(owner => owner.includes(senderNumber));
};

// pencekan kondisi owner, admin, atau penyewa
const hasPermission = async (sock, groupId, sender) => {
  if (isOwner(sender)) return true;

  try {
    const groupMetadata = await sock.groupMetadata(groupId);
    const participant = groupMetadata.participants.find(p => p.id === sender);

    if (participant && (participant.admin === 'admin' || participant.admin === 'superadmin')) {
      return true;
    }
  } catch (error) {
    console.log('Error checking permission:', error.message);
  }

  if (RentalDB.isActive(groupId)) return true;

  return false;
};

// respon bot

const responses = {
  menu: () => {
    const ownerJid = Array.isArray(config.ownerNumber) ? config.ownerNumber[0] : (config.ownerNumber + '@s.whatsapp.net');
    const ownerNumberDisplay = ownerJid.split('@')[0];

    return `
*LIST MENU* 

『 *MENU GRUP* 』

📢 *HIDETAG*
${config.prefix}hidetag
🖼️ *STIKER*
${config.prefix}stiker

🛒 *STORE*
${config.prefix}addlist
${config.prefix}dellist
${config.prefix}updatelist
${config.prefix}list
${config.prefix}proses
${config.prefix}done

『  *👑OWNER ONLY*  』

${config.prefix}sewa
${config.prefix}unsewa
${config.prefix}ceksewa
${config.prefix}listsewa
${config.prefix}cekjid

UNTUK SEWA BOT KETIK ${config.prefix}info untuk lebih lanjut
`;
  },

  info: () => {
    const ownerJid = Array.isArray(config.ownerNumber) ? config.ownerNumber[0] : (config.ownerNumber + '@s.whatsapp.net');
    const ownerNumberDisplay = ownerJid.split('@')[0];

    return `*INFO*

│ 🤖 *INFO BOT*
Nama: *${config.botName}*
Versi: 1.0.1

│ 👤 *INFO OWNER*
Nomor: wa.me/${ownerNumberDisplay}
WhatsApp: @${ownerNumberDisplay}


_Hubungi owner untuk sewa bot!_`;
  },

  noPermission: () => `Kamu ga punya izin!`,

  ownerOnly: () => `*Perintah Khusus Owner!*`,

  addListSuccess: (name, price) => `✅ *Berhasil Menambah Produk!*`,

  showList: (items) => {
    let text = `📋 *LIST PRODUK*\n\n`;
    items.forEach(([name], index) => {
      text += `*${name}*\n`;
    });
    return text;
  }
};
// fitur handler

async function handleMenu(sock, from) {
  const ownerJid = Array.isArray(config.ownerNumber) ? config.ownerNumber[0] : (config.ownerNumber + '@s.whatsapp.net');

  await sock.sendMessage(from, {
    text: responses.menu(),
    mentions: [ownerJid]
  });
}

async function handleInfo(sock, from) {
  const ownerJid = Array.isArray(config.ownerNumber) ? config.ownerNumber[0] : (config.ownerNumber + '@s.whatsapp.net');

  await sock.sendMessage(from, {
    text: responses.info(),
    mentions: [ownerJid]
  });
}

async function handleCekJid(sock, msg, from) {
  const sender = msg.key.participant || msg.key.remoteJid;
  if (!isOwner(sender)) {
    return sock.sendMessage(from, { text: responses.ownerOnly() });
  }

  const quoted = msg.message?.extendedTextMessage?.contextInfo;
  let targetJid, targetNumber;

  if (quoted && quoted.participant) {
    // Jika reply pesan orang lain
    targetJid = quoted.participant;
    targetNumber = targetJid.split('@')[0].split(':')[0];
  } else {
    // Jika tidak reply, cek JID sendiri
    targetJid = sender;
    targetNumber = sender.split('@')[0].split(':')[0];
  }

  // Cek apakah JID adalah format LID (@lid) atau ID
  const isLid = targetJid.includes('@lid');
  const isStandard = targetJid.includes('@s.whatsapp.net');

  let infoText = `📍 *CEK JID/LID*\n\n`;
  infoText += `📱 Nomor: ${targetNumber}\n`;

  if (isLid) {
    infoText += `🔗 LID: ${targetJid}\n`;
    infoText += `\n_LID adalah Linked ID untuk akun tertaut._`;
  } else if (isStandard) {
    infoText += `🆔 JID: ${targetJid}\n`;
    infoText += `\n_JID adalah standar ID WhatsApp._`;
  } else {
    infoText += `🆔 ID: ${targetJid}\n`;
  }

  await sock.sendMessage(from, {
    text: infoText,
    mentions: [targetJid]
  }, { quoted: msg });
}

// --- FUNGSI STIKER (GAMBAR & VIDEO) ---
async function handleSticker(sock, msg) {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

  // Cek semua tipe media
  const isImage = msg.message?.imageMessage;
  const isQuotedImage = quoted?.imageMessage;
  const isVideo = msg.message?.videoMessage;
  const isQuotedVideo = quoted?.videoMessage;

  // Jika tidak ada media sama sekali
  if (!isImage && !isQuotedImage && !isVideo && !isQuotedVideo) {
    return sock.sendMessage(msg.key.remoteJid, {
      text: '❌ Kirim/Reply *gambar* atau *video pendek* Max 10 Detik'
    });
  }

  try {
    // === PROSES GAMBAR ===
    if (isImage || isQuotedImage) {
      const targetMessage = isImage || isQuotedImage;

      await sock.sendMessage(msg.key.remoteJid, { text: 'Otewei on the way..' });

      const stream = await downloadContentFromMessage(targetMessage, 'image');
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }

      const stickerBuffer = await sharp(buffer)
        .resize(512, 512, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .webp()
        .toBuffer();

      await sock.sendMessage(msg.key.remoteJid, {
        sticker: stickerBuffer
      }, { quoted: msg });

      return;
    }

    // === PROSES VIDEO ===
    if (isVideo || isQuotedVideo) {
      const targetMessage = isVideo || isQuotedVideo;

      // Cek durasi video
      const duration = targetMessage.seconds || 0;
      if (duration > 10) {
        return sock.sendMessage(msg.key.remoteJid, {
          text: `Kepanjangan Woy! (${duration} detik)\n\nMaksimal durasinya *10 detik*`
        });
      }

      await sock.sendMessage(msg.key.remoteJid, { text: 'Otewei on the way...' });

      const stream = await downloadContentFromMessage(targetMessage, 'video');
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }

      const tempDir = os.tmpdir();
      const inputPath = path.join(tempDir, `input_${Date.now()}.mp4`);
      const outputPath = path.join(tempDir, `output_${Date.now()}.webp`);

      fs.writeFileSync(inputPath, buffer);

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .inputOptions(['-t 10'])
          .outputOptions([
            '-vcodec', 'libwebp',
            '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:-1:-1:color=white@0.0,split[a][b];[a]palettegen=reserve_transparent=on:transparency_color=ffffff[p];[b][p]paletteuse',
            '-loop', '0',
            '-preset', 'default',
            '-an',
            '-vsync', '0',
            '-quality', '50'
          ])
          .toFormat('webp')
          .on('end', resolve)
          .on('error', reject)
          .save(outputPath);
      });

      const stickerBuffer = fs.readFileSync(outputPath);

      await sock.sendMessage(msg.key.remoteJid, {
        sticker: stickerBuffer
      }, { quoted: msg });

      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    }

  } catch (error) {
    console.log('Error creating sticker:', error);
    await sock.sendMessage(msg.key.remoteJid, {
      text: 'Gagal membuat stiker! Pastikan media yang kamu kirimkan benar.'
    });
  } finally {
    // Cleanup temp files jika ada
    try {
      const tempDir = os.tmpdir();
      const files = fs.readdirSync(tempDir);
      files.forEach(file => {
        if (file.startsWith('input_') || file.startsWith('output_')) {
          const filePath = path.join(tempDir, file);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
      });
    } catch (e) { /* ignore cleanup errors */ }
  }
}

async function handleHidetag(sock, msg, args, groupId) {
  const sender = msg.key.participant || msg.key.remoteJid;
  if (!await hasPermission(sock, groupId, sender)) {
    return sock.sendMessage(groupId, { text: responses.noPermission() });
  }

  try {
    const text = args.join(' ') || '📢 *Cek ombakkk*';
    const groupMetadata = await sock.groupMetadata(groupId);
    const participants = groupMetadata.participants.map(p => p.id);
    await sock.sendMessage(groupId, { text, mentions: participants });
  } catch (error) {
    console.log('Hidetag error:', error);
    await sock.sendMessage(groupId, { text: 'Upss, ada yang salah!' });
  }
}

async function handleAddList(sock, msg, args, groupId) {
  const sender = msg.key.participant || msg.key.remoteJid;
  if (!await hasPermission(sock, groupId, sender)) {
    return sock.sendMessage(groupId, { text: responses.noPermission() });
  }

  const input = args.join(' ').split('|');
  if (input.length < 2) {
    return sock.sendMessage(groupId, {
      text: `Format: ${config.prefix}addlist <nama>|<harga/info>\nContoh: ${config.prefix}addlist Diamond ML|Rp 20.000`
    });
  }

  const [itemName, itemPrice] = [input[0].trim(), input[1].trim()];
  ListDB.addItem(groupId, itemName, itemPrice);
  await sock.sendMessage(groupId, { text: responses.addListSuccess(itemName, itemPrice) });
}

async function handleDelList(sock, msg, args, groupId) {
  const sender = msg.key.participant || msg.key.remoteJid;
  if (!await hasPermission(sock, groupId, sender)) {
    return sock.sendMessage(groupId, { text: responses.noPermission() });
  }

  const itemName = args.join(' ').trim();
  if (!itemName) {
    return sock.sendMessage(groupId, { text: `Format: ${config.prefix}dellist <nama>` });
  }

  if (!ListDB.deleteItem(groupId, itemName)) {
    return sock.sendMessage(groupId, { text: `Produk "${itemName}" tidak ditemukan!` });
  }
  await sock.sendMessage(groupId, { text: `Berhasil menghapus: *${itemName}*` });
}

async function handleUpdateList(sock, msg, args, groupId) {
  const sender = msg.key.participant || msg.key.remoteJid;
  if (!await hasPermission(sock, groupId, sender)) {
    return sock.sendMessage(groupId, { text: responses.noPermission() });
  }

  const input = args.join(' ').split('|');
  if (input.length < 2) {
    return sock.sendMessage(groupId, { text: `Format: ${config.prefix}updatelist <nama>|<harga baru>` });
  }

  const [itemName, itemPrice] = [input[0].trim(), input[1].trim()];
  if (!ListDB.updateItem(groupId, itemName, itemPrice)) {
    return sock.sendMessage(groupId, { text: `Produk "${itemName}" tidak ditemukan!` });
  }
  await sock.sendMessage(groupId, { text: `Cihuyy, berhasil update!\n\n📦 *${itemName}*\n💰 ${itemPrice}` });
}

async function handleShowList(sock, groupId) {
  const lists = ListDB.getGroupLists(groupId);
  const items = Object.entries(lists);
  if (items.length === 0) {
    return sock.sendMessage(groupId, { text: `*LIST KOSONG*\n\nBelum ada produk.` });
  }
  await sock.sendMessage(groupId, { text: responses.showList(items) });
}

async function handleProses(sock, msg, groupId) {
  const sender = msg.key.participant || msg.key.remoteJid;
  if (!await hasPermission(sock, groupId, sender)) {
    return sock.sendMessage(groupId, { text: responses.noPermission() });
  }

  // Cek apakah ada pesan yang di-reply
  const quotedMessage = msg.message?.extendedTextMessage?.contextInfo;
  if (!quotedMessage || !quotedMessage.participant) {
    return sock.sendMessage(groupId, {
      text: `Reply pesan seseorang dengan *${config.prefix}proses* untuk menandai pesanan sedang diproses!`
    });
  }

  const targetUser = quotedMessage.participant;
  const now = toWIB();
  const dateStr = formatTanggal(now);
  const timeStr = formatWaktu(now);

  await sock.sendMessage(groupId, {
    text: `⏳ *PESANAN SEDANG DIPROSES*\n\n👤 Customer: @${targetUser.split('@')[0]}\n📅 Tanggal: ${dateStr}\n⏰ Waktu: ${timeStr}\n\n_Mohon ditunggu ya!_`,
    mentions: [targetUser]
  }, { quoted: msg });
}

async function handleDone(sock, msg, groupId) {
  const sender = msg.key.participant || msg.key.remoteJid;
  if (!await hasPermission(sock, groupId, sender)) {
    return sock.sendMessage(groupId, { text: responses.noPermission() });
  }

  // Cek apakah ada pesan yang di-reply
  const quotedMessage = msg.message?.extendedTextMessage?.contextInfo;
  if (!quotedMessage || !quotedMessage.participant) {
    return sock.sendMessage(groupId, {
      text: `Reply pesan seseorang dengan *${config.prefix}done* untuk menandai pesanan selesai!`
    });
  }

  const targetUser = quotedMessage.participant;
  const now = toWIB();
  const dateStr = formatTanggal(now);
  const timeStr = formatWaktu(now);

  await sock.sendMessage(groupId, {
    text: `✅ *PESANAN SELESAI*\n\n👤 Customer: @${targetUser.split('@')[0]}\n📅 Tanggal: ${dateStr}\n⏰ Waktu: ${timeStr}\n\n_Terima kasih sudah order!_ 🙏`,
    mentions: [targetUser]
  }, { quoted: msg });
}

async function handleSewa(sock, msg, args, from) {
  const sender = msg.key.participant || msg.key.remoteJid;
  if (!isOwner(sender)) return sock.sendMessage(from, { text: responses.ownerOnly() });

  const input = args.join(' ').split('|');
  if (input.length < 2) {
    return sock.sendMessage(from, { text: `Format: ${config.prefix}sewa <link invite>|<hari>` });
  }

  const [link, daysStr] = [input[0].trim(), input[1].trim()];
  const days = parseInt(daysStr);
  if (isNaN(days) || days <= 0) return sock.sendMessage(from, { text: 'Durasi harus angka positif!' });

  const inviteCode = link.replace('https://chat.whatsapp.com/', '');
  let targetGroup;
  try {
    targetGroup = await sock.groupAcceptInvite(inviteCode);
  } catch (error) {
    if (error.message.includes('participant-already-in-group')) {
      const groupMeta = await sock.groupGetInviteInfo(inviteCode);
      targetGroup = groupMeta.id;
    } else {
      return sock.sendMessage(from, { text: 'Gagal join grup. Link tidak valid.' });
    }
  }

  const expiry = RentalDB.addRental(targetGroup, days);
  await sock.sendMessage(from, { text: `SEWA BERHASIL!\n\n📱 Grup: ${targetGroup}\n📅 Kadaluarsa: ${formatDate(expiry)}` });
  await sock.sendMessage(targetGroup, { text: `🎉 *BOT TELAH DISEWA!*\n\n⏱️ Durasi: ${days} hari\n📅 Kadaluarsa: ${formatDate(expiry)}` });
}

async function handleUnsewa(sock, msg, args, from) {
  const sender = msg.key.participant || msg.key.remoteJid;
  if (!isOwner(sender)) return sock.sendMessage(from, { text: responses.ownerOnly() });

  const targetGroup = args[0]?.trim();
  if (!targetGroup || !RentalDB.getInfo(targetGroup)) return sock.sendMessage(from, { text: `Grup tidak terdaftar!` });

  RentalDB.remove(targetGroup);
  await sock.sendMessage(from, { text: `Sewa dibatalkan untuk: ${targetGroup}` });
}

async function handleCekSewa(sock, msg, args, from) {
  const sender = msg.key.participant || msg.key.remoteJid;
  if (!isOwner(sender)) return sock.sendMessage(from, { text: responses.ownerOnly() });

  const targetGroup = args[0]?.trim() || from;
  const info = RentalDB.getInfo(targetGroup);
  if (!info) return sock.sendMessage(from, { text: `Grup tidak terdaftar!` });

  const remaining = getRemainingDays(info.expiry);
  await sock.sendMessage(from, {
    text: `📊 *INFO SEWA*\n\n📱 Grup: ${targetGroup}\n📅 Expire: ${formatDate(info.expiry)}\n⏳ Sisa: ${remaining} hari`
  });
}

async function handleListSewa(sock, msg, from) {
  const sender = msg.key.participant || msg.key.remoteJid;
  if (!isOwner(sender)) return sock.sendMessage(from, { text: responses.ownerOnly() });

  const rentals = RentalDB.getAllActive();
  if (rentals.length === 0) return sock.sendMessage(from, { text: `📋 *LIST SEWA KOSONG*` });

  let text = `📋 *LIST SEWA BOT*\n\n`;
  rentals.forEach(([groupId, info], index) => {
    text += `${index + 1}. ${groupId} - ${getRemainingDays(info.expiry)} hari lagi\n`;
  });
  await sock.sendMessage(from, { text });
}

async function handleProductMention(sock, msg, content) {
  const groupId = msg.key.remoteJid;
  const groupLists = ListDB.getGroupLists(groupId);
  const productNames = Object.keys(groupLists);
  const lowerContent = content.toLowerCase().trim();

  for (const productName of productNames) {
    if (productName.toLowerCase() === lowerContent) {
      await sock.sendMessage(groupId, { text: `『 *INFO PRODUK* 』\n\n${groupLists[productName]}` }, { quoted: msg });
      return;
    }
  }
}

// logika utama handler

function startAutoLeaveChecker(sock) {
  // Track reminder yang sudah dikirim (reset setiap restart)
  const reminderSent = new Set();

  setInterval(async () => {
    const allRentals = RentalDB.getAll();
    const now = Date.now();
    const threeDays = 3 * 24 * 60 * 60 * 1000;

    for (const [groupId, info] of Object.entries(allRentals)) {
      const remaining = info.expiry - now;
      const remainingDays = Math.ceil(remaining / (24 * 60 * 60 * 1000));

      // Reminder 3 hari sebelum expired
      if (remaining > 0 && remaining <= threeDays && !reminderSent.has(groupId)) {
        try {
          await sock.sendMessage(groupId, {
            text: `⚠️ *REMINDER SEWA BOT*\n\nMasa sewa bot tinggal *${remainingDays} hari* lagi!\n📅 Kadaluarsa: ${formatDate(info.expiry)}\n\n_Hubungi owner untuk perpanjang sewa._`
          });
          reminderSent.add(groupId);
        } catch (e) { console.log('Reminder error:', e.message); }
      }

      // Auto leave jika expired
      if (now > info.expiry) {
        try {
          await sock.sendMessage(groupId, { text: `⏰ *MASA SEWA HABIS!* Bot akan keluar.` });
          await new Promise(r => setTimeout(r, 3000));
          await sock.groupLeave(groupId);
          RentalDB.remove(groupId);
          reminderSent.delete(groupId);
        } catch (e) { console.log(e.message); }
      }
    }
  }, 60000);
}

function getMessageContent(msg) {
  if (!msg.message) return '';
  const typeOrder = ['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage'];
  for (const type of typeOrder) {
    if (msg.message[type]) {
      return msg.message[type].text || msg.message[type].caption || msg.message[type] || '';
    }
  }
  return '';
}

async function handleMessage(sock, messages) {
  try {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const content = getMessageContent(msg);
    if (!content || typeof content !== 'string') return;

    if (content.startsWith(config.prefix)) {
      const args = content.slice(config.prefix.length).trim().split(/ +/);
      const command = args.shift().toLowerCase();

      switch (command) {
        case 'menu': await handleMenu(sock, from); break;
        case 'info': await handleInfo(sock, from); break;
        case 'stiker':
        case 's': await handleSticker(sock, msg); break;
        case 'hidetag': isGroup ? await handleHidetag(sock, msg, args, from) : await sock.sendMessage(from, { text: '❌ Khusus grup!' }); break;
        case 'addlist': isGroup ? await handleAddList(sock, msg, args, from) : await sock.sendMessage(from, { text: '❌ Khusus grup!' }); break;
        case 'dellist': isGroup ? await handleDelList(sock, msg, args, from) : await sock.sendMessage(from, { text: '❌ Khusus grup!' }); break;
        case 'updatelist': isGroup ? await handleUpdateList(sock, msg, args, from) : await sock.sendMessage(from, { text: '❌ Khusus grup!' }); break;
        case 'list': isGroup ? await handleShowList(sock, from) : await sock.sendMessage(from, { text: '❌ Khusus grup!' }); break;
        case 'proses': isGroup ? await handleProses(sock, msg, from) : await sock.sendMessage(from, { text: '❌ Khusus grup!' }); break;
        case 'done': isGroup ? await handleDone(sock, msg, from) : await sock.sendMessage(from, { text: '❌ Khusus grup!' }); break;
        case 'sewa': await handleSewa(sock, msg, args, from); break;
        case 'unsewa': await handleUnsewa(sock, msg, args, from); break;
        case 'ceksewa': await handleCekSewa(sock, msg, args, from); break;
        case 'listsewa': await handleListSewa(sock, msg, from); break;
        case 'cekjid': await handleCekJid(sock, msg, from); break;
      }
      return;
    }

    // Cek product mention terlebih dahulu
    if (isGroup) {
      const groupLists = ListDB.getGroupLists(from);
      const productNames = Object.keys(groupLists);
      const isProductMention = productNames.some(name =>
        name.toLowerCase() === content.toLowerCase().trim()
      );

      if (isProductMention) {
        await handleProductMention(sock, msg, content);
        return; // Jangan lanjut ke anti-reply check
      }
    }

    // Cek jika user tanpa izin reply pesan bot (hanya jika bukan product mention)
    if (isGroup) {
      const quotedMessage = msg.message?.extendedTextMessage?.contextInfo;
      if (quotedMessage && quotedMessage.participant) {
        const botNumber = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
        const isReplyToBot = quotedMessage.participant === botNumber ||
          quotedMessage.participant === sock.user?.id;

        if (isReplyToBot) {
          const sender = msg.key.participant || msg.key.remoteJid;
          const hasAccess = await hasPermission(sock, from, sender);

          if (!hasAccess) {
            await sock.sendMessage(from, {
              text: 'Jangan reply bot!!'
            }, { quoted: msg });
          }
        }
      }
    }

  } catch (error) { console.log('Error handling message:', error); }
}

module.exports = { handleMessage, startAutoLeaveChecker };