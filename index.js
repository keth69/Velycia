const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const readline = require('readline');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const { handleMessage, startAutoLeaveChecker } = require('./handler');

// Clear console saat start
console.clear();

const question = (text) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(text, (answer) => {
    rl.close();
    resolve(answer);
  }));
};

const wsBrowserOptions = process.argv.includes('--use-pairing-code')
  ? ['Mac OS', 'Chrome', '121.0.6167.159']
  : ['Mac OS', 'Chrome', '121.0.6167.159'];

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionName);

  const sock = makeWASocket({
    logger: pino({ level: 'info' }),
    printQRInTerminal: !process.argv.includes('--use-pairing-code'),
    auth: state,
    browser: wsBrowserOptions,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
    markOnlineOnConnect: true,
    keepAliveIntervalMs: 30000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: undefined
  });

  if (process.argv.includes('--use-pairing-code') && !sock.authState.creds.registered) {
    setTimeout(async () => {
      console.log(`\n======================================================`);
      const phoneNumber = await question('Masukkan nomor WhatsApp bot (contoh: 6281234567890): ');
      try {
        const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
        console.log(`\n📱 KODE PAIRING ANDA: ${code?.match(/.{1,4}/g)?.join('-') || code}`);
        console.log(`Buka WhatsApp > Tautkan Perangkat > Tautkan dengan Nomor Telepon`);
        console.log(`======================================================\n`);
      } catch (err) {
        console.log('\n❌ Gagal mendapatkan kode pairing:', err.message);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !process.argv.includes('--use-pairing-code')) {
      console.clear();
      console.log('\n╔════════════════════════════════════╗');
      console.log('║      SCAN QR CODE DI BAWAH INI     ║');
      console.log('╚════════════════════════════════════╝\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;

      console.log('\n⚠️  Koneksi terputus. Reconnecting in 3 seconds:', shouldReconnect);

      if (shouldReconnect) {
        setTimeout(() => {
          startBot();
        }, 3000);
      }
    } else if (connection === 'open') {
      console.clear();

      const botJid = sock.user?.id || 'Unknown';
      const botNumber = botJid.split(':')[0];
      const ownerJid = Array.isArray(config.ownerNumber) ? config.ownerNumber[0] : config.ownerNumber;
      const ownerNumber = ownerJid.split('@')[0];

      console.log('\n╔════════════════════════════════════╗');
      console.log('║         🤖 VELYCIA BOT v1.0.1       ║');
      console.log('╠════════════════════════════════════╣');
      console.log('║  Status: ✅ Connected              ║');
      console.log('╚════════════════════════════════════╝\n');

      console.log('┌──────────────────────────────────────');
      console.log('│ 📱 BOT INFO');
      console.log('├──────────────────────────────────────');
      console.log(`│ Nama    : ${config.botName}`);
      console.log(`│ Prefix  : ${config.prefix}`);
      console.log(`│ Nomor   : ${botNumber}`);
      console.log(`│ JID     : ${botJid}`);
      console.log('└──────────────────────────────────────\n');

      console.log('┌──────────────────────────────────────');
      console.log('│ 👤 OWNER INFO');
      console.log('├──────────────────────────────────────');
      console.log(`│ Nomor   : ${ownerNumber}`);
      console.log(`│ JID     : ${ownerJid}`);
      console.log('└──────────────────────────────────────\n');

      console.log('📝 Bot siap menerima perintah!\n');

      startAutoLeaveChecker(sock);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type === 'notify') {
      await handleMessage(sock, messages);
    }
  });

  return sock;
}

startBot().catch(err => {
  console.log('\n❌ Error starting bot:', err.message);
});